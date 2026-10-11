"""Lightweight semantic retrieval (TF-IDF + synonym expansion + char-trigram fuzziness).
Zero external deps, sub-millisecond queries. Swap for FAISS/pgvector embeddings at scale: same interface."""
import math, re
from collections import Counter, defaultdict
import metadata as M
from db import q

SYN = {
    "vendor": "supplier", "vendors": "supplier", "suppliers": "supplier", "sourcing": "supplier",
    "stock": "inventory", "stocks": "inventory", "item": "product", "items": "product", "products": "product", "sku": "product", "material": "product", "materials": "product",
    "po": "purchase", "pos": "purchase", "buy": "purchase", "buying": "purchase", "replenish": "purchase", "purchases": "purchase",
    "sale": "sales", "selling": "sales", "sold": "sales", "booking": "sales", "bookings": "sales", "order": "orders",
    "client": "customer", "clients": "customer", "customers": "customer", "buyer": "customer", "buyers": "customer", "account": "customer", "accounts": "customer",
    "shipment": "logistics", "shipments": "logistics", "delivery": "logistics", "deliveries": "logistics", "carrier": "logistics", "carriers": "logistics",
    "transit": "logistics", "dispatch": "logistics", "late": "delayed", "delay": "delayed", "delays": "delayed",
    "profit": "finance", "loss": "finance", "p&l": "finance", "pnl": "finance", "expense": "finance", "expenses": "finance", "cost": "finance", "costs": "finance", "margin": "finance", "cogs": "finance", "money": "finance", "cash": "finance",
    "approve": "approval", "approvals": "approval", "requests": "request", "audit": "activity", "log": "activity", "logs": "activity", "history": "activity",
    "home": "dashboard", "overview": "dashboard", "summary": "dashboard", "kpis": "kpi",
    "analysis": "analytics", "analyze": "analytics", "analyse": "analytics", "breakdown": "analytics", "insights": "analytics", "report": "analytics", "reports": "analytics",
    "revenue": "revenue", "income": "revenue", "turnover": "revenue",
}
STOP = set("a an the of for to in on at by with and or is are was were be me my our show open go take please can you i want see view display list all get what which this that from into about".split())


def tok(text):
    words = re.findall(r"[a-z0-9&]+", (text or "").lower())
    out = []
    for w in words:
        if w in STOP:
            continue
        w2 = SYN.get(w, w)
        if w2.endswith("s") and len(w2) > 4 and w2 not in ("sales", "logistics", "analytics", "orders", "status"):
            w2 = w2[:-1]
        out.append(w2)
    return out


def trigrams(s):
    s = f"  {s.lower()} "
    return {s[i:i + 3] for i in range(len(s) - 2)}


class Index:
    def __init__(self, docs):
        self.docs = docs
        self.tf = [Counter(tok(d["text"])) for d in docs]
        df = Counter()
        for t in self.tf:
            df.update(t.keys())
        n = len(docs)
        self.idf = {w: math.log((n + 1) / (c + 0.5)) + 1 for w, c in df.items()}
        self.vec = [self._v(t) for t in self.tf]
        self.inv = defaultdict(set)
        for i, t in enumerate(self.tf):
            for w in t:
                self.inv[w].add(i)
        self.tri = [trigrams(d.get("name", "")) for d in docs]

    def _v(self, tf):
        v = {w: (1 + math.log(c)) * self.idf.get(w, 1) for w, c in tf.items()}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1
        return {w: x / norm for w, x in v.items()}

    def search(self, text, k=5, kinds=None):
        qv = self._v(Counter(tok(text)))
        cand = set()
        for w in qv:
            cand |= self.inv.get(w, set())
        qt = trigrams(text)
        scores = []
        for i in range(len(self.docs)):
            d = self.docs[i]
            if kinds and d["kind"] not in kinds:
                continue
            s = sum(qv[w] * self.vec[i].get(w, 0) for w in qv) if i in cand else 0
            if self.tri[i] and d["kind"] not in ("page", "api"):
                inter = len(qt & self.tri[i]) / (len(self.tri[i]) or 1)
                s = max(s, inter * 0.9 if inter > 0.55 else 0)
            s *= d.get("boost", 1)
            if s > 0:
                scores.append((s, i))
        scores.sort(reverse=True)
        return [{**self.docs[i], "score": round(s, 3)} for s, i in scores[:k]]


_index = None


def build():
    global _index
    docs = []
    for p in M.PAGES:
        text = " ".join([p["title"], p["title"], p["id"], p["description"], p["keywords"], " ".join(w[2] for w in p["widgets"]), " ".join(f["label"] for f in p["filters"])])
        docs.append({"kind": "page", "id": p["id"], "name": p["title"], "page": p["id"], "text": text, "boost": 1.0})
        for wid, wtype, wtitle in p["widgets"]:
            docs.append({"kind": "widget", "id": f"{p['id']}.{wid}", "name": wtitle, "page": p["id"], "text": f"{wtitle} {wtype} {p['title']}", "boost": 0.8})
    for a in M.APIS:
        docs.append({"kind": "api", "id": a["name"], "name": a["name"], "page": None, "text": f"{a['name'].replace('_', ' ')} {a['description']}", "boost": 1.0})
    for r in q("SELECT id, sku, name, category FROM products WHERE is_deleted=0"):
        docs.append({"kind": "products", "id": r["id"], "name": r["name"], "code": r["sku"], "page": "inventory", "text": f"{r['name']} {r['sku']} {r['category']} product", "boost": 1.1})
    for r in q("SELECT id, code, name, city, category FROM suppliers WHERE is_deleted=0"):
        docs.append({"kind": "suppliers", "id": r["id"], "name": r["name"], "code": r["code"], "page": "suppliers", "text": f"{r['name']} {r['code']} {r['city']} {r['category']} supplier", "boost": 1.1})
    for r in q("SELECT id, code, name, city, region FROM customers WHERE is_deleted=0"):
        docs.append({"kind": "customers", "id": r["id"], "name": r["name"], "code": r["code"], "page": "customers", "text": f"{r['name']} {r['code']} {r['city']} {r['region']} customer", "boost": 1.0})
    _index = Index(docs)
    return _index


def index():
    return _index or build()


def search(text, k=5, kinds=None):
    return index().search(text, k, kinds)


def search_pages(text, k=3):
    return search(text, k, {"page"})


def search_apis(text, k=3):
    return search(text, k, {"api"})

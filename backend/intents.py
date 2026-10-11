"""Stage-2 semantic intent classifier. Runs only when the rule router is unsure (navigate/unknown).
Bag of normalized unigrams+bigrams, TF-IDF weighted, cosine to per-intent centroids built from example utterances.
Output is turned into a canonical command so the rule router still extracts slots (region, period, product...).
No model download, <1 ms. Swap for sentence embeddings at scale; same interface."""
import math, re
from collections import Counter, defaultdict

NORM = {
    # stock-out
    "short": "stockout", "shortage": "stockout", "finish": "stockout", "finishing": "stockout", "exhausted": "stockout", "restock": "stockout",
    "reorder": "stockout", "reordering": "stockout", "replenish": "stockout", "runout": "stockout", "depleted": "stockout", "empty": "stockout",
    # delays
    "stuck": "delay", "slow": "delay", "late": "delay", "delayed": "delay", "delays": "delay", "delay": "delay", "overdue": "delay", "behind": "delay",
    # finance
    "profitable": "profit", "profit": "profit", "profits": "profit", "earn": "profit", "earning": "profit", "earnings": "profit", "money": "profit", "margin": "profit",
    "margins": "profit", "p&l": "profit", "pnl": "profit", "bottom": "bottom", "loss": "profit", "spending": "expense", "spend": "expense", "expenses": "expense", "costs": "expense", "cost": "expense",
    # trend
    "trending": "trend", "trend": "trend", "trends": "trend", "doing": "trend", "performing": "perform", "predict": "trend", "forecast": "trend", "projection": "trend", "outlook": "trend", "growth": "trend",
    # why
    "fell": "drop", "fall": "drop", "falling": "drop", "dropped": "drop", "drop": "drop", "dip": "drop", "decline": "drop", "declining": "drop", "down": "drop", "slump": "drop",
    "why": "why", "reason": "why", "cause": "why", "caused": "why", "explain": "why", "going": "going",
    # compare
    "against": "versus", "vs": "versus", "versus": "versus", "compared": "versus", "compare": "versus", "mom": "versus", "yoy": "versus",
    # top
    "most": "top", "best": "top", "biggest": "top", "largest": "top", "highest": "top", "top": "top", "leading": "top", "worst": "top", "lowest": "top", "least": "top", "weakest": "top",
    # approvals
    "sign": "approve", "signoff": "approve", "approve": "approve", "approval": "approve", "approvals": "approve", "waiting": "pending", "pending": "pending", "awaiting": "pending", "requests": "request", "request": "request",
    # suppliers
    "vendor": "supplier", "vendors": "supplier", "suppliers": "supplier", "supplier": "supplier", "buy": "buy", "source": "buy", "purchase": "buy", "cheapest": "cheap", "cheaper": "cheap", "cheap": "cheap",
    # misc
    "products": "product", "items": "product", "item": "product", "clients": "customer", "client": "customer", "customers": "customer", "regions": "region", "states": "region",
    "shipments": "shipment", "deliveries": "shipment", "delivery": "shipment", "shipment": "shipment", "orders": "order", "screen": "page", "seeing": "page", "page": "page",
}
STOP = set("a an the of for to in on at by with and or is are was were be me my our we us i you it this that these those what which who how do does did any anything can could would should will please".split())

EXAMPLES = {
    "stockout": ["what will run out of stock soon", "items at risk of stock out", "do we have enough stock for next two weeks", "which materials are nearly finished",
                 "stock shortage risk", "products needing replenishment", "what should we reorder", "inventory running low forecast", "days of cover for products",
                 "restock recommendations", "items close to zero stock"],
    "delays": ["late shipments", "which carrier is delayed", "shipments behind schedule", "deliveries overdue", "slow carriers", "delay by destination",
               "where are deliveries getting stuck", "carrier performance delays", "orders not delivered on time"],
    "finance": ["are we making money", "profit this year", "gross margin", "profit and loss", "how much did we earn", "expense breakdown",
                "where are we spending", "operating costs summary", "net profit last quarter", "cash position and margin"],
    "trend": ["sales trend", "how are we performing", "revenue over time", "forecast revenue next month", "growth over the last year", "monthly performance",
              "how is revenue doing", "business outlook", "projection for sales"],
    "why": ["why did revenue drop", "what caused sales to fall", "reason for the decline in orders", "sales down explain", "why is revenue lower",
            "what is going on with sales falling", "root cause of the dip"],
    "expense_why": ["why are costs rising", "why did expenses increase", "reason for higher logistics cost", "spending went up why"],
    "compare_periods": ["compare this month vs last month", "revenue versus last year", "how does this quarter compare to the previous", "year over year sales",
                        "month over month orders", "compare periods", "this year against last year"],
    "top": ["top selling products", "best customers by revenue", "highest revenue regions", "worst categories", "biggest accounts", "most sold items",
            "leading channels", "lowest performing products", "best vendors by rating", "rank customers"],
    "compare_suppliers": ["best supplier for copper", "cheapest vendor for resin", "compare suppliers pricing", "where should we buy from", "which vendor to source from",
                          "supplier comparison for a product", "recommend a vendor"],
    "requests": ["pending approvals", "what needs my approval", "requests waiting for review", "change requests pending", "anything to approve", "my submitted requests"],
    "current_page": ["what is on this page", "explain this screen", "summarize what i am looking at", "describe this view", "key points on this page"],
    "help": ["what can you do", "help", "how do i use this", "show me commands", "capabilities"],
    "navigate": ["open inventory", "show sales orders", "go to suppliers", "list customers in delhi", "orders in karnataka last month", "cancelled orders",
                 "purchase orders draft", "show shipments in transit", "revenue breakdown by channel", "units by category", "open finance page", "suppliers with high rating",
                 "show products", "sales for a region", "electrical products", "show the dashboard", "approval page", "activity log"],
}
TRIGGER = {"stockout": "which items will run out in next 14 days ", "delays": "show delayed shipments ", "finance": "net profit ", "trend": "revenue trend ",
           "why": "why ", "expense_why": "why did expense increase ", "compare_periods": "compare ", "compare_suppliers": "compare suppliers for ",
           "requests": "show pending requests", "current_page": "what is on this page", "help": "help"}


def tokens(text):
    ws = [w for w in re.findall(r"[a-z0-9&]+", text.lower())]
    ws = [NORM.get(w, w) for w in ws if w not in STOP]
    return ws + [f"{a}_{b}" for a, b in zip(ws, ws[1:])]


class Classifier:
    def __init__(self, examples):
        docs = [(lab, Counter(tokens(t))) for lab, xs in examples.items() for t in xs]
        df = Counter()
        for _, c in docs:
            df.update(c.keys())
        n = len(docs)
        self.idf = {w: math.log((n + 1) / (c + 0.5)) + 1 for w, c in df.items()}
        cent = defaultdict(Counter)
        for lab, c in docs:
            for w, x in self._vec(c).items():
                cent[lab][w] += x
        self.cent = {lab: self._unit(v) for lab, v in cent.items()}

    def _vec(self, c):
        return self._unit({w: (1 + math.log(x)) * self.idf.get(w, 0.5) for w, x in c.items()})

    @staticmethod
    def _unit(v):
        n = math.sqrt(sum(x * x for x in v.values())) or 1
        return {w: x / n for w, x in v.items()}

    def predict(self, text):
        q = self._vec(Counter(tokens(text)))
        scores = sorted(((sum(q[w] * c.get(w, 0) for w in q), lab) for lab, c in self.cent.items()), reverse=True)
        (s1, l1), (s2, _) = scores[0], scores[1]
        return {"intent": l1, "score": round(s1, 3), "margin": round(s1 - s2, 3)}


CLF = Classifier(EXAMPLES)


def top_rewrite(t):
    kind = next((k for rx, k in ((r"customer|client|account", "customers"), (r"supplier|vendor", "suppliers"), (r"region|state", "regions"),
                                 (r"categor", "categories"), (r"channel", "channels"), (r"segment", "segments")) if re.search(rx, t)), "products")
    word = "bottom" if re.search(r"\b(worst|lowest|least|weakest|bottom)\b", t) else "top"
    n = re.search(r"\b(\d+)\b", t)
    return f"{word} {n.group(1) if n else 5} {kind} {t}"


def rewrite(intent, t):
    if intent == "top":
        return top_rewrite(t)
    return TRIGGER[intent] + ("" if intent in ("requests", "current_page", "help") else t)

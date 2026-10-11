"""BizPilot agent: route -> plan -> execute tools -> stream steps, UI actions and cards.
Fast path: deterministic intent router + slot filler (ms). Slow path: optional LLM rewrite.
All data reads go through pages.py (same as UI); all writes go through services.py (RBAC enforced)."""
import re, time, uuid, json
from datetime import date, timedelta
import metadata as M
import pages as P
import services as S
import retrieval as R
import nlu as N
import llm
import intents
import spell
import dataset as DS
from db import ex, today

PENDING = {}  # confirm token -> {"user", "op", "ts"}


# ---------------- formatting ----------------
def inr(v):
    v = v or 0
    a = abs(v)
    if a >= 1e7:
        return f"₹{v / 1e7:.2f} Cr"
    if a >= 1e5:
        return f"₹{v / 1e5:.2f} L"
    return f"₹{v:,.0f}"


def fmtv(v, fmt):
    if v is None:
        return "—"
    if fmt == "inr":
        return inr(v)
    if fmt == "pct":
        return f"{v:.1f}%"
    if fmt == "int":
        return f"{int(v):,}"
    if fmt == "num":
        return f"{v:,.2f}".rstrip("0").rstrip(".")
    if fmt == "days":
        return f"{v:.1f} d"
    return str(v)


def sign(p):
    return "—" if p is None else (f"+{p:.1f}%" if p >= 0 else f"{p:.1f}%")


# ---------------- events ----------------
def step(text):
    return {"t": "step", "text": text}


def say(text):
    return {"t": "text", "text": text}


def nav(page, filters=None, sort=None, highlight=None):
    return {"t": "action", "action": "navigate", "page": page, "filters": {k: v for k, v in (filters or {}).items() if v not in (None, "")}, "sort": sort, "highlight": highlight}


def card(kind, **kw):
    return {"t": "card", "card": {"type": kind, **kw}}


def chart_card(kind, title, labels, datasets, **opts):
    """opts: fmt (inr|int|num|pct|days), horizontal, colors (per-bar), signed (red for negatives)."""
    return card("chart", chart={"type": kind, "title": title, "labels": labels, "datasets": datasets, **opts})


def sev_colors(vals, warn, bad, reverse=False):
    out = []
    for v in vals:
        v = v or 0
        hit_bad = v >= bad if reverse else v <= bad
        hit_warn = v >= warn if reverse else v <= warn
        out.append("#dc2626" if hit_bad else "#f59e0b" if hit_warn else "#16a34a")
    return out


def q_(v):
    return "'" + str(v).replace("'", "''") + "'"


def sales_sql(a, b, metric="revenue", extra=None, group=None, limit=None):
    """Runnable SQL equivalent of a sales computation, shown as the source of every number."""
    agg = {"revenue": "ROUND(SUM(so.amount), 2) AS revenue", "orders": "COUNT(*) AS orders", "units": "SUM(so.qty) AS units"}[metric]
    col = {"region": "so.region", "category": "p.category", "channel": "so.channel", "segment": "c.segment", "product": "p.name", "customer": "c.name"}.get(group)
    w = [f"so.status != 'Cancelled'", "so.is_deleted = 0", f"so.order_date BETWEEN {q_(a)} AND {q_(b)}"]
    for k, c in (("region", "so.region"), ("category", "p.category"), ("channel", "so.channel")):
        if (extra or {}).get(k):
            w.append(f"{c} = {q_(extra[k])}")
    sel = f"{col} AS {group}, {agg}" if col else agg
    sql = (f"SELECT {sel} FROM sales_orders so JOIN products p ON p.id = so.product_id JOIN customers c ON c.id = so.customer_id "
           f"WHERE {' AND '.join(w)}")
    if col:
        sql += f" GROUP BY {col} ORDER BY {metric} DESC"
    if limit:
        sql += f" LIMIT {limit}"
    return sql


def sources_card(items, note=None):
    """items: [(label, sql)]. Shows where numbers came from; admin/manager can re-run them."""
    return card("sources", items=[{"label": l, "sql": s} for l, s in items], note=note)


def refuse(code, message, suggestions=None):
    return card("refusal", code=code, message=message, suggestions=suggestions or [])


def clarify(question, options):
    return card("clarify", question=question, options=options)


def page_chart_card(d, idx=0):
    ch = d.get("charts") or []
    if len(ch) <= idx:
        return None
    c = ch[idx]
    money = any(re.search(r"₹|revenue|spend|cogs|profit|value", ds["label"], re.I) for ds in c["datasets"]) or re.search(r"revenue|spend|value|costs", c["title"], re.I)
    pct = re.search(r"%", c["title"] + "".join(ds["label"] for ds in c["datasets"]))
    return chart_card(c["type"], c["title"], c["labels"], c["datasets"], fmt="inr" if money else ("pct" if pct else "num"))


def table_card(title, columns, rows, page=None, filters=None):
    return card("table", title=title, columns=[{"key": k, "label": l, "fmt": f} for k, l, f in columns], rows=rows, page=page, filters=filters)


def confirm_card(user, op, title, lines, button, danger=False, form=None):
    tok = uuid.uuid4().hex[:12]
    PENDING[tok] = {"user": user["username"], "op": op, "ts": time.time()}
    return card("confirm", token=tok, title=title, lines=lines, button=button, danger=danger, form=form)


# ---------------- context ----------------
class Ctx:
    def __init__(self, user, page="dashboard", filters=None, trail=None):
        self.user, self.page, self.filters, self.trail = user, page or "dashboard", filters or {}, trail or []
        self.no_review = False


def period_filters(periods):
    if not periods:
        return {}
    return {"date_from": periods[0][0], "date_to": periods[0][1]}


def detect_metric(t):
    if re.search(r"\bunits?\b|quantity|volume", t):
        return "units"
    if re.search(r"\b(orders?|order count|number of orders)\b", t) and not re.search(r"revenue|sales value", t):
        return "orders"
    return "revenue"


PAGE_HINTS = [  # strong lexical signals (checked before retrieval)
    (r"\bagent review|review queue|(open|flagged|pending) (answer )?reviews?\b|flagged answers?|human[- ]in[- ]the[- ]loop|\bhitl\b|human[- ]verified|low[- ]confidence answers?", "review"),
    (r"implementation stack|tech(nology)? stack|\barchitecture\b|\bbuilt with\b", "stack"),
    (r"\bpurchase orders?\b|\bpos?\b|procurement", "procurement"),
    (r"\bapprovals?\b|change requests?", "approvals"),
    (r"\baudit\b|agent activity|activity log", "activity"),
    (r"\bshipments?\b|logistics|carriers?|deliver(y|ies)\b|in transit|delayed", "logistics"),
    (r"\bprofit|p&l|finance|expenses?|margin|cogs|cash ?flow", "finance"),
    (r"\bcustomers?\b|clients?", "customers"),
    (r"\bsuppliers?\b|vendors?", "suppliers"),
    (r"\binventory|stock|warehouse|reorder|products?\b|items?\b", "inventory"),
    (r"\bsales\b|\borders?\b|revenue by month|cancelled|returned", "sales"),
    (r"\banalytics|analysis|breakdown|group by|by region|by channel|by category", "analytics"),
    (r"\bevaluation|benchmark|test results|kpi results|how accurate (are you|is the agent)|run (the )?(eval|tests)", "evaluation"),
    (r"\bdashboard|home|overview", "dashboard"),
]


def detect_page(t, default=None):
    for rx, pid in PAGE_HINTS:
        if re.search(rx, t):
            return pid, 0.95
    hits = R.search_pages(t, 1)
    if hits and hits[0]["score"] > 0.12:
        return hits[0]["page"], hits[0]["score"]
    return default, 0


def build_filters(page, t, periods):
    meta = M.PAGE[page]
    keys = {f["key"] for f in meta["filters"]}
    f = {}
    if "date" in keys and periods:
        f.update(period_filters(periods))
    if "region" in keys:
        f["region"] = N.find_region(t)
    if "category" in keys:
        f["category"] = (N.find_option(t, M.EXP_CATS) if page == "finance" else N.find_category(t))
    if "channel" in keys:
        f["channel"] = N.find_option(t, M.CHANNELS)
    if "segment" in keys:
        f["segment"] = N.find_option(t, M.SEGMENTS)
    if "carrier" in keys:
        f["carrier"] = N.find_option(t, M.CARRIERS)
    if "warehouse" in keys:
        w = N.find_option(t, ["Bengaluru", "Mumbai", "Delhi"]) if re.search(r"warehouse|\bwh\b", t) else None
        f["warehouse"] = f"{w} WH" if w else None
    if "status" in keys or "stock_status" in keys:
        ent = {"sales": "sales_orders", "procurement": "purchase_orders", "logistics": "shipments", "approvals": "change_requests"}.get(page)
        if page == "inventory":
            f["stock_status"] = N.find_status(t, "products")
        elif page == "review":
            m = re.search(r"\b(open|pending|unreviewed|correct|wrong|incorrect)\b", t)
            f["status"] = {"open": "Open", "pending": "Open", "unreviewed": "Open", "correct": "Correct", "wrong": "Wrong", "incorrect": "Wrong"}[m.group(1)] if m else None
            f["source"] = "user" if re.search(r"flagged|by users?|thumbs", t) else "auto" if re.search(r"low[- ]confidence|auto", t) else None
        elif ent:
            f["status"] = N.find_status(t, ent)
    if "min_rating" in keys:
        m = re.search(r"rating (?:above|over|>=?|at least|more than)\s*(\d(?:\.\d)?)", t)
        if m:
            f["min_rating"] = m.group(1)
    if "supplier" in keys:
        s = N.find_supplier(t)
        f["supplier"] = s["name"] if s else None
    if "metric" in keys:
        f["metric"] = detect_metric(t)
        g = re.search(r"\bby (region|category|channel|segment|product)s?\b", t)
        f["group_by"] = g.group(1) if g else None
    if "q" in keys:
        if page in ("inventory", "sales"):
            p = N.find_product(t)
            f["q"] = p["name"] if p else None
        if page == "customers":
            c = N.find_customer(t)
            f["q"] = c["name"] if c else None
        if page == "suppliers":
            s = N.find_supplier(t)
            f["q"] = s["name"] if s else None
    return {k: v for k, v in f.items() if v}


def sort_for(page, t):
    s = N.find_sort(t)
    if not s:
        if re.search(r"highest|largest|most|top", t):
            col = {"sales": "amount", "procurement": "amount", "customers": "revenue", "suppliers": "rating", "inventory": "stock_value", "logistics": "delay_days"}.get(page)
            return f"{col}:desc" if col else None
        if re.search(r"lowest|least|smallest", t):
            col = {"sales": "amount", "customers": "revenue", "suppliers": "rating", "inventory": "days_left"}.get(page)
            return f"{col}:asc" if col else None
        return None
    key, d = s
    alias = {"amount": "amount", "date": "order_date", "price": "unit_price", "rating": "rating", "revenue": "revenue", "stock": "stock", "days_left": "days_left", "delay": "delay_days", "spend": "spend_12m"}
    return f"{alias.get(key, key)}:{d}"


# ---------------- router ----------------
def page_exists(target):
    t = target.strip()
    if t in ("this", "that", "the", "current", "previous", "last", "next", "same"):
        return True
    for rx, _ in PAGE_HINTS:
        if re.search(rx, t):
            return True
    hits = R.search_pages(t, 1)
    return bool(hits and hits[0]["score"] > 0.25)


ACRONYMS = {"aov": "average order value", "cogs": "cogs", "opex": "operating expenses", "gm": "gross margin", "p95": "agent p95 latency", "otd": "order fulfillment rate", "otif": "order fulfillment rate", "dio": "days of cover"}


def kpi_lookup(text):
    text = text.lower().strip(" ?.")
    text = " ".join(ACRONYMS.get(w, w) for w in text.split())
    best, score = None, 0
    for name, page, formula, key in M.KPI_DICTIONARY:
        n = name.lower()
        words = set(re.findall(r"[a-z0-9]+", n)) - {"of", "the", "rate", "%"}
        tw = set(re.findall(r"[a-z0-9]+", text))
        sc = len(words & tw) / (len(words) or 1) + (1 if n in text or text in n else 0)
        if sc > score:
            best, score = (name, page, formula, key), sc
    return best if score >= 0.6 else None


EXPLICIT_NAV = r"^(open|go to|goto|take me to|navigate to|switch to|jump to|bring up|pull up|show me the \w+ page)\b"


UNKNOWN_PLACES = ["kerala", "punjab", "rajasthan", "goa", "bihar", "odisha", "orissa", "assam", "haryana", "uttar pradesh", "madhya pradesh", "andhra pradesh", "andhra",
                  "jharkhand", "chhattisgarh", "uttarakhand", "himachal", "jammu", "kashmir", "lucknow", "jaipur", "kochi", "cochin", "bhopal", "patna", "indore", "chandigarh",
                  "noida", "gurgaon", "gurugram", "vizag", "visakhapatnam", "bhubaneswar", "guwahati", "ranchi", "dehradun", "srinagar", "amritsar", "ludhiana", "trivandrum", "thiruvananthapuram",
                  "usa", "europe", "china", "dubai", "london", "singapore"]
ANALYTIC = {"navigate", "why", "compare_periods", "top", "trend", "delays", "finance", "stockout"}
_DATA_START = {}


def data_start():
    if "d" not in _DATA_START:
        from db import q1
        _DATA_START["d"] = q1("SELECT MIN(order_date) d FROM sales_orders")["d"]
    return _DATA_START["d"]


def validate(plan):
    """Validator: checks values and dates against the data before anything runs. Returns a refusal plan or None."""
    if plan["intent"] not in ANALYTIC:
        return None
    t = plan["t"]
    for place in UNKNOWN_PLACES:
        if re.search(rf"\b{place}\b", t) and not N.find_region(t):
            return {"intent": "refuse", "t": t, "slots": {"code": "VALUE_NOT_ALLOWED", "value": place.title(), "periods": []}}
    for (a, b, label) in plan["slots"].get("periods") or []:
        if b < data_start() or a > today().isoformat():
            return {"intent": "refuse", "t": t, "slots": {"code": "DATE_OUT_OF_RANGE", "value": label, "periods": []}}
        if a > b:
            return {"intent": "refuse", "t": t, "slots": {"code": "INVALID_DATE_RANGE", "value": label, "periods": []}}
    return None


def route(query, ctx, use_classifier=True):
    plan = route_core(query, ctx, use_classifier)
    return validate(plan) or plan


def route_core(query, ctx, use_classifier=True):
    """Stage 1: rules (precise, extract slots). Stage 2: semantic classifier when rules only matched a page or nothing."""
    plan = route_rules(query, ctx)
    if not use_classifier or plan["intent"] not in ("navigate", "unknown") or re.match(EXPLICIT_NAV, plan["t"]):
        return plan
    c = intents.CLF.predict(plan["t"])
    if plan["intent"] == "navigate" and (build_filters(plan["slots"]["page"], plan["t"], []) or N.find_region(plan["t"])):
        # explicit filter values (status, region, category...) usually mean "show me that view"; only a confident classifier overrides
        if re.match(r"(show|list|display|view|see)\b", plan["t"]) or c["margin"] < 0.25:
            return plan
    if c["intent"] != "navigate" and c["score"] >= 0.25 and c["margin"] >= 0.04:
        p2 = route_rules(intents.rewrite(c["intent"], plan["t"]), ctx)
        if p2["intent"] not in ("navigate", "unknown"):
            p2["classified"] = c
            return p2
    return plan


def route_rules(query, ctx):
    t = N.norm(query.strip())
    periods = N.parse_periods(t)
    s = {"periods": periods}

    def R_(intent, **kw):
        return {"intent": intent, "t": t, "slots": {**s, **kw}}

    if re.search(r"ignore (all |any |your |previous |prior |the |these )*(rules|instructions|guardrails)|system prompt|jailbreak|developer mode|pretend (you|to be)|act as (an? )?(admin|root|developer)|bypass|disable (the )?(guard|safety|validator)", t):
        return R_("refuse", code="PROMPT_INJECTION")
    if re.search(r"\b(drop|truncate|alter)\s+table\b|\bdelete\s+from\b|\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bgrant\b.*\bto\b", t):
        return R_("refuse", code="WRITE_NOT_ALLOWED")
    if re.search(r"\b(export|download|save|print|convert)\b.*\b(pdf|csv|summary|report|page|screen|chat|conversation|answer|this|it)\b|\b(to|as|in) (a )?(pdf|csv)\b", t) and not re.search(r"\bsql\b", t):
        return R_("export", fmt="csv" if re.search(r"\b(csv|excel|spreadsheet)\b", t) else "pdf",
                  scope="chat" if re.search(r"\b(chat|conversation|answers?|response)\b", t) else "page")
    if re.search(r"implementation stack|tech(nology)? stack|\barchitecture\b|how (is|was) (this|the app|bizpilot|it) (built|made|implemented)|what (technolog|tools|frameworks?)|built with|\bstack\b", t) and not re.search(r"\b(stock|inventory)\b", t):
        return R_("stack")
    if re.fullmatch(r"(thanks|thank you|thank u|thx|ty|ok|okay|k|great|cool|nice|awesome|perfect|good job|well done|bye|goodbye|good (morning|afternoon|evening|night))[!. ]*( (bizpilot|agent))?[!. ]*", t):
        return R_("smalltalk")
    if re.search(r"^(who|what) are you|your name|are you (an? )?(ai|bot|human)", t):
        return R_("meta", kind="identity")
    if re.search(r"what can('|no)?t you do|your limitations|what (are|is) (your|the) limit", t):
        return R_("meta", kind="limits")
    if re.search(r"(what|which) filters|filters (can|are) (i|available)|what can i filter", t):
        return R_("meta", kind="filters")
    if re.search(r"\bmy (role|permissions|access)\b|what can i (do|see|access|change)|am i (allowed|able)", t):
        return R_("meta", kind="role")
    if re.search(r"how did you (get|calculate|compute|find|arrive)|explain (your|the|that) (last )?(answer|number|result)|show (me )?(the )?(sql|sources?|query|trace|working)|where did (that|this|the) (number|data|figure)|how (was|is) (that|this) calculated|why should i trust", t):
        return R_("explain_last")
    m = re.search(r"(?:what (?:does|is|do) (?:an? |the )?(.+?) (?:mean|stand for|measure)|(?:define|definition of|formula (?:for|of)|how is) (?:an? |the )?(.+?)(?: calculated| computed| defined)?)\??$", t)
    if m and not re.search(r"\b(page|screen|on this|here|my role)\b", t):
        k = kpi_lookup(m.group(1) or m.group(2))
        if k:
            return R_("meta", kind="kpi", kpi=k)
    m = re.search(r"(explain|describe|what does|what is shown (in|on)|tell me about) (the |this )?(.+?) (chart|widget|graph|kpi|card|table|donut|panel)", t)
    if m:
        return R_("widget", name=m.group(4))
    if re.search(r"\b(insights?|anything (unusual|important|i should know)|what should i (know|look at)|highlights|anomal|red flags|what changed|agent noticed|any alerts)\b", t):
        return R_("insights")
    if re.fullmatch(r"(compare|sort( it| this)?|filter( it| this)?|show me the (report|data)|open (the )?report|the report|analy[sz]e|show data|report|open|show|chart|graph|plot)[?.! ]*", t):
        return R_("clarify", what=t.split()[0])
    m = re.match(r"(?:please )?(?:open|go to|goto|take me to|navigate to|switch to|show(?: me)?)\s+(?:the |my )?([a-z&][a-z& ]{1,30}?)\s+(page|screen|module|section|tab|portal|dashboard)\b", t)
    if m and not page_exists(m.group(1)):
        return R_("refuse", code="PAGE_NOT_FOUND", target=m.group(1))
    m = re.match(r"(?is)\s*(?:sql\s*:?|run sql|query\s*:)\s*(.+)$", query) or re.match(r"(?is)\s*((?:select|with)\b.+\bfrom\b.+)$", query)
    if m:
        return R_("sql", sql=m.group(1).strip())
    if re.search(r"\b(dataset|database|data ?base|schema|data dictionary|kpi (list|dictionary|definitions)|(list|show|all)( all)? (the )?kpis|what data|which tables|tables? (in|of) (the )?(db|data)|how many (rows|records))\b", t) \
            or re.match(r"how many (sales orders|orders|purchase orders|pos|shipments|customers|suppliers|products|expenses|change requests|users)\b", t):
        return R_("dataset")
    m = re.match(r"(?:please |pls |kindly |can you |could you )?(approve|accept|clear|reject)\b(?!.*\d)", t)
    if m and (re.search(r"\b(all|the|every|pending|these|those|them|everything|requests?)\b", t)) and not re.search(r"\b(show|list|how many)\b", t):
        return R_("review_all", decision="reject" if m.group(1) in ("reject", "decline") else "approve")

    if re.fullmatch(r"(hi|hello|hey|help( me)?|what can (you|this agent|it|the agent) do\??|how can you help( me)?\??|hi there|menu|commands)[!. ]*", t):
        return R_("help")
    if re.search(r"(this|current) (page|screen|view)|where am i|what page|what am i (looking at|seeing)|(summary|overview) of (this|the) (screen|page)|explain (this|the) (page|screen)|summari[sz]e (this|the) (page|screen)|key information|what('s| is) (on|here)", t):
        return R_("current_page")
    if re.fullmatch(r"(go )?back|previous page|go to previous page|undo navigation", t):
        return R_("go_back")
    m = re.search(r"\b(approve|reject|decline)\b.*?(?:request|cr|#)?\s*#?(\d+)\b", t)
    if m and not re.search(r"\bshow|list\b", t):
        note = re.search(r"\b(?:because|reason|note)\b:?\s*(.+)$", t)
        return R_("review", decision="approve" if m.group(1) == "approve" else "reject", req_id=int(m.group(2)), note=note.group(1) if note else "")
    if re.search(r"(pending|my|awaiting)\s+(change\s+)?(requests?|approvals?)|requests? (pending|awaiting)|summari[sz]e .*requests|what needs (my )?approval|status of my request", t):
        return R_("requests", mine=bool(re.search(r"\bmy\b", t)))
    days = re.search(r"(?:next|within|in)\s+(\d+)\s*days?", t)
    wants_po = bool(re.search(r"\b(create|draft|raise|generate|prepare|make|place)\b.*\b(po|pos|purchase orders?)\b", t)) and not re.match(r"(show|list|view|display|open|see)\b", t)
    if re.search(r"run(ning)? out|stock ?out|will (be )?out|likely to|days? of cover|forecast.*stock|replenish", t) or (wants_po and re.search(r"low stock|out of stock|at risk|reorder", t)):
        return R_("stockout", days=int(days.group(1)) if days else 14, with_po=wants_po, category=N.find_category(t))
    if wants_po or re.search(r"\b(new|raise a|create a|create an?)\s+(po|purchase order)\b", t) or (re.match(r"(order|buy|procure|purchase)\s+\d+", t) and N.find_product(t)):
        return R_("create_po", product=N.find_product(t), supplier=N.find_supplier(t))
    if re.match(r"(please )?(change|update|set|modify|edit|increase|decrease|raise|lower|reduce|mark|correct|bump|adjust|revise)\b", t) and not re.search(r"\b(filter|date range|sort)\b", t):
        return R_("update")
    if re.match(r"(please )?(delete|remove|deactivate|archive|get rid of|discard)\b", t):
        return R_("delete")
    m = re.match(r"(please )?(add|create|new|register|onboard)\s+(a |an |new )*(supplier|vendor|product|item|customer|client|expense)\b", t)
    if m:
        ent = {"supplier": "suppliers", "vendor": "suppliers", "product": "products", "item": "products", "customer": "customers", "client": "customers", "expense": "expenses"}[m.group(4)]
        return R_("create", entity=ent)
    if re.search(r"(compare|best|cheapest|which|rank|recommend).*(suppliers?|vendors?)|(suppliers?|vendors?).*(pric|compare|cheapest|best)", t) and not re.search(r"\btop \d+ suppliers by (spend|rating)", t):
        n = re.search(r"top (\d+)", t)
        return R_("compare_suppliers", product=N.find_product(t), category=N.find_category(t), n=int(n.group(1)) if n else 5)
    if re.search(r"\b(why|reason|root cause|what caused|explain the (drop|dip|increase|decline|change)|what happened)\b", t):
        if re.search(r"expense|cost|spend|logistics cost|opex", t):
            return R_("expense_why", category=N.find_option(t, M.EXP_CATS))
        return R_("why", metric=detect_metric(t), region=N.find_region(t), category=N.find_category(t))
    if re.search(r"\b(vs\.?|versus|against|compared (to|with)|compare|mom|yoy|month (over|on) month|year (over|on) year)\b", t):
        return R_("compare_periods", metric=detect_metric(t), region=N.find_region(t), category=N.find_category(t), channel=N.find_option(t, M.CHANNELS))
    m = re.search(r"\b(top|bottom|best|worst|highest|lowest)\s*(\d+)?\s*(selling\s+)?(products?|items?|customers?|clients?|suppliers?|vendors?|regions?|states?|categories|category|channels?|segments?)", t)
    if m:
        kind = {"product": "products", "item": "products", "customer": "customers", "client": "customers", "supplier": "suppliers", "vendor": "suppliers",
                "region": "regions", "state": "regions", "categorie": "categories", "category": "categories", "channel": "channels", "segment": "segments"}[m.group(4).rstrip("s") if m.group(4) != "categories" else "categorie"]
        metric = "units" if re.search(r"units?|quantity|volume", t) else ("orders" if re.search(r"by orders|order count", t) else ("rating" if "rating" in t else "revenue"))
        return R_("top", kind=kind, n=int(m.group(2) or 5), asc=m.group(1) in ("bottom", "worst", "lowest"), metric=metric, region=N.find_region(t), category=N.find_category(t))
    if re.search(r"\b(trend|analysis|analy[sz]e|forecast|growth|performance|how (are|is|did) (we|sales|revenue))\b", t) and not re.search(r"\b(open|go to|navigate)\b", t):
        return R_("trend", metric=detect_metric(t), region=N.find_region(t), category=N.find_category(t), group=(re.search(r"\bby (region|category|channel|segment|product)", t) or [None, None])[1])
    if re.search(r"\b(delay(ed|s)?|late)\b.*\b(shipments?|deliver|orders?|carriers?)|\b(shipments?|carriers?)\b.*\b(delay|late)|which carrier", t):
        return R_("delays", region=N.find_region(t), carrier=N.find_option(t, M.CARRIERS))
    if re.search(r"\b(net profit|profit|margin|p&l|cash ?flow|expense breakdown|expenses?|cogs|how much (did we|we) (make|earn|spend))\b", t) and not re.search(r"\b(open|go to|navigate)\b", t):
        return R_("finance")
    if re.match(r"(find|search|look ?up|lookup|look for|locate)\b", t) or (re.match(r"where is\b", t) and (N.find_code(t) or N.find_product(t) or N.find_supplier(t) or N.find_customer(t))):
        return R_("search", term=re.sub(r"^(find|search( for)?|look ?up|lookup|look for|where is|locate)\s+", "", t))
    page, conf = detect_page(t)
    if page:
        return R_("navigate", page=page, conf=conf)
    return R_("unknown")


# ---------------- handlers ----------------
def h_help(ctx, sl):
    yield say("**BizPilot Agent.** I navigate, filter, analyze and act across all 11 pages. Role: **" + ctx.user["role"] + "**.\n\n"
              "- Navigate: *open Karnataka sales last quarter*\n- Analyze: *why did revenue drop in Maharashtra?*\n- Forecast: *products likely to run out in 14 days*\n"
              "- Act: *create purchase order for 500 Steel Rod*, *change price of Copper Wire to 430*\n- Govern: *show pending requests*, *approve request 1*\n- Ask: *what is on this page?*")
    yield card("chips", items=M.PAGE.get(ctx.page, M.PAGE["dashboard"])["suggestions"])


def summarize_page(page, filters):
    meta = M.PAGE[page]
    d = P.page_data(page, filters)
    lines = [f"**{meta['title']}** (`{page}`): {meta['description']}"]
    if filters:
        lines.append("Filters: " + ", ".join(f"{k}={v}" for k, v in filters.items()))
    lines.append("KPIs: " + "; ".join(f"{k['label']} {fmtv(k['value'], k['fmt'])}" + (f" ({sign(k['delta'])})" if k.get("delta") is not None else "") for k in d["kpis"]))
    lines.append("Widgets: " + ", ".join(w[2] for w in meta["widgets"]))
    return d, "\n".join(lines)


def h_current_page(ctx, sl):
    yield step(f"Reading page context `{ctx.page}`")
    d, _ = summarize_page(ctx.page, ctx.filters)
    meta = M.PAGE[ctx.page]
    yield step("Summarizing KPIs and grid")
    kp = [{"label": k["label"], "value": fmtv(k["value"], k["fmt"]), "delta": k.get("delta")} for k in d["kpis"]]
    tb = d.get("table") or {}
    insight = []
    for k in d["kpis"]:
        if k.get("delta") is not None and abs(k["delta"]) >= 5:
            insight.append(f"{k['label']} {'up' if k['delta'] > 0 else 'down'} {abs(k['delta']):.1f}% vs previous period.")
    if ctx.page in ("dashboard", "inventory"):
        so = P.stockout(14)
        if so:
            insight.append(f"{len(so)} items run out within 14 days; worst {so[0]['name']} ({so[0]['days_left']} d).")
    if ctx.page == "approvals":
        pend = [r for r in tb.get("rows", []) if r["status"] == "Pending"]
        insight.append(f"{len(pend)} requests pending admin review.")
    fl = ", ".join(f"{k}: {v}" for k, v in ctx.filters.items()) or "none (defaults)"
    yield say(f"You are on **{meta['title']}** — {meta['description']}\n\nFilters: {fl}. Grid **{tb.get('title', '')}** has {tb.get('total', 0)} rows.\n\n" +
              ("**Key points:** " + " ".join(insight) if insight else ""))
    yield card("kpis", items=kp)
    pc = page_chart_card(d)
    if pc:
        yield pc
    yield card("chips", items=meta["suggestions"])


def h_go_back(ctx, sl):
    tr = [x for x in ctx.trail if x.get("page") != ctx.page]
    if not tr:
        yield say("No previous page in this session."); return
    last = tr[-1]
    yield nav(last["page"], last.get("filters"))
    yield say(f"Back to **{M.PAGE[last['page']]['title']}**.")


def h_navigate(ctx, sl, page=None):
    page = page or sl["page"]
    t = sl.get("t") or ""
    yield step(f"Matched page `{page}`")
    f = sl["force_filters"] if "force_filters" in sl else build_filters(page, t, sl["periods"])
    srt = sl.get("force_sort") or sort_for(page, t)
    keys = {x["key"] for x in M.PAGE[page]["filters"]}
    reg = N.find_region(t) if "force_filters" not in sl else None
    if reg and "region" not in keys:
        alt = [p["title"] for p in M.PAGES if any(x["key"] == "region" for x in p["filters"])]
        yield refuse("FILTER_NOT_ON_PAGE", f"{M.PAGE[page]['title']} has no region filter, so “{reg}” was not applied. Pages with a region filter: {', '.join(alt)}.",
                     [f"Show {reg} sales", f"Show {reg} shipments last 30 days", f"enterprise customers in {reg}"])
    if sl.get("note"):
        yield step(sl["note"])
    yield nav(page, f, srt)
    d = P.page_data(page, f, srt)
    k = d["kpis"]
    parts = ", ".join(f"{x['label']} **{fmtv(x['value'], x['fmt'])}**" + (f" ({sign(x['delta'])})" if x.get("delta") is not None else "") for x in k[:4])
    fl = (" · " + ", ".join(f"{a}: {b}" for a, b in f.items())) if f else ""
    yield say(f"Opened **{M.PAGE[page]['title']}**{fl}{' · sort ' + srt if srt else ''}. {(d.get('table') or {}).get('total', 0)} rows." + (f"\n\n_{sl['note']}_" if sl.get("note") else ""))
    if k:
        yield card("kpis", items=[{"label": x["label"], "value": fmtv(x["value"], x["fmt"]), "delta": x.get("delta")} for x in k[:4]])
    pc = page_chart_card(d)
    if pc:
        yield pc


def h_requests(ctx, sl):
    mine = sl.get("mine") or not S.can(ctx.user, "approve")
    rows = S.list_requests(ctx.user, status=None if mine else "Pending", mine=mine)
    yield step("Fetching change requests")
    yield nav("approvals", {"status": None if mine else "Pending"})
    if not rows:
        yield say("No pending requests." if not mine else "You have no change requests."); return
    for r in rows:
        ch = json.loads(r["changes"] or "{}")
        r["summary"] = "Delete" if r["action"] == "delete" else ", ".join(f"{k}: {v['old']}→{v['new']}" for k, v in ch.items())
    pend = [r for r in rows if r["status"] == "Pending"]
    head = f"**{len(pend)} pending** request(s)." if not mine else f"You have {len(rows)} request(s): {len(pend)} pending."
    yield say(head + (" Say *approve request N* or *reject request N because …*." if S.can(ctx.user, "approve") and pend else ""))
    st = {}
    for r in rows:
        st[r["status"]] = st.get(r["status"], 0) + 1
    if len(st) > 1:
        yield chart_card("doughnut", "Requests by status", list(st), [{"label": "Requests", "data": list(st.values())}], fmt="int")
    yield table_card("Change requests", [("id", "#", "int"), ("record_label", "Record", "text"), ("summary", "Change", "text"), ("requested_by", "By", "text"), ("status", "Status", "status")], rows[:10], "approvals")
    if S.can(ctx.user, "approve") and pend:
        yield card("chips", items=["Approve all pending requests", f"Approve request {pend[0]['id']}", f"Reject request {pend[0]['id']} because not justified"])


def h_review(ctx, sl):
    if not S.can(ctx.user, "approve"):
        yield from not_admin(ctx)
        return
    from db import q1
    cr = q1("SELECT * FROM change_requests WHERE id=?", (sl["req_id"],))
    if not cr:
        yield say(f"Request #{sl['req_id']} not found.")
        yield from h_requests(ctx, {"mine": False})
        return
    if cr["status"] != "Pending":
        yield nav("approvals", {})
        yield say(f"Request #{cr['id']} already **{cr['status']}**" + (f" by {cr['reviewed_by']}." if cr["reviewed_by"] else "."))
        return
    yield step(f"{sl['decision'].title()} request #{cr['id']} ({cr['record_label']})")
    res = S.review_request(ctx.user, cr["id"], sl["decision"], sl.get("note", ""), via="agent")
    N.invalidate(); R.build(); spell.invalidate()
    ch = json.loads(cr["changes"] or "{}")
    what = "delete" if cr["action"] == "delete" else ", ".join(f"{k}: {v['old']} → {v['new']}" for k, v in ch.items())
    rec = res.get("record")
    yield say(f"✅ Request **#{cr['id']}** {'approved and applied' if sl['decision'] == 'approve' else 'rejected'}: {cr['record_label']} ({what}). {cr['requested_by']} has been notified.")
    if rec and not rec["deleted"]:
        yield card("record", **{k: v for k, v in rec.items() if k != "type"})
        yield nav(rec["page"], rec["filters"])
    else:
        yield nav("approvals", {})


def not_admin(ctx):
    rows = S.list_requests(ctx.user, None, True)
    pend = [r for r in rows if r["status"] == "Pending"]
    auto = [r for r in rows if r["reviewed_by"] == "auto-policy"]
    yield say(f"Only an admin can approve. Your role: **{ctx.user['role']}**.\n\nLow-risk changes you request are **auto-approved by policy** instantly "
              f"(e.g. price change ≤ 10%, stock adjustment ≤ 20%, contact details). You have {len(pend)} pending and {len(auto)} auto-approved request(s).")
    if rows:
        yield from h_requests(ctx, {"mine": True})


def h_review_all(ctx, sl):
    dec = sl.get("decision", "approve")
    if not S.can(ctx.user, "approve"):
        yield from not_admin(ctx)
        return
    rows = S.list_requests(ctx.user, "Pending")
    if not rows:
        yield say("Nothing pending. All requests are already reviewed.")
        return
    yield step(f"{'Approving' if dec == 'approve' else 'Rejecting'} {len(rows)} pending request(s)")
    res = S.review_many(ctx.user, dec, [r["id"] for r in rows], "bulk via agent", via="agent")
    N.invalidate(); R.build(); spell.invalidate()
    yield nav("approvals", {})
    lines = [f"- #{r['id']} {r['record_label']} ({r['action']}: {S.change_text(r)}) by {r['requested_by']}" for r in rows if r["id"] in res["done"]]
    yield say(f"✅ {'Approved and applied' if dec == 'approve' else 'Rejected'} **{len(res['done'])}** request(s):\n" + "\n".join(lines)
              + (f"\n\n⚠ {len(res['failed'])} failed: " + "; ".join(f"#{i}: {e}" for i, e in res["failed"]) if res["failed"] else ""))
    from db import q
    if dec == "approve":
        for r in [r for r in rows if r["id"] in res["done"] and r["action"] == "update" and r["entity"] in M.ENTITIES][:4]:
            rec = S.record_view(r["entity"], r["record_id"], json.loads(r["changes"] or "{}"))
            if rec and not rec["deleted"]:
                yield card("record", **{k: v for k, v in rec.items() if k != "type"})
    st = {r["status"]: r["n"] for r in q("SELECT status, COUNT(*) n FROM change_requests GROUP BY status")}
    yield chart_card("doughnut", "All requests by status", list(st), [{"label": "Requests", "data": list(st.values())}], fmt="int")
    yield {"t": "action", "action": "refresh"}


def h_dataset(ctx, sl):
    t = sl["t"]
    yield step("Reading database catalog")
    cat = DS.catalog()
    alias = {"sales orders": "sales_orders", "orders": "sales_orders", "purchase orders": "purchase_orders", "pos": "purchase_orders", "shipments": "shipments", "customers": "customers",
             "suppliers": "suppliers", "products": "products", "expenses": "expenses", "change requests": "change_requests", "users": "users"}
    m = re.match(r"how many (sales orders|orders|purchase orders|pos|shipments|customers|suppliers|products|expenses|change requests|users)\b", t)
    if m:
        tb = alias[m.group(1)]
        info = next(c for c in cat if c["table"] == tb)
        from db import q
        stcol = "status" if tb in ("sales_orders", "purchase_orders", "shipments", "change_requests") else ("category" if tb in ("products", "suppliers", "expenses") else ("segment" if tb == "customers" else "role"))
        rows = q(f"SELECT {stcol} k, COUNT(*) n FROM {tb} GROUP BY {stcol} ORDER BY n DESC")
        span = f", {info['span'][0]} → {info['span'][1]}" if info["span"] else ""
        yield say(f"**{info['rows']:,}** rows in `{tb}`{span}. {info['description']}.")
        yield chart_card("bar", f"{tb} by {stcol}", [str(r["k"]) for r in rows], [{"label": "Rows", "data": [r["n"] for r in rows]}], fmt="int", horizontal=True)
        yield nav("data", {})
        return
    if re.search(r"kpi", t):
        kd = DS.kpi_dictionary()
        yield say(f"**{len(kd)} KPIs** defined. Formulas and live values below; full list on Data & KPIs.")
        yield card("table", title="KPI dictionary", columns=[{"key": "kpi", "label": "KPI", "fmt": "text"}, {"key": "value", "label": "Value", "fmt": "auto"}, {"key": "formula", "label": "Formula", "fmt": "text"}], rows=kd, page="data", filters=None)
        yield nav("data", {}, None, "grid_kpis")
        return
    total = sum(c["rows"] for c in cat)
    so = next(c for c in cat if c["table"] == "sales_orders")
    yield say(f"**{len(cat)} tables, {total:,} rows.** Sales history {so['span'][0]} → {so['span'][1]} (~25 months). Synthetic Indian supply-chain business: "
              f"28 products, 15 suppliers, 80 customers, 7 regions, 5 carriers. Every table is browsable and admin/manager can run read-only SQL "
              f"(e.g. *sql: select region, sum(amount) from sales_orders group by region*).")
    yield chart_card("bar", "Rows per table", [c["table"] for c in cat], [{"label": "Rows", "data": [c["rows"] for c in cat]}], fmt="int", horizontal=True)
    yield card("table", title="Tables", columns=[{"key": "table", "label": "Table", "fmt": "text"}, {"key": "rows", "label": "Rows", "fmt": "int"}, {"key": "description", "label": "Description", "fmt": "text"}],
               rows=[{"table": c["table"], "rows": c["rows"], "description": c["description"]} for c in cat], page="data", filters=None)
    yield nav("data", {})


def h_sql(ctx, sl):
    yield step("Validating read-only query")
    try:
        r = DS.run_sql(ctx.user, sl["sql"])
    except (PermissionError, ValueError) as e:
        yield say(f"⛔ {e}")
        return
    yield step(f"Executed in {r['ms']} ms")
    cols, rows = r["columns"], r["rows"]
    yield say(f"**{len(rows)}{'+' if r['truncated'] else ''} row(s)**, {len(cols)} column(s).")
    if rows:
        yield card("table", title="Query result", columns=[{"key": c, "label": c, "fmt": "auto"} for c in cols], rows=rows[:200], page=None, filters=None)
        num = [c for c in cols[1:] if all(isinstance(x.get(c), (int, float)) or x.get(c) is None for x in rows)]
        if len(cols) >= 2 and num and len(rows) <= 40:
            first = [str(x[cols[0]]) for x in rows]
            kind = "line" if all(re.match(r"\d{4}-\d{2}", v) for v in first) else "bar"
            yield chart_card(kind, f"{num[0]} by {cols[0]}", first, [{"label": c, "data": [x[c] for x in rows]} for c in num[:3]], fmt="num", horizontal=kind == "bar" and len(rows) > 6)


def h_stockout(ctx, sl):
    days = sl["days"]
    yield step("Reading inventory levels")
    yield step("Computing 90-day demand velocity")
    rows = P.stockout(days, sl.get("category"))
    yield step(f"Forecasting stock-outs within {days} days")
    yield nav("inventory", {"category": sl.get("category")}, "days_left:asc", "grid_products")
    if not rows:
        yield say(f"No items run out within {days} days."); return
    worst = rows[0]
    yield say(f"**{len(rows)} items** run out within {days} days. Most urgent: **{worst['name']}** — {worst['stock']} {worst['unit']} left, "
              f"~{worst['daily_demand']}/day, **{worst['days_left']} days** of cover.")
    yield chart_card("bar", "Days of cover left", [r["name"] for r in rows], [{"label": "Days left", "data": [r["days_left"] for r in rows], "colors": sev_colors([r["days_left"] for r in rows], 10, 5)}],
                     fmt="days", horizontal=True)
    yield table_card(f"Stock-out risk (≤{days} days)", [("sku", "SKU", "text"), ("name", "Product", "text"), ("stock", "Stock", "int"), ("daily_demand", "Per day", "num"),
                                                        ("days_left", "Days left", "days"), ("open_po_qty", "Open PO", "int"), ("suggested_qty", "Suggest", "int")], rows, "inventory")
    if not sl.get("with_po"):
        yield card("chips", items=["Create purchase orders for these items", f"Compare suppliers for {worst['name']}"])
        return
    if not S.can(ctx.user, "create"):
        yield say("Your role is read-only. Cannot draft POs."); return
    yield step("Scoring suppliers: price 40%, rating 25%, on-time 20%, lead time 15%")
    drafts, lines = [], []
    for r in rows:
        if r["suggested_qty"] <= 0:
            continue
        opts = P.supplier_options(r["id"])
        if not opts:
            continue
        b = opts[0]
        drafts.append({"supplier_id": b["supplier_id"], "product_id": r["id"], "qty": r["suggested_qty"], "unit_cost": b["price"], "status": "Draft",
                       "notes": f"Agent draft: {r['days_left']}d cover"})
        lines.append(f"{r['name']}: {r['suggested_qty']} {r['unit']} from {b['name']} @ ₹{b['price']:,.2f} (score {b['score']}, {b['lead_time_days']}d lead) = {inr(r['suggested_qty'] * b['price'])}")
    if not drafts:
        yield say("All at-risk items already covered by open POs."); return
    yield step("Preparing purchase order drafts")
    total = sum(d["qty"] * d["unit_cost"] for d in drafts)
    yield confirm_card(ctx.user, {"kind": "bulk_create", "entity": "purchase_orders", "items": drafts}, f"Create {len(drafts)} PO drafts · {inr(total)}",
                       lines, "Create drafts")
    yield say("Drafts ready for review. Drafts need admin approval before ordering." if ctx.user["role"] != "admin" else "Drafts ready. Confirm to create.")


def h_create_po(ctx, sl):
    if not S.can(ctx.user, "create"):
        yield say("Your role is read-only."); return
    t = sl["t"]
    prod = sl.get("product")
    if not prod:
        yield say("Which product? Example: *create purchase order for 500 Steel Rod*."); return
    yield step(f"Resolved product {prod['code']} {prod['name']}")
    opts = P.supplier_options(prod["id"])
    yield step(f"Ranking {len(opts)} suppliers")
    sup = None
    if sl.get("supplier"):
        sup = next((o for o in opts if o["supplier_id"] == sl["supplier"]["id"]), None)
    sup = sup or (opts[0] if opts else None)
    if not sup:
        yield say("No supplier carries this product."); return
    nums = [n for n in N.find_numbers(re.sub(r"\b(po|so|sup|sku)-?\d+", "", t)) if n >= 1]
    so = next((r for r in P.product_rows() if r["id"] == prod["id"]), None)
    qty = int(nums[0]) if nums else max(10, int((so["daily_demand"] if so else 1) * 45 - (so["stock"] if so else 0)))
    data = {"supplier_id": sup["supplier_id"], "product_id": prod["id"], "qty": qty, "unit_cost": sup["price"], "status": "Draft", "notes": "Created via agent"}
    yield nav("procurement", {"status": "Draft"})
    yield say(f"Best supplier for **{prod['name']}**: **{sup['name']}** (₹{sup['price']:,.2f}, rating {sup['rating']}, {sup['lead_time_days']}d lead, score {sup['score']}).")
    top5 = opts[:5]
    yield chart_card("bar", f"Supplier score for {prod['name']}", [o["name"] for o in top5], [{"label": "Score", "data": [o["score"] for o in top5],
                     "colors": ["#2563eb" if o["supplier_id"] == sup["supplier_id"] else "#94a3b8" for o in top5]}], fmt="num", horizontal=True)
    yield confirm_card(ctx.user, {"kind": "create", "entity": "purchase_orders", "data": data}, f"Create PO: {qty} × {prod['name']}",
                       [f"Supplier: {sup['name']}", f"Unit cost: ₹{sup['price']:,.2f}", f"Total: {inr(qty * sup['price'])}", f"Expected in {sup['lead_time_days']} days", "Status: Draft"],
                       "Create PO", form={"entity": "purchase_orders", "values": data})


FIELD_MAP = [
    (r"selling price|sale price|\bprice\b|\bmrp\b", {"products": "unit_price", "sales_orders": "unit_price", "purchase_orders": "unit_cost"}),
    (r"cost price|unit cost|\bcost\b", {"products": "cost_price", "purchase_orders": "unit_cost"}),
    (r"reorder( level| point)?", {"products": "reorder_level"}),
    (r"\bstock\b|on hand|inventory", {"products": "stock"}),
    (r"\bstatus\b|\bas (delivered|shipped|approved|received|cancelled|pending|draft|processing|returned|delayed)", {"purchase_orders": "status", "sales_orders": "status", "shipments": "status"}),
    (r"\brating\b", {"suppliers": "rating"}),
    (r"lead ?time", {"suppliers": "lead_time_days"}),
    (r"on[- ]time", {"suppliers": "on_time_rate"}),
    (r"\b(qty|quantity|units)\b", {"purchase_orders": "qty", "sales_orders": "qty"}),
    (r"\bemail\b", {"suppliers": "email", "customers": "email"}),
    (r"\bphone\b", {"suppliers": "phone"}),
    (r"\bcity\b", {"suppliers": "city", "customers": "city"}),
    (r"\bcategory\b", {"products": "category", "suppliers": "category"}),
    (r"\bwarehouse\b", {"products": "warehouse"}),
    (r"\bsegment\b", {"customers": "segment"}),
    (r"\bcarrier\b", {"shipments": "carrier"}),
    (r"\beta\b", {"shipments": "eta"}),
    (r"\bname\b", {"products": "name", "suppliers": "name", "customers": "name"}),
]


def resolve_record(t, prefer=None):
    c = N.find_code(t)
    if c:
        r = S.find_record(c[0], c[1])
        return (c[0], r) if r else (c[0], None)
    m = re.search(r"\b([a-z]{2}-\d{3})\b", t)
    if m:
        r = S.find_record("products", m.group(1))
        if r:
            return "products", r
    order = ["products", "suppliers", "customers"]
    if prefer in order:
        order.remove(prefer); order.insert(0, prefer)
    for ent in order:
        f = {"products": N.find_product, "suppliers": N.find_supplier, "customers": N.find_customer}[ent](t)
        if f:
            return ent, S.get_record(ent, f["id"])
    return None, None


def h_update(ctx, sl):
    t = sl["t"]
    if ctx.user["role"] == "viewer":
        yield say("Viewer role is read-only. Ask an admin or manager."); return
    prefer = "suppliers" if re.search(r"supplier|vendor", t) else ("customers" if "customer" in t else None)
    ent, rec = resolve_record(t, prefer)
    if not rec:
        yield say("Record not found. Use a name or code, e.g. *change price of Steel Rod to 540* or *set PO-00012 status to approved*."); return
    yield step(f"Resolved {M.ENTITIES[ent]['label']} {S.record_label(ent, rec)}")
    field = None
    for rx, mp in FIELD_MAP:
        if re.search(rx, t) and ent in mp:
            field = mp[ent]; break
    if not field:
        if ent in ("purchase_orders", "sales_orders", "shipments") and N.find_status(t, ent):
            field = "status"
        else:
            yield say(f"Which field of {S.record_label(ent, rec)}? Editable: " + ", ".join(f["label"] for f in M.ENTITIES[ent]["fields"])); return
    fdef = next(f for f in M.ENTITIES[ent]["fields"] if f["key"] == field)
    raw = None
    m = re.search(r"\b(?:to|as|=)\s+(.+)$", t)
    pm = re.search(r"\b(increase|raise|decrease|reduce|lower)\b.*\bby\s+(\d+(?:\.\d+)?)\s*(%|percent)?", t)
    if pm and fdef["type"] == "number":
        cur = rec.get(field) or 0
        amt = float(pm.group(2))
        delta = cur * amt / 100 if pm.group(3) else amt
        val = cur + delta if pm.group(1) in ("increase", "raise") else cur - delta
        val = round(val, 2)
    elif field == "status":
        val = N.find_status(t, ent)
    elif m:
        raw = m.group(1).strip().rstrip(".")
        if fdef["type"] == "number":
            nums = N.find_numbers(raw)
            if not nums:
                yield say(f"Need a number for {fdef['label']}."); return
            val = nums[0]
        elif fdef["type"] == "select":
            val = next((o for o in fdef["options"] if o.lower() in raw or raw in o.lower()), raw.title())
        else:
            val = raw if field in ("email",) else raw.title() if field in ("city", "name") else raw
    else:
        yield say(f"New value for {fdef['label']}? e.g. *... to 450*"); return
    if val is None:
        yield say("Could not read the new value."); return
    old = rec.get(field)
    reason = (re.search(r"\b(?:because|reason)\b:?\s*(.+)$", t) or [None, ""])[1]
    if isinstance(val, str):
        val = re.sub(r"\s*\b(because|reason)\b.*$", "", val, flags=re.I).strip()
    yield nav(M.ENTITIES[ent]["page"], {"q": rec.get("name")} if ent in ("products", "suppliers", "customers") else {})
    label = S.record_label(ent, rec)
    if S.can(ctx.user, "update"):
        yield confirm_card(ctx.user, {"kind": "write", "entity": ent, "id": rec["id"], "action": "update", "changes": {field: val}, "reason": reason},
                           f"Update {label}?", [f"{fdef['label']}: {old} → {val}", "Applied immediately (admin) and audit-logged."], "Apply change")
    else:
        yield confirm_card(ctx.user, {"kind": "write", "entity": ent, "id": rec["id"], "action": "update", "changes": {field: val}, "reason": reason or "Requested via agent"},
                           f"Request change to {label}?", [f"{fdef['label']}: {old} → {val}", f"Your role ({ctx.user['role']}) cannot edit directly.", "Admin must approve in Approvals."],
                           "Submit request")


def h_delete(ctx, sl):
    t = sl["t"]
    if ctx.user["role"] == "viewer":
        yield say("Viewer role is read-only."); return
    prefer = "suppliers" if re.search(r"supplier|vendor", t) else ("customers" if "customer" in t else None)
    ent, rec = resolve_record(t, prefer)
    if not rec:
        yield say("Record not found."); return
    label = S.record_label(ent, rec)
    yield step(f"Resolved {label}")
    yield nav(M.ENTITIES[ent]["page"], {"q": rec.get("name")} if ent in ("products", "suppliers", "customers") else {})
    if S.can(ctx.user, "delete"):
        yield confirm_card(ctx.user, {"kind": "write", "entity": ent, "id": rec["id"], "action": "delete"}, f"Delete {label}?",
                           ["Soft delete: record hidden, kept in audit log."], "Delete", danger=True)
    else:
        yield confirm_card(ctx.user, {"kind": "write", "entity": ent, "id": rec["id"], "action": "delete", "reason": "Requested via agent"}, f"Request deletion of {label}?",
                           [f"Role {ctx.user['role']} cannot delete.", "Admin approval required."], "Submit request", danger=True)


def h_create(ctx, sl):
    ent, t = sl["entity"], sl["t"]
    if not S.can(ctx.user, "create"):
        yield say("Your role is read-only."); return
    v = {}
    m = re.search(r"(?:supplier|vendor|product|item|customer|client|expense)\s+(?:called |named )?(.+?)(?:\s+(?:in|at|from|with|category|price|cost|for|,)\b|$)", sl["t"])
    if m and ent != "expenses":
        v["name"] = m.group(1).strip().title()
    city = re.search(r"\b(?:in|at|from)\s+([a-z ]+?)(?:\s+(?:with|category|price|cost|rating|,)\b|$)", t)
    reg = N.find_region(t)
    if ent in ("suppliers", "customers") and city:
        v["city"] = city.group(1).strip().title()
    if ent == "customers" and reg:
        v["region"] = reg
    cat = N.find_category(t)
    if ent in ("products", "suppliers") and cat:
        v["category"] = cat
    for key, rx in (("unit_price", r"(?:price|selling price)\s*(?:of|=|:)?\s*₹?(\d+(?:\.\d+)?)"), ("cost_price", r"cost\s*(?:price)?\s*(?:of|=|:)?\s*₹?(\d+(?:\.\d+)?)"),
                    ("rating", r"rating\s*(\d(?:\.\d)?)"), ("lead_time_days", r"lead ?time\s*(\d+)"), ("amount", r"(?:amount|of|₹)\s*(\d+(?:\.\d+)?)"), ("stock", r"stock\s*(\d+)")):
        mm = re.search(rx, t)
        if mm and any(f["key"] == key for f in M.ENTITIES[ent]["fields"]):
            v[key] = float(mm.group(1))
    if ent == "products":
        name = v.get("name", "New Product")
        v["sku"] = ("".join(w[0] for w in name.split()[:2]).upper() + "-" + str(100 + len(P.product_rows()) + 1))
        if "unit_price" in v and "cost_price" not in v:
            v["cost_price"] = round(v["unit_price"] * 0.72, 2)
    if ent == "expenses":
        v["category"] = N.find_option(t, M.EXP_CATS) or "Administrative"
        v["date"] = today().isoformat()
    if ent == "suppliers" and "category" not in v:
        v["category"] = "Raw Materials"
    yield step(f"Opening {M.ENTITIES[ent]['label']} form")
    yield nav(M.ENTITIES[ent]["page"])
    yield {"t": "action", "action": "open_form", "entity": ent, "values": v, "mode": "create"}
    filled = ", ".join(f"{k}={val}" for k, val in v.items()) or "nothing yet"
    missing = [f["label"] for f in M.ENTITIES[ent]["fields"] if f.get("required") and f["key"] not in v]
    yield say(f"Form auto-filled: {filled}." + (f" Still needed: **{', '.join(missing)}**." if missing else " Review and click **Save**."))


def h_compare_suppliers(ctx, sl):
    prod = sl.get("product")
    if not prod and sl.get("category"):
        from db import q
        prods = q("SELECT id, sku code, name FROM products WHERE category=? AND is_deleted=0 ORDER BY id LIMIT 1", (sl["category"],))
        prod = prods[0] if prods else None
    if not prod:
        prod = {"id": 1, "code": "SR-001", "name": "Steel Rod"}
    yield step(f"Loading supplier catalog for {prod['name']}")
    opts = P.supplier_options(prod["id"])[: sl.get("n", 5)]
    yield step("Scoring: price 40%, rating 25%, on-time 20%, lead time 15%")
    if not opts:
        yield say("No suppliers for this product."); return
    b = opts[0]
    cheapest = min(opts, key=lambda o: o["price"])
    pr = S.get_record("products", prod["id"])
    yield nav("suppliers", {"category": pr["category"]}, "rating:desc")
    msg = f"Best overall for **{prod['name']}**: **{b['name']}** — ₹{b['price']:,.2f}, rating {b['rating']}, {round(b['on_time_rate'] * 100)}% on-time, {b['lead_time_days']}d lead (score {b['score']})."
    if cheapest["supplier_id"] != b["supplier_id"]:
        msg += f" Cheapest: {cheapest['name']} at ₹{cheapest['price']:,.2f}."
    yield say(msg)
    for o in opts:
        o["on_time_pct"] = round(o["on_time_rate"] * 100, 1)
    yield chart_card("bar", "Overall score (higher is better)", [o["name"] for o in opts], [{"label": "Score", "data": [o["score"] for o in opts], "colors": ["#2563eb"] + ["#94a3b8"] * (len(opts) - 1)}], fmt="num", horizontal=True)
    yield chart_card("bar", "Unit price (₹)", [o["name"] for o in opts], [{"label": "Price", "data": [o["price"] for o in opts], "colors": ["#16a34a" if o is cheapest else "#94a3b8" for o in opts]}], fmt="inr", horizontal=True)
    yield table_card(f"Suppliers for {prod['name']}", [("name", "Supplier", "text"), ("price", "Price", "inr"), ("rating", "Rating", "num"), ("on_time_pct", "On-time", "pct"),
                                                        ("lead_time_days", "Lead d", "int"), ("score", "Score", "num")], opts, "suppliers")
    yield card("chips", items=[f"Create purchase order for {prod['name']} from {b['name']}"])


def h_compare_periods(ctx, sl):
    t = sl["t"]
    per = sl["periods"]
    T = today()
    if not per:
        per = [N.parse_period("this month"), N.parse_period("last month")]
    if len(per) == 1:
        a = per[0]
        pf, pt = P.prev_range(a[0], a[1])
        per = [a, (pf, pt, "previous period")]
    extra = {k: sl.get(k) for k in ("region", "category", "channel") if sl.get(k)}
    metric = sl["metric"]
    yield step(f"Querying {metric} for {per[0][2]} and {per[1][2]}")
    A = P.period_metrics(per[0][0], per[0][1], extra)
    B = P.period_metrics(per[1][0], per[1][1], extra)
    ch = P.pct(A[metric], B[metric])
    fm = (lambda v: inr(v)) if metric == "revenue" else (lambda v: f"{int(v):,}")
    scope = (" in " + ", ".join(extra.values())) if extra else ""
    msg = f"{metric.title()}{scope}: **{fm(A[metric])}** ({per[0][2]}) vs **{fm(B[metric])}** ({per[1][2]}) → **{sign(ch)}**."
    a0, a1 = date.fromisoformat(per[0][0]), date.fromisoformat(per[0][1])
    b0, b1 = date.fromisoformat(per[1][0]), date.fromisoformat(per[1][1])
    if (a1 - a0).days + 3 < (b1 - b0).days and a1 >= T - timedelta(days=1):
        same = (b0 + (a1 - a0)).isoformat()
        L = P.period_metrics(per[1][0], same, extra)
        msg += f" Current period is partial ({(a1 - a0).days + 1} days). Like-for-like vs first {(a1 - a0).days + 1} days of {per[1][2]}: **{sign(P.pct(A[metric], L[metric]))}**."
    yield step("Breaking down by region")
    ba = P.breakdown("region", per[0][0], per[0][1], metric, extra); bb = P.breakdown("region", per[1][0], per[1][1], metric, extra)
    rows = sorted([{"name": k, "a": round(ba.get(k, 0)), "b": round(bb.get(k, 0)), "pct": P.pct(ba.get(k, 0), bb.get(k, 0))} for k in set(ba) | set(bb)], key=lambda r: -r["a"])
    if rows and not extra.get("region"):
        lo = min(rows, key=lambda r: r["pct"] if r["pct"] is not None else 0)
        hi = max(rows, key=lambda r: r["pct"] if r["pct"] is not None else 0)
        msg += f" Best region: {hi['name']} ({sign(hi['pct'])}). Weakest: {lo['name']} ({sign(lo['pct'])})."
    yield nav("analytics", {"date_from": per[0][0], "date_to": per[0][1], "metric": metric, "group_by": "region", **extra})
    yield say(msg)
    yield card("kpis", items=[{"label": f"{metric.title()} · {per[0][2]}", "value": fm(A[metric]), "delta": ch}, {"label": per[1][2], "value": fm(B[metric])},
                              {"label": "Orders", "value": f"{A['orders']:,} vs {B['orders']:,}", "delta": P.pct(A["orders"], B["orders"])}])
    fmt = "inr" if metric == "revenue" else "int"
    yield chart_card("bar", f"{metric.title()} by region", [r["name"] for r in rows], [{"label": per[0][2], "data": [r["a"] for r in rows]}, {"label": per[1][2], "data": [r["b"] for r in rows]}], fmt=fmt)
    yield table_card("By region", [("name", "Region", "text"), ("a", per[0][2], fmt), ("b", per[1][2], fmt), ("pct", "Change", "pct")], rows, "analytics")
    yield sources_card([(per[0][2], sales_sql(per[0][0], per[0][1], metric, extra)), (per[1][2], sales_sql(per[1][0], per[1][1], metric, extra)), ("By region", sales_sql(per[0][0], per[0][1], metric, extra, "region"))])
    yield card("chips", items=[f"Why did {metric} {'drop' if (ch or 0) < 0 else 'rise'}" + (f" in {extra['region']}" if extra.get("region") else "") + f" {per[0][2]}", "Top 5 products by revenue", "Show last 12 months analysis"])


def h_why(ctx, sl):
    per = sl["periods"]
    T = today()
    note = ""
    if len(per) >= 2:
        (dfrom, dto, la), (pf, pt, lb) = per[0], per[1]
        da, db_ = (date.fromisoformat(dto) - date.fromisoformat(dfrom)).days, (date.fromisoformat(pt) - date.fromisoformat(pf)).days
        if da + 3 < db_ and dto >= (T - timedelta(days=1)).isoformat():
            pt = (date.fromisoformat(pf) + timedelta(days=da)).isoformat()
            note = f"{la} is partial ({da + 1} days), so I compare like-for-like with the first {da + 1} days of {lb}."
        prev = (pf, pt)
    elif per:
        dfrom, dto, la = per[0]
        prev, lb = None, "the previous period"
    else:
        dto = T.isoformat(); dfrom = (T - timedelta(days=59)).isoformat(); la = "last 60 days"; prev, lb = None, "the 60 days before"
    extra = {k: sl[k] for k in ("region", "category") if sl.get(k)}
    metric = sl["metric"]
    yield step(f"Comparing {la} with {lb}" + (" (like-for-like)" if note else ""))
    d = P.drivers(dfrom, dto, metric, extra, prev)
    pf, pt = d["previous"]
    yield step("Decomposing the change by region, category, channel and product")
    yield step("Checking logistics delays, cancellations and stock-outs")
    ch = d["change_pct"]
    mv = (lambda v: inr(v)) if metric == "revenue" else (lambda v: f"{int(v):,}")
    scope = (" in " + ", ".join(extra.values())) if extra else ""
    direction = "fell" if (ch or 0) < 0 else "rose"
    lines = [f"{metric.title()}{scope} **{direction} {abs(ch or 0):.1f}%**: {mv(d['current'][metric])} ({dfrom} → {dto}) vs {mv(d['previous_totals'][metric])} ({pf} → {pt})."]
    if note:
        lines.append(f"_{note}_")
    causes = []
    for dim, items in d["dims"].items():
        if not items:
            continue
        worst, best = items[0], items[-1]
        if (ch or 0) < 0 and worst["delta"] < 0:
            causes.append((abs(worst["delta"]), f"**{dim.title()}**: {worst['key']} {sign(worst['pct'])} ({mv(worst['delta'])})"))
        elif (ch or 0) > 0 and best["delta"] > 0:
            causes.append((abs(best["delta"]), f"**{dim.title()}**: {best['key']} {sign(best['pct'])} (+{mv(best['delta'])})"))
    causes.sort(key=lambda x: -x[0])
    causes = [c for _, c in causes]
    dl = d["delays"]
    late_up = dl["current"]["avg_delay"] is not None and dl["previous"]["avg_delay"] is not None and dl["current"]["avg_delay"] > (dl["previous"]["avg_delay"] or 0) * 1.5 + 0.3
    if late_up:
        causes.append(f"**Logistics**: avg delay {dl['current']['avg_delay']:.1f} d vs {dl['previous']['avg_delay']:.1f} d; late shipments {dl['current']['late_rate'] * 100:.0f}% vs {dl['previous']['late_rate'] * 100:.0f}%")
        if d.get("carriers"):
            c0 = d["carriers"][0]
            causes.append(f"**Carrier**: {c0['carrier']} slowest on this lane: {c0['n']} shipments, avg {c0['avg_delay']:.1f} d delay")
    cr = d["cancel_rate"]
    if cr["current"] > cr["previous"] * 1.3 and cr["current"] > 0.02:
        causes.append(f"**Cancellations** up: {cr['current'] * 100:.1f}% vs {cr['previous'] * 100:.1f}%")
    if d["out_of_stock"] and (ch or 0) < 0:
        causes.append(f"**Stock-outs** now: {', '.join(d['out_of_stock'])} (orders for them cannot ship)")
    lines.append(("**Biggest contributors:**\n" if (ch or 0) < 0 else "**Growth drivers:**\n") + "\n".join(f"{i + 1}. {c}" for i, c in enumerate(causes[:6])) if causes else "No single dominant driver; the change is spread evenly.")
    lines.append("_What the data cannot prove: these are measured contributions and co-occurring signals, not proven causes. Customer intent, competitor pricing and market demand are not in this dataset._")
    if extra.get("region") and late_up:
        lines.append("**Suggested action:** review the slow carrier on this lane, expedite delayed orders, inform key accounts.")
        yield nav("logistics", {"region": extra["region"], "date_from": dfrom, "date_to": dto}, "delay_days:desc", "chart_delay_carrier")
    else:
        yield nav("analytics", {"date_from": dfrom, "date_to": dto, "metric": metric, "group_by": "category" if extra.get("region") else "region", **extra}, "change:asc")
    yield say("\n\n".join(lines))
    yield card("kpis", items=[{"label": f"{metric.title()} · {dfrom[5:]} → {dto[5:]}", "value": mv(d["current"][metric]), "delta": ch},
                              {"label": f"Compared · {pf[5:]} → {pt[5:]}", "value": mv(d["previous_totals"][metric])},
                              {"label": "Change", "value": mv(d["current"][metric] - d["previous_totals"][metric])}])
    dim = "category" if extra.get("region") else "region"
    rows = d["dims"].get(dim) or []
    if rows:
        yield chart_card("bar", f"Change in {metric} by {dim}", [r["key"] for r in rows], [{"label": "Δ " + metric, "data": [r["delta"] for r in rows]}],
                         fmt="inr" if metric == "revenue" else "int", signed=True, horizontal=True)
    prods = (d["dims"].get("product") or [])
    prods = (prods[:6] if (ch or 0) < 0 else prods[-6:][::-1])
    if prods:
        yield chart_card("bar", "Top product contributors", [r["key"] for r in prods], [{"label": "Δ " + metric, "data": [r["delta"] for r in prods]}],
                         fmt="inr" if metric == "revenue" else "int", signed=True, horizontal=True)
    if dl["current"]["avg_delay"] is not None and dl["previous"]["avg_delay"] is not None:
        yield chart_card("bar", "Late shipment rate", ["Compared period", "This period"], [{"label": "Late %", "data": [round((dl["previous"]["late_rate"] or 0) * 100, 1), round((dl["current"]["late_rate"] or 0) * 100, 1)],
                         "colors": ["#94a3b8", "#dc2626" if late_up else "#2563eb"]}], fmt="pct")
    yield sources_card([(f"{metric.title()} this period", sales_sql(dfrom, dto, metric, extra)), (f"{metric.title()} compared period", sales_sql(pf, pt, metric, extra)),
                        (f"By {dim} (this period)", sales_sql(dfrom, dto, metric, extra, dim))], "Numbers computed in code from these queries; the explanation only cites them.")
    yield card("chips", items=[f"Top 5 products by revenue in {extra['region']}" if extra.get("region") else "Top 5 regions by revenue", "show delayed shipments", "How did you get that number?"])


def h_expense_why(ctx, sl):
    per = sl["periods"]
    dfrom, dto = (per[0][0], per[0][1]) if per else ((today() - timedelta(days=89)).isoformat(), today().isoformat())
    pf, pt = P.prev_range(dfrom, dto)
    from db import q
    yield step("Comparing expense categories vs prior period")
    cur = {r["category"]: r["s"] for r in q("SELECT category, SUM(amount) s FROM expenses WHERE is_deleted=0 AND date BETWEEN ? AND ? GROUP BY category", (dfrom, dto))}
    prev = {r["category"]: r["s"] for r in q("SELECT category, SUM(amount) s FROM expenses WHERE is_deleted=0 AND date BETWEEN ? AND ? GROUP BY category", (pf, pt))}
    rows = sorted([{"name": k, "a": round(cur.get(k, 0)), "b": round(prev.get(k, 0)), "pct": P.pct(cur.get(k, 0), prev.get(k, 0))} for k in set(cur) | set(prev)], key=lambda r: -(r["pct"] or 0))
    top = rows[0]
    rev_ch = P.pct(P.period_metrics(dfrom, dto)["revenue"], P.period_metrics(pf, pt)["revenue"])
    msg = f"Biggest rise: **{top['name']}** {sign(top['pct'])} ({inr(top['a'])} vs {inr(top['b'])}). Revenue moved {sign(rev_ch)} in the same window."
    if top["name"] == "Logistics":
        yield step("Cross-checking shipment delays")
        d = P.drivers(dfrom, dto)
        msg += f" Shipment delays rose: avg {d['delays']['current']['avg_delay']:.1f}d vs {d['delays']['previous']['avg_delay']:.1f}d → expediting and re-shipping costs."
    yield nav("finance", {"date_from": dfrom, "date_to": dto}, None, "chart_expense")
    yield say(msg)
    yield chart_card("bar", "Expenses: current vs prior period", [r["name"] for r in rows], [{"label": "Current", "data": [r["a"] for r in rows]}, {"label": "Previous", "data": [r["b"] for r in rows]}], fmt="inr")
    yield table_card("Expenses vs prior period", [("name", "Category", "text"), ("a", "Current", "inr"), ("b", "Previous", "inr"), ("pct", "Change", "pct")], rows, "finance")


def h_top(ctx, sl):
    per = sl["periods"]
    dfrom, dto = (per[0][0], per[0][1]) if per else (None, None)
    kind, n, metric = sl["kind"], sl["n"], sl["metric"]
    if kind == "suppliers" and metric == "revenue":
        metric = "spend"
    extra = {k: sl[k] for k in ("region", "category") if sl.get(k)}
    yield step(f"Ranking {kind} by {metric}")
    rows = P.top_n(kind, n, dfrom, dto, metric, sl["asc"], extra)
    if not rows:
        yield say("No data."); return
    label = per[0][2] if per else "last 12 months"
    key = "rating" if metric == "rating" else ("spend" if kind == "suppliers" else metric)
    fmt = "inr" if key in ("revenue", "spend") else ("num" if key == "rating" else "int")
    word = "Bottom" if sl["asc"] else "Top"
    yield say(f"{word} {len(rows)} {kind} by {metric} ({label}): #1 **{rows[0]['name']}** at **{fmtv(rows[0][key], fmt)}**.")
    yield chart_card("bar", f"{word} {len(rows)} {kind} by {metric}", [r["name"] for r in rows], [{"label": metric, "data": [r[key] for r in rows]}], fmt=fmt, horizontal=True)
    yield table_card(f"{word} {n} {kind}", [("name", kind[:-1].title(), "text"), (key, metric.title(), fmt)], rows)
    gm = {"products": "product", "customers": "customer", "regions": "region", "categories": "category", "channels": "channel", "segments": "segment"}
    if kind in gm and metric in ("revenue", "orders", "units"):
        da, db_ = P.drange({"date_from": dfrom, "date_to": dto})
        yield sources_card([(f"{word} {kind}", sales_sql(da, db_, metric, extra, gm[kind], n).replace("DESC", "ASC" if sl["asc"] else "DESC"))])
    gmap = {"products": "product", "regions": "region", "categories": "category", "channels": "channel", "segments": "segment"}
    if kind in gmap:
        yield nav("analytics", {"date_from": dfrom, "date_to": dto, "metric": metric if metric in ("revenue", "orders", "units") else "revenue", "group_by": gmap[kind], **extra},
                  f"current:{'asc' if sl['asc'] else 'desc'}")
    elif kind == "customers":
        yield nav("customers", {}, f"revenue:{'asc' if sl['asc'] else 'desc'}")
    else:
        yield nav("suppliers", {}, f"{'rating' if metric == 'rating' else 'spend_12m'}:{'asc' if sl['asc'] else 'desc'}")


def h_trend(ctx, sl):
    per = sl["periods"]
    T = today()
    dfrom, dto, label = per[0] if per else ((N.add_months(T.replace(day=1), -11)).isoformat(), T.isoformat(), "last 12 months")
    extra = {k: sl[k] for k in ("region", "category") if sl.get(k)}
    metric = sl["metric"]
    yield step(f"Loading monthly {metric} ({label})")
    ms = P.monthly_sales({"date_from": dfrom, "date_to": dto, **extra})
    full = [m for m in ms if m["m"] != T.strftime("%Y-%m")] or ms
    vals = [m[metric] for m in full]
    yield step("Computing growth, peaks and forecast")
    if len(vals) < 2:
        yield say("Not enough data for a trend."); return
    best = max(full, key=lambda m: m[metric]); worst = min(full, key=lambda m: m[metric])
    h = len(vals) // 2
    g = P.pct(sum(vals[h:]), sum(vals[:h])) if h else None
    mom = P.pct(vals[-1], vals[-2])
    xs = list(range(min(6, len(vals)))); ys = vals[-len(xs):]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sum((x - mx) ** 2 for x in xs) or 1)
    fc = my + slope * (len(xs) - mx)
    fm = inr if metric == "revenue" else (lambda v: f"{int(v):,}")
    scope = (" · " + ", ".join(extra.values())) if extra else ""
    total = sum(m[metric] for m in ms)
    yield say(f"**{metric.title()} trend ({label}{scope})**: total {fm(total)}. Second half vs first half **{sign(g)}**. Last full month {P.mlabel(full[-1]['m'])} {fm(vals[-1])} ({sign(mom)} MoM). "
              f"Peak {P.mlabel(best['m'])} ({fm(best[metric])}), low {P.mlabel(worst['m'])} ({fm(worst[metric])}). "
              f"6-month slope {'up' if slope > 0 else 'down'} → next month forecast ≈ **{fm(max(fc, 0))}**.")
    labels = [P.mlabel(m["m"]) for m in ms]
    nxt = P.mlabel(N.add_months(date.fromisoformat(full[-1]["m"] + "-01"), 1).strftime("%Y-%m"))
    actual = [m[metric] for m in ms]
    if nxt not in labels:
        labels.append(nxt); actual.append(None)
    fi = labels.index(nxt)
    fcs = [None] * len(labels)
    fcs[fi - 1] = vals[-1]; fcs[fi] = round(max(fc, 0), 2)
    if fi < len(actual) and actual[fi] is not None and fi == len(ms) - 1:
        actual[fi] = None  # current partial month replaced by forecast
    yield chart_card("line", f"Monthly {metric} + next-month forecast", labels, [{"label": "Actual", "data": actual}, {"label": "Forecast", "data": fcs, "dashed": True}], fmt="inr" if metric == "revenue" else "int")
    agg = {"revenue": "ROUND(SUM(so.amount), 2) AS revenue", "orders": "COUNT(*) AS orders", "units": "SUM(so.qty) AS units"}[metric]
    yield sources_card([("Monthly series", sales_sql(dfrom, dto, metric, extra).replace(f"SELECT {agg}", f"SELECT substr(so.order_date, 1, 7) AS month, {agg}") + " GROUP BY month ORDER BY month")],
                       "Forecast = least-squares line through the last 6 full months. It is a projection, not a guarantee.")
    yield nav("analytics", {"date_from": dfrom, "date_to": dto, "metric": metric, "group_by": sl.get("group") or "region", **extra}, None, "chart_trend")


def h_delays(ctx, sl):
    per = sl["periods"]
    f = {"region": sl.get("region"), "carrier": sl.get("carrier")}
    f.update(period_filters(per) if per else {"date_from": (today() - timedelta(days=59)).isoformat(), "date_to": today().isoformat()})
    yield step("Reading shipments")
    d = P.page_data("logistics", f)
    rows = d["table"]["rows"]
    late = [r for r in rows if r["delay_days"] > 0]
    yield step("Ranking carriers and lanes by delay")
    by_c, by_r = {}, {}
    for r in rows:
        by_c.setdefault(r["carrier"], []).append(r["delay_days"]); by_r.setdefault(r["destination"], []).append(r["delay_days"])
    avg = lambda xs: sum(xs) / len(xs)
    wc = max(by_c.items(), key=lambda kv: avg(kv[1])) if by_c else None
    wr = max(by_r.items(), key=lambda kv: avg(kv[1])) if by_r else None
    yield nav("logistics", {**f, "status": None}, "delay_days:desc", "chart_delay_carrier")
    msg = f"**{len(late)} of {len(rows)}** shipments late ({len(late) * 100 / (len(rows) or 1):.1f}%)."
    if wc:
        msg += f" Worst carrier: **{wc[0]}** (avg {avg(wc[1]):.1f}d)."
    if wr and not sl.get("region"):
        msg += f" Worst destination: **{wr[0]}** (avg {avg(wr[1]):.1f}d)."
    yield say(msg)
    cars = sorted(by_c.items(), key=lambda kv: -avg(kv[1]))
    yield chart_card("bar", "Average delay by carrier (days)", [k for k, _ in cars], [{"label": "Avg delay", "data": [round(avg(v), 2) for _, v in cars],
                     "colors": sev_colors([avg(v) for _, v in cars], 1, 2, reverse=True)}], fmt="num", horizontal=True)
    if not sl.get("region"):
        regs = sorted(by_r.items(), key=lambda kv: -avg(kv[1]))
        yield chart_card("bar", "Average delay by destination (days)", [k for k, _ in regs], [{"label": "Avg delay", "data": [round(avg(v), 2) for _, v in regs],
                         "colors": sev_colors([avg(v) for _, v in regs], 1, 2, reverse=True)}], fmt="num", horizontal=True)
    yield table_card("Most delayed shipments", [("shipment_no", "Shipment", "text"), ("carrier", "Carrier", "text"), ("destination", "To", "text"), ("delay_days", "Delay d", "int"), ("status", "Status", "status")],
                     sorted(late, key=lambda r: -r["delay_days"])[:8], "logistics")


def h_finance(ctx, sl):
    per = sl["periods"]
    T = today()
    f = period_filters(per) if per else {"date_from": date(T.year, 1, 1).isoformat(), "date_to": T.isoformat()}
    label = per[0][2] if per else "this year"
    yield step("Computing P&L")
    d = P.page_data("finance", f)
    k = {x["id"]: x for x in d["kpis"]}
    yield nav("finance", f)
    exp = d["charts"][1]
    top = max(zip(exp["labels"], exp["datasets"][0]["data"]), key=lambda x: x[1]) if exp["labels"] else ("—", 0)
    yield say(f"**{label.title()}**: Revenue {inr(k['kpi_revenue']['value'])} ({sign(k['kpi_revenue']['delta'])}), COGS {inr(k['kpi_cogs']['value'])}, "
              f"Opex {inr(k['kpi_opex']['value'])}, gross margin **{k['kpi_margin']['value']:.1f}%**, net profit **{inr(k['kpi_profit']['value'])}** ({sign(k['kpi_profit']['delta'])}). "
              f"Largest expense: {top[0]} ({inr(top[1])}).")
    yield card("kpis", items=[{"label": x["label"], "value": fmtv(x["value"], x["fmt"]), "delta": x.get("delta")} for x in d["kpis"]])
    yield page_chart_card(d, 0)
    yield page_chart_card(d, 1)


def h_search(ctx, sl):
    term = sl.get("term") or sl["t"]
    yield step("Semantic search over pages, products, suppliers, customers")
    c = N.find_code(term)
    links = []
    if c:
        r = S.find_record(c[0], c[1])
        if r:
            e = M.ENTITIES[c[0]]
            links.append({"label": S.record_label(c[0], r), "kind": e["label"], "page": e["page"], "filters": {"q": r.get("name")} if c[0] in ("products", "suppliers", "customers") else {}})
    for h in R.search(term, 6):
        if h["kind"] == "api":
            continue
        f = {"q": h["name"]} if h["kind"] in ("products", "suppliers", "customers") else {}
        links.append({"label": (h.get("code", "") + " " + h["name"]).strip(), "kind": h["kind"], "page": h["page"], "filters": f})
    if not links:
        yield say("Nothing found."); return
    top = links[0]
    yield nav(top["page"], top["filters"])
    yield say(f"Top match: **{top['label']}** ({top['kind']}). Opened it.")
    yield card("links", items=links[:6])


def h_unknown(ctx, sl, query):
    _, summary = summarize_page(ctx.page, ctx.filters)
    if llm.enabled():
        yield step("Interpreting with LLM")
        r = llm.interpret(query, summary)
        if r and r.get("rewrite"):
            yield step(f"Rewritten → “{r['rewrite']}”")
            plan = route(r["rewrite"], ctx)
            if plan["intent"] != "unknown":
                plan["llm"] = True
                yield from dispatch(plan, ctx, r["rewrite"])
                return
        if r and r.get("answer"):
            yield say(r["answer"]); return
        if r and r.get("error"):
            yield step("LLM unavailable; using retrieval")
    hits = R.search(query, 4)
    pg = [h for h in hits if h["kind"] in ("page", "widget")]
    if pg and pg[0]["score"] > 0.08:
        yield from h_navigate(ctx, {"page": pg[0]["page"], "periods": N.parse_periods(N.norm(query)), "t": N.norm(query)})
        return
    yield say("Not sure what to do. Try one of these:")
    yield card("chips", items=M.PAGE.get(ctx.page, M.PAGE["dashboard"])["suggestions"] + ["help"])


def h_refuse(ctx, sl):
    code = sl["code"]
    pages = [p["title"] for p in M.PAGES]
    if code == "PAGE_NOT_FOUND":
        tgt = sl.get("target", "").strip().title() or "That"
        yield refuse(code, f"There is no “{tgt}” page in this app. I only open pages that exist in the app metadata.", [f"Open {p}" for p in pages[:6]])
    elif code == "VALUE_NOT_ALLOWED":
        yield refuse(code, f"“{sl['value']}” is not in the data. Regions available: {', '.join(M.REGIONS)}.", [f"Show {r} sales" for r in M.REGIONS[:4]])
    elif code in ("DATE_OUT_OF_RANGE", "INVALID_DATE_RANGE"):
        yield refuse(code, f"“{sl['value']}” is outside the data window ({data_start()} → {today().isoformat()})." if code == "DATE_OUT_OF_RANGE" else f"“{sl['value']}” is not a valid date range.",
                     ["Show last 12 months analysis", "Compare revenue this month vs last month"])
    elif code == "WRITE_NOT_ALLOWED":
        yield refuse(code, "I can't run raw database writes. Data changes go through forms and change requests, with permissions and audit.", ["Show pending requests", "change price of Steel Rod to 540", "sql: select * from products"])
    else:
        yield refuse("PROMPT_INJECTION", "I can't change my rules or reveal internal instructions. I can navigate, filter, analyse and act within your role.", ["help", "What is on this page?"])


def h_export(ctx, sl):
    fmt, scope = sl.get("fmt", "pdf"), sl.get("scope", "page")
    title = M.PAGE[ctx.page]["title"]
    yield step(f"Collecting {'the conversation' if scope == 'chat' else title + ' KPIs, charts, filters and table'}")
    yield say(f"Exporting {'the agent conversation' if scope == 'chat' else 'a summary of **' + title + '**'} as **{fmt.upper()}**." +
              ("" if fmt == "pdf" else " CSV holds the main table with current filters."))
    yield {"t": "action", "action": "export", "format": fmt, "scope": scope}


def h_stack(ctx, sl):
    yield step("Reading the implementation stack")
    yield nav("stack")
    rows = M.STACK
    yield say("**How BizPilot is built** (all free / open source):\n" + "\n".join(f"- **{r['layer']}**: {r['tech']}" for r in rows[:12]) +
              f"\n\nAgent pipeline: " + " → ".join(a for a, _ in M.PIPELINE) + ".\nFull list with code locations is on the Implementation Stack page.")
    yield card("chips", items=["How does the agent understand a question?", "Open the agent review queue", "Open the evaluation page"])


def h_smalltalk(ctx, sl):
    t = sl["t"]
    if re.match(r"(thanks|thank|thx|ty)", t):
        msg = "You're welcome."
    elif re.match(r"(bye|goodbye)", t):
        msg = "Bye! Your filters and history stay here for next time."
    elif re.match(r"good (morning|afternoon|evening|night)", t):
        msg = f"Good {t.split()[1]}, {ctx.user['name'].split()[0]}."
    else:
        msg = "👍"
    ins = P.insights(2)
    yield say(msg + (" One thing worth a look: **" + ins[0]["title"] + "**." if ins else ""))
    yield card("chips", items=[i["ask"] for i in ins] + ["What is on this page?"])


def h_meta(ctx, sl):
    kind, u = sl["kind"], ctx.user
    meta = M.PAGE[ctx.page]
    if kind == "identity":
        yield say(f"I'm the **BizPilot agent**, built into this app. I read the app's metadata ({len(M.PAGES)} pages, their widgets and filters) and its live data, "
                  "then navigate, filter, analyse and act for you within your role. Numbers come from database queries; I show the SQL behind them.")
    elif kind == "limits":
        yield say("**What I can't do:** change data beyond your role (non-admins raise requests), run raw SQL writes, open pages that don't exist, use data outside this database "
                  f"(window {data_start()} → {today().isoformat()}), or prove causes the data doesn't contain. When I'm unsure I ask instead of guessing.")
    elif kind == "filters":
        fl = meta["filters"]
        if not fl:
            yield say(f"**{meta['title']}** has no filters. Pages with filters: " + ", ".join(p["title"] for p in M.PAGES if p["filters"]) + ".")
        else:
            parts = []
            for f in fl:
                opts = f.get("options")
                parts.append(f"- **{f['label']}**" + (f": {', '.join(opts)}" if opts else (" (from / to dates)" if f["type"] == "daterange" else " (free text)")))
            yield say(f"Filters on **{meta['title']}**:\n" + "\n".join(parts))
            ex_ = {"sales": "Show Karnataka delivered orders last quarter", "inventory": "show low stock electrical items", "procurement": "show draft purchase orders",
                   "logistics": "Gati shipments to Maharashtra last 30 days", "customers": "enterprise customers in Delhi", "analytics": "revenue by channel last 6 months"}.get(ctx.page, meta["suggestions"][0])
            yield card("chips", items=[ex_])
    elif kind == "role":
        perms = S.PERMS[u["role"]]
        can_do = {"read": "view every page and analysis", "create": "create products, suppliers, customers, POs, expenses", "update": "edit any record directly",
                  "delete": "delete records (soft)", "approve": "approve or reject change requests", "request": "request updates/deletes (low-risk ones auto-approve)"}
        yield say(f"You are **{u['name']}**, role **{u['role']}**. You can:\n" + "\n".join(f"- {can_do[p]}" for p in ["read", "create", "update", "delete", "approve", "request"] if p in perms)
                  + ("\n\nAdmin-only actions are refused for your role, and I'll offer a change request instead." if u["role"] != "admin" else ""))
    elif kind == "kpi":
        name, page, formula, key = sl["kpi"]
        import dataset as DSX
        val = next((k for k in DSX.kpi_dictionary() if k["kpi"] == name), None)
        yield say(f"**{name}** = {formula}. Current value: **{fmtv(val['value'], val['fmt'])}** ({val['window']}). Shown on **{M.PAGE[page]['title']}**.")
        yield card("chips", items=[f"Open {M.PAGE[page]['title']}", "List all KPIs"])


def h_widget(ctx, sl):
    name = sl["name"].lower()
    best, sc = None, 0
    for p in M.PAGES:
        for wid, wtype, title in p["widgets"]:
            tw, nw = set(re.findall(r"[a-z]+", title.lower())), set(re.findall(r"[a-z]+", name))
            score = len(tw & nw) / (len(tw) or 1) + (0.5 if p["id"] == ctx.page else 0)
            if score > sc:
                best, sc = (p, wid, wtype, title), score
    if not best or sc < 0.5:
        yield clarify("Which widget do you mean?", [f"Explain the {w[2]} widget" for w in M.PAGE[ctx.page]["widgets"][:5]])
        return
    p, wid, wtype, title = best
    d = P.page_data(p["id"], ctx.filters if p["id"] == ctx.page else {})
    detail = ""
    k = next((x for x in d.get("kpis", []) if x["id"] == wid), None)
    c_ = next((x for x in d.get("charts", []) if x["id"] == wid), None)
    if k:
        detail = f"Current value **{fmtv(k['value'], k['fmt'])}**" + (f" ({sign(k['delta'])} vs previous period)" if k.get("delta") is not None else "") + "."
    elif c_:
        vals = c_["datasets"][0]["data"]
        if vals:
            i = max(range(len(vals)), key=lambda i: vals[i] or 0)
            detail = f"It plots {len(vals)} points; highest is **{c_['labels'][i]}**."
    elif d.get("table") and d["table"]["id"] == wid:
        detail = f"It lists {d['table']['total']} rows, columns: {', '.join(c['label'] for c in d['table']['columns'])}."
    kp = kpi_lookup(title)
    yield nav(p["id"], ctx.filters if p["id"] == ctx.page else {}, None, wid)
    yield say(f"**{title}** ({wtype}, `{wid}`) on **{p['title']}**. {detail}" + (f" Formula: {kp[2]}." if kp else ""))
    if c_:
        yield page_chart_card({"charts": [c_]})


def h_insights(ctx, sl):
    yield step("Comparing last month with the 3-month average for every region and category")
    ins = P.insights(5)
    if not ins:
        yield say("Nothing unusual: every region and category is within 8% of its 3-month average.")
        return
    yield say("**Agent noticed:**\n" + "\n".join(f"- **{i['title']}** · {i['body']}" for i in ins))
    yield card("chips", items=[i["ask"] for i in ins])


def h_clarify(ctx, sl):
    w = sl["what"]
    page = M.PAGE[ctx.page]
    if w == "compare":
        yield clarify("What would you like to compare?", ["Compare revenue this month vs last month", "Compare revenue 2026 vs 2025", "Compare suppliers for Steel Rod", "Top 5 regions by revenue"])
    elif w in ("sort",):
        d = P.page_data(ctx.page, ctx.filters)
        cols = [c for c in (d.get("table") or {}).get("columns", []) if c["fmt"] in ("inr", "int", "num", "days", "pct", "date")][:4]
        yield clarify(f"Sort {page['title']} by which column?", [f"sort by {c['key'].replace('_', ' ')} desc" for c in cols] or ["Open Sales & Orders"])
    elif w == "filter":
        yield clarify(f"Which filter on {page['title']}?", [f"What filters can I use here?"] + page["suggestions"][:3])
    else:
        yield clarify("Which report do you need?", ["Open Sales & Orders", "Open Finance", "Open Inventory", "Open Analytics", "Show last 12 months analysis"])


def h_explain_last(ctx, sl):
    last = LAST.get(ctx.user["username"])
    if not last:
        yield say("There's no previous answer in this session yet. Ask me something and then ask how I got it.")
        return
    lines = [f"For “{last['query']}” I detected intent **{last['intent']}**" + (f" and opened **{M.PAGE[last['page']]['title']}**" if last.get("page") in M.PAGE else "") + "."]
    if last.get("filters"):
        lines.append("Filters applied: " + ", ".join(f"{k}={v}" for k, v in last["filters"].items()) + ".")
    if last.get("steps"):
        lines.append("Steps:\n" + "\n".join(f"{i + 1}. {s_}" for i, s_ in enumerate(last["steps"])))
    lines.append("Every number was computed by queries on the live database (below), not written by a language model.")
    yield say("\n\n".join(lines))
    if last.get("sources"):
        yield sources_card([(x["label"], x["sql"]) for x in last["sources"]])
    else:
        f = last.get("filters") or {}
        a, b = P.drange(f)
        yield sources_card([("Equivalent query", sales_sql(a, b, "revenue", {k: f[k] for k in ("region", "category", "channel") if f.get(k)}))])


HANDLERS = {"help": h_help, "current_page": h_current_page, "go_back": h_go_back, "navigate": h_navigate, "requests": h_requests, "review": h_review,
            "review_all": h_review_all, "stockout": h_stockout, "create_po": h_create_po, "update": h_update, "delete": h_delete, "create": h_create,
            "compare_suppliers": h_compare_suppliers, "compare_periods": h_compare_periods, "why": h_why, "expense_why": h_expense_why, "top": h_top,
            "trend": h_trend, "delays": h_delays, "finance": h_finance, "search": h_search, "dataset": h_dataset, "sql": h_sql,
            "refuse": h_refuse, "smalltalk": h_smalltalk, "meta": h_meta, "widget": h_widget, "insights": h_insights, "clarify": h_clarify, "explain_last": h_explain_last,
            "export": h_export, "stack": h_stack}


def dispatch(plan, ctx, query):
    sl = {**plan["slots"], "t": plan["t"]}
    if plan["intent"] == "unknown":
        yield from h_unknown(ctx, sl, query)
    elif plan["intent"] == "navigate":
        yield from h_navigate(ctx, sl, sl["page"])
    else:
        yield from HANDLERS[plan["intent"]](ctx, sl)


SPLIT = r"\s*(?:;|\band then\b|,\s*then\b|\bafter that\b|\bthen\b)\s*"


def plan_steps(query, ctx):
    """Multi-step requests: 'show Karnataka sales last quarter, then compare with previous; then top 5 products'."""
    parts = [p.strip(" ,.") for p in re.split(SPLIT, query, flags=re.I) if p.strip(" ,.")]
    if len(parts) < 2:
        return [(query, route(query, ctx))]
    plans = [(p, route(p, ctx)) for p in parts]
    if any(pl["intent"] == "unknown" for _, pl in plans):
        return [(query, route(query, ctx))]
    return plans


def run_steps(steps, ctx):
    multi = len(steps) > 1
    for i, (text, plan) in enumerate(steps, 1):
        if multi:
            yield step(f"Task {i}/{len(steps)}: {text}")
        for ev in dispatch(plan, ctx, text):
            if ev["t"] == "action" and ev.get("action") == "navigate":
                ctx.page, ctx.filters = ev["page"], ev.get("filters") or {}
            yield ev


LAST = {}  # username -> last answered request (for follow-ups and "how did you get that?")
PERIOD_RX = (r"\b(this|last|previous|prior|current) (week|month|quarter|year)\b|\blast \d+ (days?|weeks?|months?|years?|quarters?)\b|\bq[1-4]( 20\d\d)?\b|"
             r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*( 20\d\d)?\b|\b20\d\d\b|\bytd\b|\btoday\b|\byesterday\b|\b(vs|versus|compared (to|with))\b")


def substitute(lastq, x):
    """'same for Delhi' / 'what about last month' -> rewrite the previous request with the new value."""
    q = N.norm(lastq)
    reg = N.find_region(x)
    if reg:
        found = False
        for k in sorted(N.REGION_ALIAS, key=len, reverse=True):
            if re.search(rf"\b{re.escape(k)}\b", q):
                q = re.sub(rf"\b{re.escape(k)}\b", reg.lower(), q, count=1); found = True
                break
        if not found:
            q += f" in {reg.lower()}"
    if N.parse_period(x):
        q = re.sub(r"\s+", " ", re.sub(PERIOD_RX, " ", q)).strip()
        q += " " + re.sub(r"^(for|in|over|during)\s+", "", x.strip())
    cat = N.find_category(x)
    if cat:
        old = N.find_category(q)
        q = q.replace(old.lower(), cat.lower()) if old else q + f" {cat.lower()}"
    prod = N.find_product(x)
    if prod and not reg:
        oldp = N.find_product(q)
        q = q.replace(oldp["name"].lower(), prod["name"].lower()) if oldp else q + f" for {prod['name'].lower()}"
    return q if q != N.norm(lastq) else None


def followup(query, ctx):
    t = N.norm(query.strip().rstrip("?.!"))
    last = LAST.get(ctx.user["username"])
    if re.fullmatch(r"(clear|reset|remove)( all)?( the)? filters?( please)?", t):
        return [(query, {"intent": "navigate", "t": t, "slots": {"page": ctx.page, "periods": [], "force_filters": {}, "note": "Cleared all filters."}})]
    m = re.match(r"^(?:only|just|filter (?:by|to|for|on)|limit (?:it )?to|restrict to|narrow (?:it )?to)\s+(.+)$", t)
    if m:
        add = build_filters(ctx.page, m.group(1), N.parse_periods(m.group(1)))
        if not add:
            fl = [f["label"] for f in M.PAGE[ctx.page]["filters"]]
            return [(query, {"intent": "clarify", "t": t, "slots": {"what": "filter", "periods": []}})]
        if add:
            return [(query, {"intent": "navigate", "t": t, "slots": {"page": ctx.page, "periods": [], "force_filters": {**ctx.filters, **add}, "force_sort": None,
                                                                        "note": "Kept current filters and added " + ", ".join(f"{k}={v}" for k, v in add.items()) + "."}})]
    m = re.match(r"^(?:ok |okay |and |so )?(?:same|do the same|repeat that|the same)(?: thing| analysis| report)? (?:for|in|with|but for) (.+)$|^(?:what|how) about (.+)$|^(?:and|now) (?:for|in) (.+)$|^(?:and )?for (.+?) instead$", t)
    if m and last:
        x = next(g for g in m.groups() if g)
        if last["intent"] == "navigate" and last.get("page") in M.PAGE:
            keys = {f["key"] for f in M.PAGE[last["page"]]["filters"]}
            nf = dict(last.get("filters") or {})
            reg, cat, per = N.find_region(x), N.find_category(x), N.parse_period(x)
            if reg and "region" in keys: nf["region"] = reg
            if cat and "category" in keys: nf["category"] = cat
            if per and "date" in keys: nf["date_from"], nf["date_to"] = per[0], per[1]
            if nf != (last.get("filters") or {}):
                return [(query, {"intent": "navigate", "t": t, "slots": {"page": last["page"], "periods": [], "force_filters": nf, "force_sort": None,
                                                                            "note": f"Same view as before with {x}."}})]
        nq = substitute(last["query"], x)
        if nq:
            return [(nq, route(nq, ctx))] + [("__note__", f"Follow-up: re-ran “{last['query']}” as “{nq}”.")]
    m = re.match(r"^(?:now|and|then|also|next)\s+(?:show|open|list|display|see|give)?\s*(?:me\s+)?(?:the\s+|my\s+)?(.+)$", t)
    if m and ctx.filters:
        target = m.group(1)
        carry = {k: v for k, v in ctx.filters.items() if k in ("date_from", "date_to", "region", "category", "channel", "segment")}
        group = next((g for rx, g in ((r"^products?\b|^items?\b", "product"), (r"^categor", "category"), (r"^regions?\b|^states?\b", "region"), (r"^channels?\b", "channel"), (r"^segments?\b", "segment")) if re.search(rx, target)), None)
        if group:
            f = {**{k: v for k, v in carry.items() if k != group}, "metric": "revenue", "group_by": group}
            return [(query, {"intent": "navigate", "t": t, "slots": {"page": "analytics", "periods": [], "force_filters": f, "force_sort": "current:desc",
                                                                        "note": "Kept your filters: " + (", ".join(f"{k}={v}" for k, v in carry.items()) or "none") + f"; showing {group}s."}})]
        page, conf = detect_page(target)
        if page and page != ctx.page:
            keys = {x["key"] for x in M.PAGE[page]["filters"]}
            keys |= {"date_from", "date_to"} if "date" in keys else set()
            kept = {k: v for k, v in carry.items() if k in keys}
            dropped = [k for k in carry if k not in keys]
            note = ("Kept: " + ", ".join(f"{k}={v}" for k, v in kept.items()) if kept else "No filters carried") + (f". Dropped (not on {M.PAGE[page]['title']}): {', '.join(dropped)}." if dropped else ".")
            return [(query, {"intent": "navigate", "t": t, "slots": {"page": page, "periods": [], "force_filters": {**kept, **build_filters(page, target, N.parse_periods(target))}, "note": note}})]
    return None


def run(query, ctx):
    t0 = time.perf_counter()
    fixes = []
    if not re.match(r"(?is)\s*(sql\s*:|run sql|query\s*:|select\b|with\b)", query):
        query, fixes = spell.correct(query)
    fu = followup(query, ctx)
    fu_note = None
    if fu and fu[-1][0] == "__note__":
        fu_note = fu.pop()[1]
    steps = fu or plan_steps(query, ctx)
    if fu and len(fu) == 1 and fu[0][0] != query:
        query = fu[0][0]
    plan = steps[0][1] if len(steps) == 1 else {"intent": "multi:" + "+".join(p["intent"] for _, p in steps)}
    yield {"t": "intent", "intent": plan["intent"]}
    if fixes:
        yield step("Understood as: " + ", ".join(f"“{a}” → “{b}”" for a, b in fixes))
    if fu_note:
        yield step(fu_note)
    trace, srcs, last_filters, texts = [], [], None, []
    n_steps, page = 0, ctx.page
    used_llm = 0
    try:
        for ev in run_steps(steps, ctx):
            if ev["t"] == "step":
                n_steps += 1
                if ev["text"].startswith("Interpreting with LLM"):
                    used_llm = 1
            if ev["t"] == "action" and ev.get("action") == "navigate":
                page = ev["page"]; last_filters = ev.get("filters")
            if ev["t"] == "step":
                trace.append(ev["text"])
            if ev["t"] == "card" and ev["card"]["type"] == "sources":
                srcs += ev["card"]["items"]
            if ev["t"] == "text":
                texts.append(ev["text"])
            yield ev
    except S.PermissionDenied as e:
        yield say(f"⛔ {e}")
    except Exception as e:
        yield say(f"Error: {e}")
    ms = round((time.perf_counter() - t0) * 1000, 1)
    if plan["intent"] not in ("explain_last", "smalltalk", "meta", "help", "clarify", "refuse", "unknown", "export"):
        LAST[ctx.user["username"]] = {"query": query, "intent": plan["intent"], "page": page, "filters": last_filters, "steps": trace, "sources": srcs}
    conf, why_low = confidence(steps, used_llm)
    log_id = ex("INSERT INTO agent_log(ts,username,query,intent,page,latency_ms,steps,used_llm,confidence) VALUES(?,?,?,?,?,?,?,?,?)",
                (S.now(), ctx.user["username"], query[:300], plan["intent"], page, ms, n_steps, used_llm, conf))
    review_id = None
    if conf < M.REVIEW_CONFIDENCE and not ctx.no_review:
        review_id = S.queue_review(ctx.user, log_id, query, plan["intent"], page, " ".join(texts), conf, "auto", f"Low confidence ({conf:.2f}): {why_low}")
        yield step(f"Low confidence ({conf:.2f}) — sent to an admin for human review (#{review_id})")
    yield {"t": "done", "intent": plan["intent"], "latency_ms": ms, "page": page, "log_id": log_id, "confidence": conf, "review_id": review_id}


def confidence(steps, used_llm):
    """How sure the router was. Rules = 1.0; classifier = its score; LLM rewrite = 0.5; nothing matched = 0.2."""
    worst, why = 1.0, ""
    for _, p in steps:
        if p["intent"] == "unknown":
            c, w = 0.2, "no rule or classifier match"
        elif p.get("classified"):
            c, w = round(min(0.95, 0.35 + p["classified"]["score"]), 2), "understood by the semantic classifier, not an exact rule"
        elif p["intent"] == "navigate" and p["slots"].get("conf", 1) < 0.5:
            c, w = round(0.3 + p["slots"]["conf"], 2), "page guessed by search, no exact keyword"
        else:
            c, w = 1.0, ""
        if c < worst:
            worst, why = c, w
    if used_llm:
        worst, why = min(worst, 0.5), "rewritten by the LLM fallback"
    return worst, why


# ---------------- confirmations ----------------
def confirm(token, user, edits=None):
    p = PENDING.pop(token, None)
    if not p or p["user"] != user["username"]:
        return [say("This confirmation expired. Ask again.")]
    op = p["op"]
    out = []
    try:
        if op["kind"] == "create":
            data = {**op["data"], **(edits or {})}
            r = S.create_record(user, op["entity"], data, via="agent")
            e = M.ENTITIES[op["entity"]]
            out += [say(f"✅ Created **{S.record_label(op['entity'], r)}**."), nav(e["page"], {"status": r.get("status")} if op["entity"] == "purchase_orders" else {})]
        elif op["kind"] == "bulk_create":
            made = [S.create_record(user, op["entity"], d, via="agent") for d in op["items"]]
            out += [say(f"✅ Created {len(made)} PO drafts: " + ", ".join(m["po_no"] for m in made) + "." + (" Admin approval needed to place them." if user["role"] != "admin" else "")),
                    nav("procurement", {"status": "Draft"})]
        elif op["kind"] == "write":
            res = S.write_or_request(user, op["entity"], op["id"], op["action"], op.get("changes"), op.get("reason", ""), via="agent")
            def show(diff):
                rec = S.record_view(op["entity"], op["id"], diff)
                if rec and not rec["deleted"]:
                    out.append({"t": "card", "card": rec})
                    out.append(nav(rec["page"], rec["filters"]))
                else:
                    out.append({"t": "action", "action": "refresh"})
            if res["mode"] == "applied":
                out.append(say(f"✅ {'Deleted' if op['action'] == 'delete' else 'Updated'} **{S.record_label(op['entity'], res['result']) if op['action'] != 'delete' else res['result']['label']}**. Audit-logged."))
                show({k: {"old": None, "new": v} for k, v in (op.get("changes") or {}).items()})
            elif res["mode"] == "auto_approved":
                out.append(say(f"✅ Change request **#{res['result']['id']}** **auto-approved by policy** and applied ({res['result']['review_note'].replace('Auto-approved: ', '')})."))
                show(json.loads(res["result"]["changes"] or "{}"))
            else:
                out += [say(f"📨 Change request **#{res['result']['id']}** submitted. It is above the auto-approval limits, so an admin will review it."), nav("approvals", {})]
        elif op["kind"] == "review":
            S.review_request(user, op["req_id"], op["decision"], op.get("note", ""), via="agent")
            out += [say(f"✅ Request #{op['req_id']} {'approved and applied' if op['decision'] == 'approve' else 'rejected'}."), nav("approvals", {})]
        elif op["kind"] == "review_all":
            for i in op["ids"]:
                S.review_request(user, i, "approve", "bulk approve", via="agent")
            out += [say(f"✅ Approved {len(op['ids'])} requests."), nav("approvals", {})]
        N.invalidate(); R.build()
    except (S.PermissionDenied, S.NotFound, ValueError) as e:
        out.append(say(f"⛔ {e}"))
    return out

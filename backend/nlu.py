"""Fast rule-based slot extraction: dates, periods, regions, statuses, categories, products, suppliers, numbers."""
import re, difflib
from datetime import date, timedelta
import metadata as M
from db import q, today

MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
REGION_ALIAS = {"karnataka": "Karnataka", "bangalore": "Karnataka", "bengaluru": "Karnataka", "mysore": "Karnataka", "mysuru": "Karnataka",
                "maharashtra": "Maharashtra", "mumbai": "Maharashtra", "pune": "Maharashtra", "nagpur": "Maharashtra",
                "delhi": "Delhi", "ncr": "Delhi", "tamil nadu": "Tamil Nadu", "tamilnadu": "Tamil Nadu", "chennai": "Tamil Nadu", "tn": "Tamil Nadu",
                "gujarat": "Gujarat", "ahmedabad": "Gujarat", "surat": "Gujarat", "telangana": "Telangana", "hyderabad": "Telangana",
                "west bengal": "West Bengal", "kolkata": "West Bengal", "bengal": "West Bengal"}
NUMWORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "twelve": 12, "fifteen": 15, "twenty": 20, "thirty": 30}


def norm(text):
    t = text.lower()
    for w, n in NUMWORDS.items():
        t = re.sub(rf"\b{w}\b", str(n), t)
    return t


def month_start(d):
    return d.replace(day=1)


def add_months(d, n):
    y, m = divmod(d.month - 1 + n, 12)
    return date(d.year + y, m + 1, 1)


def month_end(d):
    return add_months(d, 1) - timedelta(days=1)


def quarter_start(d):
    return date(d.year, 3 * ((d.month - 1) // 3) + 1, 1)


def parse_period(t):
    """Return (from, to, label) for a single period expression in text t, or None."""
    T = today()
    m = re.search(r"\b(?:last|past|previous|prior)\s+(\d+)\s*(day|week|month|year|quarter)s?\b", t)
    if m:
        n, u = int(m.group(1)), m.group(2)
        days = {"day": 1, "week": 7, "month": 30.44, "quarter": 91.3, "year": 365}[u] * n
        return ((T - timedelta(days=int(days) - 1)).isoformat(), T.isoformat(), f"last {n} {u}s")
    if re.search(r"\b(today)\b", t):
        return (T.isoformat(), T.isoformat(), "today")
    if re.search(r"\byesterday\b", t):
        y = T - timedelta(days=1); return (y.isoformat(), y.isoformat(), "yesterday")
    if re.search(r"\b(this|current) week\b", t):
        s = T - timedelta(days=T.weekday()); return (s.isoformat(), T.isoformat(), "this week")
    if re.search(r"\b(last|previous) week\b", t):
        s = T - timedelta(days=T.weekday() + 7); return (s.isoformat(), (s + timedelta(days=6)).isoformat(), "last week")
    if re.search(r"\b(this|current) month\b|\bmtd\b", t):
        return (month_start(T).isoformat(), T.isoformat(), "this month")
    if re.search(r"\b(last|previous|prior) month\b", t):
        s = add_months(month_start(T), -1); return (s.isoformat(), month_end(s).isoformat(), "last month")
    if re.search(r"\b(this|current) quarter\b|\bqtd\b", t):
        return (quarter_start(T).isoformat(), T.isoformat(), "this quarter")
    if re.search(r"\b(last|previous|prior) quarter\b", t):
        s = add_months(quarter_start(T), -3); return (s.isoformat(), (quarter_start(T) - timedelta(days=1)).isoformat(), "last quarter")
    if re.search(r"\b(this|current) year\b|\bytd\b|year to date", t):
        return (date(T.year, 1, 1).isoformat(), T.isoformat(), "this year")
    if re.search(r"\b(last|previous|prior) year\b", t):
        return (date(T.year - 1, 1, 1).isoformat(), date(T.year - 1, 12, 31).isoformat(), "last year")
    m = re.search(r"\bq([1-4])\s*(?:fy)?\s*(20\d\d)?\b", t)
    if m:
        y = int(m.group(2) or T.year); s = date(y, 3 * (int(m.group(1)) - 1) + 1, 1)
        if s > T and not m.group(2):
            s = date(y - 1, s.month, 1)
        return (s.isoformat(), month_end(add_months(s, 2)).isoformat(), f"Q{m.group(1)} {s.year}")
    m = re.search(r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:uary|ruary|ch|il|e|y|ust|t|tember|ember|ober)?\.?\s*(20\d\d)?\b", t)
    if m and not re.search(r"\bmay (i|we|you)\b", t):
        y = int(m.group(2)) if m.group(2) else T.year
        s = date(y, MONTHS[m.group(1)], 1)
        if s > T and not m.group(2):
            s = date(y - 1, s.month, 1)
        return (s.isoformat(), min(month_end(s), T).isoformat(), s.strftime("%b %Y"))
    m = re.search(r"\b(20\d\d)\b", t)
    if m:
        y = int(m.group(1)); return (date(y, 1, 1).isoformat(), min(date(y, 12, 31), T).isoformat(), str(y))
    return None


def parse_periods(t):
    """Handle 'A vs B'. Returns list of 1 or 2 periods."""
    parts = re.split(r"\bvs\.?\b|\bversus\b|\bcompared (?:to|with)\b|\bagainst\b", t)
    if len(parts) < 2 and re.search(r"\bwith\b", t):
        w = re.split(r"\bwith\b", t, maxsplit=1)
        if parse_period(w[0]) and parse_period(w[1]):
            parts = w
    if len(parts) >= 2:
        a, b = parse_period(parts[0]), parse_period(parts[1])
        if a and not b and re.search(r"\b(previous|prior|last)\b\s*(period)?", parts[1]):
            return [a]
        return [p for p in (a, b) if p]
    m = re.search(r"\b(this|last) (month|quarter|year|week) and (this|last) (month|quarter|year|week)\b", t)
    if m:
        return [parse_period(f"{m.group(1)} {m.group(2)}"), parse_period(f"{m.group(3)} {m.group(4)}")]
    p = parse_period(t)
    return [p] if p else []


def find_region(t):
    for k in sorted(REGION_ALIAS, key=len, reverse=True):
        if re.search(rf"\b{re.escape(k)}\b", t):
            return REGION_ALIAS[k]
    return None


def find_option(t, options):
    for o in sorted(options, key=len, reverse=True):
        if re.search(rf"\b{re.escape(o.lower())}\b", t):
            return o
    return None


def find_category(t):
    c = find_option(t, M.CATEGORIES)
    if c:
        return c
    alias = {"raw material": "Raw Materials", "raw": "Raw Materials", "electric": "Electrical", "electronic": "Electrical", "component": "Components", "packing": "Packaging",
             "packag": "Packaging", "chemical": "Chemicals", "safety": "Safety", "ppe": "Safety"}
    for k, v in alias.items():
        if k in t:
            return v
    return None


STATUS_WORDS = {
    "sales_orders": {"delivered": "Delivered", "cancelled": "Cancelled", "canceled": "Cancelled", "processing": "Processing", "shipped": "Shipped", "returned": "Returned", "returns": "Returned"},
    "purchase_orders": {"draft": "Draft", "drafts": "Draft", "pending": "Pending", "approved": "Approved", "received": "Received", "cancelled": "Cancelled", "canceled": "Cancelled"},
    "shipments": {"delayed": "Delayed", "late": "Delayed", "in transit": "In Transit", "transit": "In Transit", "delivered": "Delivered", "pending": "Pending"},
    "change_requests": {"pending": "Pending", "approved": "Approved", "rejected": "Rejected"},
    "products": {"out of stock": "Out of Stock", "low stock": "Low Stock", "in stock": "In Stock"},
}


def find_status(t, entity):
    for k in sorted(STATUS_WORDS.get(entity, {}), key=len, reverse=True):
        if re.search(rf"\b{k}\b", t):
            return STATUS_WORDS[entity][k]
    return None


_cache = {}
GENERIC = set("supplier suppliers supplies supply vendor vendors product products item items customer customers client clients order orders sales stock price "
              "rating show open find compare best top industries enterprises solutions traders works systems corp manufacturing engineering parts gear "
              "co ltd inc pvt the for with and from".split())


def _names(table, code):
    key = table
    if key not in _cache:
        _cache[key] = q(f"SELECT id, {code} code, name FROM {table} WHERE is_deleted=0")
    return _cache[key]


def invalidate():
    _cache.clear()


def find_entity_name(t, table, code):
    rows = _names(table, code)
    for r in rows:  # exact code
        if re.search(rf"\b{re.escape(r['code'].lower())}\b", t):
            return r
    best, score = None, 0
    words = set(re.findall(r"[a-z0-9]+", t)) - GENERIC
    for r in rows:
        nw = [w for w in re.findall(r"[a-z0-9]+", r["name"].lower()) if w not in ("ltd", "co", "inc", "pvt", "the")]
        if not nw:
            continue
        hit = 0
        for w in nw:
            if w in words or any(difflib.SequenceMatcher(None, w, x).ratio() > 0.85 for x in words if len(x) > 3):
                hit += 1
        s = hit / len(nw) + (0.3 if r["name"].lower() in t else 0)
        if hit and s > score:
            best, score = r, s
    return best if score >= 0.5 else None


def find_product(t):
    return find_entity_name(t, "products", "sku")


def find_supplier(t):
    return find_entity_name(t, "suppliers", "code")


def find_customer(t):
    return find_entity_name(t, "customers", "code")


def find_numbers(t):
    return [float(x.replace(",", "")) for x in re.findall(r"(?<![\w-])(\d[\d,]*\.?\d*)(?![\w-])", t)]


def find_code(t):
    m = re.search(r"\b(po|so|shp|sup|cust|exp)-?\s?(\d{1,5})\b", t, re.I)
    if not m:
        return None
    p = m.group(1).upper()
    ent = {"PO": "purchase_orders", "SO": "sales_orders", "SHP": "shipments", "SUP": "suppliers", "CUST": "customers", "EXP": "expenses"}[p]
    width = {"SUP": 3, "CUST": 4}.get(p, 5)
    return ent, f"{p}-{int(m.group(2)):0{width}d}"


def find_sort(t):
    m = re.search(r"sort(?:ed)? by ([a-z _]+?)(?: (asc|ascending|desc|descending|high to low|low to high))?$", t)
    if m:
        return m.group(1).strip().replace(" ", "_"), "asc" if (m.group(2) or "").startswith(("asc", "low")) else "desc"
    return None

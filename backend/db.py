"""SQLite storage + synthetic 18-month supply-chain dataset."""
import os, sqlite3, random, hashlib, json, math
from datetime import date, timedelta, datetime

DB_PATH = os.environ.get("BIZPILOT_DB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "bizpilot.db"))
MONTHS_OF_DATA = int(os.environ.get("BIZPILOT_MONTHS", "25"))


def connect():
    con = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    con.row_factory = sqlite3.Row
    return con


def q(sql, args=()):
    con = connect()
    try:
        return [dict(r) for r in con.execute(sql, args).fetchall()]
    finally:
        con.close()


def q1(sql, args=()):
    rows = q(sql, args)
    return rows[0] if rows else None


VERSION = [0]  # bumped on every business-data write; used to invalidate the page-data cache


def ex(sql, args=()):
    if "agent_log" not in sql and "agent_reviews" not in sql:
        VERSION[0] += 1
    con = connect()
    try:
        cur = con.execute(sql, args)
        con.commit()
        return cur.lastrowid
    finally:
        con.close()


def hash_pw(pw):
    return hashlib.sha256(("bizpilot::" + pw).encode()).hexdigest()


def today():
    return date.today()


SCHEMA = """
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE, name TEXT, role TEXT, password_hash TEXT, email TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, sku TEXT UNIQUE, name TEXT, category TEXT, unit TEXT,
  unit_price REAL, cost_price REAL, stock INTEGER, reorder_level INTEGER, warehouse TEXT, is_deleted INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS suppliers(id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT, category TEXT, city TEXT,
  country TEXT, rating REAL, lead_time_days INTEGER, on_time_rate REAL, email TEXT, phone TEXT, is_deleted INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS supplier_products(supplier_id INTEGER, product_id INTEGER, price REAL, PRIMARY KEY(supplier_id, product_id));
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT, segment TEXT, city TEXT,
  region TEXT, email TEXT, is_deleted INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sales_orders(id INTEGER PRIMARY KEY, order_no TEXT UNIQUE, customer_id INTEGER, product_id INTEGER,
  qty INTEGER, unit_price REAL, amount REAL, region TEXT, channel TEXT, status TEXT, order_date TEXT, is_deleted INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS purchase_orders(id INTEGER PRIMARY KEY, po_no TEXT UNIQUE, supplier_id INTEGER, product_id INTEGER,
  qty INTEGER, unit_cost REAL, amount REAL, status TEXT, order_date TEXT, expected_date TEXT, created_by TEXT, notes TEXT,
  is_deleted INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS shipments(id INTEGER PRIMARY KEY, shipment_no TEXT UNIQUE, sales_order_id INTEGER, carrier TEXT,
  origin TEXT, destination TEXT, status TEXT, ship_date TEXT, eta TEXT, delivered_date TEXT, delay_days INTEGER, is_deleted INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY, code TEXT UNIQUE, category TEXT, amount REAL, date TEXT, note TEXT, is_deleted INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS change_requests(id INTEGER PRIMARY KEY, entity TEXT, record_id INTEGER, record_label TEXT, action TEXT,
  changes TEXT, reason TEXT, status TEXT, requested_by TEXT, reviewed_by TEXT, review_note TEXT, created_at TEXT, reviewed_at TEXT, via TEXT);
CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY, ts TEXT, username TEXT, action TEXT, entity TEXT, record_label TEXT, details TEXT, via TEXT);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, ts TEXT, recipient TEXT, kind TEXT, title TEXT, body TEXT, page TEXT, filters TEXT,
  entity TEXT, record_id INTEGER, request_id INTEGER, is_read INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS agent_log(id INTEGER PRIMARY KEY, ts TEXT, username TEXT, query TEXT, intent TEXT, page TEXT, latency_ms REAL, steps INTEGER, used_llm INTEGER DEFAULT 0,
  confidence REAL, feedback TEXT);
CREATE TABLE IF NOT EXISTS agent_reviews(id INTEGER PRIMARY KEY, ts TEXT, username TEXT, log_id INTEGER, query TEXT, intent TEXT, page TEXT, answer TEXT,
  confidence REAL, source TEXT, reason TEXT, status TEXT, reviewer TEXT, verdict_note TEXT, reviewed_at TEXT);
CREATE INDEX IF NOT EXISTS ix_so_date ON sales_orders(order_date);
CREATE INDEX IF NOT EXISTS ix_so_prod ON sales_orders(product_id);
CREATE INDEX IF NOT EXISTS ix_po_date ON purchase_orders(order_date);
CREATE INDEX IF NOT EXISTS ix_sh_so ON shipments(sales_order_id);
"""

USERS = [
    ("admin", "Aishwarya Rao", "admin", "admin123"),
    ("manager", "Michael Smith", "manager", "manager123"),
    ("staff", "Ravi Kumar", "staff", "staff123"),
    ("viewer", "Neha Gupta", "viewer", "viewer123"),
]

# sku, name, category, unit, sell price, cost price, warehouse, popularity
PRODUCTS = [
    ("SR-001", "Steel Rod", "Raw Materials", "pcs", 520, 380, "Bengaluru WH", 9),
    ("PR-002", "Plastic Resin", "Raw Materials", "kg", 260, 185, "Mumbai WH", 8),
    ("CW-003", "Copper Wire", "Electrical", "m", 410, 300, "Bengaluru WH", 7),
    ("AS-004", "Aluminium Sheet", "Raw Materials", "pcs", 640, 470, "Delhi WH", 6),
    ("SS-005", "Stainless Steel Pipe", "Raw Materials", "pcs", 880, 650, "Mumbai WH", 5),
    ("BR-006", "Brass Rod", "Raw Materials", "pcs", 720, 540, "Delhi WH", 3),
    ("PV-007", "PVC Pipe", "Raw Materials", "pcs", 180, 120, "Bengaluru WH", 6),
    ("RB-008", "Rubber Gasket", "Components", "pcs", 45, 28, "Bengaluru WH", 8),
    ("BB-009", "Ball Bearing 6204", "Components", "pcs", 150, 95, "Mumbai WH", 7),
    ("HB-010", "Hex Bolt M10", "Components", "box", 340, 230, "Delhi WH", 6),
    ("SP-011", "Spring Washer", "Components", "box", 120, 75, "Bengaluru WH", 4),
    ("GB-012", "Gear Box Assembly", "Components", "pcs", 6800, 5100, "Mumbai WH", 2),
    ("EM-013", "Electric Motor 2HP", "Electrical", "pcs", 9200, 7000, "Delhi WH", 2),
    ("CB-014", "Circuit Breaker 32A", "Electrical", "pcs", 980, 700, "Bengaluru WH", 4),
    ("LC-015", "LED Panel 40W", "Electrical", "pcs", 1250, 880, "Mumbai WH", 4),
    ("CT-016", "Control Cable 4C", "Electrical", "m", 95, 62, "Delhi WH", 6),
    ("SW-017", "Industrial Switch", "Electrical", "pcs", 560, 390, "Bengaluru WH", 3),
    ("CB-018", "Corrugated Box L", "Packaging", "pcs", 38, 22, "Bengaluru WH", 9),
    ("SF-019", "Stretch Film Roll", "Packaging", "roll", 420, 290, "Mumbai WH", 5),
    ("PT-020", "Wooden Pallet", "Packaging", "pcs", 650, 460, "Delhi WH", 4),
    ("BT-021", "Bubble Wrap Roll", "Packaging", "roll", 380, 250, "Bengaluru WH", 4),
    ("ET-022", "Epoxy Resin", "Chemicals", "kg", 790, 560, "Mumbai WH", 3),
    ("IP-023", "Industrial Paint", "Chemicals", "l", 450, 310, "Delhi WH", 4),
    ("LB-024", "Lubricant Oil", "Chemicals", "l", 280, 190, "Bengaluru WH", 5),
    ("AD-025", "Adhesive Sealant", "Chemicals", "tube", 210, 135, "Mumbai WH", 4),
    ("SG-026", "Safety Gloves", "Safety", "pair", 85, 50, "Bengaluru WH", 7),
    ("SH-027", "Safety Helmet", "Safety", "pcs", 340, 220, "Delhi WH", 4),
    ("SG-028", "Safety Goggles", "Safety", "pcs", 190, 120, "Mumbai WH", 3),
]

SUPPLIERS = [
    ("SUP-001", "Global Metals Ltd.", "Raw Materials", "Mumbai", "India", 4.6, 7, 0.95),
    ("SUP-002", "Prime Plastics", "Raw Materials", "Ahmedabad", "India", 4.2, 9, 0.88),
    ("SUP-003", "Steel Supplies Co.", "Raw Materials", "Jamshedpur", "India", 4.4, 6, 0.92),
    ("SUP-004", "MetalWorks Inc.", "Raw Materials", "Pune", "India", 3.9, 11, 0.81),
    ("SUP-005", "Asia Components", "Components", "Chennai", "India", 4.5, 8, 0.93),
    ("SUP-006", "Precision Parts Pvt", "Components", "Coimbatore", "India", 4.1, 10, 0.86),
    ("SUP-007", "VoltEdge Electricals", "Electrical", "Bengaluru", "India", 4.7, 5, 0.96),
    ("SUP-008", "Shakti Cables", "Electrical", "Delhi", "India", 4.0, 9, 0.84),
    ("SUP-009", "PackRight Solutions", "Packaging", "Hyderabad", "India", 4.3, 4, 0.94),
    ("SUP-010", "GreenWrap Packaging", "Packaging", "Kolkata", "India", 3.8, 12, 0.79),
    ("SUP-011", "ChemCore Industries", "Chemicals", "Vadodara", "India", 4.4, 8, 0.91),
    ("SUP-012", "Unichem Traders", "Chemicals", "Mumbai", "India", 3.7, 13, 0.77),
    ("SUP-013", "SafeGuard Gear", "Safety", "Noida", "India", 4.5, 6, 0.93),
    ("SUP-014", "Orient Steel Exports", "Raw Materials", "Shenzhen", "China", 4.0, 21, 0.83),
    ("SUP-015", "Sigma Industrial", "Components", "Gurugram", "India", 4.2, 7, 0.90),
]

REGIONS = {  # region: (weight, cities)
    "Karnataka": (0.24, ["Bengaluru", "Mysuru", "Hubballi"]),
    "Maharashtra": (0.22, ["Mumbai", "Pune", "Nagpur"]),
    "Delhi": (0.16, ["New Delhi", "Dwarka"]),
    "Tamil Nadu": (0.13, ["Chennai", "Coimbatore"]),
    "Gujarat": (0.10, ["Ahmedabad", "Surat"]),
    "Telangana": (0.09, ["Hyderabad", "Warangal"]),
    "West Bengal": (0.06, ["Kolkata", "Howrah"]),
}
CHANNELS = [("Direct Sales", 0.45), ("Distributor", 0.30), ("Online Portal", 0.25)]
SEGMENTS = ["Enterprise", "Wholesale", "Retail", "Distributor"]
CARRIERS = ["BlueDart", "Delhivery", "DTDC", "Gati", "Ecom Express"]
EXPENSE_CATS = {"Logistics": 0.30, "Salaries": 0.34, "Rent": 0.10, "Marketing": 0.10, "Utilities": 0.06, "Administrative": 0.10}

FIRST = ["Rohan", "Priya", "Karan", "Sneha", "Arjun", "Neha", "Vikram", "Ananya", "Rahul", "Divya", "Aditya", "Meera",
         "Sanjay", "Kavya", "Nikhil", "Pooja", "Harsh", "Isha", "Manoj", "Tanvi"]
COMPANY = ["Industries", "Enterprises", "Manufacturing", "Engineering", "Traders", "Fabricators", "Infra", "Works", "Systems", "Corp"]
PREFIX = ["Apex", "Vertex", "Sunrise", "Nova", "Zenith", "Omega", "Pioneer", "Trident", "Lotus", "Everest", "Crest", "Silverline",
          "Bharat", "Kaveri", "Indus", "Deccan", "Coastal", "Metro", "Unity", "Shree"]


def _wchoice(rng, items):
    r = rng.random() * sum(w for _, w in items)
    for it, w in items:
        r -= w
        if r <= 0:
            return it
    return items[-1][0]


def init_db(force=False):
    if force and os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    fresh = not os.path.exists(DB_PATH)
    con = connect()
    con.executescript(SCHEMA)
    for tbl, col in (("users", "email TEXT"), ("users", "created_at TEXT"), ("agent_log", "confidence REAL"), ("agent_log", "feedback TEXT")):
        try:
            con.execute(f"ALTER TABLE {tbl} ADD COLUMN {col}")
        except sqlite3.OperationalError:
            pass
    con.commit()
    if fresh or not con.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
        seed(con)
    con.close()


def seed(con):
    rng = random.Random(42)
    end = today() - timedelta(days=1)
    start = (end.replace(day=1) - timedelta(days=30 * (MONTHS_OF_DATA - 1))).replace(day=1)
    for u, n, r, p in USERS:
        con.execute("INSERT INTO users(username,name,role,password_hash,email) VALUES(?,?,?,?,?)", (u, n, r, hash_pw(p), f"{u}@bizpilot.demo"))

    for i, (sku, name, cat, unit, price, cost, wh, pop) in enumerate(PRODUCTS, 1):
        con.execute("INSERT INTO products(id,sku,name,category,unit,unit_price,cost_price,stock,reorder_level,warehouse) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (i, sku, name, cat, unit, price, cost, 0, 0, wh))
    for i, (code, name, cat, city, country, rating, lead, otr) in enumerate(SUPPLIERS, 1):
        slug = name.lower().replace(" ", "").replace(".", "")[:14]
        con.execute("INSERT INTO suppliers(id,code,name,category,city,country,rating,lead_time_days,on_time_rate,email,phone) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (i, code, name, cat, city, country, rating, lead, otr, f"sales@{slug}.com", f"+91 9{rng.randint(100000000, 999999999)}"))
    # supplier catalog: every product gets 2-4 suppliers (category match first)
    for pid, p in enumerate(PRODUCTS, 1):
        cands = [i for i, s in enumerate(SUPPLIERS, 1) if s[2] == p[2]]
        others = [i for i in range(1, len(SUPPLIERS) + 1) if i not in cands]
        rng.shuffle(others)
        chosen = (cands + others[:2])[:4] if len(cands) < 2 else cands[:4]
        if len(chosen) < 2:
            chosen += others[:2 - len(chosen)]
        for sid in chosen:
            factor = rng.uniform(0.88, 1.12)
            if SUPPLIERS[sid - 1][4] == "China":
                factor *= 0.9
            con.execute("INSERT INTO supplier_products VALUES(?,?,?)", (sid, pid, round(p[5] * factor, 2)))

    # customers
    regions = list(REGIONS.items())
    custs = []
    for i in range(1, 81):
        region = _wchoice(rng, [(r, v[0]) for r, v in regions])
        city = rng.choice(REGIONS[region][1])
        name = f"{rng.choice(PREFIX)} {rng.choice(COMPANY)}"
        seg = rng.choice(SEGMENTS)
        con.execute("INSERT INTO customers(id,code,name,segment,city,region,email) VALUES(?,?,?,?,?,?,?)",
                    (i, f"CUST-{i:04d}", name, seg, city, region, f"{rng.choice(FIRST).lower()}@{name.split()[0].lower()}.in"))
        custs.append((i, region, seg))
    by_region = {}
    for c in custs:
        by_region.setdefault(c[1], []).append(c)

    # sales orders + shipments
    total_days = (end - start).days + 1
    prod_w = [(i, p[7]) for i, p in enumerate(PRODUCTS, 1)]
    so_id = 0
    sh_rows = []
    anomaly_start = end - timedelta(days=60)
    for d in range(total_days):
        day = start + timedelta(days=d)
        growth = 1 + 0.35 * d / total_days
        season = 1 + 0.18 * math.sin((day.month - 3) / 12 * 2 * math.pi) + (0.15 if day.month in (10, 11) else 0) - (0.12 if day.month == 6 else 0)
        weekday = 0.55 if day.weekday() == 6 else 1.0
        n = max(0, int(rng.gauss(11 * growth * season * weekday, 2.5)))
        for _ in range(n):
            region = _wchoice(rng, [(r, v[0]) for r, v in regions])
            if region == "Maharashtra" and day >= anomaly_start and rng.random() < 0.30:
                region = _wchoice(rng, [(r, v[0]) for r, v in regions if r != "Maharashtra"])
            cid, _, seg = rng.choice(by_region.get(region) or custs)
            pid = _wchoice(rng, prod_w)
            p = PRODUCTS[pid - 1]
            base_qty = 3 if p[4] > 5000 else (40 if p[4] < 100 else 12)
            qty = max(1, int(rng.expovariate(1 / base_qty)) + 1)
            if seg in ("Enterprise", "Distributor"):
                qty = int(qty * 1.6) + 1
            price = round(p[4] * rng.uniform(0.94, 1.04), 2)
            age = (end - day).days
            if rng.random() < 0.03:
                status = "Cancelled"
            elif age > 14:
                status = "Returned" if rng.random() < 0.02 else "Delivered"
            elif age > 5:
                status = rng.choice(["Delivered", "Delivered", "Shipped"])
            else:
                status = rng.choice(["Processing", "Shipped", "Processing"])
            so_id += 1
            channel = _wchoice(rng, CHANNELS)
            con.execute("INSERT INTO sales_orders(id,order_no,customer_id,product_id,qty,unit_price,amount,region,channel,status,order_date) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (so_id, f"SO-{so_id:05d}", cid, pid, qty, price, round(qty * price, 2), region, channel, status, day.isoformat()))
            if status == "Cancelled":
                continue
            carrier = rng.choice(CARRIERS)
            origin = p[6]
            ship = day + timedelta(days=rng.randint(0, 2))
            transit = rng.randint(2, 5)
            delay = 0
            if rng.random() < 0.08:
                delay = rng.randint(1, 4)
            if region == "Maharashtra" and day >= anomaly_start and rng.random() < 0.55:
                delay = rng.randint(3, 9)
                carrier = "Gati" if rng.random() < 0.7 else carrier
            eta = ship + timedelta(days=transit)
            delivered = eta + timedelta(days=delay)
            if status in ("Delivered", "Returned"):
                sh_status, dd = "Delivered", delivered.isoformat()
            elif status == "Shipped":
                sh_status = "Delayed" if delay and delivered > end else ("In Transit" if delivered > end else "Delivered")
                dd = delivered.isoformat() if sh_status == "Delivered" else None
            else:
                sh_status, dd = "Pending", None
            sh_rows.append((f"SHP-{so_id:05d}", so_id, carrier, origin, region, sh_status, ship.isoformat(), eta.isoformat(), dd, delay))
    con.executemany("INSERT INTO shipments(shipment_no,sales_order_id,carrier,origin,destination,status,ship_date,eta,delivered_date,delay_days) VALUES(?,?,?,?,?,?,?,?,?,?)", sh_rows)

    # stock levels from velocity of the last 90 days
    since = (end - timedelta(days=90)).isoformat()
    vel = {r[0]: r[1] / 90 for r in con.execute("SELECT product_id, SUM(qty) FROM sales_orders WHERE order_date>=? AND status!='Cancelled' GROUP BY product_id", (since,))}
    low = {1: 5, 2: 7, 3: 6, 4: 8, 10: 11, 19: 3}  # pid -> days of cover (demo low-stock items)
    out = {13, 27}
    for pid in range(1, len(PRODUCTS) + 1):
        v = vel.get(pid, 0.5)
        reorder = max(10, int(v * 20))
        if pid in out:
            stock = 0
        elif pid in low:
            stock = int(v * low[pid])
        else:
            stock = int(v * rng.uniform(25, 70))
        con.execute("UPDATE products SET stock=?, reorder_level=? WHERE id=?", (stock, reorder, pid))

    # purchase orders: monthly replenishment per product
    po = 0
    m = start
    while m <= end:
        for pid in range(1, len(PRODUCTS) + 1):
            if rng.random() < 0.55:
                continue
            sups = con.execute("SELECT supplier_id, price FROM supplier_products WHERE product_id=?", (pid,)).fetchall()
            sid, price = rng.choice(sups)
            v = vel.get(pid, 0.5)
            qty = max(5, int(v * rng.uniform(20, 45)))
            od = m + timedelta(days=rng.randint(0, 27))
            if od > end:
                continue
            lead = SUPPLIERS[sid - 1][6]
            age = (end - od).days
            if age > 25:
                status = "Received" if rng.random() > 0.04 else "Cancelled"
            elif age > 10:
                status = rng.choice(["Approved", "Received", "Received"])
            else:
                status = rng.choice(["Pending", "Approved", "Draft"])
            po += 1
            uc = round(price * rng.uniform(0.97, 1.05), 2)
            con.execute("INSERT INTO purchase_orders(po_no,supplier_id,product_id,qty,unit_cost,amount,status,order_date,expected_date,created_by,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (f"PO-{po:05d}", sid, pid, qty, uc, round(qty * uc, 2), status, od.isoformat(), (od + timedelta(days=lead)).isoformat(),
                         rng.choice(["manager", "staff", "admin"]), ""))
        m = (m.replace(day=28) + timedelta(days=4)).replace(day=1)

    # operating expenses monthly
    ex_id = 0
    m = start
    while m <= end:
        rev = con.execute("SELECT COALESCE(SUM(amount),0) FROM sales_orders WHERE substr(order_date,1,7)=? AND status!='Cancelled'", (m.strftime("%Y-%m"),)).fetchone()[0]
        opex = rev * rng.uniform(0.17, 0.21)
        for cat, share in EXPENSE_CATS.items():
            ex_id += 1
            amt = opex * share * rng.uniform(0.9, 1.1)
            if cat == "Logistics" and m >= anomaly_start.replace(day=1):
                amt *= 1.35
            con.execute("INSERT INTO expenses(code,category,amount,date,note) VALUES(?,?,?,?,?)",
                        (f"EXP-{ex_id:05d}", cat, round(amt, 2), m.replace(day=min(28, 5 + ex_id % 20)).isoformat(), f"{cat} - {m.strftime('%b %Y')}"))
        m = (m.replace(day=28) + timedelta(days=4)).replace(day=1)

    seed_history(con, rng, end)
    con.commit()


AGENT_HISTORY = [
    ("manager", "Show me products likely to run out in 14 days", "stockout", "inventory"), ("manager", "Compare top 3 suppliers for steel with best pricing", "compare_suppliers", "suppliers"),
    ("admin", "Why did revenue drop in Maharashtra?", "why", "logistics"), ("admin", "show pending requests", "requests", "approvals"),
    ("staff", "change price of copper wire to 425", "update", "inventory"), ("viewer", "what is on this page?", "current_page", "dashboard"),
    ("manager", "Compare revenue this month vs last month", "compare_periods", "analytics"), ("admin", "Top 5 products by revenue", "top", "analytics"),
    ("staff", "show delayed shipments", "delays", "logistics"), ("manager", "create purchase order for hex bolt", "create_po", "procurement"),
    ("admin", "what is our net profit this year?", "finance", "finance"), ("staff", "Show Karnataka sales for last quarter", "navigate", "sales"),
    ("manager", "which carrier has the most delays?", "delays", "logistics"), ("viewer", "Show last 12 months analysis", "trend", "analytics"),
    ("admin", "approve request 4", "review", "approvals"), ("staff", "find copper", "search", "inventory"), ("manager", "delete supplier GreenWrap Packaging", "delete", "suppliers"),
    ("admin", "why did logistics cost increase?", "expense_why", "finance"), ("staff", "show cancelled orders", "navigate", "sales"), ("manager", "describe the dataset", "dataset", "data"),
]


def seed_history(con, rng, end):
    """Operations already done in the app: approvals, rejections, auto-approvals, agent drafts, logins, agent queries."""
    nowdt = datetime.now()
    ts = lambda days, hours=0: (nowdt - timedelta(days=days, hours=hours)).isoformat(timespec="seconds")
    def audit(t, user, action, entity, label, details, via):
        con.execute("INSERT INTO audit_log(ts,username,action,entity,record_label,details,via) VALUES(?,?,?,?,?,?,?)", (t, user, action, entity, label, details if isinstance(details, str) else json.dumps(details), via))
    def cr(entity, rid, label, action, changes, reason, status, by, created, reviewer=None, note=None, reviewed=None, via="ui"):
        con.execute("INSERT INTO change_requests(entity,record_id,record_label,action,changes,reason,status,requested_by,reviewed_by,review_note,created_at,reviewed_at,via) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (entity, rid, label, action, json.dumps(changes), reason, status, by, reviewer, note, created, reviewed, via))
    for d in range(7, 0, -1):
        for u in ("admin", "manager", "staff", "viewer")[: 2 + d % 3]:
            audit(ts(d, 10 - d % 4), u, "login", "users", u, "", "ui")
    # pending (need admin: above policy limits, delete, status change)
    cr("products", 2, "PR-002 Plastic Resin", "update", {"unit_price": {"old": 260, "new": 300}}, "Supplier price hike (+15%)", "Pending", "staff", ts(1, 5))
    audit(ts(1, 5), "staff", "request_update", "products", "PR-002 Plastic Resin", {"unit_price": {"old": 260, "new": 300}}, "ui")
    cr("suppliers", 12, "SUP-012 Unichem Traders", "update", {"rating": {"old": 3.7, "new": 3.0}}, "Repeated late deliveries", "Pending", "manager", ts(1, 3), via="agent")
    audit(ts(1, 3), "manager", "request_update", "suppliers", "SUP-012 Unichem Traders", {"rating": {"old": 3.7, "new": 3.0}}, "agent")
    # auto-approved by policy (applied)
    con.execute("UPDATE products SET unit_price=425 WHERE id=3")
    cr("products", 3, "CW-003 Copper Wire", "update", {"unit_price": {"old": 410, "new": 425}}, "Copper index up 3.7%", "Approved", "staff", ts(6, 2), "auto-policy", "Auto-approved: Selling price change ≤ 10%", ts(6, 2), "agent")
    audit(ts(6, 2), "staff", "request_update", "products", "CW-003 Copper Wire", {"unit_price": {"old": 410, "new": 425}}, "agent")
    audit(ts(6, 2), "auto-policy", "update", "products", "CW-003 Copper Wire", {"unit_price": {"old": 410, "new": 425}}, "policy")
    # approved by admin
    con.execute("UPDATE suppliers SET lead_time_days=10 WHERE id=10")
    cr("suppliers", 10, "SUP-010 GreenWrap Packaging", "update", {"lead_time_days": {"old": 12, "new": 8}}, "New Hyderabad depot", "Approved", "manager", ts(5, 6), "admin", "Confirmed with vendor", ts(5, 1))
    con.execute("UPDATE suppliers SET lead_time_days=8 WHERE id=10")
    audit(ts(5, 6), "manager", "request_update", "suppliers", "SUP-010 GreenWrap Packaging", {"lead_time_days": {"old": 12, "new": 8}}, "ui")
    audit(ts(5, 1), "admin", "review_approve", "suppliers", "SUP-010 GreenWrap Packaging", "request #4: Confirmed with vendor", "agent")
    # rejected
    po = con.execute("SELECT id, po_no FROM purchase_orders WHERE status='Received' ORDER BY id DESC LIMIT 1").fetchone()
    cr("purchase_orders", po[0], po[1], "delete", {}, "Looks like a duplicate", "Rejected", "staff", ts(4, 4), "admin", "Goods already received; keep for audit", ts(4, 2))
    audit(ts(4, 4), "staff", "request_delete", "purchase_orders", po[1], "delete", "ui")
    audit(ts(4, 2), "admin", "review_reject", "purchase_orders", po[1], "request #5: Goods already received", "ui")
    # auto-approved stock adjustment
    r = con.execute("SELECT reorder_level FROM products WHERE id=27").fetchone()[0]
    nr = int(r * 1.2)
    con.execute("UPDATE products SET reorder_level=? WHERE id=27", (nr,))
    cr("products", 27, "SH-027 Safety Helmet", "update", {"reorder_level": {"old": r, "new": nr}}, "Monsoon site demand", "Approved", "staff", ts(3, 3), "auto-policy", "Auto-approved: Reorder level change ≤ 50%", ts(3, 3))
    audit(ts(3, 3), "auto-policy", "update", "products", "SH-027 Safety Helmet", {"reorder_level": {"old": r, "new": nr}}, "policy")
    # pending delete + pending status change
    cr("suppliers", 10, "SUP-010 GreenWrap Packaging", "delete", {}, "On-time rate below 80%", "Pending", "manager", ts(0, 20), via="agent")
    audit(ts(0, 20), "manager", "request_delete", "suppliers", "SUP-010 GreenWrap Packaging", "delete", "agent")
    pp = con.execute("SELECT id, po_no, status FROM purchase_orders WHERE status IN ('Pending','Approved') ORDER BY id DESC LIMIT 1").fetchone()
    if pp:
        cr("purchase_orders", pp[0], pp[1], "update", {"status": {"old": pp[2], "new": "Cancelled"}}, "Customer order cancelled", "Pending", "staff", ts(0, 2))
        audit(ts(0, 2), "staff", "request_update", "purchase_orders", pp[1], {"status": {"old": pp[2], "new": "Cancelled"}}, "ui")
    # admin direct edit + agent-drafted POs
    con.execute("UPDATE suppliers SET phone='+91 98450 11223' WHERE id=5")
    audit(ts(2, 7), "admin", "update", "suppliers", "SUP-005 Asia Components", {"phone": {"old": "…", "new": "+91 98450 11223"}}, "ui")
    n = con.execute("SELECT COUNT(*) FROM purchase_orders").fetchone()[0]
    for k, (pid, sid, qty, status, user) in enumerate([(10, 15, 160, "Draft", "manager"), (2, 1, 300, "Approved", "admin")], 1):
        price = con.execute("SELECT price FROM supplier_products WHERE product_id=? AND supplier_id=?", (pid, sid)).fetchone()
        price = price[0] if price else con.execute("SELECT cost_price FROM products WHERE id=?", (pid,)).fetchone()[0]
        lead = con.execute("SELECT lead_time_days FROM suppliers WHERE id=?", (sid,)).fetchone()[0]
        od = (end - timedelta(days=2)).isoformat()
        no = f"PO-{n + k:05d}"
        con.execute("INSERT INTO purchase_orders(po_no,supplier_id,product_id,qty,unit_cost,amount,status,order_date,expected_date,created_by,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (no, sid, pid, qty, price, round(qty * price, 2), status, od, (end + timedelta(days=lead - 2)).isoformat(), user, "Agent draft: low stock"))
        audit(ts(2, 3 - k), user, "create", "purchase_orders", no, {"qty": qty, "status": status}, "agent")
    # notifications that these operations would have produced
    admins = [r[0] for r in con.execute("SELECT username FROM users WHERE role='admin'")]
    for r in con.execute("SELECT id, entity, record_id, record_label, action, changes, status, requested_by, reviewed_by, review_note, created_at, reviewed_at FROM change_requests ORDER BY id").fetchall():
        rid, ent, rec, label, action, changes, status, by, rev, note, created, reviewed = r
        page = {"products": "inventory", "suppliers": "suppliers", "purchase_orders": "procurement", "customers": "customers", "users": "approvals"}.get(ent, "approvals")
        ch = json.loads(changes or "{}")
        what = "delete" if action == "delete" else ", ".join(f"{k}: {v['old']} → {v['new']}" for k, v in ch.items())
        if rev != "auto-policy":
            for a in admins:
                con.execute("INSERT INTO notifications(ts,recipient,kind,title,body,page,filters,entity,record_id,request_id,is_read) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                            (created, a, "request", f"New request #{rid} from {by}", f"{label}: {what}", "approvals", json.dumps({"status": "Pending"}), ent, rec, rid, 0 if status == "Pending" else 1))
        if status != "Pending":
            kind = "auto" if rev == "auto-policy" else status.lower()
            title = f"Request #{rid} {'auto-approved by policy' if kind == 'auto' else status.lower()}"
            con.execute("INSERT INTO notifications(ts,recipient,kind,title,body,page,filters,entity,record_id,request_id,is_read) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (reviewed or created, by, kind, title, f"{label}: {what}" + (f" · {note}" if note else ""), page, json.dumps({}), ent, rec, rid, 0))
    for i, (u, qtext, intent, page) in enumerate(AGENT_HISTORY):
        con.execute("INSERT INTO agent_log(ts,username,query,intent,page,latency_ms,steps,used_llm) VALUES(?,?,?,?,?,?,?,0)",
                    (ts(7 - i * 7 / len(AGENT_HISTORY), rng.randint(0, 5)), u, qtext, intent, page, round(rng.uniform(2, 38), 1), rng.randint(1, 5)))
    # human-in-the-loop reviews of agent answers already in the queue
    for (days, u, qtext, intent, page, ans, conf, src, reason, status, rev, note) in REVIEW_HISTORY:
        con.execute("INSERT INTO agent_reviews(ts,username,log_id,query,intent,page,answer,confidence,source,reason,status,reviewer,verdict_note,reviewed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (ts(days), u, None, qtext, intent, page, ans, conf, src, reason, status, rev, note, ts(days - 0.5) if rev else None))
        if status == "Open":
            for a in admins:
                con.execute("INSERT INTO notifications(ts,recipient,kind,title,body,page,filters,entity,record_id,request_id,is_read) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                            (ts(days), a, "review", f"Agent answer flagged by {u}" if src == "user" else "Low-confidence agent answer queued", f"“{qtext}” · {reason}", "review", json.dumps({"status": "Open"}), None, None, None, 0))


REVIEW_HISTORY = [
    (3, "staff", "why did logistics cost increase", "why_cost", "finance", "Logistics expenses rose vs the previous period; delays at Gati add cost.", 1.0, "user", "Numbers look high, please verify against finance", "Correct", "admin", "Checked against expenses table: figures match."),
    (2, "manager", "which vendor is cheapest for copper", "compare_suppliers", "suppliers", "Ranked suppliers for Copper Wire by weighted score.", 0.41, "auto", "Low confidence (0.41): understood by semantic classifier, not rules", "Wrong", "admin", "User wanted lowest price, not weighted score. Added to test set."),
    (1, "staff", "are any products about to go out of stock", "navigate", "inventory", "Opened Inventory.", 0.3, "auto", "Low confidence (0.30): no precise rule matched", "Open", None, None),
    (0.3, "viewer", "show me the sales dip reasons for mumbai", "why", "sales", "Revenue in Maharashtra fell vs the previous period; drivers listed.", 1.0, "user", "Answer said Maharashtra, I asked about Mumbai only", "Open", None, None),
]


if __name__ == "__main__":
    init_db(force=True)
    print("DB ready:", DB_PATH, q1("SELECT COUNT(*) n FROM sales_orders"))

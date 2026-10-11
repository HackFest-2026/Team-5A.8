"""Dataset access: catalog (tables, columns, rows, coverage), KPI dictionary with live values, table browser, read-only SQL."""
import sqlite3, re, time
from datetime import date, timedelta
import db
from db import q, q1, today
import metadata as M
import pages as P

DATE_COLS = {"sales_orders": "order_date", "purchase_orders": "order_date", "shipments": "ship_date", "expenses": "date", "change_requests": "created_at", "audit_log": "ts", "agent_log": "ts"}


def catalog():
    out = []
    for t, (desc, page, cols) in M.TABLE_DOCS.items():
        info = q(f"PRAGMA table_info({t})")
        n = q1(f"SELECT COUNT(*) n FROM {t}")["n"]
        span = None
        if t in DATE_COLS:
            r = q1(f"SELECT MIN({DATE_COLS[t]}) a, MAX({DATE_COLS[t]}) b FROM {t}")
            span = [str(r["a"])[:10] if r["a"] else None, str(r["b"])[:10] if r["b"] else None]
        hidden = M.HIDDEN_COLUMNS.get(t, set())
        out.append({"table": t, "description": desc, "page": page, "rows": n, "span": span,
                    "columns": [{"name": c["name"], "type": c["type"] or "TEXT", "pk": bool(c["pk"]), "description": "Row id" if c["name"] == "id" else cols.get(c["name"], "")}
                                for c in info if c["name"] not in hidden]})
    return out


def kpi_values():
    t = today()
    y0 = (t - timedelta(days=364)).isoformat()
    s12 = P.sales_totals({"date_from": y0, "date_to": t.isoformat()})
    pr = P.product_rows()
    d90 = (t - timedelta(days=89)).isoformat()
    sh = q1("SELECT COUNT(*) n, SUM(CASE WHEN delay_days=0 THEN 1 ELSE 0 END) ok, SUM(CASE WHEN delay_days>0 THEN 1 ELSE 0 END) late, AVG(delay_days) d FROM shipments WHERE ship_date>=?", (d90,))
    all_o = q1("SELECT COUNT(*) n, SUM(CASE WHEN status='Cancelled' THEN 1 ELSE 0 END) c FROM sales_orders WHERE order_date>=?", (y0,))
    opex = q1("SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE is_deleted=0 AND date>=?", (y0,))["s"]
    sup = q1("SELECT COUNT(*) n, AVG(rating) r, AVG(on_time_rate) o FROM suppliers WHERE is_deleted=0")
    po = q1("SELECT COALESCE(SUM(CASE WHEN status!='Cancelled' THEN amount END),0) s, SUM(CASE WHEN status IN ('Pending','Approved') THEN 1 ELSE 0 END) open FROM purchase_orders WHERE is_deleted=0 AND order_date>=?", (y0,))
    appr = q1("SELECT SUM(CASE WHEN status='Pending' THEN 1 ELSE 0 END) p, SUM(CASE WHEN status='Approved' THEN 1 ELSE 0 END) a, SUM(CASE WHEN reviewed_by='auto-policy' THEN 1 ELSE 0 END) au FROM change_requests")
    lat = sorted(r["latency_ms"] for r in q("SELECT latency_ms FROM agent_log"))
    act = q1("SELECT COUNT(DISTINCT customer_id) n FROM sales_orders WHERE order_date>=? AND status!='Cancelled'", (d90,))["n"]
    vel = [r for r in pr if r["days_left"] is not None]
    return {
        "revenue": ("inr", s12["revenue"]), "orders": ("int", s12["orders"]), "aov": ("inr", s12["revenue"] / (s12["orders"] or 1)),
        "cancel_rate": ("pct", (all_o["c"] or 0) * 100 / (all_o["n"] or 1)), "units": ("int", s12["units"]),
        "inventory_value": ("inr", sum(r["stock_value"] for r in pr)), "low_stock": ("int", sum(r["stock_status"] == "Low Stock" for r in pr)),
        "out_of_stock": ("int", sum(r["stock_status"] == "Out of Stock" for r in pr)), "days_cover": ("days", sorted(r["days_left"] for r in vel)[len(vel) // 2] if vel else 0),
        "suppliers": ("int", sup["n"]), "rating": ("num", sup["r"]), "supplier_ontime": ("pct", (sup["o"] or 0) * 100),
        "po_spend": ("inr", po["s"]), "open_pos": ("int", po["open"] or 0), "fulfillment": ("pct", (sh["ok"] or 0) * 100 / (sh["n"] or 1)),
        "delayed": ("int", sh["late"] or 0), "avg_delay": ("num", sh["d"] or 0), "cogs": ("inr", s12["cogs"]), "opex": ("inr", opex),
        "gross_margin": ("pct", (s12["revenue"] - s12["cogs"]) * 100 / (s12["revenue"] or 1)), "net_profit": ("inr", s12["revenue"] - s12["cogs"] - opex),
        "active_customers": ("int", act), "pending": ("int", appr["p"] or 0), "auto_rate": ("pct", (appr["au"] or 0) * 100 / (appr["a"] or 1)),
        "agent_p95": ("num", lat[max(0, int(len(lat) * 0.95) - 1)] if lat else 0),
    }


def kpi_dictionary():
    vals = kpi_values()
    return [{"kpi": n, "page": p, "formula": f, "value": vals[k][1], "fmt": vals[k][0], "window": "last 12 months" if k in ("revenue", "orders", "aov", "cancel_rate", "units", "po_spend", "cogs", "opex", "gross_margin", "net_profit") else ("last 90 days" if k in ("fulfillment", "delayed", "avg_delay", "active_customers") else "current")}
            for n, p, f, k in M.KPI_DICTIONARY]


def browse(table, qtext="", offset=0, limit=50, sort=None):
    if table not in M.TABLE_DOCS:
        raise ValueError("Unknown table")
    hidden = M.HIDDEN_COLUMNS.get(table, set())
    cols = [c["name"] for c in q(f"PRAGMA table_info({table})") if c["name"] not in hidden]
    w, a = "", []
    if qtext:
        w = "WHERE " + " OR ".join(f"CAST({c} AS TEXT) LIKE ?" for c in cols)
        a = [f"%{qtext}%"] * len(cols)
    order = "id DESC"
    if sort:
        k, _, d = sort.partition(":")
        if k in cols:
            order = f"{k} {'ASC' if d == 'asc' else 'DESC'}"
    total = q1(f"SELECT COUNT(*) n FROM {table} {w}", a)["n"]
    rows = q(f"SELECT {','.join(cols)} FROM {table} {w} ORDER BY {order} LIMIT ? OFFSET ?", a + [min(int(limit), 200), int(offset)])
    return {"table": table, "columns": cols, "rows": rows, "total": total, "offset": int(offset)}


def run_sql(user, sql, limit=500):
    if user["role"] not in ("admin", "manager"):
        raise PermissionError("SQL console is for admin and manager roles. You can browse tables instead.")
    sql = (sql or "").strip().rstrip(";").strip()
    if not re.match(r"(?is)^(select|with)\b", sql) or ";" in sql:
        raise ValueError("Read-only console: one SELECT (or WITH … SELECT) statement.")
    con = sqlite3.connect(f"file:{db.DB_PATH}?mode=ro", uri=True, timeout=5)
    con.row_factory = sqlite3.Row

    def auth(action, a, b, dbname, src):
        if action == sqlite3.SQLITE_READ and a == "users" and b in ("password_hash", "password"):
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK
    con.set_authorizer(auth)
    start = time.perf_counter()
    con.set_progress_handler(lambda: 1 if time.perf_counter() - start > 3 else 0, 10000)
    try:
        cur = con.execute(sql)
        cols = [d[0] for d in cur.description or []]
        rows = [dict(zip(cols, r)) for r in cur.fetchmany(limit + 1)]
    except sqlite3.DatabaseError as e:
        raise ValueError(f"SQL error: {e}")
    finally:
        con.close()
    return {"columns": cols, "rows": rows[:limit], "truncated": len(rows) > limit, "ms": round((time.perf_counter() - start) * 1000, 1)}

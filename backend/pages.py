"""Page data engine + analytics. Same functions feed the UI and the agent, so answers are traceable to views."""
from datetime import date, timedelta
from collections import defaultdict, OrderedDict
import copy
import json
from db import q, q1, today
import metadata as M

NOT_CANCELLED = "so.status NOT IN ('Cancelled')"


# ---------------- helpers ----------------
def drange(f, default_days=365):
    t = today()
    dto = f.get("date_to") or t.isoformat()
    dfrom = f.get("date_from") or (date.fromisoformat(dto) - timedelta(days=default_days - 1)).isoformat()
    return dfrom, dto


def prev_range(dfrom, dto):
    a, b = date.fromisoformat(dfrom), date.fromisoformat(dto)
    n = (b - a).days + 1
    return (a - timedelta(days=n)).isoformat(), (a - timedelta(days=1)).isoformat()


def pct(cur, prev):
    if not prev:
        return None
    return round((cur - prev) / prev * 100, 1)


def kpi(id, label, value, fmt="int", delta=None, note=None):
    return {"id": id, "label": label, "value": value, "fmt": fmt, "delta": delta, "note": note}


def months_between(dfrom, dto):
    a = date.fromisoformat(dfrom).replace(day=1)
    b = date.fromisoformat(dto)
    out = []
    while a <= b:
        out.append(a.strftime("%Y-%m"))
        a = (a.replace(day=28) + timedelta(days=4)).replace(day=1)
    return out


def mlabel(ym):
    return date.fromisoformat(ym + "-01").strftime("%b %y")


def apply_sort(rows, sort, default=None):
    sort = sort or default
    if not sort or not rows:
        return rows
    key, _, d = sort.partition(":")
    if key not in rows[0]:
        return rows
    return sorted(rows, key=lambda r: (r.get(key) is None, r.get(key) if r.get(key) is not None else 0), reverse=(d != "asc"))


def sales_where(f, alias_date=True):
    dfrom, dto = drange(f)
    w, a = [NOT_CANCELLED if not f.get("status") else "so.status=?", "so.order_date BETWEEN ? AND ?", "so.is_deleted=0"], []
    if f.get("status"):
        a.append(f["status"])
    a += [dfrom, dto]
    for k, col in (("region", "so.region"), ("channel", "so.channel"), ("category", "p.category"), ("segment", "c.segment")):
        if f.get(k):
            w.append(f"{col}=?"); a.append(f[k])
    if f.get("product_id"):
        w.append("so.product_id=?"); a.append(f["product_id"])
    if f.get("q"):
        w.append("(c.name LIKE ? OR p.name LIKE ? OR so.order_no LIKE ?)"); a += [f"%{f['q']}%"] * 3
    return " AND ".join(w), a


SALES_JOIN = "FROM sales_orders so JOIN products p ON p.id=so.product_id JOIN customers c ON c.id=so.customer_id"


def sales_totals(f):
    w, a = sales_where(f)
    r = q1(f"SELECT COALESCE(SUM(so.amount),0) revenue, COUNT(*) orders, COALESCE(SUM(so.qty),0) units, COALESCE(SUM(so.qty*p.cost_price),0) cogs {SALES_JOIN} WHERE {w}", a)
    return r


def monthly_sales(f):
    w, a = sales_where(f)
    rows = q(f"SELECT substr(so.order_date,1,7) m, SUM(so.amount) revenue, COUNT(*) orders, SUM(so.qty) units {SALES_JOIN} WHERE {w} GROUP BY m ORDER BY m", a)
    by = {r["m"]: r for r in rows}
    dfrom, dto = drange(f)
    return [{"m": m, "revenue": round(by.get(m, {}).get("revenue") or 0, 2), "orders": by.get(m, {}).get("orders") or 0,
             "units": by.get(m, {}).get("units") or 0} for m in months_between(dfrom, dto)]


def velocity(days=90):
    since = (today() - timedelta(days=days)).isoformat()
    return {r["product_id"]: r["u"] / days for r in q("SELECT product_id, SUM(qty) u FROM sales_orders WHERE order_date>=? AND status!='Cancelled' AND is_deleted=0 GROUP BY product_id", (since,))}


def product_rows():
    vel = velocity()
    rows = q("SELECT * FROM products WHERE is_deleted=0")
    for r in rows:
        v = vel.get(r["id"], 0)
        r["daily_demand"] = round(v, 1)
        r["days_left"] = round(r["stock"] / v, 1) if v > 0 else None
        r["stock_value"] = round(r["stock"] * r["cost_price"], 2)
        r["stock_status"] = "Out of Stock" if r["stock"] <= 0 else ("Low Stock" if r["stock"] <= r["reorder_level"] else "In Stock")
    return rows


# ---------------- analytics (agent tools) ----------------
def stockout(days=14, category=None):
    rows = [r for r in product_rows() if r["days_left"] is not None and r["days_left"] <= days and (not category or r["category"] == category)]
    open_po = {r["product_id"]: r["qty"] for r in q("SELECT product_id, SUM(qty) qty FROM purchase_orders WHERE status IN ('Draft','Pending','Approved') AND is_deleted=0 GROUP BY product_id")}
    for r in rows:
        r["open_po_qty"] = open_po.get(r["id"], 0)
        r["suggested_qty"] = max(0, int(r["daily_demand"] * 45 - r["stock"] - r["open_po_qty"]))
    return sorted(rows, key=lambda r: r["days_left"])


def supplier_options(product_id):
    rows = q("""SELECT s.id supplier_id, s.code, s.name, s.city, s.country, s.rating, s.lead_time_days, s.on_time_rate, sp.price
                FROM supplier_products sp JOIN suppliers s ON s.id=sp.supplier_id WHERE sp.product_id=? AND s.is_deleted=0""", (product_id,))
    if not rows:
        return []
    pmin = min(r["price"] for r in rows); pmax = max(r["price"] for r in rows)
    lmin = min(r["lead_time_days"] for r in rows); lmax = max(r["lead_time_days"] for r in rows)
    for r in rows:
        price_s = 1 - (r["price"] - pmin) / (pmax - pmin) if pmax > pmin else 1
        lead_s = 1 - (r["lead_time_days"] - lmin) / (lmax - lmin) if lmax > lmin else 1
        r["score"] = round(100 * (0.40 * price_s + 0.25 * (r["rating"] / 5) + 0.20 * r["on_time_rate"] + 0.15 * lead_s), 1)
    return sorted(rows, key=lambda r: -r["score"])


def period_metrics(dfrom, dto, extra=None):
    f = dict(extra or {}); f["date_from"], f["date_to"] = dfrom, dto
    return sales_totals(f)


def breakdown(dim, dfrom, dto, metric="revenue", extra=None):
    col = {"region": "so.region", "category": "p.category", "channel": "so.channel", "segment": "c.segment", "product": "p.name", "customer": "c.name"}[dim]
    f = dict(extra or {}); f["date_from"], f["date_to"] = dfrom, dto
    w, a = sales_where(f)
    agg = {"revenue": "SUM(so.amount)", "orders": "COUNT(*)", "units": "SUM(so.qty)"}[metric]
    return {r["k"]: r["v"] or 0 for r in q(f"SELECT {col} k, {agg} v {SALES_JOIN} WHERE {w} GROUP BY k", a)}


def drivers(dfrom, dto, metric="revenue", extra=None, prev=None):
    """Explain change between period and previous period (or an explicit comparison period)."""
    pf, pt = prev or prev_range(dfrom, dto)
    out = {"period": [dfrom, dto], "previous": [pf, pt], "dims": {}}
    cur = period_metrics(dfrom, dto, extra); prev = period_metrics(pf, pt, extra)
    out["current"], out["previous_totals"] = cur, prev
    out["change_pct"] = pct(cur[metric], prev[metric])
    for dim in ("region", "category", "channel", "product"):
        if extra and extra.get(dim):
            continue
        c, p = breakdown(dim, dfrom, dto, metric, extra), breakdown(dim, pf, pt, metric, extra)
        items = [{"key": k, "current": round(c.get(k, 0), 2), "previous": round(p.get(k, 0), 2), "delta": round(c.get(k, 0) - p.get(k, 0), 2),
                  "pct": pct(c.get(k, 0), p.get(k, 0))} for k in set(c) | set(p)]
        out["dims"][dim] = sorted(items, key=lambda x: x["delta"])
    # operational signals
    reg = (extra or {}).get("region")
    rw, ra = ("AND sh.destination=?", [reg]) if reg else ("", [])
    def delay_stats(a, b):
        return q1(f"""SELECT AVG(sh.delay_days) avg_delay, SUM(CASE WHEN sh.delay_days>0 THEN 1 ELSE 0 END)*1.0/COUNT(*) late_rate
                      FROM shipments sh JOIN sales_orders so ON so.id=sh.sales_order_id WHERE so.order_date BETWEEN ? AND ? {rw}""", [a, b] + ra)
    out["delays"] = {"current": delay_stats(dfrom, dto), "previous": delay_stats(pf, pt)}
    if reg:
        out["carriers"] = q("""SELECT sh.carrier, COUNT(*) n, AVG(sh.delay_days) avg_delay FROM shipments sh JOIN sales_orders so ON so.id=sh.sales_order_id
                               WHERE so.order_date BETWEEN ? AND ? AND sh.destination=? GROUP BY sh.carrier ORDER BY avg_delay DESC""", (dfrom, dto, reg))
    cw = "AND region=?" if reg else ""
    def cancel_rate(a, b):
        r = q1(f"SELECT SUM(CASE WHEN status='Cancelled' THEN 1 ELSE 0 END)*1.0/COUNT(*) r FROM sales_orders WHERE order_date BETWEEN ? AND ? {cw}", [a, b] + ([reg] if reg else []))
        return r["r"] or 0
    out["cancel_rate"] = {"current": cancel_rate(dfrom, dto), "previous": cancel_rate(pf, pt)}
    oos = [r["name"] for r in product_rows() if r["stock_status"] == "Out of Stock"]
    out["out_of_stock"] = oos
    return out


def top_n(kind, n=5, dfrom=None, dto=None, metric="revenue", ascending=False, extra=None):
    dfrom, dto = drange({"date_from": dfrom, "date_to": dto})
    if kind == "suppliers":
        rows = q("""SELECT s.code, s.name, s.rating, s.on_time_rate, COALESCE(SUM(po.amount),0) spend FROM suppliers s
                    LEFT JOIN purchase_orders po ON po.supplier_id=s.id AND po.order_date BETWEEN ? AND ? AND po.status!='Cancelled'
                    WHERE s.is_deleted=0 GROUP BY s.id""", (dfrom, dto))
        k = "rating" if metric == "rating" else "spend"
        return sorted(rows, key=lambda r: r[k], reverse=not ascending)[:n]
    dim = {"products": "product", "customers": "customer", "regions": "region", "categories": "category", "channels": "channel", "segments": "segment"}.get(kind, "product")
    b = breakdown(dim, dfrom, dto, metric, extra)
    rows = [{"name": k, metric: round(v, 2)} for k, v in b.items()]
    return sorted(rows, key=lambda r: r[metric], reverse=not ascending)[:n]


# ---------------- pages ----------------
_CACHE = OrderedDict()


def page_data(page_id, f=None, sort=None):
    """Cached by (page, filters, sort, data version): agent read + UI render of the same view cost one computation."""
    import db as _db, time as _t
    f = {k: v for k, v in (f or {}).items() if v not in (None, "", "All")}
    fn = PAGE_FUNCS.get(page_id)
    if not fn:
        raise KeyError(page_id)
    key = (page_id, json.dumps(f, sort_keys=True), sort, _db.VERSION[0], int(_t.time() // 60))
    if page_id not in ("activity", "data", "approvals", "evaluation", "review") and key in _CACHE:
        _CACHE.move_to_end(key)
        return copy.deepcopy(_CACHE[key])
    d = fn(f, sort)
    d["page"] = page_id
    d["filters"] = f
    if page_id not in ("activity", "data", "approvals", "evaluation", "review"):
        _CACHE[key] = copy.deepcopy(d)
        while len(_CACHE) > 64:
            _CACHE.popitem(last=False)
    return d


def insights(limit=4):
    """'Agent noticed': last full month vs average of the previous 3 months, per region and per category. Computed, never hardcoded."""
    t = today()
    last_end = t.replace(day=1) - timedelta(days=1)
    last_start = last_end.replace(day=1)
    months = []
    m = last_start
    for _ in range(3):
        m = (m - timedelta(days=1)).replace(day=1)
        months.append(m)
    base_start, base_end = months[-1], last_start - timedelta(days=1)
    out = []
    for dim in ("region", "category"):
        cur = breakdown(dim, last_start.isoformat(), last_end.isoformat())
        base = breakdown(dim, base_start.isoformat(), base_end.isoformat())
        for k in set(cur) | set(base):
            avg = base.get(k, 0) / 3
            if avg <= 0:
                continue
            ch = (cur.get(k, 0) - avg) / avg * 100
            out.append({"dim": dim, "key": k, "pct": round(ch, 1), "current": round(cur.get(k, 0)), "baseline": round(avg),
                        "month": last_start.strftime("%b %Y")})
    sh = q1("""SELECT AVG(delay_days) d, SUM(CASE WHEN delay_days>0 THEN 1 ELSE 0 END)*100.0/COUNT(*) late FROM shipments WHERE ship_date BETWEEN ? AND ?""", (last_start.isoformat(), last_end.isoformat()))
    shb = q1("""SELECT SUM(CASE WHEN delay_days>0 THEN 1 ELSE 0 END)*100.0/COUNT(*) late FROM shipments WHERE ship_date BETWEEN ? AND ?""", (base_start.isoformat(), base_end.isoformat()))
    out.sort(key=lambda x: -abs(x["pct"]))
    res = []
    for x in out:
        if abs(x["pct"]) < 8 or len(res) >= limit - 1:
            continue
        up = x["pct"] > 0
        what = f"{x['key']} revenue" if x["dim"] == "region" else f"{x['key']} sales"
        ask = (f"why did revenue {'increase' if up else 'drop'} in {x['key']} last month" if x["dim"] == "region"
               else f"why did {x['key']} revenue {'increase' if up else 'drop'} last month")
        res.append({"title": f"{what} {'up' if up else 'down'} {abs(x['pct']):.0f}%", "body": f"{x['month']}: {inr_s(x['current'])} vs 3-month average {inr_s(x['baseline'])}",
                    "tone": "good" if up else "bad", "ask": ask})
    if sh and shb and sh["late"] and shb["late"] and sh["late"] > shb["late"] * 1.3:
        res.append({"title": f"Late shipments {sh['late']:.0f}% (was {shb['late']:.0f}%)", "body": f"{last_start.strftime('%b %Y')} vs previous 3 months · avg delay {sh['d']:.1f} d", "tone": "bad", "ask": "which carrier has the most delays last month"})
    so = stockout(7)
    if so:
        res.append({"title": f"{len(so)} items out within 7 days", "body": ", ".join(r["name"] for r in so[:3]), "tone": "warn", "ask": "products likely to run out in 7 days and create purchase orders"})
    return res[:limit]


def inr_s(v):
    v = v or 0
    return f"₹{v / 1e7:.2f} Cr" if abs(v) >= 1e7 else (f"₹{v / 1e5:.2f} L" if abs(v) >= 1e5 else f"₹{v:,.0f}")


def p_dashboard(f, sort):
    dfrom, dto = drange(f)
    pf, pt = prev_range(dfrom, dto)
    cur = sales_totals(f); prev = sales_totals({**f, "date_from": pf, "date_to": pt})
    prows = product_rows()
    inv_val = sum(r["stock_value"] for r in prows)
    sup = q1("SELECT COUNT(*) n FROM suppliers WHERE is_deleted=0")["n"]
    sup_prev = q1("SELECT COUNT(DISTINCT supplier_id) n FROM purchase_orders WHERE order_date BETWEEN ? AND ?", (pf, pt))["n"]
    sup_cur = q1("SELECT COUNT(DISTINCT supplier_id) n FROM purchase_orders WHERE order_date BETWEEN ? AND ?", (dfrom, dto))["n"]
    ms = monthly_sales(f)
    status = defaultdict(int)
    for r in prows:
        status[r["stock_status"]] += 1
    low = apply_sort([r for r in prows if r["stock_status"] != "In Stock"], sort, "days_left:asc")
    pend = q1("SELECT COUNT(*) n FROM change_requests WHERE status='Pending'")["n"]
    recent = q("""SELECT po.id, po.po_no, s.name supplier, p.name product, po.status, po.amount, po.order_date FROM purchase_orders po
                  JOIN suppliers s ON s.id=po.supplier_id JOIN products p ON p.id=po.product_id WHERE po.is_deleted=0 ORDER BY po.order_date DESC, po.id DESC LIMIT 6""")
    rw, ra = ("AND sh.destination=?", [f["region"]]) if f.get("region") else ("", [])
    ful = q1(f"""SELECT COUNT(*) n, SUM(CASE WHEN sh.delay_days=0 THEN 1 ELSE 0 END) ok, SUM(CASE WHEN sh.delay_days>0 THEN 1 ELSE 0 END) late
                 FROM shipments sh WHERE sh.status='Delivered' AND sh.ship_date BETWEEN ? AND ? {rw}""", [dfrom, dto] + ra)
    exp = q("SELECT category, SUM(amount) amt FROM expenses WHERE is_deleted=0 AND date BETWEEN ? AND ? GROUP BY category ORDER BY amt DESC", (dfrom, dto))
    w, a = sales_where(f)
    top = q(f"SELECT p.name, p.sku, SUM(so.qty) units, SUM(so.amount) revenue {SALES_JOIN} WHERE {w} GROUP BY p.id ORDER BY revenue DESC LIMIT 6", a)
    return {
        "layout": "dashboard",
        "kpis": [kpi("kpi_revenue", "Total Revenue", cur["revenue"], "inr", pct(cur["revenue"], prev["revenue"])) | {"icon": "revenue", "tone": "green"},
                 kpi("kpi_orders", "Total Orders", cur["orders"], "int", pct(cur["orders"], prev["orders"])) | {"icon": "cart", "tone": "blue"},
                 kpi("kpi_inventory", "Inventory Value", inv_val, "inr", None, f"{len(prows)} SKUs · {sum(r['stock_status'] != 'In Stock' for r in prows)} need attention") | {"icon": "box", "tone": "violet"},
                 kpi("kpi_suppliers", "Active Suppliers", sup, "int", pct(sup_cur, sup_prev), f"{pend} approvals pending") | {"icon": "users", "tone": "sky"}],
        "charts": [{"id": "chart_trend", "title": "Revenue & Orders Trend", "type": "line", "labels": [mlabel(m["m"]) for m in ms],
                    "datasets": [{"label": "Revenue (₹)", "data": [m["revenue"] for m in ms]}, {"label": "Orders", "data": [m["orders"] for m in ms], "axis": "y1"}]},
                   {"id": "chart_inventory_status", "title": "Inventory Status", "type": "doughnut", "labels": ["In Stock", "Low Stock", "Out of Stock"],
                    "datasets": [{"label": "Items", "data": [status["In Stock"], status["Low Stock"], status["Out of Stock"]]}]}],
        "table": {"id": "grid_low_stock", "title": "Low Stock Alerts", "entity": "products",
                  "columns": [c("sku", "SKU"), c("name", "Product"), c("stock", "Current Stock", "int"), c("reorder_level", "Reorder Level", "int"),
                              c("days_left", "Days Left", "days"), c("stock_status", "Status", "status")], "rows": low, "total": len(low)},
        "extra": {
            "recent_pos": recent,
            "fulfillment": {"rate": round((ful["ok"] or 0) * 100 / (ful["n"] or 1), 1), "total": ful["n"] or 0, "on_time": ful["ok"] or 0, "late": ful["late"] or 0},
            "expenses": {"total": sum(e["amt"] for e in exp), "items": [{"label": e["category"], "value": round(e["amt"])} for e in exp]},
            "top_products": top,
            "inventory_total": len(prows),
            "insights": insights(),
            "pending": pend,
        },
    }


def c(key, label, fmt="text"):
    return {"key": key, "label": label, "fmt": fmt}


def p_inventory(f, sort):
    rows = product_rows()
    for k in ("category", "stock_status", "warehouse"):
        if f.get(k):
            rows = [r for r in rows if r[k] == f[k]]
    if f.get("q"):
        s = f["q"].lower(); rows = [r for r in rows if s in r["name"].lower() or s in r["sku"].lower()]
    by_cat = defaultdict(float)
    for r in rows:
        by_cat[r["category"]] += r["stock_value"]
    rows = apply_sort(rows, sort, "days_left:asc")
    return {"kpis": [kpi("kpi_items", "Total Items", len(rows)), kpi("kpi_value", "Stock Value", sum(r["stock_value"] for r in rows), "inr"),
                     kpi("kpi_low", "Low Stock", sum(r["stock_status"] == "Low Stock" for r in rows)),
                     kpi("kpi_out", "Out of Stock", sum(r["stock_status"] == "Out of Stock" for r in rows))],
            "charts": [{"id": "chart_value_by_cat", "title": "Stock Value by Category", "type": "bar", "labels": list(by_cat),
                        "datasets": [{"label": "Stock value (₹)", "data": [round(v) for v in by_cat.values()]}]}],
            "table": {"id": "grid_products", "title": "Products", "entity": "products",
                      "columns": [c("sku", "SKU"), c("name", "Product"), c("category", "Category"), c("stock", "Stock", "int"),
                                  c("reorder_level", "Reorder", "int"), c("daily_demand", "Daily Demand", "num"), c("days_left", "Days Left", "days"),
                                  c("unit_price", "Price", "inr"), c("stock_value", "Stock Value", "inr"), c("warehouse", "Warehouse"), c("stock_status", "Status", "status")],
                      "rows": rows, "total": len(rows)}}


def p_suppliers(f, sort):
    since = (today() - timedelta(days=365)).isoformat()
    rows = q("""SELECT s.*, (SELECT COUNT(*) FROM supplier_products sp WHERE sp.supplier_id=s.id) products,
                COALESCE((SELECT SUM(amount) FROM purchase_orders po WHERE po.supplier_id=s.id AND po.order_date>=? AND po.status!='Cancelled'),0) spend_12m
                FROM suppliers s WHERE s.is_deleted=0""", (since,))
    if f.get("category"):
        rows = [r for r in rows if r["category"] == f["category"]]
    if f.get("min_rating"):
        rows = [r for r in rows if r["rating"] >= float(f["min_rating"])]
    if f.get("q"):
        s = f["q"].lower(); rows = [r for r in rows if s in r["name"].lower() or s in (r["city"] or "").lower()]
    for r in rows:
        r["on_time_pct"] = round(r["on_time_rate"] * 100, 1)
    rows = apply_sort(rows, sort, "rating:desc")
    n = len(rows) or 1
    return {"kpis": [kpi("kpi_active", "Active Suppliers", len(rows)), kpi("kpi_rating", "Avg Rating", round(sum(r["rating"] for r in rows) / n, 2), "num"),
                     kpi("kpi_ontime", "Avg On-time", round(sum(r["on_time_pct"] for r in rows) / n, 1), "pct"),
                     kpi("kpi_spend", "Spend (12m)", sum(r["spend_12m"] for r in rows), "inr")],
            "charts": [{"id": "chart_ontime", "title": "On-time Delivery by Supplier", "type": "bar", "labels": [r["name"] for r in rows],
                        "datasets": [{"label": "On-time %", "data": [r["on_time_pct"] for r in rows]}]}],
            "table": {"id": "grid_suppliers", "title": "Suppliers", "entity": "suppliers",
                      "columns": [c("code", "Code"), c("name", "Supplier"), c("category", "Category"), c("city", "City"), c("rating", "Rating", "num"),
                                  c("lead_time_days", "Lead (d)", "int"), c("on_time_pct", "On-time %", "pct"), c("products", "Products", "int"), c("spend_12m", "Spend 12m", "inr")],
                      "rows": rows, "total": len(rows)}}


def p_procurement(f, sort):
    dfrom, dto = drange(f, 3650 if f.get("q") else 365)
    w, a = ["po.order_date BETWEEN ? AND ?", "po.is_deleted=0"], [dfrom, dto]
    if f.get("status"):
        w.append("po.status=?"); a.append(f["status"])
    if f.get("supplier"):
        w.append("s.name LIKE ?"); a.append(f"%{f['supplier']}%")
    if f.get("q"):
        w.append("(po.po_no LIKE ? OR p.name LIKE ? OR s.name LIKE ?)"); a += [f"%{f['q']}%"] * 3
    rows = q(f"""SELECT po.*, s.name supplier, p.name product, p.sku FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id
                 JOIN products p ON p.id=po.product_id WHERE {' AND '.join(w)}""", a)
    rows = apply_sort(rows, sort, "order_date:desc")
    spend = defaultdict(float)
    for r in rows:
        if r["status"] != "Cancelled":
            spend[r["order_date"][:7]] += r["amount"]
    ms = months_between(dfrom, dto)
    return {"kpis": [kpi("kpi_spend", "PO Spend", sum(r["amount"] for r in rows if r["status"] != "Cancelled"), "inr"),
                     kpi("kpi_open", "Open POs", sum(r["status"] in ("Pending", "Approved") for r in rows)),
                     kpi("kpi_draft", "Drafts", sum(r["status"] == "Draft" for r in rows)),
                     kpi("kpi_count", "Total POs", len(rows))],
            "charts": [{"id": "chart_spend", "title": "Monthly Purchase Spend", "type": "bar", "labels": [mlabel(m) for m in ms],
                        "datasets": [{"label": "Spend (₹)", "data": [round(spend.get(m, 0)) for m in ms]}]}],
            "table": {"id": "grid_pos", "title": "Purchase Orders", "entity": "purchase_orders",
                      "columns": [c("po_no", "PO #"), c("supplier", "Supplier"), c("product", "Product"), c("qty", "Qty", "int"), c("unit_cost", "Unit Cost", "inr"),
                                  c("amount", "Amount", "inr"), c("status", "Status", "status"), c("order_date", "Date", "date"), c("expected_date", "Expected", "date")],
                      "rows": rows[:400], "total": len(rows)}}


def p_sales(f, sort):
    cur = sales_totals(f)
    dfrom, dto = drange(f); pf, pt = prev_range(dfrom, dto)
    prev = sales_totals({**f, "date_from": pf, "date_to": pt})
    w, a = sales_where(f)
    rows = q(f"""SELECT so.id, so.order_no, c.name customer, p.name product, p.category, so.qty, so.unit_price, so.amount, so.region, so.channel, so.status, so.order_date
                 {SALES_JOIN} WHERE {w}""", a)
    rows = apply_sort(rows, sort, "order_date:desc")
    total_all = q1("SELECT COUNT(*) n, SUM(CASE WHEN status='Cancelled' THEN 1 ELSE 0 END) cn FROM sales_orders WHERE order_date BETWEEN ? AND ?" + (" AND region=?" if f.get("region") else ""),
                   [dfrom, dto] + ([f["region"]] if f.get("region") else []))
    ms = monthly_sales(f)
    return {"kpis": [kpi("kpi_revenue", "Revenue", cur["revenue"], "inr", pct(cur["revenue"], prev["revenue"])),
                     kpi("kpi_orders", "Orders", cur["orders"], "int", pct(cur["orders"], prev["orders"])),
                     kpi("kpi_aov", "Avg Order Value", cur["revenue"] / cur["orders"] if cur["orders"] else 0, "inr"),
                     kpi("kpi_cancel", "Cancel Rate", round((total_all["cn"] or 0) * 100 / (total_all["n"] or 1), 1), "pct")],
            "charts": [{"id": "chart_monthly", "title": "Monthly Revenue", "type": "bar", "labels": [mlabel(m["m"]) for m in ms],
                        "datasets": [{"label": "Revenue (₹)", "data": [m["revenue"] for m in ms]}]}],
            "table": {"id": "grid_orders", "title": "Orders", "entity": "sales_orders",
                      "columns": [c("order_no", "Order #"), c("customer", "Customer"), c("product", "Product"), c("qty", "Qty", "int"), c("amount", "Amount", "inr"),
                                  c("region", "Region"), c("channel", "Channel"), c("status", "Status", "status"), c("order_date", "Date", "date")],
                      "rows": rows[:400], "total": len(rows)}}


def p_customers(f, sort):
    rows = q("""SELECT c.*, COALESCE(SUM(CASE WHEN so.status!='Cancelled' THEN so.amount END),0) revenue, COUNT(so.id) orders, MAX(so.order_date) last_order
                FROM customers c LEFT JOIN sales_orders so ON so.customer_id=c.id WHERE c.is_deleted=0 GROUP BY c.id""")
    for k in ("region", "segment"):
        if f.get(k):
            rows = [r for r in rows if r[k] == f[k]]
    if f.get("q"):
        s = f["q"].lower(); rows = [r for r in rows if s in r["name"].lower() or s in (r["city"] or "").lower()]
    rows = apply_sort(rows, sort, "revenue:desc")
    cutoff = (today() - timedelta(days=90)).isoformat()
    seg = defaultdict(float)
    for r in rows:
        seg[r["segment"]] += r["revenue"]
    return {"kpis": [kpi("kpi_customers", "Customers", len(rows)), kpi("kpi_active", "Active (90d)", sum((r["last_order"] or "") >= cutoff for r in rows)),
                     kpi("kpi_ltv", "Avg Lifetime Revenue", sum(r["revenue"] for r in rows) / (len(rows) or 1), "inr")],
            "charts": [{"id": "chart_segment", "title": "Revenue by Segment", "type": "doughnut", "labels": list(seg), "datasets": [{"label": "Revenue", "data": [round(v) for v in seg.values()]}]}],
            "table": {"id": "grid_customers", "title": "Customers", "entity": "customers",
                      "columns": [c("code", "Code"), c("name", "Customer"), c("segment", "Segment"), c("city", "City"), c("region", "Region"),
                                  c("orders", "Orders", "int"), c("revenue", "Revenue", "inr"), c("last_order", "Last Order", "date")],
                      "rows": rows, "total": len(rows)}}


def p_logistics(f, sort):
    dfrom, dto = drange(f, 90)
    w, a = ["sh.ship_date BETWEEN ? AND ?", "sh.is_deleted=0"], [dfrom, dto]
    for k, col in (("status", "sh.status"), ("carrier", "sh.carrier"), ("region", "sh.destination")):
        if f.get(k):
            w.append(f"{col}=?"); a.append(f[k])
    rows = q(f"""SELECT sh.*, so.order_no FROM shipments sh JOIN sales_orders so ON so.id=sh.sales_order_id WHERE {' AND '.join(w)}""", a)
    rows = apply_sort(rows, sort, "ship_date:desc")
    n = len(rows) or 1
    reg, car = defaultdict(list), defaultdict(list)
    for r in rows:
        reg[r["destination"]].append(r["delay_days"]); car[r["carrier"]].append(r["delay_days"])
    avg = lambda xs: round(sum(xs) / len(xs), 2) if xs else 0
    return {"kpis": [kpi("kpi_ontime", "On-time %", round(sum(r["delay_days"] == 0 for r in rows) * 100 / n, 1), "pct"),
                     kpi("kpi_delayed", "Delayed", sum(r["delay_days"] > 0 for r in rows)),
                     kpi("kpi_transit", "In Transit", sum(r["status"] == "In Transit" for r in rows)),
                     kpi("kpi_avg", "Avg Delay (days)", avg([r["delay_days"] for r in rows]), "num")],
            "charts": [{"id": "chart_delay_region", "title": "Avg Delay by Region (days)", "type": "bar", "labels": list(reg), "datasets": [{"label": "Avg delay", "data": [avg(v) for v in reg.values()]}]},
                       {"id": "chart_delay_carrier", "title": "Avg Delay by Carrier (days)", "type": "bar", "labels": list(car), "datasets": [{"label": "Avg delay", "data": [avg(v) for v in car.values()]}]}],
            "table": {"id": "grid_shipments", "title": "Shipments", "entity": "shipments",
                      "columns": [c("shipment_no", "Shipment"), c("order_no", "Order"), c("carrier", "Carrier"), c("origin", "Origin"), c("destination", "Destination"),
                                  c("ship_date", "Shipped", "date"), c("eta", "ETA", "date"), c("delay_days", "Delay (d)", "int"), c("status", "Status", "status")],
                      "rows": rows[:400], "total": len(rows)}}


def p_finance(f, sort):
    dfrom, dto = drange(f)
    pf, pt = prev_range(dfrom, dto)
    cur = sales_totals({"date_from": dfrom, "date_to": dto}); prev = sales_totals({"date_from": pf, "date_to": pt})
    ew = " AND category=?" if f.get("category") else ""
    ea = [f["category"]] if f.get("category") else []
    exp_rows = q(f"SELECT substr(date,1,7) m, category, SUM(amount) amt FROM expenses WHERE is_deleted=0 AND date BETWEEN ? AND ? {ew} GROUP BY m, category", [dfrom, dto] + ea)
    prev_opex = q1(f"SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE is_deleted=0 AND date BETWEEN ? AND ? {ew}", [pf, pt] + ea)["s"]
    opex = sum(r["amt"] for r in exp_rows)
    by_cat, by_m = defaultdict(float), defaultdict(float)
    for r in exp_rows:
        by_cat[r["category"]] += r["amt"]; by_m[r["m"]] += r["amt"]
    w, a = sales_where({"date_from": dfrom, "date_to": dto})
    mrev = {r["m"]: r for r in q(f"SELECT substr(so.order_date,1,7) m, SUM(so.amount) rev, SUM(so.qty*p.cost_price) cogs {SALES_JOIN} WHERE {w} GROUP BY m", a)}
    ms = months_between(dfrom, dto)
    table = []
    for m in ms:
        rv = mrev.get(m, {}).get("rev") or 0; cg = mrev.get(m, {}).get("cogs") or 0; op = by_m.get(m, 0)
        table.append({"month": mlabel(m), "revenue": round(rv), "cogs": round(cg), "opex": round(op), "gross_margin_pct": round((rv - cg) * 100 / rv, 1) if rv else 0, "net_profit": round(rv - cg - op)})
    gm = cur["revenue"] - cur["cogs"]; net = gm - opex
    prev_net = prev["revenue"] - prev["cogs"] - prev_opex
    return {"kpis": [kpi("kpi_revenue", "Revenue", cur["revenue"], "inr", pct(cur["revenue"], prev["revenue"])),
                     kpi("kpi_cogs", "COGS", cur["cogs"], "inr"),
                     kpi("kpi_opex", "Operating Expenses", opex, "inr", pct(opex, prev_opex)),
                     kpi("kpi_margin", "Gross Margin", round(gm * 100 / cur["revenue"], 1) if cur["revenue"] else 0, "pct"),
                     kpi("kpi_profit", "Net Profit", net, "inr", pct(net, prev_net))],
            "charts": [{"id": "chart_pl", "title": "Revenue vs Costs", "type": "line", "labels": [t["month"] for t in table],
                        "datasets": [{"label": "Revenue", "data": [t["revenue"] for t in table]}, {"label": "COGS + Opex", "data": [t["cogs"] + t["opex"] for t in table]},
                                     {"label": "Net Profit", "data": [t["net_profit"] for t in table]}]},
                       {"id": "chart_expense", "title": "Expense Breakdown", "type": "doughnut", "labels": list(by_cat), "datasets": [{"label": "₹", "data": [round(v) for v in by_cat.values()]}]}],
            "table": {"id": "grid_pl", "title": "Monthly P&L", "entity": None,
                      "columns": [c("month", "Month"), c("revenue", "Revenue", "inr"), c("cogs", "COGS", "inr"), c("opex", "Opex", "inr"),
                                  c("gross_margin_pct", "Gross Margin", "pct"), c("net_profit", "Net Profit", "inr")],
                      "rows": apply_sort(table, sort) if sort else table, "total": len(table)}}


def p_analytics(f, sort):
    dfrom, dto = drange(f)
    pf, pt = prev_range(dfrom, dto)
    metric = f.get("metric") or "revenue"; group = f.get("group_by") or "region"
    extra = {k: f[k] for k in ("region", "category", "channel") if f.get(k) and k != group}
    cur, prev = breakdown(group, dfrom, dto, metric, extra), breakdown(group, pf, pt, metric, extra)
    rows = [{"name": k, "current": round(cur.get(k, 0), 2), "previous": round(prev.get(k, 0), 2), "change": round(cur.get(k, 0) - prev.get(k, 0), 2),
             "growth_pct": pct(cur.get(k, 0), prev.get(k, 0))} for k in set(cur) | set(prev)]
    total = sum(r["current"] for r in rows) or 1
    for r in rows:
        r["share_pct"] = round(r["current"] * 100 / total, 1)
    rows = apply_sort(rows, sort, "current:desc")
    ms = monthly_sales({"date_from": dfrom, "date_to": dto, **extra})
    fmt = "inr" if metric == "revenue" else "int"
    tc, tp = sum(cur.values()), sum(prev.values())
    return {"kpis": [kpi("kpi_current", f"{metric.title()} (period)", tc, fmt, pct(tc, tp)), kpi("kpi_previous", "Previous period", tp, fmt),
                     kpi("kpi_groups", {"category": "Categories"}.get(group, f"{group.title()}s"), len(rows))],
            "charts": [{"id": "chart_breakdown", "title": f"{metric.title()} by {group}: current vs previous", "type": "bar", "labels": [r["name"] for r in rows[:15]],
                        "datasets": [{"label": "Current", "data": [r["current"] for r in rows[:15]]}, {"label": "Previous", "data": [r["previous"] for r in rows[:15]]}]},
                       {"id": "chart_trend", "title": f"Monthly {metric}", "type": "line", "labels": [mlabel(m["m"]) for m in ms], "datasets": [{"label": metric.title(), "data": [m[metric] for m in ms]}]}],
            "table": {"id": "grid_breakdown", "title": f"Breakdown by {group}", "entity": None,
                      "columns": [c("name", group.title()), c("current", "Current", fmt), c("previous", "Previous", fmt), c("change", "Change", fmt),
                                  c("growth_pct", "Growth", "pct"), c("share_pct", "Share", "pct")], "rows": rows, "total": len(rows)}}


def p_approvals(f, sort):
    rows = q("SELECT * FROM change_requests ORDER BY id DESC")
    counts = defaultdict(int)
    for r in rows:
        counts[r["status"]] += 1
        ch = json.loads(r["changes"] or "{}")
        r["summary"] = "Delete record" if r["action"] == "delete" else ", ".join(f"{k}: {v.get('old')} → {v.get('new')}" for k, v in ch.items())
    if f.get("status"):
        rows = [r for r in rows if r["status"] == f["status"]]
    rows = apply_sort(rows, sort) if sort else rows
    auto = sum(1 for r in rows if r.get("reviewed_by") == "auto-policy")
    return {"kpis": [kpi("kpi_pending", "Pending", counts["Pending"]), kpi("kpi_approved", "Approved", counts["Approved"]), kpi("kpi_auto", "Auto-approved by policy", auto),
                     kpi("kpi_rejected", "Rejected", counts["Rejected"])],
            "charts": [],
            "table": {"id": "grid_requests", "title": "Change Requests", "entity": "change_requests",
                      "columns": [c("id", "#", "int"), c("record_label", "Record"), c("action", "Action"), c("summary", "Change"), c("reason", "Reason"),
                                  c("requested_by", "By"), c("status", "Status", "status"), c("reviewed_by", "Reviewer"), c("review_note", "Decision note"), c("created_at", "Created", "date")],
                      "rows": rows, "total": len(rows)}}


def p_activity(f, sort):
    audit = q("SELECT * FROM audit_log ORDER BY id DESC LIMIT 300")
    ag = q("SELECT * FROM agent_log ORDER BY id DESC LIMIT 300")
    lat = sorted(r["latency_ms"] for r in ag)
    p95 = lat[int(len(lat) * 0.95) - 1] if lat else 0
    return {"kpis": [kpi("kpi_queries", "Agent Queries", len(ag)), kpi("kpi_latency", "Avg Latency (ms)", round(sum(lat) / len(lat), 1) if lat else 0, "num"),
                     kpi("kpi_p95", "p95 Latency (ms)", round(p95, 1), "num"), kpi("kpi_changes", "Data Changes", len(audit))],
            "charts": [],
            "table": {"id": "grid_audit", "title": "Audit Log", "entity": None,
                      "columns": [c("ts", "Time"), c("username", "User"), c("action", "Action"), c("entity", "Entity"), c("record_label", "Record"), c("details", "Details"), c("via", "Via")],
                      "rows": audit, "total": len(audit)},
            "table2": {"id": "grid_agent", "title": "Agent Log", "entity": None,
                       "columns": [c("ts", "Time"), c("username", "User"), c("query", "Query"), c("intent", "Intent"), c("page", "Page"), c("latency_ms", "Latency ms", "num"), c("used_llm", "LLM", "int")],
                       "rows": ag, "total": len(ag)}}


def p_data(f, sort):
    import dataset as DS
    cat = DS.catalog()
    rows = [{"table": t["table"], "description": t["description"], "rows": t["rows"], "columns": len(t["columns"]),
             "from": (t["span"] or [None, None])[0], "to": (t["span"] or [None, None])[1], "page": t["page"]} for t in cat]
    so = next(t for t in cat if t["table"] == "sales_orders")
    kd = DS.kpi_dictionary()
    return {"kpis": [kpi("kpi_tables", "Tables", len(cat)), kpi("kpi_rows", "Total Rows", sum(t["rows"] for t in cat)),
                     kpi("kpi_span", "Sales Data Coverage", f"{so['span'][0]} → {so['span'][1]}", "text"), kpi("kpi_kpis", "KPIs Defined", len(kd))],
            "charts": [{"id": "chart_rows", "title": "Rows per table", "type": "bar", "labels": [r["table"] for r in rows], "datasets": [{"label": "Rows", "data": [r["rows"] for r in rows]}]}],
            "table": {"id": "grid_tables", "title": "Tables", "entity": None,
                      "columns": [c("table", "Table"), c("description", "Description"), c("rows", "Rows", "int"), c("columns", "Columns", "int"), c("from", "From", "date"), c("to", "To", "date"), c("page", "Page")],
                      "rows": rows, "total": len(rows)},
            "table2": {"id": "grid_kpis", "title": "KPI Dictionary", "entity": None,
                       "columns": [c("kpi", "KPI"), c("value", "Current Value", "auto"), c("window", "Window"), c("formula", "Formula"), c("page", "Page")],
                       "rows": kd, "total": len(kd)},
            "catalog": cat, "layout": "data"}


def p_evaluation(f, sort):
    import os
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "eval", "results.json")
    res = json.load(open(path)) if os.path.exists(path) else None
    out = {"layout": "eval", "results": res, "targets": M.EVAL_TARGETS, "kpis": [], "charts": []}
    if res:
        k = res["kpis"]
        out["kpis"] = [kpi("kpi_dest", "Intent → destination", k["Intent-to-destination accuracy"], "pct"), kpi("kpi_ui", "UI-state correctness", k["UI-state correctness (filters, dates, sort)"], "pct"),
                       kpi("kpi_multi", "Multi-step success", k["Multi-step task success"], "pct"), kpi("kpi_p95", "Latency p95 (ms)", k["Latency p95 (ms)"], "num"),
                       kpi("kpi_invalid", "Invalid actions executed", k["Invalid actions executed"], "int", None, f"{res['tests']} tests · {res['ran_at']}")]
    return out


def p_review(f, sort):
    rows = q("SELECT * FROM agent_reviews ORDER BY id DESC")
    allr = list(rows)
    if f.get("status"):
        rows = [r for r in rows if r["status"] == f["status"]]
    if f.get("source"):
        rows = [r for r in rows if r["source"] == f["source"]]
    rows = apply_sort(rows, sort) if sort else rows
    for r in rows:
        r["confidence_pct"] = None if r["confidence"] is None else round(r["confidence"] * 100)
    n = lambda st: sum(1 for r in allr if r["status"] == st)
    ok, bad = n("Correct"), n("Wrong")
    votes = q("SELECT feedback, COUNT(*) n FROM agent_log WHERE feedback IS NOT NULL GROUP BY feedback")
    v = {r["feedback"]: r["n"] for r in votes}
    tot = sum(v.values())
    by_src = defaultdict(int)
    for r in allr:
        by_src[("User flag" if r["source"] == "user" else "Auto") + " · " + r["status"]] += 1
    return {"kpis": [kpi("kpi_open", "Open", n("Open"), "int", None, "awaiting admin"), kpi("kpi_reviewed", "Reviewed", ok + bad),
                     kpi("kpi_human_acc", "Human-verified accuracy", round(100 * ok / (ok + bad), 1) if ok + bad else None, "pct", None, f"{ok} correct · {bad} wrong"),
                     kpi("kpi_helpful", "Helpful votes", round(100 * v.get("up", 0) / tot, 1) if tot else None, "pct", None, f"{tot} rated answers")],
            "charts": [{"id": "chart_review", "title": "Review queue by source and outcome", "type": "bar", "horizontal": True,
                        "labels": list(by_src.keys()), "datasets": [{"label": "Answers", "data": list(by_src.values())}]}],
            "table": {"id": "grid_reviews", "title": "Review queue", "entity": "agent_reviews",
                      "columns": [c("id", "#", "int"), c("ts", "Time"), c("username", "User"), c("query", "Question"), c("answer", "Agent answer"), c("intent", "Intent"),
                                  c("confidence_pct", "Conf. %", "int"), c("source", "Source"), c("reason", "Why queued"), c("status", "Status", "status"),
                                  c("reviewer", "Reviewer"), c("verdict_note", "Reviewer note")],
                      "rows": rows, "total": len(rows)}}


def p_stack(f, sort):
    rows = [dict(r) for r in M.STACK]
    return {"layout": "stack", "kpis": [kpi("kpi_layers", "Layers", len(rows)), kpi("kpi_tables", "Tables", len(q("SELECT name FROM sqlite_master WHERE type='table'"))),
                                        kpi("kpi_pages", "Pages", len(M.PAGES)), kpi("kpi_cost", "Licence cost", "₹0", "text", None, "all open source / free tiers")],
            "charts": [], "pipeline": M.PIPELINE, "hitl": M.HITL,
            "table": {"id": "stack_layers", "title": "Layers", "entity": None,
                      "columns": [c("layer", "Layer"), c("tech", "Technology"), c("where", "Where in code"), c("why", "Why")], "rows": rows, "total": len(rows)}}


PAGE_FUNCS = {"review": p_review, "stack": p_stack, "evaluation": p_evaluation, "data": p_data, "dashboard": p_dashboard, "inventory": p_inventory, "suppliers": p_suppliers, "procurement": p_procurement, "sales": p_sales,
              "customers": p_customers, "logistics": p_logistics, "finance": p_finance, "analytics": p_analytics, "approvals": p_approvals, "activity": p_activity}

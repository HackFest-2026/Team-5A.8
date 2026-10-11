"""Benchmark the agent against the labelled utterance corpus.
KPIs: intent accuracy, intent-to-destination accuracy, UI-state (filter) correctness, latency p50/p95,
retrieval MRR over application metadata, action-hallucination rate (writes executed without confirmation).
Run:  python eval/run_eval.py   (from project root)"""
import os, sys, json, time, statistics
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "backend"))
import shutil, tempfile
_tmp = os.path.join(tempfile.mkdtemp(), "eval.db")
os.environ["BIZPILOT_DB"] = _tmp  # fresh copy: eval executes real actions
import db
db.init_db()
import agent as A, retrieval as R
from db import q1

ROLE = os.environ.get("EVAL_ROLE", "admin")
user = q1("SELECT id, username, name, role FROM users WHERE username=?", (ROLE,))
items = json.load(open(os.path.join(HERE, "utterances.json")))
UNCMD = "action NOT IN ('login') AND action NOT LIKE 'review_%' AND username!='auto-policy'"  # explicit approve/reject commands execute directly
audit_before = q1(f"SELECT COUNT(*) n FROM audit_log WHERE {UNCMD}")["n"]

res, lat, unrequested = [], [], []
for it in items:
    ctx = A.Ctx(user, "dashboard", {}, [{"page": "inventory", "filters": {}}, {"page": "dashboard", "filters": {}}])
    before = q1("SELECT COALESCE(MAX(id),0) m FROM audit_log")["m"]
    t0 = time.perf_counter()
    evs = list(A.run(it["utterance"], ctx))
    ms = (time.perf_counter() - t0) * 1000
    lat.append(ms)
    intent = evs[-1]["intent"]
    wrote = q1("SELECT COUNT(*) n FROM audit_log WHERE id>? AND action IN ('create','update','delete')", (before,))["n"]
    if wrote and intent not in ("review", "review_all"):  # explicit approve/reject commands are allowed to write
        unrequested.append(it["utterance"])
    navs = [e for e in evs if e["t"] == "action" and e["action"] == "navigate"]
    page = navs[-1]["page"] if navs else None
    f = navs[-1]["filters"] if navs else {}
    ok_int = intent == it["intent"]
    ok_page = it["page"] is None or page == it["page"]
    ok_f = all(str(f.get(k)) == str(v) for k, v in it["filters"].items()) and (not it["has_date"] or ("date_from" in f) or it["intent"] in ("why", "delays", "top", "expense_why"))
    res.append({**it, "got_intent": intent, "got_page": page, "got_filters": f, "ok_intent": ok_int, "ok_page": ok_page, "ok_filters": ok_f, "ms": round(ms, 1)})

audit_after = q1(f"SELECT COUNT(*) n FROM audit_log WHERE {UNCMD}")["n"]
nav_items = [r for r in res if r["page"]]
fil_items = [r for r in res if r["filters"] or r["has_date"]]

# retrieval MRR: page-description style queries -> correct page rank
RQ = [("where can I see stock levels and reorder points", "inventory"), ("vendor performance and on time delivery", "suppliers"), ("purchase spend by month", "procurement"),
      ("customer orders and invoices", "sales"), ("client list with lifetime value", "customers"), ("carrier delays and eta", "logistics"),
      ("profit and loss statement", "finance"), ("breakdown of metrics by region with growth", "analytics"), ("change requests waiting for review", "approvals"),
      ("who changed what and when", "activity"), ("executive overview kpis", "dashboard"), ("cash flow and margins", "finance"), ("days of cover for items", "inventory"),
      ("supplier ratings", "suppliers"), ("late shipments", "logistics"), ("cancelled orders", "sales"), ("audit trail", "activity"), ("approve or reject", "approvals")]
rr = []
for qtext, want in RQ:
    hits = R.search_pages(qtext, 5)
    rank = next((i + 1 for i, h in enumerate(hits) if h["page"] == want), None)
    rr.append(1 / rank if rank else 0)
API_Q = [("forecast items that will run out", "stockout_forecast"), ("compare vendor prices for a product", "compare_suppliers"), ("why did revenue fall", "root_cause"),
         ("request an update that admin approves", "submit_change_request"), ("approve a pending change", "review_request"), ("top customers by revenue", "top_n")]
ar = []
for qtext, want in API_Q:
    hits = R.search_apis(qtext, 5)
    rank = next((i + 1 for i, h in enumerate(hits) if h["id"] == want), None)
    ar.append(1 / rank if rank else 0)

pct = lambda xs: f"{100 * sum(xs) / len(xs):.1f}%"
lat_sorted = sorted(lat)
report = {
    "role": ROLE, "utterances": len(res),
    "intent_accuracy": pct([r["ok_intent"] for r in res]),
    "intent_to_destination_accuracy": pct([r["ok_page"] for r in nav_items]),
    "ui_state_correctness": pct([r["ok_filters"] for r in fil_items]),
    "task_success (intent+page+filters)": pct([r["ok_intent"] and r["ok_page"] and r["ok_filters"] for r in res]),
    "latency_ms_p50": round(statistics.median(lat), 1), "latency_ms_p95": round(lat_sorted[int(len(lat) * .95) - 1], 1), "latency_ms_max": round(max(lat), 1),
    "page_retrieval_MRR": round(sum(rr) / len(rr), 3), "api_retrieval_MRR": round(sum(ar) / len(ar), 3),
    "unrequested_writes (action hallucination)": len(unrequested),
}
print(json.dumps(report, indent=2))
fails = [r for r in res if not (r["ok_intent"] and r["ok_page"] and r["ok_filters"])]
if fails:
    print(f"\n{len(fails)} failures:")
    for r in fails:
        print(f" - {r['utterance']!r}: intent {r['got_intent']} (want {r['intent']}), page {r['got_page']} (want {r['page']}), filters {r['got_filters']} (want {r['filters']})")
json.dump({"report": report, "results": res}, open(os.path.join(HERE, "eval_results.json"), "w"), indent=1, default=str)

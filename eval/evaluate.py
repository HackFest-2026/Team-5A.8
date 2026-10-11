"""One-command evaluation of every KPI in the problem statement, on a fresh temporary database.
Same code path as the app (agent.run). Strict scoring. Writes eval/results.json and eval/results.csv.
  python eval/evaluate.py            (prints summary)
The Evaluation page in the app calls the same harness through /api/eval/run."""
import os, sys, json, time, re, random, tempfile, statistics, csv, sqlite3
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "backend"))
if "BIZPILOT_DB" not in os.environ or os.environ.get("EVAL_FRESH", "1") == "1":
    os.environ["BIZPILOT_DB"] = os.path.join(tempfile.mkdtemp(), "eval.db")
import db
db.init_db()
import agent as A, retrieval as R, pages as P
from db import q1, q

load = lambda f: json.load(open(os.path.join(HERE, f)))
USER = q1("SELECT id, username, name, role FROM users WHERE username='admin'")


def run1(text, ctx):
    t0 = time.perf_counter()
    evs = list(A.run(text, ctx))
    ms = (time.perf_counter() - t0) * 1000
    navs = [e for e in evs if e["t"] == "action" and e["action"] == "navigate"]
    if navs:
        ctx.trail.append({"page": ctx.page, "filters": ctx.filters})
        ctx.page, ctx.filters = navs[-1]["page"], navs[-1]["filters"]
    cards = [e["card"] for e in evs if e["t"] == "card"]
    return {"intent": evs[-1]["intent"], "page": navs[-1]["page"] if navs else None, "filters": navs[-1]["filters"] if navs else {}, "ms": ms,
            "steps": sum(e["t"] == "step" for e in evs), "tools": len(navs) + sum(c["type"] in ("chart", "table", "kpis", "sources", "record") for c in cards), "cards": cards, "events": evs}


def fresh_ctx():
    return A.Ctx(USER, "dashboard", {}, [{"page": "inventory", "filters": {}}])


def wrote_since(mark):
    return q1("SELECT COUNT(*) n FROM audit_log WHERE id>? AND action IN ('create','update','delete')", (mark,))["n"]


def audit_mark():
    return q1("SELECT COALESCE(MAX(id),0) m FROM audit_log")["m"]


def suite_core():
    rows = []
    for it in load("utterances.json"):
        A.LAST.clear()
        mark = audit_mark()
        r = run1(it["utterance"], fresh_ctx())
        f = r["filters"]
        ok_i = r["intent"] == it["intent"]
        ok_p = it["page"] is None or r["page"] == it["page"]
        ok_f = all(str(f.get(k)) == str(v) for k, v in it["filters"].items()) and (not it["has_date"] or "date_from" in f or it["intent"] in ("why", "delays", "top", "expense_why"))
        unreq = bool(wrote_since(mark)) and r["intent"] not in ("review", "review_all")
        reason = [] if ok_i else [f"intent {r['intent']}≠{it['intent']}"]
        reason += [] if ok_p else [f"page {r['page']}≠{it['page']}"]
        reason += [] if ok_f else [f"filters {f}"]
        rows.append({"suite": "core", "test": it["utterance"], "expected": it["intent"], "got": r["intent"], "intent_ok": ok_i, "page_ok": ok_p, "has_page": it["page"] is not None,
                     "filters_ok": ok_f, "has_filters": bool(it["filters"] or it["has_date"]), "pass": ok_i and ok_p and ok_f, "ms": round(r["ms"], 1), "steps": r["steps"], "tools": r["tools"],
                     "unrequested_write": unreq, "reason": "; ".join(reason)})
    return rows


def suite_intents(file, name):
    rows = []
    for it in load(file):
        A.LAST.clear()
        r = run1(it["utterance"], fresh_ctx())
        ok = r["intent"] == it["intent"] and (not it.get("page") or r["page"] == it["page"])
        rows.append({"suite": name, "test": it["utterance"], "expected": it["intent"], "got": r["intent"], "pass": ok, "ms": round(r["ms"], 1), "reason": "" if ok else f"got {r['intent']} / {r['page']}"})
    return rows


def suite_safety():
    rows = []
    for it in load("safety_tests.json"):
        A.LAST.clear()
        mark = audit_mark()
        ctx = fresh_ctx()
        r = run1(it["utterance"], ctx)
        codes = [c.get("code") for c in r["cards"] if c["type"] == "refusal"]
        ok = r["intent"] == it["intent"] and (it["code"] is None or it["code"] in codes)
        invalid = (it["intent"] == "refuse" and (r["page"] is not None or wrote_since(mark) > 0)) or (it["intent"] == "clarify" and r["page"] is not None)
        rows.append({"suite": "safety", "test": it["utterance"], "expected": it["intent"] + (f":{it['code']}" if it["code"] else ""), "got": r["intent"] + (f":{codes[0]}" if codes else ""),
                     "pass": ok and not invalid, "invalid_action": invalid, "kind": it["intent"], "ms": round(r["ms"], 1), "reason": "" if ok else "wrong handling"})
    return rows


def suite_followups():
    rows = []
    for it in load("followup_tests.json"):
        A.LAST.clear()
        ctx = A.Ctx(USER, "dashboard", {}, [])
        total_ms, steps, r = 0, 0, None
        for turn in it["turns"]:
            r = run1(turn, ctx)
            total_ms += r["ms"]; steps += r["steps"]
        ok = True
        if "page" in it:
            ok &= ctx.page == it["page"]
        if "filters" in it:
            ok &= all(str(ctx.filters.get(k)) == str(v) for k, v in it["filters"].items()) and (bool(it["filters"]) or not {k: v for k, v in ctx.filters.items() if k not in ("metric", "group_by")})
        if "intent" in it:
            ok &= r["intent"] == it["intent"] or r["intent"].startswith("multi")
        rows.append({"suite": "multi_step", "test": " → ".join(it["turns"]), "expected": it.get("page") or it.get("intent"), "got": f"{ctx.page} {ctx.filters}", "pass": ok,
                     "ms": round(total_ms, 1), "steps": steps, "turns": len(it["turns"]), "reason": "" if ok else "final state differs"})
    return rows


def suite_typos():
    rows = []
    for it in load("typo_cases.json"):
        A.LAST.clear()
        r = run1(it["utterance"], fresh_ctx())
        ok = r["intent"] == it["intent"] and (it["page"] is None or r["page"] == it["page"])
        rows.append({"suite": "typos", "test": it["utterance"], "expected": it["intent"], "got": r["intent"], "pass": ok, "ms": round(r["ms"], 1), "reason": "" if ok else f"{r['intent']} / {r['page']}"})
    return rows


RQ = [(x["query"], x["page"]) for x in load("retrieval_queries.json")]


def suite_retrieval():
    rows = []
    for text, want in RQ:
        hits = R.search(text, 10, {"page", "widget"})
        ranked = []
        for h in hits:
            if h["page"] not in ranked:
                ranked.append(h["page"])
        rank = ranked.index(want) + 1 if want in ranked else None
        rows.append({"suite": "retrieval", "test": text, "expected": want, "got": ranked[0] if ranked else None, "pass": rank == 1, "rank": rank, "reason": "" if rank == 1 else f"rank {rank}"})
    return rows


def parse_inr(s):
    m = re.search(r"₹\s?([-\d,.]+)\s*(Cr|L)?", s or "")
    if not m:
        return None
    v = float(m.group(1).replace(",", ""))
    return v * (1e7 if m.group(2) == "Cr" else 1e5 if m.group(2) == "L" else 1)


def suite_analytical():
    """Numbers shown by the agent vs an independent pure-Python computation vs the SQL the agent cites."""
    rows = []
    rng = random.Random(3)
    regions = ["Karnataka", "Maharashtra", "Delhi", "Tamil Nadu", "Gujarat", "Telangana", "West Bengal"]
    months = ["January", "February", "March", "April", "May", "June", "July", "August", "September"]
    con = sqlite3.connect(db.DB_PATH)
    raw = con.execute("SELECT order_date, region, amount, status, is_deleted FROM sales_orders").fetchall()
    for _ in range(20):
        reg, m1 = rng.choice(regions), rng.choice(months[1:])
        m0 = months[months.index(m1) - 1]
        A.LAST.clear()
        r = run1(f"compare revenue {m1} 2026 vs {m0} 2026 in {reg}", fresh_ctx())
        k = next((c for c in r["cards"] if c["type"] == "kpis"), None)
        src = next((c for c in r["cards"] if c["type"] == "sources"), None)
        mi = months.index(m1) + 1
        a, b = f"2026-{mi:02d}-01", f"2026-{mi:02d}-31"
        truth = sum(x[2] for x in raw if a <= x[0] <= b and x[1] == reg and x[3] != "Cancelled" and not x[4])
        shown = parse_inr(k["items"][0]["value"]) if k else None
        sql_v = con.execute(src["items"][0]["sql"]).fetchone()[0] if src else None
        ok_num = shown is not None and truth and abs(shown - truth) / truth <= 0.01
        ok_src = sql_v is not None and abs(sql_v - truth) <= 1
        text = " ".join(e["text"] for e in r["events"] if e["t"] == "text")
        nums = [parse_inr(x) for x in re.findall(r"₹\s?[-\d,.]+\s*(?:Cr|L)?", text)]
        faithful = all(any(abs(n - v) / max(abs(v), 1) <= 0.01 for v in (truth, sql_v or 0, parse_inr((k or {"items": [{}, {"value": ""}]})["items"][1].get("value", "")) or 0)) for n in nums if n)
        rows.append({"suite": "analytical", "test": f"{reg}: {m1} vs {m0}", "expected": round(truth), "got": round(shown or 0), "pass": bool(ok_num and ok_src), "faithful": faithful,
                     "reason": "" if ok_num and ok_src else f"shown {shown}, sql {sql_v}"})
    con.close()
    return rows


def pct(xs):
    xs = list(xs)
    return round(100 * sum(xs) / len(xs), 1) if xs else None


def main():
    t0 = time.time()
    core, gen1, gen2 = suite_core(), suite_intents("paraphrases.json", "paraphrase"), suite_intents("blind_test.json", "blind")
    typos = suite_typos() if os.path.exists(os.path.join(HERE, "typo_cases.json")) else []
    safety, follow, retr, anal = suite_safety(), suite_followups(), suite_retrieval(), suite_analytical()
    lat = sorted(r["ms"] for r in core)
    ranks = [r["rank"] for r in retr]
    kpis = {
        "Intent-to-destination accuracy": pct(r["page_ok"] for r in core if r["has_page"]),
        "Intent accuracy (core)": pct(r["intent_ok"] for r in core),
        "UI-state correctness (filters, dates, sort)": pct(r["filters_ok"] for r in core if r["has_filters"]),
        "Task success (core, strict)": pct(r["pass"] for r in core),
        "Multi-step task success": pct(r["pass"] for r in follow),
        "Avg steps per request": round(statistics.mean(r["steps"] for r in core), 2),
        "Avg tool calls per request": round(statistics.mean(r["tools"] for r in core), 2),
        "Latency p50 (ms)": round(statistics.median(lat), 1),
        "Latency p95 (ms)": round(lat[int(len(lat) * 0.95) - 1], 1),
        "Analytical correctness (within 1%)": pct(r["pass"] for r in anal),
        "Explanation faithfulness": pct(r["faithful"] for r in anal),
        "Retrieval precision@1": pct(r == 1 for r in ranks),
        "Retrieval recall@3": pct(r is not None and r <= 3 for r in ranks),
        "Retrieval MRR": round(sum(1 / r for r in ranks if r) / len(ranks), 3),
        "Correct refusals": pct(r["pass"] for r in safety if r["kind"] == "refuse"),
        "Correct clarifications": pct(r["pass"] for r in safety if r["kind"] == "clarify"),
        "Meta / help answers": pct(r["pass"] for r in safety if r["kind"] not in ("refuse", "clarify")),
        "Invalid actions executed": sum(r.get("invalid_action", False) for r in safety) + sum(r["unrequested_write"] for r in core),
        "Generalization: paraphrases (tuned on)": pct(r["pass"] for r in gen1),
        "Generalization: blind set (never tuned)": pct(r["pass"] for r in gen2),
        "Typo robustness": pct(r["pass"] for r in typos) if typos else None,
    }
    suites = {}
    for r in core + gen1 + gen2 + typos + safety + follow + retr + anal:
        s = suites.setdefault(r["suite"], {"suite": r["suite"], "tests": 0, "passed": 0})
        s["tests"] += 1; s["passed"] += bool(r["pass"])
    for s in suites.values():
        s["rate"] = round(100 * s["passed"] / s["tests"], 1)
    allrows = core + gen1 + gen2 + typos + safety + follow + retr + anal
    out = {"ran_at": time.strftime("%Y-%m-%d %H:%M:%S"), "seconds": round(time.time() - t0, 1), "kpis": kpis, "suites": list(suites.values()),
           "failures": [r for r in allrows if not r["pass"]], "tests": len(allrows),
           "note": "Test sets are synthetic and written by the BizPilot team. 'paraphrase' was used for tuning; 'blind' was never tuned on."}
    json.dump(out, open(os.path.join(HERE, "results.json"), "w"), indent=1, default=str)
    with open(os.path.join(HERE, "results.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["suite", "test", "expected", "got", "pass", "ms", "reason"], extrasaction="ignore")
        w.writeheader(); w.writerows(allrows)
    return out


if __name__ == "__main__":
    o = main()
    if "--json" in sys.argv:
        print(json.dumps(o, default=str))
    else:
        print(json.dumps(o["kpis"], indent=1))
        print(json.dumps(o["suites"], indent=1))
        for f in o["failures"]:
            print(" FAIL", f["suite"], "|", f["test"], "|", f.get("reason"))

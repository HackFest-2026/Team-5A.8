"""Build the static, serverless version of BizPilot: one self-contained HTML file.
The in-browser engine (deploy/web/engine.js) replaces the Python backend; the UI is the same frontend/app.js.
Usage: python deploy/build_web.py   -> deploy/web/dist/bizpilot.html (hostable anywhere: Netlify, GitHub Pages, S3...)
       python deploy/build_web.py --standalone  -> also inlines Chart.js (works fully offline)"""
import os, re, sys, json, subprocess
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "backend"))

def read(*p):
    return open(os.path.join(*p), encoding="utf-8").read()

def build(standalone=False, doctype=False):
    import metadata as M
    meta = {"PAGES": M.PAGES, "NAV": M.NAV, "ENTITIES": M.ENTITIES, "APIS": M.APIS, "REGIONS": M.REGIONS, "CATEGORIES": M.CATEGORIES,
            "CHANNELS": M.CHANNELS, "SEGMENTS": M.SEGMENTS, "CARRIERS": M.CARRIERS, "EXP_CATS": M.EXP_CATS,
            "TABLE_DOCS": M.TABLE_DOCS, "KPI_DICTIONARY": M.KPI_DICTIONARY, "APPROVAL_POLICY": M.APPROVAL_POLICY, "APPROVAL_POLICY_NOTE": M.APPROVAL_POLICY_NOTE,
            "SPELL_DOMAIN": M.SPELL_DOMAIN, "SPELL_COMMON": M.SPELL_COMMON}
    code = read(HERE, "web", "engine.js") + "".join(read(ROOT, "backend", f) for f in ("agent.py", "nlu.py", "intents.py"))
    meta["SPELL_CODE"] = sorted(set(re.findall(r"[a-z]{3,}", code)))
    meta["EVAL_TARGETS"] = M.EVAL_TARGETS
    import db as _db
    meta.update({"STACK": M.STACK, "PIPELINE": M.PIPELINE, "HITL": M.HITL, "QUICK_PROMPTS": M.QUICK_PROMPTS, "REVIEW_CONFIDENCE": M.REVIEW_CONFIDENCE, "REVIEW_HISTORY": _db.REVIEW_HISTORY})
    ev = os.path.join(ROOT, "eval")
    meta["EVAL"] = {k: json.load(open(os.path.join(ev, f))) for k, f in (("core", "utterances.json"), ("paraphrase", "paraphrases.json"), ("blind", "blind_test.json"),
                    ("typos", "typo_cases.json"), ("safety", "safety_tests.json"), ("followups", "followup_tests.json"), ("retrieval", "retrieval_queries.json"))}
    idx = read(ROOT, "frontend", "index.html")
    body = re.search(r"<body>(.*?)<script", idx, re.S).group(1)
    css = read(ROOT, "frontend", "styles.css")
    app = read(ROOT, "frontend", "app.js")
    eng = read(HERE, "web", "engine.js")
    sqljs = read(ROOT, "frontend", "vendor", "sql-asm.js")
    for name, code in (("app.js", app), ("engine.js", eng)):
        assert "</script" not in code.lower(), name
    chart = (f"<script>{read(ROOT, 'frontend', 'vendor', 'chart.umd.min.js')}</script>\n<script>{read(ROOT, 'frontend', 'vendor', 'jspdf.umd.min.js')}</script>" if standalone
             else '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>\n<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>')
    html = f"""<title>BizPilot AI</title>
<meta name="description" content="Supply chain and business operations app with an embedded context-aware AI agent.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">
<style>
{css}
html,body{{height:100%}}body{{background:var(--bg);color:var(--ink)}}#app{{height:100%}}#login{{min-height:100%}}
</style>
{body}
{chart}
<script>{sqljs}</script>
<script>window.BP_EMBED = true; window.BP_META = {json.dumps(meta)};</script>
<script>
{eng}
</script>
<script>
{app}
</script>
"""
    if doctype:
        html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n' + html.replace("\n<style>", "\n<style>", 1) + "</html>"
    return html

if __name__ == "__main__":
    out = os.path.join(HERE, "web", "dist"); os.makedirs(out, exist_ok=True)
    open(os.path.join(out, "bizpilot.html"), "w", encoding="utf-8").write(build(standalone="--standalone" in sys.argv))
    open(os.path.join(out, "index.html"), "w", encoding="utf-8").write(build(standalone=True, doctype=True))
    print("built", out)

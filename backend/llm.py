"""Optional LLM fallback. The rule router handles most requests in ~ms; the LLM is only called when the
router is unsure. It rewrites a free-form request into a canonical command the router understands, or answers
a general question grounded in the current page summary. Works with Anthropic (default) or any
OpenAI-compatible endpoint. No key set -> agent runs fully offline."""
import os, json, urllib.request

PROVIDER = os.environ.get("LLM_PROVIDER", "anthropic").lower()
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
OPENAI_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_BASE = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
MODEL = os.environ.get("LLM_MODEL", "claude-haiku-4-5" if PROVIDER == "anthropic" else "gpt-4o-mini")
TIMEOUT = float(os.environ.get("LLM_TIMEOUT", "20"))

CANONICAL = """Canonical commands the app understands (fill <> slots):
- open <page> [for <region>] [<status>] [<period like 'last quarter', 'this month', 'last 6 months', 'Q2 2026', 'Mar 2026'>]
- what is on this page
- products likely to run out in <N> days [and create purchase orders]
- create purchase order for <qty> <product> [from <supplier>]
- compare suppliers for <product>
- compare <revenue|orders|units> <period A> vs <period B> [in <region>]
- why did <revenue|orders> drop in <region> [<period>]
- top <N> <products|customers|suppliers|regions|categories|channels> by <revenue|units|orders>
- <metric> trend <period>
- show delayed shipments [in <region>]
- net profit <period> / expense breakdown <period>
- change <field> of <record> to <value>   (fields: price, cost, stock, reorder level, status, rating, lead time, qty)
- delete <supplier|product|customer|PO-xxxxx>
- add supplier <name> in <city> / add product <name> category <category> price <n> cost <n>
- show pending requests / approve request <n> / reject request <n>
- find <text>
Pages: dashboard, inventory, suppliers, procurement, sales, customers, logistics, finance, analytics, approvals, activity."""


def enabled():
    return bool(ANTHROPIC_KEY if PROVIDER == "anthropic" else OPENAI_KEY)


def _call(system, user):
    if PROVIDER == "anthropic":
        body = {"model": MODEL, "max_tokens": 400, "system": system, "messages": [{"role": "user", "content": user}]}
        req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(),
                                     headers={"x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            d = json.loads(r.read())
        return "".join(b.get("text", "") for b in d.get("content", []))
    body = {"model": MODEL, "max_tokens": 400, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    req = urllib.request.Request(OPENAI_BASE.rstrip("/") + "/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {OPENAI_KEY}", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        d = json.loads(r.read())
    return d["choices"][0]["message"]["content"]


def interpret(query, page_summary):
    """Returns {"rewrite": str} or {"answer": str} or None."""
    if not enabled():
        return None
    system = ("You are the intent layer of BizPilot, a supply-chain business app agent. Convert the user's request into ONE canonical "
              "command if it maps to an app action. Otherwise answer briefly using only the page context. Reply with JSON only: "
              '{"rewrite": "<canonical command>"} or {"answer": "<short answer>"}.\n\n' + CANONICAL)
    try:
        txt = _call(system, f"Current page context:\n{page_summary}\n\nUser request: {query}")
        s, e = txt.find("{"), txt.rfind("}")
        return json.loads(txt[s:e + 1]) if s >= 0 else {"answer": txt.strip()}
    except Exception as ex:
        return {"error": str(ex)}

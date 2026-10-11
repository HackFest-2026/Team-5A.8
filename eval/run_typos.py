"""Typo robustness: each test utterance gets 1-2 random typos (swap, drop, double, wrong key) in words of 5+ letters.
Measures intent + destination accuracy with automatic spelling correction."""
import os, sys, json, random, re, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(HERE, "..", "backend"))
os.environ["BIZPILOT_DB"] = os.path.join(tempfile.mkdtemp(), "typo.db")
import db; db.init_db()
import agent as A
from db import q1
KEYS = "qwertyuiopasdfghjklzxcvbnm"
NEAR = {c: KEYS[max(0, i - 1)] + KEYS[min(len(KEYS) - 1, i + 1)] for i, c in enumerate(KEYS)}
rng = random.Random(7)

def typo(w):
    i = rng.randint(1, len(w) - 2); k = rng.choice(["swap", "drop", "double", "near"])
    if k == "swap": return w[:i] + w[i + 1] + w[i] + w[i + 2:]
    if k == "drop": return w[:i] + w[i + 1:]
    if k == "double": return w[:i] + w[i] + w[i:]
    return w[:i] + rng.choice(NEAR.get(w[i], w[i])) + w[i + 1:]

u = q1("SELECT id, username, name, role FROM users WHERE username='admin'")
items = json.load(open(os.path.join(HERE, "utterances.json")))
ok = tested = 0; fails = []; cases = []
for it in items:
    words = it["utterance"].split()
    idx = [i for i, w in enumerate(words) if re.fullmatch(r"[A-Za-z]{5,}", w)]
    if not idx: continue
    for i in rng.sample(idx, min(len(idx), rng.choice([1, 2]))):
        words[i] = typo(words[i])
    text = " ".join(words); tested += 1; cases.append({"utterance": text, "intent": it["intent"], "page": it["page"]})
    evs = list(A.run(text, A.Ctx(u, "dashboard", {}, [{"page": "inventory", "filters": {}}])))
    navs = [e for e in evs if e["t"] == "action" and e["action"] == "navigate"]
    page = navs[-1]["page"] if navs else None
    good = evs[-1]["intent"] == it["intent"] and (it["page"] is None or page == it["page"])
    ok += good
    if not good: fails.append((text, evs[-1]["intent"], it["intent"]))
json.dump(cases, open(os.path.join(HERE, "typo_cases.json"), "w"), indent=1)
for f in fails: print("  miss:", f)
print(f"typo robustness: {ok}/{tested} = {100 * ok / tested:.1f}% (intent + destination)")

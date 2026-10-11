"""Held-out paraphrase test (not used to build rules or examples). Measures intent accuracy on loose phrasing."""
import os, sys, json
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(HERE, "..", "backend"))
import db; db.init_db()
import agent as A
from db import q1
u = q1("SELECT id, username, name, role FROM users WHERE username='admin'")
items = json.load(open(os.path.join(HERE, "paraphrases.json"))); ok = 0
for it in items:
    evs = list(A.run(it["utterance"], A.Ctx(u, "dashboard")))
    got = evs[-1]["intent"]; good = got == it["intent"]; ok += good
    if not good: print(f"  miss: {it['utterance']!r} -> {got} (want {it['intent']})")
print(f"paraphrase intent accuracy: {ok}/{len(items)} = {100*ok/len(items):.1f}%")

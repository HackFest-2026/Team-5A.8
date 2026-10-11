"""Auto spelling correction tuned to the app's vocabulary (pages, metrics, statuses, regions, products, suppliers, customers).
Only corrects tokens that are not known words; never touches numbers, codes (PO-00012), emails or short words."""
import re
from collections import Counter
import metadata as M
from db import q

_V = {"vocab": None, "bylen": None}


def _words(text):
    return re.findall(r"[a-z]+", (text or "").lower())


def code_words():
    """Every word the router itself understands (regex literals in agent/nlu/intents) is a known word."""
    import os
    here = os.path.dirname(os.path.abspath(__file__))
    ws = set()
    for f in ("agent.py", "nlu.py", "intents.py"):
        ws |= set(re.findall(r"[a-z]{3,}", open(os.path.join(here, f), encoding="utf-8").read()))
    return ws


def build():
    import intents
    words = Counter()
    for w in M.SPELL_DOMAIN:
        words[w] += 5
    for p in M.PAGES:
        for w in _words(" ".join([p["title"], p["keywords"], p["description"], " ".join(x[2] for x in p["widgets"]), " ".join(f["label"] for f in p["filters"])])):
            words[w] += 2
        for f in p["filters"]:
            for o in f.get("options", []):
                for w in _words(o):
                    words[w] += 2
    for e in M.ENTITIES.values():
        for w in _words(e["label"] + " " + " ".join(f["label"] for f in e["fields"])):
            words[w] += 1
    for xs in intents.EXAMPLES.values():
        for t in xs:
            for w in _words(t):
                words[w] += 1
    for w in intents.NORM:
        words[w] += 1
    for t in ("products", "suppliers", "customers"):
        for r in q(f"SELECT name FROM {t} WHERE is_deleted=0"):
            for w in _words(r["name"]):
                words[w] += 3
    for r in q("SELECT DISTINCT city FROM customers"):
        for w in _words(r["city"]):
            words[w] += 2
    vocab = {w: c for w, c in words.items() if len(w) >= 3}
    bylen = {}
    for w in vocab:
        bylen.setdefault(len(w), []).append(w)
    _V["vocab"], _V["bylen"] = vocab, bylen
    _V["known"] = set(vocab) | set(M.SPELL_COMMON) | code_words()


def invalidate():
    _V["vocab"] = None


def osa(a, b, maxd):
    """Optimal string alignment distance (Damerau-Levenshtein with adjacent transpositions), early exit."""
    la, lb = len(a), len(b)
    if abs(la - lb) > maxd:
        return maxd + 1
    prev2, prev = None, list(range(lb + 1))
    for i in range(1, la + 1):
        cur = [i] + [0] * lb
        best = cur[0]
        for j in range(1, lb + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            v = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                v = min(v, prev2[j - 2] + 1)
            cur[j] = v
            best = min(best, v)
        if best > maxd:
            return maxd + 1
        prev2, prev = prev, cur
    return prev[lb]


def suggest(word):
    if _V["vocab"] is None:
        build()
    maxd = 1 if len(word) <= 5 else 2
    best, bd, tie = None, maxd + 1, False
    for L in range(len(word) - maxd, len(word) + maxd + 1):
        for w in _V["bylen"].get(L, []):
            d = osa(word, w, maxd)
            if d < bd or (d == bd and best and (_V["vocab"][w], w[0] == word[0]) > (_V["vocab"][best], best[0] == word[0])):
                tie = d == bd and best is not None and _V["vocab"][w] == _V["vocab"][best] and (w[0] == word[0]) == (best[0] == word[0])
                best, bd = w, d
            elif d == bd and best and _V["vocab"][w] == _V["vocab"][best] and (w[0] == word[0]) == (best[0] == word[0]):
                tie = True
    if best is None or bd > maxd or (tie and bd == 2):
        return None
    return best


SHORTHAND = {"lst": "last", "nxt": "next", "prev": "previous", "mnth": "month", "mth": "month", "mths": "months", "qtr": "quarter", "qtrs": "quarters", "yr": "year", "yrs": "years",
             "pls": "please", "plz": "please", "wat": "what", "wht": "what", "shw": "show", "sho": "show", "rev": "revenue", "inv": "inventory", "qty": "qty", "amt": "amount",
             "pos": "pos", "u": "you", "ur": "your", "r": "are", "abt": "about", "btw": "between", "vs": "vs", "thru": "through", "tmrw": "tomorrow", "ystd": "yesterday",
             "wk": "week", "wks": "weeks", "dlvry": "delivery", "shpmt": "shipment", "supp": "supplier", "cust": "cust", "pdt": "product", "prdt": "product", "approv": "approve"}


def correct(text):
    """Returns (corrected_text, [(wrong, right), ...])."""
    if _V["vocab"] is None:
        build()
    fixes = []

    def short(m):
        w = m.group(0)
        r = SHORTHAND.get(w.lower())
        if r and r != w.lower():
            fixes.append((w, r))
            return r
        return w
    text = re.sub(r"(?<![\w@.-])[A-Za-z]{1,6}(?![\w@-])", short, text)

    def fix(m):
        w = m.group(0)
        lw = w.lower()
        if len(lw) < 4 or lw in _V["known"]:
            return w
        # plural / -ing / -ed of known words are fine
        for suf in ("s", "es", "ing", "ed", "ly"):
            if lw.endswith(suf) and lw[: -len(suf)] in _V["known"]:
                return w
        s = suggest(lw)
        if s and s != lw:
            fixes.append((w, s))
            return s
        return w
    # skip codes like PO-00012, emails, numbers
    out = re.sub(r"(?<![\w@.-])[A-Za-z]+(?![\w@-])", fix, text)
    return out, fixes

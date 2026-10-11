"""Auth, RBAC, CRUD, change-request workflow, audit. Enforced in backend — the agent cannot bypass it."""
import os, json, hmac, hashlib, base64, time
from datetime import datetime, date, timedelta
from db import q, q1, ex, hash_pw
import metadata as M

SECRET = os.environ.get("BIZPILOT_SECRET", "change-me-in-production").encode()
TOKEN_TTL = 12 * 3600

PERMS = {
    "admin": {"read", "create", "update", "delete", "approve"},
    "manager": {"read", "create", "request"},
    "staff": {"read", "create", "request"},
    "viewer": {"read"},
}


class PermissionDenied(Exception):
    pass


class NotFound(Exception):
    pass


def can(user, perm):
    return perm in PERMS.get(user["role"], set())


def require(user, perm):
    if not can(user, perm):
        raise PermissionDenied(f"Role '{user['role']}' cannot {perm}.")


# ---------- tokens ----------
def _b64(b):
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def make_token(user):
    payload = json.dumps({"u": user["username"], "r": user["role"], "exp": int(time.time()) + TOKEN_TTL}).encode()
    sig = hmac.new(SECRET, payload, hashlib.sha256).digest()
    return _b64(payload) + "." + _b64(sig)


def verify_token(tok):
    try:
        p, s = tok.split(".")
        payload = base64.urlsafe_b64decode(p + "=" * (-len(p) % 4))
        sig = base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
        if not hmac.compare_digest(sig, hmac.new(SECRET, payload, hashlib.sha256).digest()):
            return None
        d = json.loads(payload)
        if d["exp"] < time.time():
            return None
        u = q1("SELECT id, username, name, role FROM users WHERE username=?", (d["u"],))
        return u
    except Exception:
        return None


SIGNUP_ROLES = ("viewer", "staff", "manager")


def signup(name, username, email, password, role="staff"):
    """Self-service account. Viewer/staff granted at once; manager is created as staff + a role request for admin approval."""
    import re
    name, username, email = (name or "").strip(), (username or "").strip().lower(), (email or "").strip().lower()
    if len(name) < 2:
        raise ValueError("Enter your full name.")
    if not re.fullmatch(r"[a-z0-9_.]{3,20}", username):
        raise ValueError("Username: 3-20 characters, letters, numbers, dot or underscore.")
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[a-z]{2,}", email):
        raise ValueError("Enter a valid email address.")
    if len(password or "") < 6:
        raise ValueError("Password must be at least 6 characters.")
    if role not in SIGNUP_ROLES:
        raise ValueError("Choose viewer, staff or manager.")
    if q1("SELECT id FROM users WHERE username=?", (username,)):
        raise ValueError("Username already taken.")
    if q1("SELECT id FROM users WHERE email=?", (email,)):
        raise ValueError("An account with this email already exists. Sign in instead.")
    granted = "staff" if role == "manager" else role
    uid = ex("INSERT INTO users(username,name,role,password_hash,email,created_at) VALUES(?,?,?,?,?,?)", (username, name, granted, hash_pw(password), email, now()))
    u = {"id": uid, "username": username, "name": name, "role": granted}
    audit(u, "signup", "users", username, f"role {granted}", "ui")
    pending = None
    if role == "manager":
        pending = ex("INSERT INTO change_requests(entity,record_id,record_label,action,changes,reason,status,requested_by,created_at,via) VALUES(?,?,?,?,?,?,?,?,?,?)",
                     ("users", uid, f"user {username} ({name})", "role", json.dumps({"role": {"old": granted, "new": "manager"}}), "Requested at sign-up", "Pending", username, now(), "ui"))
    return {"user": u, "granted_role": granted, "role_request_id": pending}


def login(username, password):
    u = q1("SELECT id, username, name, role, password_hash FROM users WHERE username=?", (username,))
    if not u or u["password_hash"] != hash_pw(password):
        return None
    u.pop("password_hash")
    audit(u, "login", "users", u["username"], "", "ui")
    return {"token": make_token(u), "user": u, "permissions": sorted(PERMS[u["role"]])}


# ---------- audit ----------
def now():
    return datetime.now().isoformat(timespec="seconds")


def audit(user, action, entity, label, details, via="ui"):
    ex("INSERT INTO audit_log(ts,username,action,entity,record_label,details,via) VALUES(?,?,?,?,?,?,?)",
       (now(), user["username"], action, entity, label, details if isinstance(details, str) else json.dumps(details), via))


# ---------- notifications ----------
ENTITY_PAGE = {"products": "inventory", "suppliers": "suppliers", "purchase_orders": "procurement", "customers": "customers", "sales_orders": "sales",
               "shipments": "logistics", "expenses": "finance", "users": "approvals"}


def notify(recipients, kind, title, body, page=None, filters=None, entity=None, record_id=None, request_id=None):
    if recipients == "@admins":
        recipients = [r["username"] for r in q("SELECT username FROM users WHERE role='admin'")]
    for r in ([recipients] if isinstance(recipients, str) else recipients):
        ex("INSERT INTO notifications(ts,recipient,kind,title,body,page,filters,entity,record_id,request_id,is_read) VALUES(?,?,?,?,?,?,?,?,?,?,0)",
           (now(), r, kind, title, body, page, json.dumps(filters or {}), entity, record_id, request_id))


def list_notifications(user, limit=40):
    rows = q("SELECT * FROM notifications WHERE recipient=? ORDER BY ts DESC, id DESC LIMIT ?", (user["username"], limit))
    unread = q1("SELECT COUNT(*) n FROM notifications WHERE recipient=? AND is_read=0", (user["username"],))["n"]
    for r in rows:
        r["filters"] = json.loads(r["filters"] or "{}")
    return {"items": rows, "unread": unread}


def mark_notifications(user, ids=None):
    if ids:
        ex(f"UPDATE notifications SET is_read=1 WHERE recipient=? AND id IN ({','.join('?' * len(ids))})", [user["username"]] + list(ids))
    else:
        ex("UPDATE notifications SET is_read=1 WHERE recipient=?", (user["username"],))
    return list_notifications(user)


def change_text(cr):
    if cr["action"] == "delete":
        return "delete"
    ch = json.loads(cr["changes"] or "{}")
    return ", ".join(f"{k}: {v['old']} → {v['new']}" for k, v in ch.items())


def record_link(entity, rec):
    """Page + filters that show this record in a grid."""
    page = ENTITY_PAGE.get(entity, "approvals")
    if not rec:
        return page, {}
    if entity in ("products", "suppliers", "customers"):
        return page, {"q": rec.get("name")}
    code = rec.get(M.ENTITIES[entity]["code"]) if entity in M.ENTITIES else None
    return page, ({"q": code} if code else {})


def record_view(entity, rid, diff=None):
    """Readable snapshot of a record after a change, with changed fields marked (shown right after approval)."""
    if entity not in M.ENTITIES:
        return None
    e = M.ENTITIES[entity]
    r = q1(f"SELECT * FROM {e['table']} WHERE id=?", (rid,))
    if not r:
        return None
    diff = diff or {}
    fields = [] if any(f["key"] == e["code"] for f in e["fields"]) else [{"key": e["code"], "label": "Code", "value": r.get(e["code"])}]
    for f in e["fields"]:
        v = r.get(f["key"])
        if f["type"] == "ref" and v:
            ref = M.ENTITIES[f["ref"]]
            rr = q1(f"SELECT {ref['code']} c, {ref['name']} n FROM {ref['table']} WHERE id=?", (v,))
            v = f"{rr['c']} · {rr['n']}" if rr else v
        item = {"key": f["key"], "label": f["label"], "value": v}
        if f["key"] in diff:
            item["changed"] = True
            item["old"] = diff[f["key"]].get("old")
        fields.append(item)
    if entity == "purchase_orders":
        fields.append({"key": "amount", "label": "Amount (₹)", "value": r["amount"], "changed": "qty" in diff or "unit_cost" in diff})
    page, flt = record_link(entity, r)
    return {"type": "record", "title": record_label(entity, r), "entity": entity, "deleted": bool(r.get("is_deleted")), "fields": fields, "page": page, "filters": flt}


# ---------- records ----------
def ent(entity):
    if entity not in M.ENTITIES:
        raise NotFound(f"Unknown entity {entity}")
    return M.ENTITIES[entity]


def get_record(entity, rid):
    e = ent(entity)
    r = q1(f"SELECT * FROM {e['table']} WHERE id=? AND is_deleted=0", (rid,))
    if not r:
        raise NotFound(f"{e['label']} {rid} not found")
    return r


def record_label(entity, r):
    e = ent(entity)
    code, name = r.get(e["code"]), r.get(e["name"])
    return f"{code} {name}" if name and name != code else str(code)


def find_record(entity, ref):
    """Resolve by numeric id, code (SKU, PO-00012) or fuzzy name."""
    e = ent(entity)
    ref = str(ref).strip()
    if ref.isdigit():
        r = q1(f"SELECT * FROM {e['table']} WHERE id=? AND is_deleted=0", (int(ref),))
        if r:
            return r
    r = q1(f"SELECT * FROM {e['table']} WHERE UPPER({e['code']})=UPPER(?) AND is_deleted=0", (ref,))
    if r:
        return r
    r = q1(f"SELECT * FROM {e['table']} WHERE LOWER({e['name']})=LOWER(?) AND is_deleted=0", (ref,))
    if r:
        return r
    return q1(f"SELECT * FROM {e['table']} WHERE LOWER({e['name']}) LIKE LOWER(?) AND is_deleted=0 ORDER BY LENGTH({e['name']})", (f"%{ref}%",))


def coerce(entity, data, partial=False):
    e = ent(entity)
    fields = {f["key"]: f for f in e["fields"]}
    out = {}
    for k, v in data.items():
        if k not in fields:
            continue
        f = fields[k]
        if v in ("", None):
            continue
        if f["type"] in ("number", "ref"):
            v = float(v)
            if f["type"] == "ref" or k in ("qty", "stock", "reorder_level", "lead_time_days", "delay_days"):
                v = int(v)
        if f["type"] == "select" and f.get("options") and v not in f["options"]:
            match = [o for o in f["options"] if o.lower() == str(v).lower()]
            if not match:
                raise ValueError(f"{f['label']} must be one of {', '.join(f['options'])}")
            v = match[0]
        out[k] = v
    if not partial:
        missing = [f["label"] for f in e["fields"] if f.get("required") and f["key"] not in out]
        if missing:
            raise ValueError("Missing: " + ", ".join(missing))
    return out


def next_code(entity):
    e = ent(entity)
    if not e["prefix"]:
        return None
    r = q1(f"SELECT {e['code']} c FROM {e['table']} WHERE {e['code']} LIKE ? ORDER BY id DESC LIMIT 1", (e["prefix"] + "%",))
    n = int(r["c"].split("-")[-1]) + 1 if r else 1
    width = 3 if entity == "suppliers" else (4 if entity == "customers" else 5)
    return f"{e['prefix']}{n:0{width}d}"


def create_record(user, entity, data, via="ui"):
    require(user, "create")
    e = ent(entity)
    d = coerce(entity, data)
    if e["prefix"]:
        d[e["code"]] = next_code(entity)
    if entity == "purchase_orders":
        d.setdefault("status", "Draft")
        if user["role"] != "admin" and d["status"] not in ("Draft", "Pending"):
            d["status"] = "Pending"
        d["amount"] = round(d["qty"] * d["unit_cost"], 2)
        d["order_date"] = date.today().isoformat()
        sup = get_record("suppliers", d["supplier_id"])
        d.setdefault("expected_date", (date.today() + timedelta(days=sup["lead_time_days"])).isoformat())
        d["created_by"] = user["username"]
    if entity == "sales_orders":
        d["amount"] = round(d["qty"] * d["unit_price"], 2)
        d.setdefault("status", "Processing")
        d["order_date"] = date.today().isoformat()
    if entity == "products":
        d.setdefault("stock", 0); d.setdefault("reorder_level", 10); d.setdefault("unit", "pcs"); d.setdefault("warehouse", "Bengaluru WH")
    if entity == "suppliers":
        d.setdefault("rating", 4.0); d.setdefault("lead_time_days", 10); d.setdefault("on_time_rate", 0.9); d.setdefault("country", "India")
    cols = ",".join(d)
    rid = ex(f"INSERT INTO {e['table']}({cols}) VALUES({','.join('?' * len(d))})", list(d.values()))
    r = get_record(entity, rid)
    audit(user, "create", entity, record_label(entity, r), {k: v for k, v in d.items()}, via)
    return r


def _diff(entity, r, changes):
    d = coerce(entity, changes, partial=True)
    return {k: {"old": r.get(k), "new": v} for k, v in d.items() if r.get(k) != v}


def _apply_update(user, entity, r, diff, via):
    e = ent(entity)
    sets = {k: v["new"] for k, v in diff.items()}
    if entity == "purchase_orders" and ("qty" in sets or "unit_cost" in sets):
        sets["amount"] = round(sets.get("qty", r["qty"]) * sets.get("unit_cost", r["unit_cost"]), 2)
    if entity == "sales_orders" and ("qty" in sets or "unit_price" in sets):
        sets["amount"] = round(sets.get("qty", r["qty"]) * sets.get("unit_price", r["unit_price"]), 2)
    ex(f"UPDATE {e['table']} SET {','.join(k + '=?' for k in sets)} WHERE id=?", list(sets.values()) + [r["id"]])
    audit(user, "update", entity, record_label(entity, r), diff, via)
    return get_record(entity, r["id"])


def update_record(user, entity, rid, changes, via="ui"):
    require(user, "update")
    r = get_record(entity, rid)
    diff = _diff(entity, r, changes)
    if not diff:
        return r
    return _apply_update(user, entity, r, diff, via)


def delete_record(user, entity, rid, via="ui"):
    require(user, "delete")
    e = ent(entity)
    r = get_record(entity, rid)
    ex(f"UPDATE {e['table']} SET is_deleted=1 WHERE id=?", (rid,))
    audit(user, "delete", entity, record_label(entity, r), "soft delete", via)
    return {"deleted": True, "label": record_label(entity, r)}


POLICY_USER = {"id": 0, "username": "auto-policy", "name": "Auto-approval policy", "role": "admin"}


def policy_check(action, diff):
    """Returns the list of rules satisfied if every changed field is low-risk, else None (needs an admin)."""
    if action != "update" or not diff:
        return None
    rules = {r["field"]: r for r in M.APPROVAL_POLICY}
    ok = []
    for k, v in diff.items():
        r = rules.get(k)
        if not r:
            return None
        if r["rule"] != "any":
            old, new = v.get("old"), v.get("new")
            if old in (None, "") or not isinstance(new, (int, float)):
                return None
            if r["rule"] == "pct":
                if not old or abs(new - old) / abs(old) * 100 > r["limit"] + 1e-9:
                    return None
            elif abs(new - old) > r["limit"] + 1e-9:
                return None
        ok.append(r["label"])
    return ok


def request_change(user, entity, rid, action, changes=None, reason="", via="ui"):
    require(user, "request")
    r = get_record(entity, rid)
    diff = _diff(entity, r, changes or {}) if action == "update" else {}
    if action == "update" and not diff:
        raise ValueError("No change detected.")
    label = record_label(entity, r)
    cid = ex("INSERT INTO change_requests(entity,record_id,record_label,action,changes,reason,status,requested_by,created_at,via) VALUES(?,?,?,?,?,?,?,?,?,?)",
             (entity, rid, label, action, json.dumps(diff), reason, "Pending", user["username"], now(), via))
    audit(user, "request_" + action, entity, label, diff or "delete", via)
    passed = policy_check(action, diff)
    page, flt = record_link(entity, r)
    if not passed:
        notify("@admins", "request", f"New request #{cid} from {user['username']}", f"{label}: {change_text({'action': action, 'changes': json.dumps(diff)})}" + (f" · {reason}" if reason else ""),
               "approvals", {"status": "Pending"}, entity, rid, cid)
    if passed:
        _apply_update(POLICY_USER, entity, r, diff, "policy")
        ex("UPDATE change_requests SET status='Approved', reviewed_by='auto-policy', review_note=?, reviewed_at=? WHERE id=?", ("Auto-approved: " + "; ".join(passed), now(), cid))
        audit(POLICY_USER, "review_approve", entity, label, f"request #{cid} auto-approved by policy", "policy")
        notify(user["username"], "auto", f"Request #{cid} auto-approved by policy", f"{label}: {change_text({'action': action, 'changes': json.dumps(diff)})} · applied", page, flt, entity, rid, cid)
    out = q1("SELECT * FROM change_requests WHERE id=?", (cid,))
    out["auto_approved"] = bool(passed)
    return out


def write_or_request(user, entity, rid, action, changes=None, reason="", via="ui"):
    """Single entry point: admin applies directly, others create a change request."""
    if action == "delete":
        if can(user, "delete"):
            return {"mode": "applied", "result": delete_record(user, entity, rid, via)}
    elif can(user, "update"):
        return {"mode": "applied", "result": update_record(user, entity, rid, changes, via)}
    if can(user, "request"):
        r = request_change(user, entity, rid, action, changes, reason, via)
        return {"mode": "auto_approved" if r.get("auto_approved") else "requested", "result": r}
    raise PermissionDenied(f"Role '{user['role']}' is read-only.")


def review_request(user, req_id, decision, note="", via="ui"):
    require(user, "approve")
    cr = q1("SELECT * FROM change_requests WHERE id=?", (req_id,))
    if not cr:
        raise NotFound(f"Request #{req_id} not found")
    if cr["status"] != "Pending":
        raise ValueError(f"Request #{req_id} already {cr['status']}")
    result = None
    if decision == "approve":
        if cr["action"] == "role":
            new_role = json.loads(cr["changes"])["role"]["new"]
            ex("UPDATE users SET role=? WHERE id=?", (new_role, cr["record_id"]))
            audit(user, "update", "users", cr["record_label"], {"role": new_role}, via)
        elif cr["action"] == "delete":
            result = delete_record(user, cr["entity"], cr["record_id"], via)
        else:
            r = get_record(cr["entity"], cr["record_id"])
            diff = json.loads(cr["changes"])
            stale = [f"{k} is now {r.get(k)} (request expected {v['old']})" for k, v in diff.items()
                     if not (r.get(k) == v["old"] or (isinstance(r.get(k), (int, float)) and isinstance(v["old"], (int, float)) and abs(r.get(k) - v["old"]) < 1e-6))]
            if stale:
                raise ValueError(f"Request #{req_id} is out of date: " + "; ".join(stale) + ". Ask the requester to resubmit.")
            result = _apply_update(user, cr["entity"], r, diff, via)
    status = "Approved" if decision == "approve" else "Rejected"
    ex("UPDATE change_requests SET status=?, reviewed_by=?, review_note=?, reviewed_at=? WHERE id=?", (status, user["username"], note, now(), req_id))
    if cr["entity"] == "users":
        page, flt = "approvals", {}
    else:
        rec = q1(f"SELECT * FROM {M.ENTITIES[cr['entity']]['table']} WHERE id=?", (cr["record_id"],)) if cr["entity"] in M.ENTITIES else None
        page, flt = record_link(cr["entity"], rec) if (rec and not rec.get("is_deleted")) else ("approvals", {})
    ex("UPDATE notifications SET is_read=1 WHERE request_id=? AND kind='request'", (req_id,))
    notify(cr["requested_by"], status.lower(), f"Request #{req_id} {status.lower()} by {user['username']}", f"{cr['record_label']}: {change_text(cr)}" + (f" · {note}" if note else ""),
           page, flt, cr["entity"], cr["record_id"], req_id)
    audit(user, "review_" + decision, cr["entity"], cr["record_label"], f"request #{req_id}: {note}", via)
    view = record_view(cr["entity"], cr["record_id"], json.loads(cr["changes"] or "{}")) if decision == "approve" and cr["entity"] in M.ENTITIES else None
    return {"request": q1("SELECT * FROM change_requests WHERE id=?", (req_id,)), "result": result, "record": view}


def review_many(user, decision="approve", ids=None, note="", via="ui"):
    require(user, "approve")
    ids = sorted(ids or [r["id"] for r in q("SELECT id FROM change_requests WHERE status='Pending' ORDER BY id")])
    done, failed = [], []
    for i in ids:
        try:
            review_request(user, i, decision, note, via)
            done.append(i)
        except Exception as e:
            failed.append((i, str(e)))
    return {"done": done, "failed": failed}


def list_requests(user, status=None, mine=False):
    w, a = ["1=1"], []
    if status:
        w.append("status=?"); a.append(status)
    if mine:
        w.append("requested_by=?"); a.append(user["username"])
    return q(f"SELECT * FROM change_requests WHERE {' AND '.join(w)} ORDER BY id DESC", a)


def ref_options(entity):
    e = ent(entity)
    return [{"value": r["id"], "label": f"{r[e['code']]} · {r[e['name']]}"} for r in q(f"SELECT id, {e['code']}, {e['name']} FROM {e['table']} WHERE is_deleted=0 ORDER BY {e['name']}")]


# ---------------- human-in-the-loop review of agent answers ----------------
def queue_review(user, log_id, query, intent, page, answer, confidence, source, reason):
    rid = ex("INSERT INTO agent_reviews(ts,username,log_id,query,intent,page,answer,confidence,source,reason,status) VALUES(?,?,?,?,?,?,?,?,?,?,'Open')",
             (now(), user["username"], log_id, query[:300], intent, page, (answer or "")[:1200], confidence, source, reason[:300]))
    title = f"Agent answer flagged by {user['username']}" if source == "user" else "Low-confidence agent answer queued"
    notify("@admins", "review", title, f"“{query[:80]}” · {reason[:120]}", "review", {"status": "Open"})
    return rid


def feedback(user, log_id, vote, reason="", answer="", query=""):
    """vote: up | down | flag. Down and flag put the answer in the admin review queue."""
    row = q1("SELECT * FROM agent_log WHERE id=?", (log_id,)) if log_id else None
    if row and row["username"] != user["username"]:
        raise PermissionDenied("You can only rate your own agent answers.")
    if row:
        ex("UPDATE agent_log SET feedback=? WHERE id=?", (vote, log_id))
    if vote == "up":
        return {"ok": True, "queued": None}
    existing = q1("SELECT id FROM agent_reviews WHERE log_id=? AND status='Open'", (log_id,)) if log_id else None
    if existing:
        return {"ok": True, "queued": existing["id"]}
    rid = queue_review(user, log_id, (row or {}).get("query") or query, (row or {}).get("intent") or "", (row or {}).get("page") or "",
                       answer, (row or {}).get("confidence"), "user", reason or ("Marked wrong" if vote == "down" else "Sent for review"))
    return {"ok": True, "queued": rid}


def review_answer(user, rid, verdict, note=""):
    if "approve" not in PERMS[user["role"]]:
        raise PermissionDenied("Only an admin can review agent answers.")
    if verdict not in ("Correct", "Wrong"):
        raise ValueError("verdict must be Correct or Wrong")
    r = q1("SELECT * FROM agent_reviews WHERE id=?", (rid,))
    if not r:
        raise NotFound(f"Review #{rid} not found")
    if r["status"] != "Open":
        raise ValueError(f"Review #{rid} is already {r['status']}")
    ex("UPDATE agent_reviews SET status=?, reviewer=?, verdict_note=?, reviewed_at=? WHERE id=?", (verdict, user["username"], note, now(), rid))
    audit(user, "review", "agent_reviews", f"Review #{rid}", {"verdict": verdict, "note": note}, "ui")
    if r["username"] != user["username"]:
        notify(r["username"], "approved" if verdict == "Correct" else "rejected", f"Your flagged answer #{rid} reviewed: {verdict}",
               f"“{r['query'][:80]}”" + (f" · {note}" if note else ""), "review", {})
    return {"ok": True, "id": rid, "status": verdict}

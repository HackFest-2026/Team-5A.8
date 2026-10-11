"""BizPilot API server: auth, page data, CRUD with RBAC, change requests, semantic search, streaming agent."""
import os, json, time
from fastapi import FastAPI, HTTPException, Header, Request, Depends
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional, Any

import db
db.init_db()
import metadata as M
import pages as P
import services as S
import retrieval as R
import agent as A
import nlu as N
import llm

FRONT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")
app = FastAPI(title="BizPilot AI", version="1.0.0")


def user_dep(authorization: Optional[str] = Header(None)):
    tok = (authorization or "").replace("Bearer ", "")
    u = S.verify_token(tok) if tok else None
    if not u:
        raise HTTPException(401, "Login required")
    return u


def guard(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except S.PermissionDenied as e:
        raise HTTPException(403, str(e))
    except S.NotFound as e:
        raise HTTPException(404, str(e))
    except (ValueError, KeyError) as e:
        raise HTTPException(400, str(e))


class LoginIn(BaseModel):
    username: str
    password: str


@app.post("/api/auth/login")
def login(body: LoginIn):
    r = S.login(body.username.strip().lower(), body.password)
    if not r:
        raise HTTPException(401, "Invalid username or password")
    return r


class SignupIn(BaseModel):
    name: str
    username: str
    email: str
    password: str
    role: Optional[str] = "staff"


@app.post("/api/auth/signup")
def signup(body: SignupIn):
    r = guard(S.signup, body.name, body.username, body.email, body.password, body.role)
    out = S.login(r["user"]["username"], body.password)
    out["granted_role"], out["role_request_id"] = r["granted_role"], r["role_request_id"]
    return out


@app.get("/api/auth/me")
def me(u=Depends(user_dep)):
    return {"user": u, "permissions": sorted(S.PERMS[u["role"]])}


@app.get("/api/meta")
def meta(u=Depends(user_dep)):
    m = M.public_meta()
    m["llm"] = {"enabled": llm.enabled(), "model": llm.MODEL if llm.enabled() else None}
    m["targets"] = M.EVAL_TARGETS
    m["quick_prompts"] = M.QUICK_PROMPTS
    m["review_threshold"] = M.REVIEW_CONFIDENCE
    m["server_now"] = S.now()
    return m


@app.get("/api/pages/{page_id}/data")
def page_data(page_id: str, request: Request, u=Depends(user_dep)):
    f = dict(request.query_params)
    sort = f.pop("sort", None)
    if page_id not in M.PAGE:
        raise HTTPException(404, "Unknown page")
    return guard(P.page_data, page_id, f, sort)


@app.get("/api/refs/{entity}")
def refs(entity: str, u=Depends(user_dep)):
    return guard(S.ref_options, entity)


@app.get("/api/entities/{entity}/{rid}")
def get_entity(entity: str, rid: int, u=Depends(user_dep)):
    return guard(S.get_record, entity, rid)


@app.post("/api/entities/{entity}")
def create_entity(entity: str, body: dict, u=Depends(user_dep)):
    r = guard(S.create_record, u, entity, body)
    N.invalidate(); R.build()
    return r


@app.put("/api/entities/{entity}/{rid}")
def update_entity(entity: str, rid: int, body: dict, u=Depends(user_dep)):
    r = guard(S.update_record, u, entity, rid, body)
    N.invalidate(); R.build()
    return r


@app.delete("/api/entities/{entity}/{rid}")
def delete_entity(entity: str, rid: int, u=Depends(user_dep)):
    r = guard(S.delete_record, u, entity, rid)
    N.invalidate(); R.build()
    return r


class ReqIn(BaseModel):
    entity: str
    record_id: int
    action: str
    changes: Optional[dict] = None
    reason: Optional[str] = ""


@app.post("/api/requests")
def create_request(body: ReqIn, u=Depends(user_dep)):
    return guard(S.request_change, u, body.entity, body.record_id, body.action, body.changes, body.reason)


@app.get("/api/requests")
def list_requests(status: Optional[str] = None, mine: bool = False, u=Depends(user_dep)):
    return S.list_requests(u, status, mine)


class ReviewIn(BaseModel):
    decision: str
    note: Optional[str] = ""


@app.post("/api/requests/{rid}/review")
def review(rid: int, body: ReviewIn, u=Depends(user_dep)):
    r = guard(S.review_request, u, rid, body.decision, body.note)
    N.invalidate(); R.build()
    return r


@app.get("/api/data/catalog")
def data_catalog(u=Depends(user_dep)):
    import dataset as DS
    return {"tables": DS.catalog(), "kpis": DS.kpi_dictionary(), "sql_allowed": u["role"] in ("admin", "manager")}


@app.get("/api/data/table/{table}")
def data_table(table: str, q: str = "", offset: int = 0, limit: int = 50, sort: Optional[str] = None, u=Depends(user_dep)):
    import dataset as DS
    return guard(DS.browse, table, q, offset, limit, sort)


class SqlIn(BaseModel):
    sql: str


@app.post("/api/data/sql")
def data_sql(body: SqlIn, u=Depends(user_dep)):
    import dataset as DS
    try:
        return DS.run_sql(u, body.sql)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/requests/review-all")
def review_all(body: ReviewIn, u=Depends(user_dep)):
    r = guard(S.review_many, u, body.decision, None, body.note)
    N.invalidate(); R.build()
    return r


@app.post("/api/eval/run")
def eval_run(u=Depends(user_dep)):
    """Runs eval/evaluate.py on a fresh temporary database (never touches live data)."""
    import subprocess, sys as _s
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env = {**os.environ, "EVAL_FRESH": "1"}
    env.pop("BIZPILOT_DB", None)
    r = subprocess.run([_s.executable, os.path.join(root, "eval", "evaluate.py"), "--json"], capture_output=True, text=True, timeout=180, env=env)
    if r.returncode != 0:
        raise HTTPException(500, "Evaluation failed: " + r.stderr[-400:])
    return json.loads(r.stdout.strip().splitlines()[-1])


@app.get("/api/eval/results")
def eval_results(u=Depends(user_dep)):
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "eval", "results.json")
    return json.load(open(path)) if os.path.exists(path) else {}


@app.get("/api/notifications")
def notifications(u=Depends(user_dep)):
    return S.list_notifications(u)


class ReadIn(BaseModel):
    ids: Optional[list] = None


@app.post("/api/notifications/read")
def notifications_read(body: ReadIn, u=Depends(user_dep)):
    return S.mark_notifications(u, body.ids)


@app.get("/api/search")
def search(q: str, u=Depends(user_dep)):
    return R.search(q, 8)


@app.get("/api/analytics/stockout")
def an_stockout(days: int = 14, u=Depends(user_dep)):
    return P.stockout(days)


@app.get("/api/analytics/suppliers/compare")
def an_suppliers(product_id: int, u=Depends(user_dep)):
    return P.supplier_options(product_id)


@app.get("/api/analytics/drivers")
def an_drivers(date_from: str, date_to: str, metric: str = "revenue", region: Optional[str] = None, u=Depends(user_dep)):
    return P.drivers(date_from, date_to, metric, {"region": region} if region else None)


@app.get("/api/analytics/top")
def an_top(kind: str = "products", n: int = 5, metric: str = "revenue", u=Depends(user_dep)):
    return P.top_n(kind, n, None, None, metric)


class ChatIn(BaseModel):
    message: str
    page: Optional[str] = "dashboard"
    filters: Optional[dict] = None
    trail: Optional[list] = None


@app.post("/api/agent/chat")
def chat(body: ChatIn, u=Depends(user_dep)):
    ctx = A.Ctx(u, body.page if body.page in M.PAGE else "dashboard", body.filters or {}, body.trail or [])

    def gen():
        for ev in A.run(body.message, ctx):
            yield json.dumps(ev, default=str) + "\n"
    return StreamingResponse(gen(), media_type="application/x-ndjson")


class ConfirmIn(BaseModel):
    token: str
    edits: Optional[dict] = None


@app.post("/api/agent/confirm")
def confirm(body: ConfirmIn, u=Depends(user_dep)):
    return {"events": A.confirm(body.token, u, body.edits)}


@app.post("/api/agent/route")
def route_only(body: ChatIn, u=Depends(user_dep)):
    """Debug: show the plan without executing."""
    p = A.route(body.message, A.Ctx(u, body.page))
    p["slots"] = {k: (v if not isinstance(v, dict) else {"id": v.get("id"), "name": v.get("name")}) for k, v in p["slots"].items()}
    return p


class FeedbackIn(BaseModel):
    log_id: Optional[int] = None
    vote: str
    reason: Optional[str] = ""
    answer: Optional[str] = ""
    query: Optional[str] = ""


@app.post("/api/agent/feedback")
def agent_feedback(body: FeedbackIn, u=Depends(user_dep)):
    if body.vote not in ("up", "down", "flag"):
        raise HTTPException(400, "vote must be up, down or flag")
    return guard(S.feedback, u, body.log_id, body.vote, body.reason or "", body.answer or "", body.query or "")


class VerdictIn(BaseModel):
    verdict: str
    note: Optional[str] = ""


@app.post("/api/reviews/{rid}")
def review_answer(rid: int, body: VerdictIn, u=Depends(user_dep)):
    return guard(S.review_answer, u, rid, body.verdict, body.note or "")


@app.get("/api/health")
def health():
    return {"ok": True, "llm": llm.enabled()}


app.mount("/static", StaticFiles(directory=FRONT), name="static")


@app.get("/")
def index():
    return FileResponse(os.path.join(FRONT, "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8000")))

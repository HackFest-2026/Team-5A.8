# BizPilot AI — Context-Aware Application Agent

Supply-chain & business operations app (11 pages) with an embedded agent that navigates, filters, analyzes, fills forms and acts on the user's behalf — inside role-based permissions.

## Run

```bash
# Python 3.10+
./run.sh            # Linux / macOS
run.bat             # Windows
# or: pip install -r requirements.txt && cd backend && python app.py
```

Open http://127.0.0.1:8000. First start generates the database (~25 months of synthetic data, ending yesterday).

### Accounts
The app always opens on **Sign in**. New users pick **Create account** (name, email, username, password, access level):
- Viewer or Staff: granted immediately.
- Manager: account starts as Staff and a role request goes to the admin's Approvals queue. Admin approves in the grid or by telling the agent *approve request N*.

| User | Password | Role |
|---|---|---|
| admin | admin123 | Full CRUD, approves change requests |
| manager | manager123 | Create, request update/delete |
| staff | staff123 | Create, request update/delete |
| viewer | viewer123 | Read only |

No API key needed. Optional LLM fallback: copy `.env.example` to `.env`, set `ANTHROPIC_API_KEY` (or OpenAI-compatible).

## Deploy

Two builds, same UI and same agent logic.

**1. Full server (Python API + SQLite)**
- Docker: `docker build -t bizpilot . && docker run -p 8000:8000 bizpilot`
- Render: push repo to GitHub → Render → New → Blueprint → select repo (`render.yaml` included). Free plan works.
- Railway / Heroku-style: `Procfile` included.
- Set `BIZPILOT_SECRET` in production. Optional `ANTHROPIC_API_KEY` for LLM fallback.

**2. Static, serverless (agent runs in the browser)**
- `python deploy/build_web.py` → `deploy/web/dist/`
  - `index.html`: fully offline single file (Chart.js inlined). Open directly or host anywhere.
  - `bizpilot.html`: same, loads Chart.js from CDN.
- Netlify: connect repo (`netlify.toml` included). Or drag `deploy/web/dist` into Netlify Drop. GitHub Pages / S3 also fine.
- `deploy/web/engine.js` is a JS port of the backend (data generator, pages, RBAC, approvals, retrieval, NLU, agent). Same 115/115 eval parity.
- Data is per browser (localStorage). Admin → "Reset demo data" restores it. Role switching (staff → admin approvals) works in the same browser.

## Pages (`page_id`)

`dashboard` · `analytics` · `inventory` · `suppliers` · `procurement` · `logistics` · `sales` · `customers` · `finance` · `approvals` · `review` · `activity` · `data` · `evaluation` · `stack`

Every page, widget and filter has an id (`data-page-id`, `data-widget-id`). The agent receives the current page, filters and navigation trail with every message.

## Approvals
- **Auto-approval policy** (`metadata.APPROVAL_POLICY`): low-risk changes from staff/manager are approved and applied instantly by `auto-policy` (price/cost ≤ 10%, qty ≤ 25%, stock ≤ 20%, reorder ≤ 50%, rating ≤ 0.5, lead time ≤ 3 days, contact details, ETA/carrier). Deletes, role changes, status changes and larger changes go to an admin.
- Admin tells the agent **"approve the requests"** / "approve request 4" / "reject request 2 because …" → executed immediately and audit-logged.
- Approvals page shows the policy, auto-approved count and decision notes.

## Header
Breadcrumb (group / page) · Quick prompts ("Karnataka Sales", "Cancelled Orders", "MoM Trend") · **Export to PDF/CSV** · notification bell · user pill (Role: NAME, click for logout).

## Voice
- 🎤 mic in the agent box: speak a question (Web Speech API, en-IN). Live transcript, sends when you stop.
- 🔊 **Explain** under every answer reads it aloud and explains charts, KPIs, tables, refusals and record changes in plain words.
- "Speak answers" toggle reads every answer. Voice questions get spoken replies automatically.
- Needs Chrome/Edge for the mic. In the hosted claude.ai preview the mic may be blocked by the viewer; the server build works.

## Human in the loop
- Writes: confirm card or "Ask first" plan (Proceed / Cancel) before anything changes.
- Changes by non-admins: approval workflow + auto-policy + notifications.
- Answers: 👍 / 👎 / ⚑ Review under every answer, plus a confidence badge.
- Confidence < 45% (no exact rule, weak page guess, LLM rewrite) → auto-queued for review.
- **Agent Review page** (`review`): admin marks Correct / Wrong with a note; user notified. KPIs: open, reviewed, human-verified accuracy, helpful votes.

## Export
- Header → Export to PDF/CSV: PDF summary of the current page (filters, KPIs, insights, charts, table, latest answer), CSV of the main table, or PDF of the agent conversation.
- ⤓ PDF under any answer. Agent commands: "export this page as pdf", "download csv", "convert the chat to pdf".
- jsPDF in the browser; no server needed.

## Implementation Stack page (`stack`)
Every layer, technology, code location and reason, plus the agent pipeline and human-in-the-loop flow. Ask "what is the implementation stack?".

| Layer | Technology |
|---|---|
| Frontend | Vanilla JS SPA, HTML5, CSS3 |
| Charts | Chart.js 4.4 |
| Voice | Web Speech API (SpeechRecognition + speechSynthesis) |
| Export | jsPDF 2.5 + CSV |
| API | Python, FastAPI, Uvicorn, Pydantic |
| Database | SQLite, 14 tables, 25 months synthetic data |
| Auth/RBAC | HMAC tokens, SHA-256 hashes, server-side permissions |
| Approvals | Change requests, auto-approval policy, stale guard, notifications |
| Spell fix | OSA edit distance over domain vocabulary |
| NLU | Regex slot extraction (dates, regions, products, statuses) |
| Router | Rules → TF-IDF classifier → validator (refusal codes) |
| Retrieval | TF-IDF + synonyms + trigrams |
| Analytics | Python computations from SQL (no invented numbers) |
| Optional LLM | Anthropic / OpenAI-compatible, off by default |
| Evaluation | Labelled suites, strict scoring, fresh DB |
| Serverless | JS port of backend + sql.js + localStorage |
| Deploy | Docker, Render, Procfile, Netlify |

## Notifications
- Bell in header (polls every 15 s). Admins see every new change request. Requesters see *approved / auto-approved / rejected* with the decision note.
- Clicking a notification marks it read and opens the page with the changed record highlighted.
- After approval (grid, bell or agent) the updated record is shown: before → after values, record card in chat, modal in the grid.
- Stale guard: approval refused if the record changed since the request was made.

## Agent: refusals, follow-ups, sources
- Refusal codes: `PAGE_NOT_FOUND`, `FILTER_NOT_ON_PAGE`, `VALUE_NOT_ALLOWED`, `DATE_OUT_OF_RANGE`, `INVALID_DATE_RANGE`, `WRITE_NOT_ALLOWED`, prompt-injection. Each says why and offers valid options.
- Clarifies ambiguous asks instead of guessing.
- Follow-ups keep context: "Now show products", "same for Delhi", "only Electrical", "clear filters", "explain that".
- "Ask first" toggle: plan card with Proceed / Cancel before acting.
- Why-analysis: like-for-like periods, drivers by region/category/product, delays, stock-outs, **what the data cannot prove**, Sources card with SQL ("Run this SQL").
- Dashboard "Agent noticed" insights + "Ask" button on each widget.

## Evaluation page (`page_id: evaluation`)
Runs the full suite in the app (fresh DB snapshot, restored after). Strict scoring, misses listed, nothing hidden.

## Data & KPIs page (`page_id: data`)
- Catalog of all 12 tables: description, row count, date coverage, every column with type and meaning.
- KPI dictionary: 25 KPIs with formula, time window and live value.
- Table browser over every table (search, paging, CSV download on the server build).
- Read-only SQL console (admin, manager): one SELECT/WITH statement, password columns blocked, 3 s timeout, results auto-charted. The agent accepts `sql: select …` too.
- Static build runs SQL in the browser with sql.js (asm build, no server).

## Pre-loaded history
The database ships with operations already done: 8 change requests (pending, admin-approved, auto-approved, rejected, a manager-role sign-up flow), agent-drafted POs, direct admin edits, a week of logins and 20 agent queries in the logs.

## Agent efficiency

Two-stage understanding, no network call on the hot path:
1. **Rule router** (`agent.py`): precise intents + slot extraction (dates, regions, products, statuses, codes).
2. **Semantic classifier** (`intents.py`): runs only when rules matched just a page or nothing. TF-IDF unigrams+bigrams with business synonyms ("stuck" → delay, "run short" → stock-out, "sign off" → approval). The prediction is rewritten into a canonical command, so stage 1 still extracts the slots.
3. Optional LLM fallback only after both miss.

Also:
- **Auto spelling correction** (`spell.py`): domain vocabulary (pages, metrics, statuses, regions, cities, every product/supplier/customer name, router keywords) + shorthand (lst → last, qtr → quarter). Optimal-string-alignment distance ≤1 (≤2 for long words); known English words are never touched; codes, emails and numbers skipped. The reply shows what it understood: “invetory” → “inventory”.
- **Multi-step**: "show Karnataka sales last quarter, then top 5 products; then why did revenue drop in Maharashtra" runs as 3 tasks in one reply.
- **Page-data cache**: agent read and UI render of the same view compute once (invalidated on any data write).
- **Every data answer is visualized**: stock cover bars with severity colors, supplier score and price bars, period comparison bars, driver bars (red = decline), trend line with dashed forecast, delay bars by carrier/region, P&L line and expense doughnut, KPI tiles on navigation.

## Agent — try these

| Ask | What happens |
|---|---|
| What is on this page? | Reads current page KPIs/grid, summarizes, flags risks |
| Show Karnataka sales for last quarter | Opens Sales, sets region + date range |
| Show me products likely to run out in 14 days | Velocity forecast, table, sorts Inventory |
| Analyze items that may run out in next 14 days and create purchase order drafts with best supplier options | Forecast → supplier scoring → bulk PO drafts (confirm card) |
| Compare top 3 suppliers for steel with best pricing | Weighted supplier score: price 40, rating 25, on-time 20, lead 15 |
| Why did revenue drop in Maharashtra? | Driver decomposition + delays + carrier + cancellations + stock-outs |
| Compare revenue this month vs last month | Period compare, like-for-like for partial month, region split |
| Top 5 products by revenue / top 10 customers | Ranking + chart, opens Analytics |
| Show last 12 months analysis | Trend, peak/low, MoM, 6-month slope forecast |
| Create purchase order for 500 Steel Rod | Best supplier, confirm card or autofilled form |
| Add supplier Acme Steels in Pune | Opens form, types values (agent autofill) |
| Change price of Copper Wire to 430 | Admin: apply. Others: change request |
| Delete supplier Unichem Traders | Admin: soft delete. Others: request |
| Show pending requests / Approve request 1 | Admin approval via chat |
| Why did logistics cost increase? | Expense category comparison + delay link |
| Find copper / go back | Semantic search / page trail |

## RBAC & safety

- Permissions enforced in backend (`services.py`), not in the prompt. Agent inherits the logged-in user's role.
- Non-admin update/delete → `change_requests` row → admin approves → applied → `audit_log`.
- Every agent write needs a confirm card click. Delete is soft.
- Eval measures unconfirmed writes: 0.

## Architecture

```
Browser (vanilla JS SPA, hash router, Chart.js)
  ├─ pages render from /api/pages/{id}/data
  └─ agent panel ──POST /api/agent/chat (NDJSON stream: step | text | action | card | done)
FastAPI
  ├─ agent.py      intent router → slot filler → handlers → events; confirm tokens for writes
  ├─ nlu.py        dates/periods ("Q2 2026", "last quarter", "A vs B"), regions+city aliases, status, products, suppliers
  ├─ retrieval.py  TF-IDF + synonyms + trigram index over pages, widgets, APIs, records (swap for pgvector/FAISS)
  ├─ llm.py        optional: rewrites free-form text into a canonical command; only on router miss
  ├─ pages.py      page data + analytics (same functions for UI and agent → answers traceable)
  ├─ services.py   auth (HMAC token), RBAC, CRUD, change requests, audit
  ├─ metadata.py   nav tree, page/widget/filter catalog, entity schemas, API catalog
  └─ db.py         SQLite + synthetic data generator
```

### Latency design

- No UI clicking. Agent calls the same data functions as the UI, then pushes route + filters to the browser.
- Rule router first (ms). LLM only on miss.
- Streamed steps; UI navigates while text still arrives.
- In-process tools, indexed SQLite, cached name lookups.

Measured (115 utterances, laptop-class CPU): p50 ≈ 7 ms, p95 ≈ 22 ms server-side.

## Evaluation

```bash
python eval/run_eval.py          # EVAL_ROLE=staff for role variant
```

Reports intent accuracy, intent→destination accuracy, UI-state (filter) correctness, task success, latency p50/p95, page/API retrieval MRR, unconfirmed-write count. Corpus: `eval/utterances.json` (115 labelled utterances).

Note: corpus was written alongside the router, so 100% is in-distribution.

Loose phrasing:
- `python eval/run_paraphrase.py`: 40 paraphrases. 37.5% before the classifier, 100% after (this set was used for tuning).
- `python eval/run_blind.py`: 25 phrasings written after tuning, never tuned on: **92%** (23/25).
- `python eval/run_typos.py`: the 115 requests with 1-2 random typos each (108 eligible). **50% without correction → 98.1% with correction.**
- `python eval/evaluate.py`: all suites → `eval/results.json` / `results.csv` (shown on Evaluation page).
- All evals run on a fresh temporary database because the agent executes real approvals.

Latest (server): core intent/destination/UI-state/task 100%, multi-step 100%, analytical 100%, refusals 100% (28 safety cases), clarifications 100%, follow-ups 100%, invalid actions 0, paraphrase 100%, blind 92%, typos 98.1%, retrieval P@1 86.7% / R@3 100% / MRR 0.93, p95 ≈ 26 ms.

Known gaps: blind misses "are any products about to go out of stock", "which shipping partner is the slowest". No row-level ACCESS_DENIED scoping. Understanding is rules + TF-IDF, not an LLM/vector DB.

Synthetic data includes planted signals for demo: Maharashtra revenue dip in the last 60 days driven by carrier (Gati) delays; several items under 14 days of cover; two out-of-stock items.

## Production path

- SQLite → Postgres; TF-IDF → pgvector embeddings (same `search()` interface).
- HMAC token → OIDC/JWT; per-tenant data.
- Playwright fallback for third-party screens without APIs.
- Persist confirm tokens in Redis; add rate limits.

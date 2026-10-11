"""Application metadata: navigation tree, page/widget/filter catalog, entity schemas, API catalog.
This is the knowledge the agent reasons over (the 'no-code platform export')."""

REGIONS = ["Karnataka", "Maharashtra", "Delhi", "Tamil Nadu", "Gujarat", "Telangana", "West Bengal"]
CATEGORIES = ["Raw Materials", "Components", "Electrical", "Packaging", "Chemicals", "Safety"]
CHANNELS = ["Direct Sales", "Distributor", "Online Portal"]
SEGMENTS = ["Enterprise", "Wholesale", "Retail", "Distributor"]
CARRIERS = ["BlueDart", "Delhivery", "DTDC", "Gati", "Ecom Express"]
WAREHOUSES = ["Bengaluru WH", "Mumbai WH", "Delhi WH"]
SO_STATUS = ["Processing", "Shipped", "Delivered", "Cancelled", "Returned"]
PO_STATUS = ["Draft", "Pending", "Approved", "Received", "Cancelled"]
SH_STATUS = ["Pending", "In Transit", "Delayed", "Delivered"]
CR_STATUS = ["Pending", "Approved", "Rejected"]
EXP_CATS = ["Logistics", "Salaries", "Rent", "Marketing", "Utilities", "Administrative"]

DATE = {"key": "date", "label": "Date range", "type": "daterange"}

NAV = [
    {"group": "Overview", "pages": ["dashboard", "analytics"]},
    {"group": "Supply Chain", "pages": ["inventory", "suppliers", "procurement", "logistics"]},
    {"group": "Commercial", "pages": ["sales", "customers", "finance"]},
    {"group": "Governance", "pages": ["approvals", "review", "activity", "data"]},
    {"group": "System", "pages": ["evaluation", "stack"]},
]

PAGES = [
    {"id": "dashboard", "title": "Dashboard", "icon": "grid", "entity": None,
     "description": "Real-time overview of revenue, orders, inventory value, suppliers, revenue trend, inventory status and low stock alerts.",
     "keywords": "home overview summary kpi executive business health total revenue orders inventory value",
     "widgets": [("kpi_revenue", "kpi", "Total Revenue"), ("kpi_orders", "kpi", "Total Orders"), ("kpi_inventory", "kpi", "Inventory Value"),
                 ("kpi_suppliers", "kpi", "Active Suppliers"), ("chart_trend", "line", "Revenue & Orders Trend"),
                 ("chart_inventory_status", "doughnut", "Inventory Status"), ("grid_low_stock", "grid", "Low Stock Alerts")],
     "filters": [DATE, {"key": "region", "label": "Region", "type": "select", "options": REGIONS}],
     "suggestions": ["What is on this page?", "Show me products likely to run out in 14 days", "Compare revenue this month vs last month", "Why did revenue drop in Maharashtra?"]},
    {"id": "inventory", "title": "Inventory", "icon": "box", "entity": "products",
     "description": "Product catalog with stock levels, reorder levels, days of cover, stock value and warehouse location.",
     "keywords": "stock products items sku warehouse reorder low stock out of stock days left catalog material",
     "widgets": [("kpi_items", "kpi", "Total Items"), ("kpi_value", "kpi", "Stock Value"), ("kpi_low", "kpi", "Low Stock"),
                 ("kpi_out", "kpi", "Out of Stock"), ("chart_value_by_cat", "bar", "Stock Value by Category"), ("grid_products", "grid", "Products")],
     "filters": [{"key": "category", "label": "Category", "type": "select", "options": CATEGORIES},
                 {"key": "stock_status", "label": "Stock status", "type": "select", "options": ["In Stock", "Low Stock", "Out of Stock"]},
                 {"key": "warehouse", "label": "Warehouse", "type": "select", "options": WAREHOUSES},
                 {"key": "q", "label": "Search", "type": "text"}],
     "suggestions": ["Show out of stock items", "Products likely to run out in 14 days", "Create purchase orders for low stock items", "Change reorder level of Steel Rod to 400"]},
    {"id": "suppliers", "title": "Suppliers", "icon": "users", "entity": "suppliers",
     "description": "Supplier directory with rating, lead time, on-time delivery rate, categories supplied and spend.",
     "keywords": "vendors supplier rating lead time on time delivery performance vendor list sourcing",
     "widgets": [("kpi_active", "kpi", "Active Suppliers"), ("kpi_rating", "kpi", "Avg Rating"), ("kpi_ontime", "kpi", "Avg On-time"),
                 ("chart_ontime", "bar", "On-time Delivery by Supplier"), ("grid_suppliers", "grid", "Suppliers")],
     "filters": [{"key": "category", "label": "Category", "type": "select", "options": CATEGORIES},
                 {"key": "min_rating", "label": "Min rating", "type": "select", "options": ["3.5", "4.0", "4.5"]},
                 {"key": "q", "label": "Search", "type": "text"}],
     "suggestions": ["Compare suppliers for Steel Rod", "Show suppliers with rating above 4.5", "Add supplier Acme Steels in Pune"]},
    {"id": "procurement", "title": "Procurement", "icon": "cart", "entity": "purchase_orders",
     "description": "Purchase orders raised to suppliers with status, quantity, cost, expected delivery and monthly purchase spend.",
     "keywords": "purchase order po buying sourcing procurement spend draft pending approved received replenishment",
     "widgets": [("kpi_spend", "kpi", "PO Spend"), ("kpi_open", "kpi", "Open POs"), ("kpi_draft", "kpi", "Drafts"),
                 ("chart_spend", "bar", "Monthly Purchase Spend"), ("grid_pos", "grid", "Purchase Orders")],
     "filters": [DATE, {"key": "status", "label": "Status", "type": "select", "options": PO_STATUS},
                 {"key": "supplier", "label": "Supplier", "type": "text"}, {"key": "q", "label": "Search", "type": "text"}],
     "suggestions": ["Show draft purchase orders", "Create purchase order for 500 Steel Rod", "Show pending POs this month"]},
    {"id": "sales", "title": "Sales & Orders", "icon": "receipt", "entity": "sales_orders",
     "description": "Customer sales orders with region, channel, status, amount and monthly revenue trend.",
     "keywords": "sales orders revenue invoices order status delivered cancelled returned region channel bookings",
     "widgets": [("kpi_revenue", "kpi", "Revenue"), ("kpi_orders", "kpi", "Orders"), ("kpi_aov", "kpi", "Avg Order Value"),
                 ("kpi_cancel", "kpi", "Cancel Rate"), ("chart_monthly", "bar", "Monthly Revenue"), ("grid_orders", "grid", "Orders")],
     "filters": [DATE, {"key": "region", "label": "Region", "type": "select", "options": REGIONS},
                 {"key": "status", "label": "Status", "type": "select", "options": SO_STATUS},
                 {"key": "channel", "label": "Channel", "type": "select", "options": CHANNELS},
                 {"key": "category", "label": "Category", "type": "select", "options": CATEGORIES},
                 {"key": "q", "label": "Search", "type": "text"}],
     "suggestions": ["Show Karnataka sales for last quarter", "Show cancelled orders", "Top 5 products by revenue"]},
    {"id": "customers", "title": "Customers", "icon": "user", "entity": "customers",
     "description": "Customer directory with segment, city, region, lifetime revenue, order count and last order date.",
     "keywords": "customer clients buyers accounts directory segment lifetime value",
     "widgets": [("kpi_customers", "kpi", "Customers"), ("kpi_active", "kpi", "Active (90d)"), ("chart_segment", "doughnut", "Revenue by Segment"),
                 ("grid_customers", "grid", "Customers")],
     "filters": [{"key": "region", "label": "Region", "type": "select", "options": REGIONS},
                 {"key": "segment", "label": "Segment", "type": "select", "options": SEGMENTS},
                 {"key": "q", "label": "Search", "type": "text"}],
     "suggestions": ["Top 10 customers by revenue", "Show enterprise customers in Delhi"]},
    {"id": "logistics", "title": "Logistics", "icon": "truck", "entity": "shipments",
     "description": "Shipments with carrier, origin warehouse, destination, status, ETA and delay days; on-time performance by carrier and region.",
     "keywords": "shipment delivery carrier transit delayed late logistics dispatch tracking eta fulfilment",
     "widgets": [("kpi_ontime", "kpi", "On-time %"), ("kpi_delayed", "kpi", "Delayed"), ("kpi_transit", "kpi", "In Transit"),
                 ("chart_delay_region", "bar", "Avg Delay by Region"), ("chart_delay_carrier", "bar", "Avg Delay by Carrier"), ("grid_shipments", "grid", "Shipments")],
     "filters": [DATE, {"key": "status", "label": "Status", "type": "select", "options": SH_STATUS},
                 {"key": "carrier", "label": "Carrier", "type": "select", "options": CARRIERS},
                 {"key": "region", "label": "Destination", "type": "select", "options": REGIONS}],
     "suggestions": ["Show delayed shipments", "Which carrier has the most delays?", "Show Maharashtra shipments last 30 days"]},
    {"id": "finance", "title": "Finance", "icon": "rupee", "entity": "expenses",
     "description": "Profit and loss: revenue, cost of goods, operating expenses, gross margin, net profit and expense breakdown by month.",
     "keywords": "finance profit loss p&l margin expense cost cogs cash flow budget spending money",
     "widgets": [("kpi_revenue", "kpi", "Revenue"), ("kpi_cogs", "kpi", "COGS"), ("kpi_opex", "kpi", "Operating Expenses"),
                 ("kpi_margin", "kpi", "Gross Margin"), ("kpi_profit", "kpi", "Net Profit"), ("chart_pl", "line", "Revenue vs Costs"),
                 ("chart_expense", "doughnut", "Expense Breakdown"), ("grid_pl", "grid", "Monthly P&L")],
     "filters": [DATE, {"key": "category", "label": "Expense type", "type": "select", "options": EXP_CATS}],
     "suggestions": ["What is our net profit this year?", "Why did logistics cost increase?", "Show expense breakdown last quarter"]},
    {"id": "analytics", "title": "Analytics", "icon": "chart", "entity": None,
     "description": "Flexible analysis: any metric (revenue, orders, units) grouped by region, category, channel or segment with period-over-period growth.",
     "keywords": "analysis analytics breakdown group by compare growth trend insights performance report",
     "widgets": [("chart_breakdown", "bar", "Current vs Previous Period"), ("chart_trend", "line", "Monthly Trend"), ("grid_breakdown", "grid", "Breakdown")],
     "filters": [DATE, {"key": "metric", "label": "Metric", "type": "select", "options": ["revenue", "orders", "units"]},
                 {"key": "group_by", "label": "Group by", "type": "select", "options": ["region", "category", "channel", "segment", "product"]},
                 {"key": "region", "label": "Region", "type": "select", "options": REGIONS}, {"key": "category", "label": "Category", "type": "select", "options": CATEGORIES}],
     "suggestions": ["Analyze revenue by region last 6 months", "Show last 12 months analysis", "Revenue by channel this year"]},
    {"id": "approvals", "title": "Approvals", "icon": "check", "entity": "change_requests",
     "description": "Change requests raised by non-admin users (updates and deletions) awaiting admin approval, with history.",
     "keywords": "approval approve reject change request pending review workflow governance",
     "widgets": [("kpi_pending", "kpi", "Pending"), ("kpi_approved", "kpi", "Approved"), ("kpi_rejected", "kpi", "Rejected"), ("grid_requests", "grid", "Change Requests")],
     "filters": [{"key": "status", "label": "Status", "type": "select", "options": CR_STATUS}],
     "suggestions": ["Summarize pending requests", "Approve request 1", "Show my requests"]},
    {"id": "activity", "title": "Agent Activity", "icon": "pulse", "entity": None,
     "description": "Audit trail of every data change and agent query latency, intents and actions taken.",
     "keywords": "audit log history activity agent latency actions trail who changed",
     "widgets": [("kpi_queries", "kpi", "Agent Queries"), ("kpi_latency", "kpi", "Avg Latency"), ("kpi_p95", "kpi", "p95 Latency"),
                 ("grid_audit", "grid", "Audit Log"), ("grid_agent", "grid", "Agent Log")],
     "filters": [],
     "suggestions": ["Who changed data today?", "What is the agent latency?"]},
]
PAGES.append({"id": "data", "title": "Data & KPIs", "icon": "db", "entity": None,
     "description": "Complete dataset: every table, column, row count and date coverage, the KPI dictionary with formulas and live values, a table browser and a read-only SQL console.",
     "keywords": "data dataset database schema tables columns rows records kpi dictionary definitions formula sql query explorer catalog",
     "widgets": [("kpi_tables", "kpi", "Tables"), ("kpi_rows", "kpi", "Total Rows"), ("kpi_span", "kpi", "Date Coverage"), ("kpi_kpis", "kpi", "KPIs Defined"),
                 ("grid_tables", "grid", "Tables"), ("grid_kpis", "grid", "KPI Dictionary"), ("table_browser", "grid", "Table Browser"), ("sql_console", "form", "SQL Console")],
     "filters": [],
     "suggestions": ["Describe the dataset", "How many sales orders are there?", "sql: select region, sum(amount) from sales_orders group by region", "List all KPIs"]})
PAGES.append({"id": "evaluation", "title": "Evaluation", "icon": "bars", "entity": None,
     "description": "Runs the labelled test sets through the same agent code on a fresh copy of the database and reports every KPI in the problem statement: intent and destination accuracy, UI-state correctness, multi-step success, latency, analytical correctness, faithfulness, retrieval P@1/R@3/MRR, refusals, clarifications and invalid actions.",
     "keywords": "evaluation benchmark accuracy test results kpi score precision recall mrr latency faithfulness refusal clarification metrics",
     "widgets": [("eval_kpis", "kpi", "KPI results"), ("grid_suites", "grid", "Test suites"), ("grid_failures", "grid", "Failures")],
     "filters": [], "suggestions": ["Run the evaluation", "What is the agent's intent accuracy?", "How fast is the agent?"]})
PAGES.append({"id": "review", "title": "Agent Review", "icon": "eye", "entity": None,
     "description": "Human-in-the-loop review of agent answers. Users flag wrong answers (thumbs down / send for review); low-confidence answers are queued automatically. Admins mark each Correct or Wrong with a note; the user is notified.",
     "keywords": "review human in the loop hitl feedback flagged wrong answers low confidence verify agent quality queue thumbs",
     "widgets": [("kpi_open", "kpi", "Open"), ("kpi_reviewed", "kpi", "Reviewed"), ("kpi_human_acc", "kpi", "Human-verified accuracy"), ("kpi_helpful", "kpi", "Helpful votes"),
                 ("grid_reviews", "grid", "Review queue")],
     "filters": [{"key": "status", "label": "Status", "type": "select", "options": ["Open", "Correct", "Wrong"]}, {"key": "source", "label": "Source", "type": "select", "options": ["user", "auto"]}],
     "suggestions": ["Show open reviews", "What is the human-verified accuracy?", "Show flagged answers"]})
PAGES.append({"id": "stack", "title": "Implementation Stack", "icon": "layers", "entity": None,
     "description": "How BizPilot is built: every layer, the technology used, where it lives in the code and why it was chosen. All free and open source.",
     "keywords": "implementation stack architecture technology tech framework built with fastapi sqlite javascript chart tfidf pipeline design",
     "widgets": [("stack_layers", "grid", "Layers"), ("stack_pipeline", "flow", "Agent pipeline"), ("stack_hitl", "flow", "Human in the loop")],
     "filters": [], "suggestions": ["What is the implementation stack?", "How does the agent understand a question?", "Open the evaluation page"]})
PAGE = {p["id"]: p for p in PAGES}

QUICK_PROMPTS = [("Karnataka Sales", "Show Karnataka sales for last quarter"), ("Cancelled Orders", "Show cancelled orders"), ("MoM Trend", "Compare revenue this month vs last month")]

STACK = [
    {"layer": "Frontend", "tech": "Vanilla JavaScript SPA, HTML5, CSS3 (Inter font)", "where": "frontend/app.js, index.html, styles.css", "why": "No build step, loads instantly, every page/widget/filter carries a data-page-id / data-widget-id the agent can target."},
    {"layer": "Charts", "tech": "Chart.js 4.4", "where": "frontend/vendor/chart.umd.min.js", "why": "Every agent answer is visualized: bars, lines with dashed forecast, doughnuts."},
    {"layer": "Voice", "tech": "Web Speech API (SpeechRecognition + speechSynthesis)", "where": "frontend/app.js · voice", "why": "Speak a question; the agent reads its answer back with an explanation. Runs in the browser, free."},
    {"layer": "PDF / CSV export", "tech": "jsPDF 2.5 (client-side) + CSV writer", "where": "frontend/vendor/jspdf.umd.min.js", "why": "Exports page summary, KPIs, charts, table and agent answers to PDF without a server."},
    {"layer": "API server", "tech": "Python 3.10+, FastAPI, Uvicorn, Pydantic", "where": "backend/app.py", "why": "Typed endpoints, NDJSON streaming for agent steps, auto docs at /docs."},
    {"layer": "Database", "tech": "SQLite · 14 tables · 25 months of synthetic data", "where": "backend/db.py", "why": "Zero setup, file-based, indexed; swap for Postgres in production."},
    {"layer": "Auth & RBAC", "tech": "HMAC-signed tokens, SHA-256 password hash, role permission sets", "where": "backend/services.py", "why": "Permissions enforced on the server, never in the prompt. Agent inherits the user's role."},
    {"layer": "Approvals", "tech": "Change-request workflow + auto-approval policy + stale-record guard", "where": "backend/services.py, metadata.APPROVAL_POLICY", "why": "Non-admin edits/deletes need approval; low-risk changes auto-approve; every decision notifies and audit-logs."},
    {"layer": "Spell correction", "tech": "Optimal-string-alignment edit distance over domain vocabulary", "where": "backend/spell.py", "why": "“Karnatka invetory” → “Karnataka inventory” before routing."},
    {"layer": "NLU", "tech": "Regex slot extraction: dates, periods, regions, cities, products, statuses", "where": "backend/nlu.py", "why": "Deterministic, millisecond, exact filters."},
    {"layer": "Intent router", "tech": "Rule router → TF-IDF semantic classifier (unigram+bigram, synonyms) → validator", "where": "backend/agent.py, intents.py", "why": "Precise rules first, classifier for loose phrasing; validator refuses invalid pages/filters/dates."},
    {"layer": "Retrieval", "tech": "TF-IDF + synonyms + character trigrams over pages, widgets, APIs, records", "where": "backend/retrieval.py", "why": "Semantic search for pages/APIs; same interface as a vector DB (pgvector/FAISS)."},
    {"layer": "Analytics", "tech": "Pure-Python computations: drivers, forecasts, supplier scoring, insights", "where": "backend/pages.py", "why": "Numbers computed in code from SQL, never invented; same functions feed UI and agent."},
    {"layer": "Optional LLM", "tech": "Anthropic / OpenAI-compatible API (off by default)", "where": "backend/llm.py", "why": "Rewrites free text into a command only when rules and classifier both miss."},
    {"layer": "Human in the loop", "tech": "Confirm cards, Ask-first plan, approvals, answer review queue", "where": "agent.py, services.py, Agent Review page", "why": "Writes need a click; flagged and low-confidence answers go to an admin who marks them Correct/Wrong."},
    {"layer": "Evaluation", "tech": "Labelled test suites, strict scoring, fresh DB per run", "where": "eval/evaluate.py, Evaluation page", "why": "Intent, UI-state, multi-step, analytical, refusals, retrieval, latency. Tuned vs blind sets reported separately."},
    {"layer": "Serverless build", "tech": "JS port of the backend + sql.js (SQLite in WebAssembly/asm.js) + localStorage journal", "where": "deploy/web/engine.js, build_web.py", "why": "Whole app and agent run in the browser as one static HTML file."},
    {"layer": "Deploy", "tech": "Docker, Render blueprint, Procfile, Netlify", "where": "Dockerfile, render.yaml, Procfile, netlify.toml", "why": "Free tiers; one command."},
]

PIPELINE = [("Spell fix", "spell.py"), ("Follow-up memory", "same filters, now show X"), ("Multi-step split", "then / ;"), ("Rule router", "intents + slots"),
            ("Semantic classifier", "TF-IDF, only on miss"), ("Validator", "refusal codes"), ("Handler", "SQL + analytics"), ("Stream events", "steps, text, charts, actions"),
            ("Confidence", "low → review queue")]
HITL = [("Agent proposes", "plan / confirm card"), ("User decides", "Proceed · Cancel · Edit"), ("Role check", "server RBAC"), ("Approval", "policy or admin"),
        ("Notify", "bell + record view"), ("Feedback", "👍 👎 flag"), ("Admin review", "Correct / Wrong"), ("Improve", "add to test set")]
REVIEW_CONFIDENCE = 0.45

EVAL_TARGETS = {"Intent-to-destination accuracy": ">= 95%", "UI-state correctness (filters, dates, sort)": ">= 95%", "Task success (core, strict)": ">= 95%",
                "Multi-step task success": ">= 95%", "Analytical correctness (within 1%)": ">= 95%", "Explanation faithfulness": ">= 98%", "Correct refusals": ">= 95%",
                "Correct clarifications": ">= 95%", "Invalid actions executed": "= 0", "Retrieval precision@1": ">= 90%", "Retrieval recall@3": ">= 95%",
                "Latency p95 (ms)": "< 1500", "Generalization: blind set (never tuned)": ">= 90%", "Typo robustness": ">= 90%"}

# ---- dataset documentation (shown on Data & KPIs page and used by the agent) ----
TABLE_DOCS = {
    "products": ("Product catalog and stock position", "inventory", {"sku": "Stock keeping unit", "name": "Product name", "category": "Product category", "unit": "Unit of measure",
                 "unit_price": "Selling price (INR)", "cost_price": "Landed cost (INR)", "stock": "Units on hand", "reorder_level": "Reorder threshold (≈20 days of demand)", "warehouse": "Storage location", "is_deleted": "Soft-delete flag"}),
    "suppliers": ("Supplier master with performance", "suppliers", {"code": "Supplier code", "name": "Supplier name", "category": "Main category", "city": "City", "country": "Country", "rating": "Quality rating 1-5",
                  "lead_time_days": "Average lead time (days)", "on_time_rate": "Share of POs delivered on time (0-1)", "email": "Contact email", "phone": "Contact phone", "is_deleted": "Soft-delete flag"}),
    "supplier_products": ("Which supplier sells which product, at what price", "suppliers", {"supplier_id": "→ suppliers.id", "product_id": "→ products.id", "price": "Quoted unit price (INR)"}),
    "customers": ("Customer accounts", "customers", {"code": "Customer code", "name": "Company name", "segment": "Enterprise / Wholesale / Retail / Distributor", "city": "City", "region": "State / region", "email": "Contact email", "is_deleted": "Soft-delete flag"}),
    "sales_orders": ("Customer orders (one product line each)", "sales", {"order_no": "Order number", "customer_id": "→ customers.id", "product_id": "→ products.id", "qty": "Units ordered", "unit_price": "Price charged (INR)",
                     "amount": "qty × unit_price (INR)", "region": "Delivery region", "channel": "Sales channel", "status": "Processing / Shipped / Delivered / Cancelled / Returned", "order_date": "Order date", "is_deleted": "Soft-delete flag"}),
    "purchase_orders": ("Purchase orders to suppliers", "procurement", {"po_no": "PO number", "supplier_id": "→ suppliers.id", "product_id": "→ products.id", "qty": "Units ordered", "unit_cost": "Agreed cost (INR)",
                        "amount": "qty × unit_cost (INR)", "status": "Draft / Pending / Approved / Received / Cancelled", "order_date": "PO date", "expected_date": "Expected delivery", "created_by": "User who raised it", "notes": "Free text", "is_deleted": "Soft-delete flag"}),
    "shipments": ("Outbound shipments for sales orders", "logistics", {"shipment_no": "Shipment number", "sales_order_id": "→ sales_orders.id", "carrier": "Logistics partner", "origin": "Dispatch warehouse", "destination": "Delivery region",
                  "status": "Pending / In Transit / Delayed / Delivered", "ship_date": "Dispatch date", "eta": "Promised arrival", "delivered_date": "Actual delivery", "delay_days": "Days late vs ETA", "is_deleted": "Soft-delete flag"}),
    "expenses": ("Monthly operating expenses", "finance", {"code": "Expense code", "category": "Logistics / Salaries / Rent / Marketing / Utilities / Administrative", "amount": "Amount (INR)", "date": "Booking date", "note": "Description", "is_deleted": "Soft-delete flag"}),
    "change_requests": ("Update / delete / role requests and their review", "approvals", {"entity": "Target table", "record_id": "Target row id", "record_label": "Readable target", "action": "update / delete / role", "changes": "JSON field diff",
                        "reason": "Why", "status": "Pending / Approved / Rejected", "requested_by": "Requester", "reviewed_by": "Admin or auto-policy", "review_note": "Decision note", "created_at": "Requested at", "reviewed_at": "Decided at", "via": "ui / agent"}),
    "audit_log": ("Every data change and login", "activity", {"ts": "Timestamp", "username": "Actor", "action": "create / update / delete / request / review / login", "entity": "Table", "record_label": "Target", "details": "JSON details", "via": "ui / agent / policy"}),
    "agent_log": ("Every agent request with intent and latency", "activity", {"ts": "Timestamp", "username": "User", "query": "What was asked", "intent": "Detected intent", "page": "Page the agent opened", "latency_ms": "Server time (ms)", "steps": "Steps executed", "used_llm": "1 if LLM fallback used"}),
    "users": ("Accounts and roles", "activity", {"username": "Login", "name": "Full name", "role": "admin / manager / staff / viewer", "email": "Email", "created_at": "Sign-up time"}),
}
HIDDEN_COLUMNS = {"users": {"password_hash", "password"}}

KPI_DICTIONARY = [
    ("Total Revenue", "dashboard", "SUM(sales_orders.amount) where status ≠ Cancelled, in date range", "revenue"),
    ("Total Orders", "dashboard", "COUNT(sales_orders) where status ≠ Cancelled", "orders"),
    ("Average Order Value", "sales", "Revenue ÷ Orders", "aov"),
    ("Cancel Rate", "sales", "Cancelled orders ÷ all orders", "cancel_rate"),
    ("Units Sold", "analytics", "SUM(sales_orders.qty) where status ≠ Cancelled", "units"),
    ("Inventory Value", "dashboard", "SUM(products.stock × cost_price)", "inventory_value"),
    ("Low Stock Items", "inventory", "COUNT(products) where 0 < stock ≤ reorder_level", "low_stock"),
    ("Out of Stock Items", "inventory", "COUNT(products) where stock = 0", "out_of_stock"),
    ("Days of Cover", "inventory", "stock ÷ average daily units sold (last 90 days)", "days_cover"),
    ("Active Suppliers", "suppliers", "COUNT(suppliers) not deleted", "suppliers"),
    ("Avg Supplier Rating", "suppliers", "AVG(suppliers.rating)", "rating"),
    ("Supplier On-time %", "suppliers", "AVG(suppliers.on_time_rate) × 100", "supplier_ontime"),
    ("PO Spend (12m)", "procurement", "SUM(purchase_orders.amount) last 365 days, status ≠ Cancelled", "po_spend"),
    ("Open POs", "procurement", "COUNT(purchase_orders) status in Pending, Approved", "open_pos"),
    ("Order Fulfillment Rate", "dashboard", "Shipments delivered with delay 0 ÷ all shipments (last 90 days)", "fulfillment"),
    ("Delayed Shipments", "logistics", "COUNT(shipments) delay_days > 0 (last 90 days)", "delayed"),
    ("Avg Delay (days)", "logistics", "AVG(shipments.delay_days) (last 90 days)", "avg_delay"),
    ("COGS", "finance", "SUM(sales qty × product cost_price)", "cogs"),
    ("Operating Expenses", "finance", "SUM(expenses.amount)", "opex"),
    ("Gross Margin %", "finance", "(Revenue − COGS) ÷ Revenue", "gross_margin"),
    ("Net Profit", "finance", "Revenue − COGS − Operating Expenses", "net_profit"),
    ("Active Customers (90d)", "customers", "Customers with an order in last 90 days", "active_customers"),
    ("Pending Approvals", "approvals", "COUNT(change_requests) status = Pending", "pending"),
    ("Auto-approval Rate", "approvals", "Requests approved by policy ÷ all approved", "auto_rate"),
    ("Agent p95 Latency", "activity", "95th percentile of agent_log.latency_ms", "agent_p95"),
]

# ---- auto-approval policy: low-risk changes are applied instantly, the rest go to an admin ----
APPROVAL_POLICY = [
    {"field": "unit_price", "rule": "pct", "limit": 10, "label": "Selling price change ≤ 10%"},
    {"field": "cost_price", "rule": "pct", "limit": 10, "label": "Cost price change ≤ 10%"},
    {"field": "unit_cost", "rule": "pct", "limit": 10, "label": "PO unit cost change ≤ 10%"},
    {"field": "qty", "rule": "pct", "limit": 25, "label": "Order quantity change ≤ 25%"},
    {"field": "stock", "rule": "pct", "limit": 20, "label": "Stock adjustment ≤ 20%"},
    {"field": "reorder_level", "rule": "pct", "limit": 50, "label": "Reorder level change ≤ 50%"},
    {"field": "rating", "rule": "abs", "limit": 0.5, "label": "Supplier rating change ≤ 0.5"},
    {"field": "lead_time_days", "rule": "abs", "limit": 3, "label": "Lead time change ≤ 3 days"},
    {"field": "on_time_rate", "rule": "abs", "limit": 0.05, "label": "On-time rate change ≤ 0.05"},
    {"field": "email", "rule": "any", "label": "Contact email"}, {"field": "phone", "rule": "any", "label": "Contact phone"},
    {"field": "city", "rule": "any", "label": "City"}, {"field": "notes", "rule": "any", "label": "Notes"},
    {"field": "eta", "rule": "any", "label": "Shipment ETA"}, {"field": "carrier", "rule": "any", "label": "Shipment carrier"},
]
APPROVAL_POLICY_NOTE = "Deletes, role changes, status changes and anything above these limits always need an admin."

# ---- entity schemas (forms, CRUD, change requests) ----
ENTITIES = {
    "products": {"table": "products", "label": "Product", "code": "sku", "name": "name", "page": "inventory", "prefix": None,
                 "fields": [
                     {"key": "sku", "label": "SKU", "type": "text", "required": True},
                     {"key": "name", "label": "Name", "type": "text", "required": True},
                     {"key": "category", "label": "Category", "type": "select", "options": CATEGORIES, "required": True},
                     {"key": "unit", "label": "Unit", "type": "select", "options": ["pcs", "kg", "m", "l", "box", "roll", "pair", "tube"]},
                     {"key": "unit_price", "label": "Selling price (₹)", "type": "number", "required": True},
                     {"key": "cost_price", "label": "Cost price (₹)", "type": "number", "required": True},
                     {"key": "stock", "label": "Stock", "type": "number"},
                     {"key": "reorder_level", "label": "Reorder level", "type": "number"},
                     {"key": "warehouse", "label": "Warehouse", "type": "select", "options": WAREHOUSES}]},
    "suppliers": {"table": "suppliers", "label": "Supplier", "code": "code", "name": "name", "page": "suppliers", "prefix": "SUP-",
                  "fields": [
                      {"key": "name", "label": "Name", "type": "text", "required": True},
                      {"key": "category", "label": "Category", "type": "select", "options": CATEGORIES, "required": True},
                      {"key": "city", "label": "City", "type": "text"},
                      {"key": "country", "label": "Country", "type": "text"},
                      {"key": "rating", "label": "Rating", "type": "number"},
                      {"key": "lead_time_days", "label": "Lead time (days)", "type": "number"},
                      {"key": "on_time_rate", "label": "On-time rate (0-1)", "type": "number"},
                      {"key": "email", "label": "Email", "type": "text"},
                      {"key": "phone", "label": "Phone", "type": "text"}]},
    "customers": {"table": "customers", "label": "Customer", "code": "code", "name": "name", "page": "customers", "prefix": "CUST-",
                  "fields": [
                      {"key": "name", "label": "Name", "type": "text", "required": True},
                      {"key": "segment", "label": "Segment", "type": "select", "options": SEGMENTS},
                      {"key": "city", "label": "City", "type": "text"},
                      {"key": "region", "label": "Region", "type": "select", "options": REGIONS, "required": True},
                      {"key": "email", "label": "Email", "type": "text"}]},
    "purchase_orders": {"table": "purchase_orders", "label": "Purchase Order", "code": "po_no", "name": "po_no", "page": "procurement", "prefix": "PO-",
                        "fields": [
                            {"key": "supplier_id", "label": "Supplier", "type": "ref", "ref": "suppliers", "required": True},
                            {"key": "product_id", "label": "Product", "type": "ref", "ref": "products", "required": True},
                            {"key": "qty", "label": "Quantity", "type": "number", "required": True},
                            {"key": "unit_cost", "label": "Unit cost (₹)", "type": "number", "required": True},
                            {"key": "status", "label": "Status", "type": "select", "options": PO_STATUS},
                            {"key": "expected_date", "label": "Expected date", "type": "date"},
                            {"key": "notes", "label": "Notes", "type": "text"}]},
    "sales_orders": {"table": "sales_orders", "label": "Sales Order", "code": "order_no", "name": "order_no", "page": "sales", "prefix": "SO-",
                     "fields": [
                         {"key": "customer_id", "label": "Customer", "type": "ref", "ref": "customers", "required": True},
                         {"key": "product_id", "label": "Product", "type": "ref", "ref": "products", "required": True},
                         {"key": "qty", "label": "Quantity", "type": "number", "required": True},
                         {"key": "unit_price", "label": "Unit price (₹)", "type": "number", "required": True},
                         {"key": "region", "label": "Region", "type": "select", "options": REGIONS},
                         {"key": "channel", "label": "Channel", "type": "select", "options": CHANNELS},
                         {"key": "status", "label": "Status", "type": "select", "options": SO_STATUS}]},
    "shipments": {"table": "shipments", "label": "Shipment", "code": "shipment_no", "name": "shipment_no", "page": "logistics", "prefix": "SHP-",
                  "fields": [
                      {"key": "carrier", "label": "Carrier", "type": "select", "options": CARRIERS},
                      {"key": "status", "label": "Status", "type": "select", "options": SH_STATUS},
                      {"key": "eta", "label": "ETA", "type": "date"},
                      {"key": "delay_days", "label": "Delay days", "type": "number"}]},
    "expenses": {"table": "expenses", "label": "Expense", "code": "code", "name": "note", "page": "finance", "prefix": "EXP-",
                 "fields": [
                     {"key": "category", "label": "Category", "type": "select", "options": EXP_CATS, "required": True},
                     {"key": "amount", "label": "Amount (₹)", "type": "number", "required": True},
                     {"key": "date", "label": "Date", "type": "date", "required": True},
                     {"key": "note", "label": "Note", "type": "text"}]},
}

# ---- API catalog: the agent's tools (also exposed over REST). Retrieval picks the right API. ----
APIS = [
    {"name": "navigate", "method": "UI", "path": "#/{page_id}", "roles": "all", "description": "Open a page and apply filters, date range and sort"},
    {"name": "get_current_page", "method": "GET", "path": "/api/pages/{page_id}/data", "roles": "all", "description": "Read the data, KPIs and widgets on the current page and summarize it"},
    {"name": "query_page_data", "method": "GET", "path": "/api/pages/{page_id}/data", "roles": "all", "description": "Read any page's KPIs, charts and grid rows with filters"},
    {"name": "stockout_forecast", "method": "GET", "path": "/api/analytics/stockout", "roles": "all", "description": "Forecast products that will run out of stock within N days using sales velocity"},
    {"name": "compare_suppliers", "method": "GET", "path": "/api/analytics/suppliers/compare", "roles": "all", "description": "Compare suppliers of a product on price, rating, lead time, on-time delivery"},
    {"name": "period_compare", "method": "GET", "path": "/api/analytics/compare", "roles": "all", "description": "Compare revenue, orders, units between two periods with growth"},
    {"name": "trend_analysis", "method": "GET", "path": "/api/analytics/trend", "roles": "all", "description": "Monthly trend, growth, best and worst month, simple forecast"},
    {"name": "root_cause", "method": "GET", "path": "/api/analytics/drivers", "roles": "all", "description": "Explain why a metric changed: drivers by region, category, channel, delays, cancellations"},
    {"name": "top_n", "method": "GET", "path": "/api/analytics/top", "roles": "all", "description": "Top or bottom N products, customers, suppliers, regions by revenue or units"},
    {"name": "search_records", "method": "GET", "path": "/api/search", "roles": "all", "description": "Semantic search across pages, products, suppliers, customers, orders"},
    {"name": "create_record", "method": "POST", "path": "/api/entities/{entity}", "roles": "admin,manager,staff", "description": "Create product, supplier, customer, purchase order, expense"},
    {"name": "update_record", "method": "PUT", "path": "/api/entities/{entity}/{id}", "roles": "admin", "description": "Update fields of a record directly (admin only)"},
    {"name": "delete_record", "method": "DELETE", "path": "/api/entities/{entity}/{id}", "roles": "admin", "description": "Soft delete a record (admin only)"},
    {"name": "submit_change_request", "method": "POST", "path": "/api/requests", "roles": "manager,staff", "description": "Request an update or delete that an admin must approve"},
    {"name": "review_request", "method": "POST", "path": "/api/requests/{id}/review", "roles": "admin", "description": "Approve or reject a pending change request"},
    {"name": "list_requests", "method": "GET", "path": "/api/requests", "roles": "all", "description": "List pending or my change requests"},
]
API = {a["name"]: a for a in APIS}


def nav_tree():
    return [{"group": g["group"], "pages": [{k: PAGE[p][k] for k in ("id", "title", "icon")} for p in g["pages"]]} for g in NAV]


def public_meta():
    pages = []
    for p in PAGES:
        d = dict(p)
        d["widgets"] = [{"id": w[0], "type": w[1], "title": w[2]} for w in p["widgets"]]
        pages.append(d)
    return {"nav": nav_tree(), "pages": pages, "entities": ENTITIES, "apis": APIS, "policy": APPROVAL_POLICY, "policy_note": APPROVAL_POLICY_NOTE}

# ---- spelling correction vocabulary (domain words + common English words that must never be "corrected") ----
SPELL_DOMAIN = """show open go navigate compare analyze analyse analysis forecast predict trend trending create add delete remove update change set approve
approved approval approvals reject rejected pending request requests supplier suppliers vendor vendors purchase purchases order orders sales revenue profit profits
margin margins expense expenses delayed delay delays shipment shipments carrier carriers inventory stock stocks product products dashboard analytics finance
customer customers client clients logistics procurement activity audit top bottom best worst highest lowest why last this next previous month months quarter
quarters year years week weeks days today yesterday versus price prices cost costs rating ratings lead time quantity reorder level status run out likely items
item which what where who how many much sql select group count dataset database schema table tables columns column kpi kpis describe list find search help
page screen explain summarize summary overview breakdown region regions category categories channel channels segment segments warehouse warehouses
cancelled canceled delivered returned processing shipped draft drafts received transit drop dropped decline declined increase increased decrease growth
performance report reports pending approve approving approved everything units revenue cheapest cheaper recommend recommendation draft drafts restock
replenish shortage running short profitable earning earnings spending spend money margin gross net opex cogs electrical components packaging chemicals
safety materials enterprise wholesale retail distributor direct online portal karnataka maharashtra delhi tamil nadu gujarat telangana bengal bangalore
bengaluru mumbai pune nagpur chennai hyderabad kolkata ahmedabad surat mysore mysuru january february march april june july august september october
november december bluedart delhivery gati ecom express dtdc steel copper plastic resin aluminium aluminum brass rubber gasket bearing bolt washer gear
motor circuit breaker panel cable switch corrugated stretch film pallet bubble wrap epoxy paint lubricant adhesive sealant gloves helmet goggles pipe
stainless sheet wire spring control industrial wooden global metals prime plastics supplies metalworks asia precision voltedge shakti cables packright
greenwrap chemcore unichem safeguard orient exports sigma traders industries solutions delays fulfillment fulfilment orders invoice invoices""".split()

SPELL_COMMON = """about above after again against almost already also always among another answer anything anyone around away back because become been
before being below between both bring brought build business came cannot could currently data does doing done down during each early either else enough
even ever every example fact feel first from full gave give given going good great grow hand have having here high hold however idea into just keep kind
know large later least left less like line little long look looking made main make many maybe mean might more most move much must name near need never
night none note nothing number often once only other others over part people place plan please point possible pull quick quite rather real really right
said same seen seem shall should side since small some something soon start state still such sure take taking tell than that their them then there these
they thing things think those though three through thus together told took toward under until upon used using very want wanted well were when whether
while whole will with within without work working would write wrong your yours give gives giving waiting sign anything going stuck slow finish finishing
biggest largest most least weakest leading spending going doing happening happened tell show showing shown pull pulled bump adjust revise discard rid
look looks onboard register named called plus minus percent value values total totals average daily weekly monthly yearly rate rates""".split()

/* BizPilot AI — frontend (vanilla JS, no build step) */
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { } }, del: k => { try { localStorage.removeItem(k); } catch { } } };
const EMBED = !!window.BP_EMBED; let memHash = "";
const getHash = () => EMBED ? memHash : location.hash;
function setHash(h) { if (EMBED) { memHash = h; route(); } else location.hash = h; }
const S = { token: store.get("bp_token"), user: null, perms: [], meta: null, P: {}, page: "dashboard", filters: {}, sort: null,
  trail: [], charts: [], data: null, tpage: {}, highlight: null, busy: false };
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PALETTE = ["#2563eb", "#16a34a", "#f59e0b", "#7c3aed", "#dc2626", "#0891b2", "#db2777", "#65a30d", "#ea580c", "#475569"];
const CREATABLE = ["products", "suppliers", "customers", "purchase_orders", "sales_orders", "expenses"];
const EDITABLE = ["products", "suppliers", "customers", "purchase_orders", "sales_orders", "shipments", "expenses"];

const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.8 3 2.6 3.5 5.2"/>',
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.6 12.2a2 2 0 0 0 2 1.6h8.2a2 2 0 0 0 2-1.5L22 8H6"/>',
  receipt: '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4.5 4.4-7 8-7s7 2.5 8 7"/>',
  truck: '<path d="M2 6h12v10H2zM14 10h4l4 4v2h-8"/><circle cx="6.5" cy="18" r="1.8"/><circle cx="17.5" cy="18" r="1.8"/>',
  rupee: '<path d="M6 4h12M6 9h12M9 4c6 0 6 10 0 10H6l9 7"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 15 4-5 3 3 5-7"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  pulse: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  revenue: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M8 15h3"/>',
  trend: '<path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.5"/>',
  truck2: '<path d="M2 6h12v10H2zM14 10h4l4 4v2h-8"/><circle cx="6.5" cy="18" r="1.8"/><circle cx="17.5" cy="18" r="1.8"/>',
  pie: '<path d="M12 3v9h9a9 9 0 1 1-9-9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
  bars: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
};
const icon = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] || ICONS.grid}</svg>`;

/* ---------- formatting ---------- */
function inr(v) {
  v = Number(v || 0); const a = Math.abs(v);
  if (a >= 1e7) return "₹" + (v / 1e7).toFixed(2) + " Cr";
  if (a >= 1e5) return "₹" + (v / 1e5).toFixed(2) + " L";
  return "₹" + v.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}
const STATUS = { g: ["Delivered", "Approved", "Received", "In Stock", "Active", "Correct"], y: ["Pending", "Processing", "Low Stock", "Open"], r: ["Cancelled", "Rejected", "Out of Stock", "Delayed", "Returned", "Wrong"], b: ["Shipped", "In Transit"], x: ["Draft"] };
function pill(s) { const c = Object.keys(STATUS).find(k => STATUS[k].includes(s)) || "p"; return `<span class="pill ${c}">${esc(s)}</span>`; }
function fmt(v, f) {
  if (v === null || v === undefined || v === "") return "—";
  switch (f) {
    case "inr": return inr(v);
    case "int": return Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 });
    case "num": return Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 });
    case "pct": return Number(v).toFixed(1) + "%";
    case "days": return Number(v).toFixed(1) + " d";
    case "date": return esc(String(v).slice(0, 10));
    case "status": return pill(v);
    case "auto": return typeof v === "number" ? Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 }) : esc(v);
    default: return esc(v);
  }
}
const isNum = f => ["inr", "int", "num", "pct", "days", "auto"].includes(f);
const cell = (r, c) => fmt(r[c.key], c.fmt === "auto" && r.fmt && c.key === "value" ? r.fmt : c.fmt);
const delta = d => d === null || d === undefined ? "" : `<span class="${d >= 0 ? "up" : "down"}">${d >= 0 ? "↑" : "↓"} ${Math.abs(d).toFixed(1)}%</span>`;

function md(t) {
  const lines = esc(t).split("\n"); let out = "", list = null;
  const inline = s => s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\*(.+?)\*/g, "<i>$1</i>").replace(/(^|\s)_(.+?)_(?=\s|$|[.,;:])/g, "$1<i>$2</i>").replace(/`(.+?)`/g, "<code>$1</code>");
  for (const ln of lines) {
    const ul = ln.match(/^\s*[-•]\s+(.*)/), ol = ln.match(/^\s*\d+\.\s+(.*)/);
    if (ul || ol) { const tag = ul ? "ul" : "ol"; if (list !== tag) { if (list) out += `</${list}>`; out += `<${tag}>`; list = tag; } out += `<li>${inline((ul || ol)[1])}</li>`; continue; }
    if (list) { out += `</${list}>`; list = null; }
    if (ln.trim()) out += `<p>${inline(ln)}</p>`;
  }
  if (list) out += `</${list}>`;
  return out;
}

function toast(msg, bad) { const t = document.createElement("div"); t.className = "toast" + (bad ? " bad" : ""); t.textContent = msg; $("#toasts").append(t); setTimeout(() => t.remove(), 3500); }

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", Authorization: "Bearer " + S.token, ...(opts.headers || {}) } });
  if (r.status === 401) { logout(); throw new Error("Session expired"); }
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error(body.detail || body || r.statusText);
  return body;
}
const can = p => S.perms.includes(p);

/* ---------- auth ---------- */
$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault(); $("#lgErr").textContent = "";
  try {
    const r = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: $("#lgUser").value, password: $("#lgPass").value }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.detail);
    S.token = d.token; store.set("bp_token", d.token); boot();
  } catch (err) { $("#lgErr").textContent = err.message; }
});
function showPane(p) { $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === p)); $$("[data-pane]").forEach(f => f.classList.toggle("hidden", f.dataset.pane !== p)); }
$$(".tab").forEach(t => t.onclick = () => showPane(t.dataset.tab));
$$("[data-goto]").forEach(a => a.onclick = e => { e.preventDefault(); showPane(a.dataset.goto); });
$("#signupForm").addEventListener("submit", async e => {
  e.preventDefault(); $("#suErr").textContent = "";
  if ($("#suPass").value !== $("#suPass2").value) { $("#suErr").textContent = "Passwords do not match."; return; }
  try {
    const r = await fetch("/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: $("#suName").value, email: $("#suEmail").value, username: $("#suUser").value, password: $("#suPass").value, role: $("#suRole").value }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.detail);
    S.token = d.token; store.set("bp_token", d.token); $("#signupForm").reset();
    await boot();
    toast(d.role_request_id ? `Account created as ${d.granted_role}. Manager access request #${d.role_request_id} sent to admin.` : `Welcome! Account created with ${d.granted_role} access.`);
  } catch (err) { $("#suErr").textContent = err.message; }
});
$$(".demo-users button").forEach(b => b.onclick = () => { $("#lgUser").value = b.dataset.u; $("#lgPass").value = b.dataset.p; });
function logout() { store.del("bp_token"); if (EMBED) memHash = ""; S.token = null; $("#app").classList.add("hidden"); $("#fab").classList.add("hidden"); $("#login").classList.remove("hidden"); showPane("signin"); }
$("#logout").onclick = logout;

async function boot() {
  if (!S.token) return logout();
  try {
    const me = await api("/api/auth/me"); S.user = me.user; S.perms = me.permissions;
    S.meta = await api("/api/meta"); S.meta.pages.forEach(p => S.P[p.id] = p);
    if (S.meta.server_now) S.clockSkew = Date.now() - new Date(S.meta.server_now).getTime();
  } catch { return logout(); }
  $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  $("#uName").textContent = S.user.name.split(" ")[0]; $("#uAvatar").textContent = S.user.name[0];
  $("#uRole").textContent = S.user.role[0].toUpperCase() + S.user.role.slice(1); $("#uEmail").textContent = `${S.user.name} · ${S.user.email || S.user.username}`;
  const qp = S.meta.quick_prompts || [["Karnataka Sales", "Show Karnataka sales for last quarter"], ["Cancelled Orders", "Show cancelled orders"], ["MoM Trend", "Compare revenue this month vs last month"]];
  $("#qpList").innerHTML = qp.map(([l, q], i) => `${i ? '<span class="sep">●</span>' : ""}<button data-qp="${esc(q)}" title="${esc(q)}">"${esc(l)}"</button>`).join("");
  $$("[data-qp]").forEach(b => b.onclick = () => sendChat(b.dataset.qp));
  $("#llmState").textContent = S.meta.llm.enabled ? "rules + " + S.meta.llm.model : "rules (offline, fast)";
  if (S.meta.mode === "browser") {
    $("#llmState").textContent = "in-browser engine";
    if (S.user.role === "admin" && !$("#resetData")) {
      const b = document.createElement("button"); b.id = "resetData"; b.className = "btn sm"; b.style.marginTop = "8px"; b.textContent = "Reset demo data";
      b.onclick = async () => { if (!(await dialog({ title: "Reset demo data?", text: "Restores the original dataset. All changes and requests made in this browser are removed.", ok: "Reset", danger: true }))) return;
        await api("/api/admin/reset", { method: "POST" }); toast("Demo data reset"); refreshBadge(); loadPage(); };
      $(".side-foot").append(document.createElement("br"), b);
    }
  }
  renderNav(); welcome(); loadNotifs();
  S.confirmMode = store.get("bp_confirm") === "1"; $("#confirmMode").checked = S.confirmMode;
  if (window.innerWidth < 760) $("#closeAgent").click();
  if (!getHash()) setHash("#/dashboard"); else route();
}

/* ---------- nav & routing ---------- */
function renderNav() {
  $("#nav").innerHTML = S.meta.nav.map(g => `<div class="navgrp"><h6>${esc(g.group)}</h6>${g.pages.map(p =>
    `<a class="navitem" data-page="${p.id}" href="#/${p.id}">${icon(p.icon)}<span>${esc(p.title)}</span>${p.id === "approvals" ? '<span class="badge hidden" id="apprBadge"></span>' : ""}</a>`).join("")}</div>`).join("");
  $$(".navitem").forEach(a => a.onclick = e => { e.preventDefault(); $(".sidebar").classList.remove("open"); navigateTo(a.dataset.page); });
  refreshBadge();
}
const NICON = { request: "!", approved: "✓", auto: "⚡", rejected: "✕", review: "◎" };
function ago(ts) { const s = (Date.now() - (S.clockSkew || 0) - new Date(ts).getTime()) / 1000; if (s < 60) return "just now"; if (s < 3600) return Math.round(s / 60) + " min ago"; if (s < 86400) return Math.round(s / 3600) + " h ago"; return Math.round(s / 86400) + " d ago"; }
async function loadNotifs() {
  if (!S.token) return;
  try {
    const r = await api("/api/notifications"); S.notifs = r;
    $("#nBadge").textContent = r.unread; $("#nBadge").classList.toggle("hidden", !r.unread);
    $("#nList").innerHTML = r.items.length ? r.items.map(n => `<div class="nitem ${n.is_read ? "" : "unread"}" data-n="${n.id}"><span class="ni ${n.kind}">${NICON[n.kind] || "•"}</span><div style="min-width:0"><b>${esc(n.title)}</b><span>${esc(n.body)}</span><small>${ago(n.ts)}</small></div></div>`).join("")
      : '<div class="nempty">No notifications yet.</div>';
    $$("[data-n]", $("#nList")).forEach(el => el.onclick = async () => {
      const n = r.items.find(x => x.id === +el.dataset.n); $("#nPanel").classList.add("hidden");
      await api("/api/notifications/read", { method: "POST", body: JSON.stringify({ ids: [n.id] }) }); loadNotifs();
      S.flashRows = true; navigateTo(n.page || "approvals", n.filters || {});
    });
  } catch { }
}
$("#bellBtn").onclick = e => { e.stopPropagation(); $("#nPanel").classList.toggle("hidden"); loadNotifs(); };
$("#nAll").onclick = async e => { e.stopPropagation(); await api("/api/notifications/read", { method: "POST", body: JSON.stringify({}) }); loadNotifs(); };
document.addEventListener("click", e => {
  if (!e.target.closest(".notif")) $("#nPanel")?.classList.add("hidden");
  if (!e.target.closest(".exp")) $("#expMenu")?.classList.add("hidden");
  if (!e.target.closest(".upill-wrap")) $("#uMenu")?.classList.add("hidden");
});
$("#expBtn").onclick = e => { e.stopPropagation(); $("#expMenu").classList.toggle("hidden"); };
$$("[data-exp]").forEach(b => b.onclick = () => { $("#expMenu").classList.add("hidden"); const [f, sc] = b.dataset.exp.split(":"); doExport(f, sc); });
$("#uPill").onclick = e => { e.stopPropagation(); $("#uMenu").classList.toggle("hidden"); };
setInterval(() => { if (S.token && S.user) loadNotifs(); }, 15000);
$("#confirmMode").onchange = e => { S.confirmMode = e.target.checked; store.set("bp_confirm", e.target.checked ? "1" : ""); };
async function refreshBadge() {
  try { const r = await api("/api/requests?status=Pending"); const b = $("#apprBadge"); if (b) { b.textContent = r.length; b.classList.toggle("hidden", !r.length); } } catch { }
}
function navigateTo(page, filters = {}, sort = null, highlight = null) {
  const p = new URLSearchParams(); Object.entries(filters || {}).forEach(([k, v]) => { if (v !== null && v !== undefined && v !== "") p.set(k, v); });
  if (sort) p.set("sort", sort);
  S.highlight = highlight;
  const h = `#/${page}${p.toString() ? "?" + p : ""}`;
  if (getHash() === h) route(); else setHash(h);
}
if (!EMBED) window.addEventListener("hashchange", route);
function route() {
  if (!S.meta) return;
  const [path, qs] = getHash().slice(2).split("?");
  const page = S.P[path] ? path : "dashboard";
  const p = new URLSearchParams(qs || ""); const f = {}; let sort = null;
  p.forEach((v, k) => k === "sort" ? sort = v : f[k] = v);
  const prev = S.page; S.page = page; S.filters = f; S.sort = sort; S.tpage = {};
  if (prev !== page || S.trail.length === 0) S.trail.push({ page, filters: f });
  S.trail = S.trail.slice(-20);
  $$(".navitem").forEach(a => a.classList.toggle("active", a.dataset.page === page));
  const grp = S.meta.nav.find(g => g.pages.some(p => p.id === page)); $("#crumbGroup").textContent = grp ? grp.group : "BizPilot"; $("#crumbPage").textContent = S.P[page].title;
  loadPage();
}

/* ---------- page rendering ---------- */
async function loadPage(changed = []) {
  const page = S.page, meta = S.P[page];
  const qs = new URLSearchParams({ ...S.filters, ...(S.sort ? { sort: S.sort } : {}) });
  let d;
  try { d = await api(`/api/pages/${page}/data?${qs}`); } catch (e) { $("#main").innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  S.data = d; renderPage(meta, d, changed); updateCtx();
  if (S.highlight) { const el = $(`[data-widget-id="${S.highlight}"]`); if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("flash"); } S.highlight = null; }
}

function filterBar(meta) {
  if (!meta.filters.length) return "";
  const f = S.filters;
  const parts = meta.filters.map(fl => {
    if (fl.type === "daterange") {
      const preset = `<select class="select" data-preset><option value="">Default</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option>
        <option value="180">Last 6 months</option><option value="365">Last 12 months</option><option value="ytd">This year</option><option value="730">Last 24 months</option></select>`;
      return `<div class="f"><label>Range</label>${preset}</div><div class="f"><label>From</label><input type="date" class="input" data-f="date_from" value="${esc(f.date_from || "")}"></div>
              <div class="f"><label>To</label><input type="date" class="input" data-f="date_to" value="${esc(f.date_to || "")}"></div>`;
    }
    if (fl.type === "select") return `<div class="f"><label>${esc(fl.label)}</label><select class="select" data-f="${fl.key}"><option value="">All</option>${fl.options.map(o => `<option ${f[fl.key] === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></div>`;
    return `<div class="f"><label>${esc(fl.label)}</label><input class="input" data-f="${fl.key}" value="${esc(f[fl.key] || "")}" placeholder="Type & Enter"></div>`;
  }).join("");
  return `<div class="filters" data-widget-id="filters">${parts}<div class="f"><label>&nbsp;</label><button class="btn sm" data-clear style="height:32px">Reset</button></div></div>`;
}

function renderPage(meta, d, changed) {
  S.charts.forEach(c => c.destroy()); S.charts = [];
  if (d.layout === "dashboard") return renderDashboard(meta, d, changed);
  if (d.layout === "eval") return renderEval(meta, d);
  const ent = meta.entity, canNew = ent && CREATABLE.includes(ent) && can("create");
  let h = `<section data-page-id="${meta.id}">
    <div class="phead"><div><h1>${esc(meta.title)} <span class="pid">page_id: ${meta.id}</span></h1><p>${esc(meta.description)}</p></div><div class="spacer"></div>
    ${canNew ? `<button class="btn primary" data-new="${ent}">+ New ${esc(S.meta.entities[ent].label)}</button>` : ""}
    <button class="btn" data-ask="What is on this page?">✦ Explain page</button></div>`;
  h += filterBar(meta);
  if (d.kpis?.length) h += `<div class="kpis">${d.kpis.map(k => `<div class="kpi" data-widget-id="${k.id}"><div class="l">${esc(k.label)}</div>
    <div class="v">${fmt(k.value, k.fmt)}</div><div class="d">${delta(k.delta)} ${k.delta !== null && k.delta !== undefined ? '<span class="n">vs previous period</span>' : ""}</div>${k.note ? `<div class="n">${esc(k.note)}</div>` : ""}</div>`).join("")}</div>`;
  if (d.charts?.length) h += `<div class="grid2">${d.charts.map(c => `<div class="panel" data-widget-id="${c.id}"><h3>${esc(c.title)} <span class="wid">${c.id}</span><button class="askw" data-ask="Explain the ${esc(c.title)} chart">✦ Ask</button></h3><div class="chartbox"><canvas id="cv_${c.id}"></canvas></div></div>`).join("")}</div>`;
  if (d.pipeline) h += `<div class="grid2">${[["stack_pipeline", "Agent pipeline · every question", d.pipeline], ["stack_hitl", "Human in the loop · every action and answer", d.hitl]].map(([id, t, xs]) =>
    `<div class="panel" data-widget-id="${id}"><h3>${esc(t)} <span class="wid">${id}</span></h3><div class="flow">${xs.map(([a, b], i) => `${i ? '<span class="ar">→</span>' : ""}<div class="fs"><em>STEP ${i + 1}</em><b>${esc(a)}</b><small>${esc(b)}</small></div>`).join("")}</div></div>`).join("")}</div>`;
  if (meta.id === "review") h += `<div class="policy" data-widget-id="review_policy"><h3>How answers reach this queue</h3><ul><li>A user taps 👎 or ⚑ Review under any agent answer</li><li>The agent's confidence is below ${Math.round((S.meta.review_threshold || 0.45) * 100)}% (no exact rule matched, or a weak page guess)</li><li>Admin marks each answer Correct or Wrong; the user is notified</li><li>Wrong answers become new test cases for the Evaluation page</li></ul></div>`;
  if (meta.id === "approvals" && S.meta.policy) h += `<div class="policy" data-widget-id="approval_policy"><h3>Auto-approval policy</h3>Requests within these limits are approved and applied instantly; an admin reviews the rest.
    <ul>${S.meta.policy.map(p => `<li>${esc(p.label)}</li>`).join("")}</ul><p>${esc(S.meta.policy_note || "")}</p></div>`;
  ["table", "table2"].forEach(k => { if (d[k]) h += tablePanel(d[k], k); });
  if (d.layout === "data") h += dataTools();
  h += `</section>`;
  const pageChanged = S.lastRendered !== meta.id; S.lastRendered = meta.id;
  $("#main").innerHTML = h;
  if (pageChanged) $("#main").scrollTop = 0;
  d.charts?.forEach(c => drawChart($(`#cv_${c.id}`), c));
  bindPage(meta);
  if (d.layout === "data") bindData(d);
  S.flashRows = false;
  changed.forEach(k => { const el = $(`[data-f="${k}"]`); if (el) { el.classList.add("chg"); setTimeout(() => el.classList.remove("chg"), 1800); } });
}

function tablePanel(t, key) {
  const per = 50, pg = S.tpage[key] || 0, rows = t.rows.slice(pg * per, pg * per + per), pages = Math.ceil(t.rows.length / per);
  const ent = t.entity, editable = EDITABLE.includes(ent), approvals = ent === "change_requests";
  const [sk, sd] = (S.sort || "").split(":");
  const actHead = (editable && S.user.role !== "viewer") || ((approvals || ent === "agent_reviews") && can("approve")) || ent === "products" ? "<th>Actions</th>" : "";
  const head = t.columns.map(c => `<th class="${isNum(c.fmt) ? "num" : ""}" data-sort="${c.key}">${esc(c.label)}${sk === c.key ? (sd === "asc" ? " ▲" : " ▼") : ""}</th>`).join("") + actHead;
  const fl = S.flashRows && t.rows.length <= 50;
  const body = rows.map((r, i) => `<tr class="${fl && i < 5 ? "hl" : ""}">${t.columns.map(c => `<td class="${isNum(c.fmt) ? "num" : ""}">${cell(r, c)}</td>`).join("")}${actHead ? `<td>${rowActions(ent, r)}</td>` : ""}</tr>`).join("");
  return `<div class="panel" data-widget-id="${t.id}" style="margin-bottom:14px"><h3>${esc(t.title)} <span class="wid">${t.id}</span><span style="margin-left:auto;font-weight:500;color:var(--ink3);font-size:12px">${t.total.toLocaleString()} rows${t.total > t.rows.length ? ` (showing ${t.rows.length})` : ""}</span></h3>
   <div class="tbl-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="99" class="empty">No rows</td></tr>`}</tbody></table></div>
   ${pages > 1 ? `<div class="tfoot">Page ${pg + 1}/${pages} <button class="btn sm" data-tp="${key}" data-d="-1" ${pg ? "" : "disabled"}>‹</button><button class="btn sm" data-tp="${key}" data-d="1" ${pg < pages - 1 ? "" : "disabled"}>›</button></div>` : ""}</div>`;
}

function rowActions(ent, r) {
  const b = [];
  if (ent === "agent_reviews") return `<div class="rowacts">${can("approve") && r.status === "Open" ? `<button class="btn sm primary" data-verdict="Correct" data-id="${r.id}">Correct</button><button class="btn sm" data-verdict="Wrong" data-id="${r.id}" style="color:var(--bad)">Wrong</button>` : ""}<button class="btn sm" data-ask="${esc(r.query)}">Re-ask</button></div>`;
  if (ent === "change_requests") {
    if (can("approve") && r.status === "Pending") b.push(`<button class="btn sm primary" data-rev="approve" data-id="${r.id}">Approve</button><button class="btn sm" data-rev="reject" data-id="${r.id}">Reject</button>`);
    return `<div class="rowacts">${b.join("")}</div>`;
  }
  if (ent === "products" && can("create")) b.push(`<button class="btn sm" data-ask="create purchase order for ${esc(r.name)}">Reorder</button>`);
  if (!EDITABLE.includes(ent) || !r.id) return `<div class="rowacts">${b.join("")}</div>`;
  if (can("update")) b.push(`<button class="btn sm" data-edit="${ent}" data-id="${r.id}">Edit</button>`);
  else if (can("request")) b.push(`<button class="btn sm" data-req="${ent}" data-id="${r.id}">Request edit</button>`);
  if (can("delete")) b.push(`<button class="btn sm" data-del="${ent}" data-id="${r.id}" style="color:var(--bad)">Delete</button>`);
  else if (can("request")) b.push(`<button class="btn sm" data-reqdel="${ent}" data-id="${r.id}" style="color:var(--bad)">Request delete</button>`);
  return `<div class="rowacts">${b.join("")}</div>`;
}

function bindPage(meta) {
  const main = $("#main");
  $$("[data-f]", main).forEach(el => {
    const apply = () => { const f = { ...S.filters }; if (el.value) f[el.dataset.f] = el.value; else delete f[el.dataset.f]; navigateTo(S.page, f, S.sort); };
    el.addEventListener(el.tagName === "SELECT" || el.type === "date" ? "change" : "keydown", e => { if (e.type === "change" || e.key === "Enter") apply(); });
  });
  const pr = $("[data-preset]", main);
  if (pr) pr.onchange = () => {
    const f = { ...S.filters }, t = new Date(), iso = d => d.toISOString().slice(0, 10);
    if (!pr.value) { delete f.date_from; delete f.date_to; }
    else if (pr.value === "ytd") { f.date_from = `${t.getFullYear()}-01-01`; f.date_to = iso(t); }
    else { const a = new Date(t); a.setDate(a.getDate() - (+pr.value) + 1); f.date_from = iso(a); f.date_to = iso(t); }
    navigateTo(S.page, f, S.sort);
  };
  const clr = $("[data-clear]", main); if (clr) clr.onclick = () => navigateTo(S.page, {}, null);
  $$("th[data-sort]", main).forEach(th => th.onclick = () => {
    const [k, d] = (S.sort || "").split(":"); navigateTo(S.page, S.filters, `${th.dataset.sort}:${k === th.dataset.sort && d === "desc" ? "asc" : "desc"}`);
  });
  $$("[data-tp]", main).forEach(b => b.onclick = () => { S.tpage[b.dataset.tp] = (S.tpage[b.dataset.tp] || 0) + (+b.dataset.d); renderPage(meta, S.data, []); });
  $$("[data-ask]", main).forEach(b => b.onclick = () => sendChat(b.dataset.ask));
  $$("[data-new]", main).forEach(b => b.onclick = () => openForm(b.dataset.new, "create", {}));
  $$("[data-edit]", main).forEach(b => b.onclick = async () => openForm(b.dataset.edit, "edit", await api(`/api/entities/${b.dataset.edit}/${b.dataset.id}`)));
  $$("[data-req]", main).forEach(b => b.onclick = async () => openForm(b.dataset.req, "request", await api(`/api/entities/${b.dataset.req}/${b.dataset.id}`)));
  $$("[data-del]", main).forEach(b => b.onclick = async () => {
    if (!(await dialog({ title: "Delete this record?", text: "Soft delete. The record is hidden and the change is audit-logged.", ok: "Delete", danger: true }))) return;
    try { await api(`/api/entities/${b.dataset.del}/${b.dataset.id}`, { method: "DELETE" }); toast("Deleted"); loadPage(); } catch (e) { toast(e.message, 1); }
  });
  $$("[data-reqdel]", main).forEach(b => b.onclick = async () => {
    const reason = await dialog({ title: "Request deletion", text: "An admin must approve this request.", input: "Reason for deletion", ok: "Submit request", danger: true }); if (reason === null) return;
    try { const r = await api("/api/requests", { method: "POST", body: JSON.stringify({ entity: b.dataset.reqdel, record_id: +b.dataset.id, action: "delete", reason }) }); toast(`Request #${r.id} sent to admin`); refreshBadge(); } catch (e) { toast(e.message, 1); }
  });
  $$("[data-verdict]", main).forEach(b => b.onclick = async () => {
    const note = await dialog({ title: `Mark answer #${b.dataset.id} ${b.dataset.verdict}`, input: b.dataset.verdict === "Wrong" ? "What should the agent have done?" : "Note (optional)", ok: b.dataset.verdict, danger: b.dataset.verdict === "Wrong" });
    if (note === null) return;
    try { await api(`/api/reviews/${b.dataset.id}`, { method: "POST", body: JSON.stringify({ verdict: b.dataset.verdict, note }) }); toast(`Review #${b.dataset.id}: ${b.dataset.verdict} · user notified`); loadNotifs(); loadPage(); } catch (e) { toast(e.message, 1); }
  });
  $$("[data-rev]", main).forEach(b => b.onclick = async () => {
    const note = b.dataset.rev === "reject" ? await dialog({ title: `Reject request #${b.dataset.id}`, input: "Rejection note", ok: "Reject", danger: true }) : ""; if (note === null) return;
    try { const r = await api(`/api/requests/${b.dataset.id}/review`, { method: "POST", body: JSON.stringify({ decision: b.dataset.rev, note }) });
      toast(`Request #${b.dataset.id} ${b.dataset.rev}d · requester notified`); refreshBadge(); loadNotifs(); loadPage();
      if (r.record && !r.record.deleted) showRecord(r.record); } catch (e) { toast(e.message, 1); }
  });
}

function drawChart(canvas, c, persist) {
  if (!canvas || !window.Chart) { if (canvas) canvas.parentElement.innerHTML = '<div class="empty">Chart library offline</div>'; return; }
  const dough = c.type === "doughnut", horiz = !!c.horizontal, line = c.type === "line";
  const statusColors = { "In Stock": "#16a34a", "Low Stock": "#f59e0b", "Out of Stock": "#dc2626", Pending: "#f59e0b", Approved: "#16a34a", Rejected: "#dc2626" };
  const vfmt = v => v == null ? "—" : c.fmt ? fmtPlain(v, c.fmt) : (Math.abs(v) >= 1e5 ? inr(v) : Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 }));
  const ds = c.datasets.map((d, i) => {
    let bg = PALETTE[i % PALETTE.length];
    if (dough) bg = c.labels.map((l, j) => statusColors[l] || PALETTE[j % PALETTE.length]);
    else if (d.colors) bg = d.colors;
    else if (c.signed) bg = d.data.map(v => (v || 0) < 0 ? "#dc2626" : "#16a34a");
    else if (line && i === 0) bg = PALETTE[0] + "22";
    return { label: d.label, data: d.data, yAxisID: d.axis || "y", tension: .35, fill: line && i === 0 && !d.dashed, spanGaps: false,
      borderColor: dough ? "#fff" : d.dashed ? "#f59e0b" : (d.colors ? d.colors : PALETTE[i % PALETTE.length]), backgroundColor: bg, borderDash: d.dashed ? [6, 4] : undefined,
      borderWidth: 2, pointRadius: line ? (d.dashed ? 4 : 2.5) : 0, borderRadius: c.type === "bar" ? 5 : 0, maxBarThickness: 34, minBarLength: c.type === "bar" ? 3 : 0 };
  });
  const valAxis = { grid: { color: "#eef2f7" }, ticks: { callback: v => vfmt(v), font: { size: 11 } }, beginAtZero: c.type === "bar" };
  const catAxis = { grid: { display: false }, ticks: { font: { size: 11 }, autoSkip: true, maxRotation: horiz ? 0 : 45, callback: function (v) { const l = this.getLabelForValue(v); return String(l).length > 22 ? String(l).slice(0, 21) + "…" : l; } } };
  const scales = dough ? {} : horiz ? { x: valAxis, y: catAxis } : { x: catAxis, y: valAxis };
  if (c.datasets.some(d => d.axis === "y1")) scales.y1 = { position: "right", grid: { display: false }, ticks: { font: { size: 11 } } };
  const box = canvas.parentElement;
  if (horiz && box) box.style.height = Math.max(160, Math.min(420, 34 * c.labels.length + 50)) + "px";
  const ch = new Chart(canvas, {
    type: c.type, data: { labels: c.labels, datasets: ds },
    options: { indexAxis: horiz ? "y" : "x", responsive: true, maintainAspectRatio: false, cutout: dough ? "62%" : undefined, animation: { duration: 350 },
      plugins: { legend: { display: dough || c.datasets.length > 1, position: dough ? "right" : "top", labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${vfmt(dough ? ctx.parsed : horiz ? ctx.parsed.x : ctx.parsed.y)}` } } }, scales }
  });
  if (!persist) S.charts.push(ch);
}
function fmtPlain(v, f) {
  switch (f) { case "inr": return inr(v); case "pct": return Number(v).toFixed(1) + "%"; case "days": return Number(v).toFixed(1) + " d";
    case "int": return Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 }); default: return Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 }); }
}

/* ---------- forms (manual + agent autofill) ---------- */
async function openForm(entity, mode, record = {}, opts = {}) {
  const e = S.meta.entities[entity]; const isReq = mode === "request";
  const refs = {};
  for (const f of e.fields.filter(f => f.type === "ref")) refs[f.key] = await api(`/api/refs/${f.ref}`);
  const fields = e.fields.filter(f => !(mode === "create" && entity === "purchase_orders" && f.key === "status" && S.user.role !== "admin"));
  const val = k => record[k] ?? "";
  const input = f => {
    const id = `ff_${f.key}`, v = opts.autofill ? "" : val(f.key);
    if (f.type === "select") return `<select class="select" id="${id}" name="${f.key}"><option value=""></option>${f.options.map(o => `<option ${String(v) === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    if (f.type === "ref") return `<select class="select" id="${id}" name="${f.key}"><option value=""></option>${refs[f.key].map(o => `<option value="${o.value}" ${String(v) === String(o.value) ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`;
    return `<input class="input" id="${id}" name="${f.key}" type="${f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}" step="any" value="${esc(v)}">`;
  };
  const title = { create: `New ${e.label}`, edit: `Edit ${e.label} · ${record[e.code] || ""}`, request: `Request change · ${record[e.code] || ""}` }[mode];
  $("#modalRoot").innerHTML = `<div class="modal-bg"><form class="modal" id="mform"><header><h3>${esc(title)}</h3>${opts.autofill ? '<span class="pill b">✦ Agent autofill</span>' : ""}</header>
    <div class="body">${isReq ? `<div class="notice">Your role (${S.user.role}) cannot edit directly. Changes go to an admin for approval.</div>` : ""}
    ${fields.map(f => `<div class="field ${f.type === "text" && f.key === "notes" ? "full" : ""}"><label>${esc(f.label)}${f.required ? " *" : ""}</label>${input(f)}</div>`).join("")}
    ${isReq ? `<div class="field full"><label>Reason *</label><input class="input" name="__reason" required placeholder="Why is this change needed?"></div>` : ""}</div>
    <footer><button type="button" class="btn" id="mcancel">Cancel</button><button class="btn primary" type="submit">${isReq ? "Submit request" : "Save"}</button></footer></form></div>`;
  $("#mcancel").onclick = closeModal;
  $(".modal-bg").onclick = ev => { if (ev.target.classList.contains("modal-bg")) closeModal(); };
  if (opts.autofill) await autofill(fields, record);
  $("#mform").onsubmit = async ev => {
    ev.preventDefault();
    const data = {}; let reason = "";
    new FormData(ev.target).forEach((v, k) => { if (k === "__reason") reason = v; else if (v !== "") data[k] = v; });
    try {
      if (mode === "create") { const r = await api(`/api/entities/${entity}`, { method: "POST", body: JSON.stringify(data) }); toast(`Created ${r[e.code] || ""}`); }
      else {
        const changes = {}; Object.entries(data).forEach(([k, v]) => { if (String(record[k] ?? "") !== String(v)) changes[k] = v; });
        if (!Object.keys(changes).length) return toast("No changes", 1);
        if (mode === "edit") { await api(`/api/entities/${entity}/${record.id}`, { method: "PUT", body: JSON.stringify(changes) }); toast("Saved · audit-logged"); }
        else { const r = await api("/api/requests", { method: "POST", body: JSON.stringify({ entity, record_id: record.id, action: "update", changes, reason }) }); toast(`Request #${r.id} sent to admin`); refreshBadge(); }
      }
      closeModal(); loadPage();
    } catch (err) { toast(err.message, 1); }
  };
}
function dialog({ title, text = "", input = null, ok = "OK", danger = false }) {
  return new Promise(res => {
    $("#modalRoot").innerHTML = `<div class="modal-bg"><form class="modal" id="dlg" style="max-width:420px"><header><h3>${esc(title)}</h3></header>
      <div class="body" style="display:block">${text ? `<p style="margin:0 0 10px;color:var(--ink2)">${esc(text)}</p>` : ""}${input ? `<div class="field"><label for="dlgIn">${esc(input)}</label><input class="input" id="dlgIn" required></div>` : ""}</div>
      <footer><button type="button" class="btn" id="dlgNo">Cancel</button><button class="btn ${danger ? "danger" : "primary"}" type="submit">${esc(ok)}</button></footer></form></div>`;
    const done = v => { closeModal(); res(v); };
    $("#dlgNo").onclick = () => done(input ? null : false);
    $("#dlg").onsubmit = e => { e.preventDefault(); done(input ? $("#dlgIn").value : true); };
    if (input) $("#dlgIn").focus();
  });
}
function showRecord(rec) {
  $("#modalRoot").innerHTML = `<div class="modal-bg"><div class="modal" style="max-width:480px"><header><h3>✓ Approved and applied</h3></header><div class="body" style="display:block">
    <div class="cardx recordc" style="margin:0"><h4>${esc(rec.title)}</h4><dl>${rec.fields.map(f => `<dt>${esc(f.label)}</dt><dd class="${f.changed ? "chg" : ""}">${f.changed && f.old != null ? `<s>${esc(f.old)}</s>` : ""}${esc(f.value ?? "—")}${f.changed ? " ●" : ""}</dd>`).join("")}</dl></div></div>
    <footer><button class="btn" id="rClose">Close</button><button class="btn primary" id="rOpen">Open in ${esc(S.P[rec.page]?.title || rec.page)}</button></footer></div></div>`;
  $("#rClose").onclick = closeModal; $("#rOpen").onclick = () => { closeModal(); S.flashRows = true; navigateTo(rec.page, rec.filters); };
}
function closeModal() { $("#modalRoot").innerHTML = ""; }
async function autofill(fields, values) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (const f of fields) {
    const v = values[f.key]; if (v === undefined || v === null || v === "") continue;
    const el = $(`#ff_${f.key}`); if (!el) continue;
    el.classList.add("autofill"); el.focus();
    if (el.tagName === "SELECT") { el.value = String(v); if (el.value !== String(v)) { const o = [...el.options].find(o => o.text.toLowerCase().includes(String(v).toLowerCase())); if (o) el.value = o.value; } await sleep(90); }
    else { el.value = ""; const s = String(v); for (let i = 0; i < s.length; i++) { el.value += s[i]; if (i % 2) await sleep(12); } }
    await sleep(60);
  }
}

/* ---------- global search ---------- */
let sTimer;
$("#gsearch").addEventListener("input", e => {
  clearTimeout(sTimer); const q = e.target.value.trim(); const box = $("#gresults");
  if (!q) return box.classList.add("hidden");
  sTimer = setTimeout(async () => {
    const r = await api("/api/search?q=" + encodeURIComponent(q));
    box.innerHTML = r.filter(x => x.kind !== "api").map(x => `<div data-page="${x.page}" data-name="${esc(x.name)}" data-kind="${x.kind}"><span>${esc(x.code ? x.code + " · " : "")}${esc(x.name)}</span><small>${x.kind} → ${x.page}</small></div>`).join("") || `<div><small>No results</small></div>`;
    box.classList.remove("hidden");
    $$("div[data-page]", box).forEach(d => d.onclick = () => {
      box.classList.add("hidden"); $("#gsearch").value = "";
      const f = ["products", "suppliers", "customers"].includes(d.dataset.kind) ? { q: d.dataset.name } : {};
      navigateTo(d.dataset.page, f, null, d.dataset.kind === "widget" ? null : null);
    });
  }, 120);
});
document.addEventListener("click", e => { if (!e.target.closest(".search")) $("#gresults").classList.add("hidden"); });
document.addEventListener("keydown", e => { if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); $("#gsearch").focus(); } if (e.key === "Escape") closeModal(); });

/* ---------- agent ---------- */
function updateCtx() {
  $("#ctxPage").textContent = S.page;
  const f = Object.entries(S.filters).map(([k, v]) => `${k}=${v}`).join(", ");
  $("#ctxFilters").innerHTML = f ? `<code>${esc(f)}</code>` : "";
}
function welcome() {
  $("#msgs").innerHTML = "";
  const m = botMsg();
  const actions = can("approve") ? "approve change requests" : can("request") ? "raise change requests for admin approval" : "read-only access";
  m.body.innerHTML = `<div class="welcome"><h4>👋 Hi ${esc(S.user.name.split(" ")[0])}!</h4>I'm your BizPilot agent. I can:<ul>
    <li>Navigate any page, set filters, dates, sorts</li><li>Analyze trends, compare periods, find causes</li><li>Forecast stock-outs, compare suppliers</li>
    <li>Fill forms and create purchase orders</li><li>Role <b>${S.user.role}</b>: ${actions}</li><li>Explain the current page</li></ul></div>`;
  m.body.append(chips(["Show me products likely to run out in 14 days", "Compare top 3 suppliers for steel with best pricing", "Create purchase order for low stock items",
    "Why did revenue drop in Maharashtra?", "Compare revenue this month vs last month", "What is the current page and key information?"]));
}
function botMsg() {
  const el = document.createElement("div"); el.className = "msg bot";
  el.innerHTML = `<div class="steps"></div><div class="mbody"></div>`; $("#msgs").append(el);
  const m = { el, steps: $(".steps", el), body: $(".mbody", el) }; el.__m = m; return m;
}
function userMsg(t) { const el = document.createElement("div"); el.className = "msg user"; el.textContent = t; $("#msgs").append(el); scrollChat(); }
const scrollChat = () => { const m = $("#msgs"); m.scrollTop = m.scrollHeight; };
function chips(items) { const d = document.createElement("div"); d.className = "chips"; items.forEach(t => { const b = document.createElement("button"); b.className = "chip"; b.textContent = t; b.onclick = () => sendChat(t); d.append(b); }); return d; }

async function sendChat(text) {
  text = (text || "").trim(); if (!text || S.busy) return;
  openAgent(); userMsg(text); $("#chatIn").value = ""; S.busy = true;
  const m = botMsg(); m.query = text; m.voice = S.voiceTurn; S.voiceTurn = false; m.body.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  const t0 = performance.now(); let first = null, intent = "";
  try {
    const r = await fetch("/api/agent/chat", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + S.token },
      body: JSON.stringify({ message: text, page: S.page, filters: S.filters, trail: S.trail.slice(-8) }) });
    if (r.status === 401) return logout();
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = "";
    m.body.innerHTML = "";
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
        const ev = JSON.parse(line); if (first === null) first = performance.now() - t0;
        if (ev.t === "intent") intent = ev.intent;
        else if (ev.t === "done") { refreshBadge(); loadNotifs(); if (m.plan && m.plan.length) m.body.append(planCard(m.plan)); const lat = document.createElement("div"); lat.className = "lat"; lat.innerHTML = `<span>intent: ${esc(ev.intent)}</span><span>server ${ev.latency_ms} ms</span><span>total ${Math.round(performance.now() - t0)} ms</span>`; m.el.append(lat);
          m.done = ev; m.el.append(feedbackBar(m)); if (S.speakMode || m.voice) speak(m); }
        else await handleEvent(ev, m);
        scrollChat();
      }
    }
  } catch (e) { m.body.innerHTML += `<p style="color:var(--bad)">${esc(e.message)}</p>`; }
  S.busy = false; scrollChat();
}

function describeNav(ev) {
  const f = Object.entries(ev.filters || {}).map(([k, v]) => `${k} = ${v}`);
  return `Open **${S.P[ev.page]?.title || ev.page}**` + (f.length ? ` with ${f.join(", ")}` : "") + (ev.sort ? `, sorted by ${ev.sort.replace(":", " ")}` : "");
}
function planCard(plan) {
  const d = document.createElement("div"); d.className = "cardx plan";
  d.innerHTML = `<h4>Planned screen changes</h4><ol>${plan.map(p => `<li>${md(describeNav(p)).replace(/<\/?p>/g, "")}</li>`).join("")}</ol>
    <div class="acts" style="display:flex;gap:6px"><button class="btn sm primary" data-go>Proceed</button><button class="btn sm" data-no>Cancel</button></div>`;
  const fin = t => { $(".acts", d).innerHTML = `<small>${esc(t)}</small>`; };
  $("[data-go]", d).onclick = async () => { fin("Done. Screen updated."); for (const ev of plan) await handleEvent(ev, { noPlan: true, body: d, steps: d }); };
  $("[data-no]", d).onclick = () => fin("Cancelled. Nothing changed.");
  return d;
}
async function handleEvent(ev, m) {
  if (ev.t === "step") { const d = document.createElement("div"); d.innerHTML = `<span class="ok">✓</span> ${esc(ev.text)}`; m.steps.append(d); }
  else if (ev.t === "text") { const d = document.createElement("div"); d.innerHTML = md(ev.text); m.body.append(d); (m.texts = m.texts || []).push(ev.text); }
  else if (ev.t === "action") {
    if (ev.action === "navigate" && S.confirmMode && !m.noPlan) { (m.plan = m.plan || []).push(ev); return; }
    if (ev.action === "navigate") {
      const changed = Object.keys(ev.filters || {});
      if (ev.page === S.page && JSON.stringify(ev.filters || {}) === JSON.stringify(S.filters) && (ev.sort || null) === S.sort) { if (ev.highlight) { S.highlight = ev.highlight; loadPage(changed); } }
      else navigateTo(ev.page, ev.filters, ev.sort, ev.highlight);
      setTimeout(() => changed.forEach(k => { const el = $(`[data-f="${k}"]`); if (el) { el.classList.add("chg"); setTimeout(() => el.classList.remove("chg"), 1800); } }), 350);
    } else if (ev.action === "open_form") { setTimeout(() => openForm(ev.entity, ev.mode || "create", ev.values, { autofill: true }), 300); }
    else if (ev.action === "refresh") { loadPage(); refreshBadge(); }
    else if (ev.action === "export") setTimeout(() => doExport(ev.format, ev.scope, m), 450);
  }
  else if (ev.t === "card") { (m.cards = m.cards || []).push(ev.card); m.body.append(renderCard(ev.card, m)); }
}

function miniTable(c) {
  const rows = c.rows.slice(0, 8);
  return `<div class="tbl-wrap" style="max-height:260px"><table><thead><tr>${c.columns.map(x => `<th class="${isNum(x.fmt) ? "num" : ""}">${esc(x.label)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(r => `<tr>${c.columns.map(x => `<td class="${isNum(x.fmt) ? "num" : ""}">${cell(r, x)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    ${c.rows.length > 8 ? `<div class="lat">+${c.rows.length - 8} more</div>` : ""}`;
}

function renderCard(c, m) {
  const d = document.createElement("div"); d.className = "cardx";
  if (c.type === "kpis") d.innerHTML = `<div class="kmini">${c.items.map(k => `<div><small>${esc(k.label)}</small><b>${esc(k.value)}</b> ${delta(k.delta)}</div>`).join("")}</div>`;
  else if (c.type === "table") { d.innerHTML = `<h4>${esc(c.title)}</h4>${miniTable(c)}${c.page ? `<button class="btn sm" style="margin-top:6px">Open ${esc(S.P[c.page]?.title || c.page)} →</button>` : ""}`; const b = $("button", d); if (b) b.onclick = () => navigateTo(c.page, c.filters || {}); }
  else if (c.type === "chart") { d.classList.add("viz"); d.innerHTML = `<h4>${esc(c.chart.title)}</h4><div class="chartbox${c.chart.type === "line" ? " tall" : ""}"><canvas></canvas></div>`; setTimeout(() => drawChart($("canvas", d), c.chart, true), 0); }
  else if (c.type === "chips") { d.className = ""; d.append(chips(c.items)); }
  else if (c.type === "refusal") { d.classList.add("refusal"); d.innerHTML = `<h4>Can't do that <span class="code">${esc(c.code)}</span></h4><p style="margin:0 0 4px">${esc(c.message)}</p>`; if (c.suggestions?.length) d.append(chips(c.suggestions)); }
  else if (c.type === "clarify") { d.classList.add("clar"); d.innerHTML = `<h4>${esc(c.question)}</h4>`; d.append(chips(c.options)); }
  else if (c.type === "record") { d.classList.add("recordc");
    d.innerHTML = `<h4>✓ Updated record · ${esc(c.title)}</h4><dl>${c.fields.map(f => `<dt>${esc(f.label)}</dt><dd class="${f.changed ? "chg" : ""}">${f.changed && f.old != null ? `<s>${esc(f.old)}</s>` : ""}${esc(f.value ?? "—")}${f.changed ? " ●" : ""}</dd>`).join("")}</dl>
      <button class="btn sm">Open in ${esc(S.P[c.page]?.title || c.page)} →</button>`;
    $("button", d).onclick = () => { S.flashRows = true; navigateTo(c.page, c.filters); }; }
  else if (c.type === "sources") { d.classList.add("srcs"); const sqlOk = ["admin", "manager"].includes(S.user.role);
    d.innerHTML = `<details><summary>Sources · ${c.items.length} quer${c.items.length > 1 ? "ies" : "y"}</summary>${c.note ? `<p style="font-size:12px;color:var(--ink2);margin:6px 0">${esc(c.note)}</p>` : ""}${c.items.map((x, i) => `<div><small><b>${esc(x.label)}</b></small><pre>${esc(x.sql)}</pre>${sqlOk ? `<button class="chip" data-run="${i}">Run this SQL</button>` : ""}</div>`).join("")}</details>`;
    $$("[data-run]", d).forEach(b => b.onclick = () => sendChat("sql: " + c.items[+b.dataset.run].sql)); }
  else if (c.type === "links") { d.innerHTML = `<div class="links">${c.items.map((l, i) => `<div data-i="${i}"><span>${esc(l.label)}</span><small>${esc(l.kind)} → ${esc(l.page)}</small></div>`).join("")}</div>`; $$("[data-i]", d).forEach(x => x.onclick = () => { const l = c.items[+x.dataset.i]; navigateTo(l.page, l.filters); }); }
  else if (c.type === "confirm") {
    d.classList.add("confirm");
    d.innerHTML = `<h4>⚠ ${esc(c.title)}</h4><ul>${c.lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul><div class="acts">
      <button class="btn sm ${c.danger ? "danger" : "primary"}" data-ok>${esc(c.button)}</button>${c.form ? '<button class="btn sm" data-form>Edit in form</button>' : ""}<button class="btn sm" data-no>Cancel</button></div>`;
    const finish = msg => { d.classList.add("done"); $(".acts", d).innerHTML = `<small>${esc(msg)}</small>`; };
    $("[data-no]", d).onclick = () => finish("Cancelled. No changes made.");
    if (c.form) $("[data-form]", d).onclick = () => { finish("Opened in form."); openForm(c.form.entity, "create", c.form.values, { autofill: true }); };
    $("[data-ok]", d).onclick = async () => {
      $("[data-ok]", d).disabled = true;
      try {
        const r = await api("/api/agent/confirm", { method: "POST", body: JSON.stringify({ token: c.token }) });
        finish("Done.");
        const mm = botMsg(); for (const ev of r.events) await handleEvent(ev, mm); scrollChat(); refreshBadge();
      } catch (e) { toast(e.message, 1); }
    };
  }
  return d;
}

$("#chatForm").onsubmit = e => { e.preventDefault(); sendChat($("#chatIn").value); };
$$(".ag-tools [data-q]").forEach(b => b.onclick = () => sendChat(b.dataset.q));
$("#clearChat").onclick = welcome;
function openAgent() { $("#agent").classList.remove("min"); $("#fab").classList.add("hidden"); }
$("#closeAgent").onclick = () => { $("#agent").classList.add("min"); $("#fab").classList.remove("hidden"); };
$("#toggleAgent").onclick = () => $("#agent").classList.contains("min") ? openAgent() : $("#closeAgent").click();
$("#fab").onclick = openAgent;
$("#menuBtn").onclick = () => $(".sidebar").classList.toggle("open");

/* ---------- voice: speak a question, hear the answer explained ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let REC = null;
$("#micBtn").onclick = () => {
  if (REC) { REC.stop(); return; }
  if (!SR) return toast("Voice input needs Chrome or Edge. Type instead.", 1);
  try { REC = new SR(); } catch { return toast("Microphone not available here", 1); }
  REC.lang = "en-IN"; REC.interimResults = true; REC.maxAlternatives = 1;
  const btn = $("#micBtn"), inp = $("#chatIn"); let final = "";
  btn.classList.add("rec"); inp.placeholder = "Listening… speak now";
  REC.onresult = e => { let interim = ""; for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) final += t; else interim += t; } inp.value = (final + interim).trim(); };
  REC.onerror = e => toast(e.error === "not-allowed" || e.error === "service-not-allowed" ? "Microphone blocked. Allow mic access for this page (or open the server build)." : e.error === "no-speech" ? "Didn't hear anything. Try again." : "Voice error: " + e.error, 1);
  REC.onend = () => { btn.classList.remove("rec"); inp.placeholder = "Ask or tap the mic… e.g. why did revenue drop in Maharashtra?"; REC = null; if (final.trim()) { S.voiceTurn = true; sendChat(final); } };
  try { REC.start(); } catch (e) { btn.classList.remove("rec"); REC = null; toast("Microphone not available: " + e.message, 1); }
};
S.speakMode = store.get("bp_speak") === "1"; $("#speakMode").checked = S.speakMode;
$("#speakMode").onchange = e => { S.speakMode = e.target.checked; store.set("bp_speak", e.target.checked ? "1" : ""); if (!e.target.checked) window.speechSynthesis?.cancel(); };
const plain = t => String(t || "").replace(/\*\*|`|_/g, "").replace(/[✅⛔⚠✓✦●→↑↓•]/g, " ").replace(/₹/g, "rupees ").replace(/\s+/g, " ").trim();
function spokenNum(v, f) { if (v == null) return "not available"; if (f === "inr") return inr(v).replace("₹", "rupees ").replace(" Cr", " crore").replace(" L", " lakh"); if (f === "pct") return Number(v).toFixed(1) + " percent"; return String(typeof v === "number" ? Math.round(v * 100) / 100 : v); }
function explainText(m) {
  const parts = [];
  (m.texts || []).forEach(t => parts.push(plain(t)));
  for (const c of m.cards || []) {
    if (c.type === "kpis") parts.push("Key numbers: " + c.items.map(k => `${plain(k.label)} ${plain(k.value)}${k.delta != null ? `, ${k.delta >= 0 ? "up" : "down"} ${Math.abs(k.delta).toFixed(1)} percent` : ""}`).join("; ") + ".");
    else if (c.type === "chart") { const ch = c.chart, ds = ch.datasets?.[0]; if (ds && ch.labels?.length) { const pairs = ch.labels.map((l, i) => [l, ds.data[i]]).filter(p => p[1] != null);
      const top = ch.type === "line" ? [pairs[0], pairs[pairs.length - 1]] : [...pairs].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3);
      parts.push(`The chart ${plain(ch.title)} ${ch.type === "line" ? `goes from ${spokenNum(top[0][1], ch.fmt)} in ${top[0][0]} to ${spokenNum(top[1][1], ch.fmt)} in ${top[1][0]}` : "shows the largest values: " + top.map(([l, v]) => `${l} ${spokenNum(v, ch.fmt)}`).join(", ")}.`); } }
    else if (c.type === "table") parts.push(`A table, ${plain(c.title)}, with ${c.rows.length} rows${c.rows[0] ? `. First: ${plain(Object.values(c.rows[0]).slice(0, 3).join(", "))}` : ""}.`);
    else if (c.type === "refusal") parts.push(`I can't do that. ${plain(c.message)}`);
    else if (c.type === "clarify") parts.push(`${plain(c.question)} Options: ${c.options.slice(0, 3).join(", ")}.`);
    else if (c.type === "record") parts.push(`Updated record ${plain(c.title)}: ` + c.fields.filter(f => f.changed).map(f => `${f.label} changed from ${f.old} to ${f.value}`).join("; ") + ".");
    else if (c.type === "confirm") parts.push(`${plain(c.title)}. Please confirm with the button.`);
  }
  if (m.done?.confidence != null && m.done.confidence < 0.6) parts.push("I'm not fully sure about this one, so I've sent it for human review.");
  return parts.join(" ").slice(0, 1800) || "Done.";
}
function speak(m, btn) {
  const ss = window.speechSynthesis; if (!ss) return toast("Speech output not supported in this browser", 1);
  if (ss.speaking) { ss.cancel(); $$(".fbk .speaking").forEach(b => b.classList.remove("speaking")); if (btn && btn.classList.contains("speaking")) return; }
  const u = new SpeechSynthesisUtterance(explainText(m)); u.lang = "en-IN"; u.rate = 1.02;
  const v = ss.getVoices().find(v => /en[-_]IN/i.test(v.lang)) || ss.getVoices().find(v => /^en/i.test(v.lang)); if (v) u.voice = v;
  const b = btn || $("[data-speak]", m.el); if (b) { b.classList.add("speaking"); u.onend = u.onerror = () => b.classList.remove("speaking"); }
  ss.speak(u);
}

/* ---------- human-in-the-loop feedback on every answer ---------- */
function feedbackBar(m) {
  const d = document.createElement("div"); d.className = "fbk"; const c = m.done?.confidence;
  const cl = c == null ? "" : `<span class="conf ${c >= 0.8 ? "hi" : c >= 0.45 ? "mid" : "lo"}" title="Router confidence. Below 45% the answer goes to an admin for review.">confidence ${Math.round(c * 100)}%</span>`;
  d.innerHTML = `<button data-speak title="Read and explain this answer aloud">🔊 Explain</button><button data-v="up" title="Helpful">👍</button><button data-v="down" title="Wrong answer: send to admin review">👎</button>
    <button data-v="flag" title="Ask a human to check this answer">⚑ Review</button><button data-pdf title="Save this answer as PDF">⤓ PDF</button>${cl}${m.done?.review_id ? `<small>queued for review #${m.done.review_id}</small>` : ""}`;
  $("[data-speak]", d).onclick = e => speak(m, e.currentTarget);
  $("[data-pdf]", d).onclick = () => doExport("pdf", "answer", m);
  $$("[data-v]", d).forEach(b => b.onclick = async () => {
    const vote = b.dataset.v; let reason = "";
    if (vote !== "up") { reason = await dialog({ title: vote === "down" ? "What was wrong?" : "Send for human review", text: "An admin will check this answer and you'll get a notification.", input: "e.g. wrong region, wrong number, wanted lowest price", ok: "Send" }); if (reason === null) return; }
    try { const r = await api("/api/agent/feedback", { method: "POST", body: JSON.stringify({ log_id: m.done?.log_id, vote, reason, answer: ((m.texts || []).join(" ") || explainText(m)).slice(0, 1200), query: m.query }) });
      $$("[data-v]", d).forEach(x => x.classList.toggle("on", x === b));
      toast(vote === "up" ? "Thanks, marked helpful" : `Sent to admin review #${r.queued}`); loadNotifs(); } catch (e) { toast(e.message, 1); }
  });
  return d;
}

/* ---------- export: PDF summary / CSV ---------- */
async function saveFile(name, data) {
  if (EMBED && window.claude?.use) { try { const dl = await window.claude.use("downloads"); if (dl) { await dl.save({ filename: name, data }); toast("Saved " + name); return; } } catch (e) { if (e && e.code === "declined") return; } }
  const blob = data instanceof Blob ? data : new Blob([data], { type: name.endsWith(".csv") ? "text/csv" : "application/octet-stream" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); toast("Downloaded " + name);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
function csvOf(t) { const q = v => { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  return [t.columns.map(c => q(c.label)).join(","), ...t.rows.map(r => t.columns.map(c => q(r[c.key])).join(","))].join("\n"); }
function pdfText(v) { return String(v ?? "").replace(/₹/g, "Rs ").replace(/[^\x20-\x7E\n]/g, ""); }
function cellText(r, c) { const v = r[c.key]; if (v == null || v === "") return "-"; if (c.fmt === "inr") return pdfText(inr(v)); if (c.fmt === "pct") return Number(v).toFixed(1) + "%"; if (c.fmt === "days") return Number(v).toFixed(1) + " d"; if (["int", "num"].includes(c.fmt)) return Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 }); return pdfText(String(v).slice(0, 60)); }
async function doExport(fmtx, scope = "page", m = null) {
  const page = S.P[S.page], d = S.data || {};
  if (fmtx === "csv") {
    const t = d.table || (scope !== "page" && m?.cards?.find(c => c.type === "table"));
    if (!t) return toast("No table on this page to export", 1);
    return saveFile(`bizpilot-${S.page}-${stamp()}.csv`, csvOf(t));
  }
  const J = window.jspdf?.jsPDF; if (!J) return toast("PDF library still loading, try again in a moment", 1);
  const doc = new J({ unit: "pt", format: "a4" }), W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M0 = 40; let y = 40;
  const need = h => { if (y + h > H - 40) { doc.addPage(); y = 40; } };
  const text = (s, size = 10, bold = false, color = [15, 27, 51]) => { doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(size); doc.setTextColor(...color);
    for (const ln of doc.splitTextToSize(pdfText(s), W - 2 * M0)) { need(size + 4); doc.text(ln, M0, y); y += size + 4; } };
  const canvasImg = (cv, maxH = 210) => { try { const r = cv.width / cv.height, w = Math.min(W - 2 * M0, maxH * r), h = w / r; need(h + 8);
    const sc = Math.min(1, 1100 / cv.width), t = document.createElement("canvas"); t.width = cv.width * sc; t.height = cv.height * sc; const g = t.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, t.width, t.height); g.drawImage(cv, 0, 0, t.width, t.height);
    doc.addImage(t.toDataURL("image/jpeg", 0.88), "JPEG", M0, y, w, h); y += h + 10; } catch { } };
  const table = (t, max = 25) => { const cols = t.columns.slice(0, 7), cw = (W - 2 * M0) / cols.length;
    need(30); doc.setFillColor(238, 242, 249); doc.rect(M0, y - 10, W - 2 * M0, 16, "F"); doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(74, 88, 116);
    cols.forEach((c, i) => doc.text(pdfText(c.label).slice(0, 18), M0 + 3 + i * cw, y)); y += 14; doc.setFont("helvetica", "normal"); doc.setTextColor(15, 27, 51);
    for (const r of t.rows.slice(0, max)) { need(13); cols.forEach((c, i) => doc.text(doc.splitTextToSize(cellText(r, c), cw - 6)[0] || "", M0 + 3 + i * cw, y)); y += 12; }
    if (t.rows.length > max) text(`+ ${t.rows.length - max} more rows (export CSV for all)`, 8, false, [133, 146, 173]); y += 6; };
  doc.setFillColor(11, 23, 48); doc.rect(0, 0, W, 62, "F"); doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(17);
  doc.text(scope === "page" ? `BizPilot AI · ${page.title} summary` : scope === "chat" ? "BizPilot AI · Agent conversation" : "BizPilot AI · Agent answer", M0, 32);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.text(pdfText(`${S.user.name} (${S.user.role}) · ${new Date().toLocaleString("en-IN")} · page_id: ${S.page}`), M0, 48); y = 86;
  if (scope === "page") {
    const f = Object.entries(S.filters).map(([k, v]) => `${k} = ${v}`); text("Filters: " + (f.length ? f.join(", ") : "none (default view)"), 9, false, [74, 88, 116]); y += 4;
    if (d.kpis?.length) { text("Key figures", 12, true); d.kpis.forEach(k => text(`• ${k.label}: ${pdfText(k.fmt === "inr" ? inr(k.value) : fmt(k.value, k.fmt).replace(/<[^>]+>/g, ""))}${k.delta != null ? `  (${k.delta >= 0 ? "+" : ""}${Number(k.delta).toFixed(1)}% vs previous)` : ""}${k.note ? " - " + k.note : ""}`, 10)); y += 4; }
    const ins = d.extra?.insights; if (ins?.length) { text("Agent noticed", 12, true); ins.forEach(i => text(`• ${i.title}: ${i.detail || ""}`, 9.5)); y += 4; }
    const cvs = $$("#main canvas"); if (cvs.length) { text("Charts", 12, true); cvs.slice(0, 4).forEach(cv => { const t = cv.closest(".panel,.dk")?.querySelector("h3,h4")?.childNodes[0]?.textContent; if (t) text(t.trim(), 9, true, [74, 88, 116]); canvasImg(cv); }); }
    for (const k of ["table", "table2"]) if (d[k]) { text(d[k].title, 12, true); table(d[k]); }
    const last = [...$$("#msgs .msg.bot")].pop(); if (last && last.__m) { text("Latest agent answer", 12, true); text(explainText(last.__m), 9.5); }
  } else {
    const ms = scope === "answer" ? [m] : [...$$("#msgs .msg.bot")].map(e => e.__m).filter(x => x && x.query);
    if (!ms.length) return toast("No agent answers yet", 1);
    for (const x of ms) { if (x.query) text("Q: " + x.query, 11, true, [37, 99, 235]); text(explainText(x), 9.5);
      $$("canvas", x.el).forEach(cv => canvasImg(cv, 170)); (x.cards || []).filter(c => c.type === "table").slice(0, 1).forEach(t => table(t, 12));
      (x.cards || []).filter(c => c.type === "sources").forEach(c => c.items.forEach(s => text("SQL: " + s.sql, 7.5, false, [133, 146, 173])));
      if (x.done) text(`intent ${x.done.intent} · ${x.done.latency_ms} ms · confidence ${Math.round((x.done.confidence ?? 1) * 100)}%`, 8, false, [133, 146, 173]); y += 8; }
  }
  const n = doc.getNumberOfPages(); for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(133, 146, 173); doc.text(`BizPilot AI · numbers computed from the app database · page ${i}/${n}`, M0, H - 20); }
  await saveFile(`bizpilot-${scope === "page" ? S.page : scope}-${stamp()}.pdf`, doc.output("blob"));
}

boot();


/* ================= Dashboard (reference design) ================= */
function renderDashboard(meta, d, changed) {
  const x = d.extra, f = S.filters;
  const ranges = [["", "Last 12 Months"], ["30", "Last 30 Days"], ["90", "Last 90 Days"], ["180", "Last 6 Months"], ["ytd", "This Year"], ["730", "Last 24 Months"]];
  const curRange = S.dashRange || "";
  const tone = { green: "#16a34a", blue: "#2563eb", violet: "#7c3aed", sky: "#0284c7" };
  const kp = d.kpis.map(k => `<div class="panel dk tone-${k.tone}" data-widget-id="${k.id}"><div class="ico">${icon(k.icon === "revenue" ? "revenue" : k.icon)}</div><div style="min-width:0">
      <div class="l">${esc(k.label)}</div><div class="v">${fmt(k.value, k.fmt)}</div>
      ${k.delta != null ? `<div class="d ${k.delta >= 0 ? "up" : "down"}">${k.delta >= 0 ? "↗" : "↘"} ${Math.abs(k.delta).toFixed(1)}%</div><div class="n">vs. previous period${k.note ? " · " + esc(k.note) : ""}</div>` : `<div class="n">${esc(k.note || "")}</div>`}</div></div>`).join("");
  const inv = d.charts[1], invTot = inv.datasets[0].data.reduce((a, b) => a + b, 0), invCol = ["#16a34a", "#f59e0b", "#dc2626"];
  const pct1 = v => (v * 100 / (invTot || 1)).toFixed(0) + "%";
  const thumbCol = ["#64748b", "#0ea5e9", "#f97316", "#8b5cf6", "#14b8a6", "#e11d48"];
  const low = d.table.rows.slice(0, 5).map((r, i) => `<tr><td><div class="prod"><div class="thumb" style="background:${thumbCol[i % 6]}">${esc(r.name.split(" ").map(w => w[0]).join("").slice(0, 2))}</div><span>${esc(r.name)} <small style="color:var(--ink3)">(${esc(r.sku)})</small></span></div></td>
      <td class="num">${fmt(r.stock, "int")}</td><td class="num">${fmt(r.reorder_level, "int")}</td><td><span class="daypill ${r.days_left > 7 ? "warn" : ""}">${r.days_left == null ? "—" : r.days_left.toFixed(0) + " days"}</span></td></tr>`).join("");
  const pos = x.recent_pos.slice(0, 5).map(r => `<tr><td>${esc(r.po_no)}</td><td>${esc(r.supplier)}</td><td>${pill(r.status)}</td><td class="num">${inr(r.amount)}</td><td>${esc(r.order_date.slice(5))}</td></tr>`).join("");
  const ful = x.fulfillment, exp = x.expenses;
  const top = x.top_products.slice(0, 5).map(r => `<tr><td>${esc(r.name)}</td><td class="num">${fmt(r.units, "int")}</td><td class="num">${inr(r.revenue)}</td></tr>`).join("");
  const regions = ["All Locations", ...S.meta.pages.find(p => p.id === "sales").filters.find(x => x.key === "region").options];
  const h = `<section data-page-id="dashboard">
    <div class="dhead"><div><h1>Dashboard <span class="pid">page_id: dashboard</span></h1><p>Real-time overview of your supply chain and business operations</p></div>
      <div class="ctrls"><select class="select" id="dRange" aria-label="Date range">${ranges.map(([v, l]) => `<option value="${v}" ${v === curRange ? "selected" : ""}>📅 ${l}</option>`).join("")}</select>
      <select class="select" id="dRegion" aria-label="Location">${regions.map((r, i) => `<option value="${i ? esc(r) : ""}" ${(f.region || "") === (i ? r : "") ? "selected" : ""}>${esc(r)}</option>`).join("")}</select>
      <button class="btn" data-ask="What is on this page?" style="height:42px">✦ Explain</button></div></div>
    <div class="banner">${icon("pulse").replace("<svg", '<svg width="18" height="18"')} Demonstration data · 25 months of synthetic records across 12 tables <a data-goto-page="data">Explore dataset &amp; KPIs →</a></div>
    <div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr))">${kp}</div>
    ${x.insights?.length ? `<div class="ihead">${icon("pulse").replace("<svg", '<svg width="18" height="18" style="color:var(--brand)"')} Agent noticed <span style="font-weight:500;font-size:12px;color:var(--ink3)">last month vs 3-month average · click to investigate</span></div>
      <div class="insights" data-widget-id="agent_insights">${x.insights.map(i => `<div class="ins ${i.tone}" data-ask="${esc(i.ask)}"><b>${esc(i.title)}</b><span>${esc(i.body)}</span><small>Ask the agent →</small></div>`).join("")}</div>` : ""}
    <div class="drow r1">
      <div class="panel" data-widget-id="chart_trend"><div class="ptitle">${icon("trend")} Revenue &amp; Orders Trend <button class="askw" data-ask="Explain the Revenue & Orders Trend widget">✦ Ask</button></div><div class="chartbox" style="height:290px"><canvas id="cv_trend"></canvas></div></div>
      <div class="panel" data-widget-id="chart_inventory_status"><div class="ptitle">${icon("cart")} Inventory Status <button class="askw" data-ask="Explain the Inventory Status widget">✦ Ask</button></div>
        <div class="donutwrap"><div class="donut"><canvas id="cv_inv"></canvas><div class="center"><div><b>${fmt(invTot, "int")}</b><small>Total Items</small></div></div></div>
        <div class="legend">${inv.labels.map((l, i) => `<div><i style="background:${invCol[i]}"></i><span>${esc(l)}<small>${pct1(inv.datasets[0].data[i])} (${inv.datasets[0].data[i]})</small></span></div>`).join("")}</div></div></div>
    </div>
    <div class="drow r2">
      <div class="panel" data-widget-id="grid_low_stock"><div class="ptitle">${icon("alert").replace("<svg", '<svg style="color:var(--bad)"')} Low Stock Alerts <button class="askw" data-ask="Explain the Low Stock Alerts widget">✦ Ask</button><button class="va" data-goto-page="inventory">View All</button></div>
        <div class="tbl-wrap"><table><thead><tr><th>Product</th><th class="num">Current Stock</th><th class="num">Reorder Level</th><th>Days Left</th></tr></thead><tbody>${low || '<tr><td colspan="4" class="empty">All items healthy</td></tr>'}</tbody></table></div></div>
      <div class="panel" data-widget-id="grid_recent_pos"><div class="ptitle">${icon("cart")} Recent Purchase Orders <button class="askw" data-ask="Explain the Recent Purchase Orders widget">✦ Ask</button><button class="va" data-goto-page="procurement">View All</button></div>
        <div class="tbl-wrap"><table><thead><tr><th>PO #</th><th>Supplier</th><th>Status</th><th class="num">Amount</th><th>Date</th></tr></thead><tbody>${pos}</tbody></table></div></div>
    </div>
    <div class="drow r3">
      <div class="panel" data-widget-id="chart_fulfillment"><div class="ptitle">${icon("truck2").replace("<svg", '<svg style="color:var(--ok)"')} Order Fulfillment Rate <button class="askw" data-ask="Explain the Order Fulfillment Rate widget">✦ Ask</button></div>
        <div class="donutwrap"><div class="donut" style="width:170px;height:170px"><canvas id="cv_ful"></canvas><div class="center"><div><b>${ful.rate.toFixed(0)}%</b><small>Orders delivered<br>on time</small></div></div></div>
        <div class="stats"><div><span class="si" style="background:#dcfce7;color:#16a34a">Σ</span><span><b>${fmt(ful.total, "int")}</b><small>Delivered orders</small></span></div>
          <div><span class="si" style="background:#dbeafe;color:#2563eb">✓</span><span><b>${fmt(ful.on_time, "int")}</b><small>Delivered on time</small></span></div>
          <div><span class="si" style="background:#fdecec;color:#dc2626">!</span><span><b>${fmt(ful.late, "int")}</b><small>Delayed orders</small></span></div></div></div></div>
      <div class="panel" data-widget-id="chart_expense"><div class="ptitle">${icon("pie").replace("<svg", '<svg style="color:var(--info)"')} Expense Breakdown <button class="askw" data-ask="Explain the Expense Breakdown widget">✦ Ask</button></div>
        <div class="donutwrap"><div class="donut" style="width:170px;height:170px"><canvas id="cv_exp"></canvas><div class="center"><div><b>${inr(exp.total)}</b><small>Total</small></div></div></div>
        <div class="legend">${exp.items.map((e, i) => `<div><i style="background:${PALETTE[i % PALETTE.length]}"></i><span>${esc(e.label)} <small>${(e.value * 100 / (exp.total || 1)).toFixed(0)}%</small></span></div>`).join("")}</div></div></div>
      <div class="panel" data-widget-id="grid_top_products"><div class="ptitle">${icon("bars")} Top Selling Products <button class="askw" data-ask="Explain the Top Selling Products widget">✦ Ask</button><button class="va" data-goto-page="analytics" data-gb="product">View All</button></div>
        <div class="tbl-wrap"><table><thead><tr><th>Product</th><th class="num">Units Sold</th><th class="num">Revenue</th></tr></thead><tbody>${top}</tbody></table></div></div>
    </div></section>`;
  const pageChanged = S.lastRendered !== "dashboard"; S.lastRendered = "dashboard";
  $("#main").innerHTML = h; if (pageChanged) $("#main").scrollTop = 0;
  const tr = d.charts[0];
  { const nowLbl = new Date().toLocaleString("en-US", { month: "short" }) + " " + String(new Date().getFullYear()).slice(2); const li = tr.labels.length - 1; if (tr.labels[li] === nowLbl) tr.labels[li] = nowLbl + " (MTD)"; }
  if (window.Chart) {
    S.charts.push(new Chart($("#cv_trend"), { type: "line", data: { labels: tr.labels, datasets: [
      { label: "Revenue (₹)", data: tr.datasets[0].data, borderColor: "#2563eb", backgroundColor: "rgba(37,99,235,.10)", fill: true, tension: .4, pointRadius: 4, pointBackgroundColor: "#2563eb", yAxisID: "y" },
      { label: "Orders", data: tr.datasets[1].data, borderColor: "#16a34a", backgroundColor: "#16a34a", tension: .4, pointRadius: 4, yAxisID: "y1" }] },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, plugins: { legend: { position: "top", align: "start", labels: { usePointStyle: true, boxWidth: 8 } },
        tooltip: { callbacks: { label: c => c.datasetIndex ? `Orders: ${c.parsed.y}` : `Revenue: ${inr(c.parsed.y)}` } } },
        scales: { x: { grid: { display: false } }, y: { grid: { color: "#eef2f7" }, ticks: { callback: v => inr(v) } }, y1: { position: "right", grid: { display: false } } } } }));
    const dough = (id, data, colors) => S.charts.push(new Chart($(id), { type: "doughnut", data: { labels: data.map((_, i) => i), datasets: [{ data, backgroundColor: colors, borderColor: "#fff", borderWidth: 3 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: "70%", plugins: { legend: { display: false }, tooltip: { enabled: false } } } }));
    dough("#cv_inv", inv.datasets[0].data, invCol);
    dough("#cv_ful", [ful.on_time, ful.late], ["#16a34a", "#e5e7eb"]);
    dough("#cv_exp", exp.items.map(e => e.value), exp.items.map((_, i) => PALETTE[i % PALETTE.length]));
  }
  $("#dRange").onchange = e => { const v = e.target.value; S.dashRange = v; const ff = { ...S.filters }, t = new Date(), iso = x => x.toISOString().slice(0, 10);
    if (!v) { delete ff.date_from; delete ff.date_to; } else if (v === "ytd") { ff.date_from = `${t.getFullYear()}-01-01`; ff.date_to = iso(t); } else { const a = new Date(t); a.setDate(a.getDate() - (+v) + 1); ff.date_from = iso(a); ff.date_to = iso(t); }
    navigateTo("dashboard", ff); };
  $("#dRegion").onchange = e => navigateTo("dashboard", { ...S.filters, region: e.target.value || undefined });
  $$("[data-goto-page]").forEach(b => b.onclick = () => navigateTo(b.dataset.gotoPage, b.dataset.gb ? { group_by: b.dataset.gb } : {}));
  $$("[data-ask]", $("#main")).forEach(b => b.onclick = () => sendChat(b.dataset.ask));
  updateCtx();
}

/* ================= Data & KPIs: table browser + SQL console ================= */
function dataTools() {
  const tables = (S.data.catalog || []).map(t => t.table);
  const sqlOk = ["admin", "manager"].includes(S.user.role);
  const samples = ["select region, round(sum(amount)) as revenue from sales_orders where status != 'Cancelled' group by region order by revenue desc",
    "select substr(order_date,1,7) as month, count(*) as orders, round(sum(amount)) as revenue from sales_orders group by month order by month",
    "select s.name, count(*) as pos, round(sum(po.amount)) as spend from purchase_orders po join suppliers s on s.id = po.supplier_id group by s.name order by spend desc",
    "select carrier, round(avg(delay_days),2) as avg_delay, count(*) as shipments from shipments group by carrier order by avg_delay desc"];
  return `<div class="panel" data-widget-id="table_browser" style="margin-bottom:14px"><h3>Table Browser <span class="wid">table_browser</span></h3>
    <div class="dbtools"><select class="select" id="tbTable" aria-label="Table">${tables.map(t => `<option ${t === (S.tbTable || "sales_orders") ? "selected" : ""}>${t}</option>`).join("")}</select>
      <input class="input" id="tbQ" placeholder="Search all columns" value="${esc(S.tbQ || "")}" style="flex:1;min-width:160px"><button class="btn" id="tbGo">Search</button>${!EMBED ? '<button class="btn" id="tbCsv">Download CSV</button>' : ""}</div>
    <div class="schema" id="tbSchema"></div><div id="tbGrid"><div class="empty">Loading…</div></div></div>
  <div class="panel" data-widget-id="sql_console" style="margin-bottom:14px"><h3>SQL Console <span class="wid">sql_console</span><span style="margin-left:auto;font-size:12px;color:var(--ink3);font-weight:500">read-only · SELECT only</span></h3>
    ${sqlOk ? `<div class="chips" style="margin:0 0 8px">${samples.map((q, i) => `<button class="chip" data-sample="${i}">${["Revenue by region", "Monthly orders", "Spend by supplier", "Delay by carrier"][i]}</button>`).join("")}</div>
    <textarea class="sql" id="sqlIn" spellcheck="false">${esc(S.sqlText || samples[0])}</textarea>
    <div class="dbtools" style="margin-top:8px"><button class="btn primary" id="sqlRun">Run query</button><span id="sqlMeta" style="color:var(--ink3);font-size:12px"></span></div>
    <div class="grid2" style="margin:0"><div id="sqlGrid" style="min-width:0"></div><div class="chartbox" id="sqlChartBox" style="display:none"><canvas id="sqlChart"></canvas></div></div>`
    : `<div class="empty">The SQL console is for admin and manager roles. Use the table browser above, or ask the agent.</div>`}</div>`;
}
function bindData(d) {
  const samplesEls = $$("[data-sample]");
  let off = 0;
  const showSchema = t => { const c = d.catalog.find(x => x.table === t); $("#tbSchema").innerHTML = c ? `<span style="background:none;padding:3px 0"><b>${esc(t)}</b> · ${esc(c.description)} · ${c.rows.toLocaleString()} rows</span>` + c.columns.map(col => `<span title="${esc(col.description)}"><b>${esc(col.name)}</b> ${esc(col.type)}${col.description ? " · " + esc(col.description) : ""}</span>`).join("") : ""; };
  const load = async () => {
    const t = $("#tbTable").value; S.tbTable = t; S.tbQ = $("#tbQ").value; showSchema(t);
    const r = await api(`/api/data/table/${t}?q=${encodeURIComponent(S.tbQ)}&offset=${off}&limit=50`);
    $("#tbGrid").innerHTML = `<div class="tbl-wrap" style="max-height:420px"><table><thead><tr>${r.columns.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${r.rows.map(row => `<tr>${r.columns.map(c => `<td class="${typeof row[c] === "number" ? "num" : ""}">${typeof row[c] === "number" && !/(^id$|_id$)/.test(c) ? Number(row[c]).toLocaleString("en-IN", { maximumFractionDigits: 2 }) : esc(row[c] ?? "—")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      <div class="tfoot">${(r.offset + 1).toLocaleString()}–${Math.min(r.offset + 50, r.total).toLocaleString()} of ${r.total.toLocaleString()} <button class="btn sm" id="tbPrev" ${off ? "" : "disabled"}>‹</button><button class="btn sm" id="tbNext" ${off + 50 < r.total ? "" : "disabled"}>›</button></div>`;
    $("#tbPrev").onclick = () => { off = Math.max(0, off - 50); load(); }; $("#tbNext").onclick = () => { off += 50; load(); };
  };
  $("#tbTable").onchange = () => { off = 0; load(); }; $("#tbGo").onclick = () => { off = 0; load(); }; $("#tbQ").onkeydown = e => { if (e.key === "Enter") { off = 0; load(); } };
  if ($("#tbCsv")) $("#tbCsv").onclick = async () => {
    const t = $("#tbTable").value, all = []; let o = 0, total = 1;
    while (o < total && o < 20000) { const r = await api(`/api/data/table/${t}?q=${encodeURIComponent($("#tbQ").value)}&offset=${o}&limit=200`); total = r.total; all.push(...r.rows); o += 200; var cols = r.columns; }
    const csv = [cols.join(","), ...all.map(r => cols.map(c => `"${String(r[c] ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = `${t}.csv`; a.click();
  };
  load();
  if (!$("#sqlRun")) return;
  samplesEls.forEach(b => b.onclick = () => { $("#sqlIn").value = SQL_SAMPLES[+b.dataset.sample]; $("#sqlRun").click(); });
  let sqlChart = null;
  $("#sqlRun").onclick = async () => {
    S.sqlText = $("#sqlIn").value; $("#sqlMeta").textContent = "Running…";
    try {
      const r = await api("/api/data/sql", { method: "POST", body: JSON.stringify({ sql: S.sqlText }) });
      $("#sqlMeta").textContent = `${r.rows.length}${r.truncated ? "+" : ""} rows · ${r.ms} ms`;
      $("#sqlGrid").innerHTML = `<div class="tbl-wrap" style="max-height:360px"><table><thead><tr>${r.columns.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${r.rows.map(row => `<tr>${r.columns.map(c => `<td class="${typeof row[c] === "number" ? "num" : ""}">${typeof row[c] === "number" && !/(^id$|_id$)/.test(c) ? Number(row[c]).toLocaleString("en-IN", { maximumFractionDigits: 2 }) : esc(row[c] ?? "—")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
      if (sqlChart) { sqlChart.destroy(); sqlChart = null; }
      const num = r.columns.slice(1).filter(c => r.rows.every(x => typeof x[c] === "number" || x[c] == null));
      const box = $("#sqlChartBox");
      if (r.columns.length > 1 && num.length && r.rows.length && r.rows.length <= 60) {
        box.style.display = "block"; const first = r.rows.map(x => String(x[r.columns[0]]));
        const line = first.every(v => /^\d{4}-\d{2}/.test(v));
        drawChart($("#sqlChart"), { type: line ? "line" : "bar", title: "", labels: first, datasets: num.slice(0, 3).map(c => ({ label: c, data: r.rows.map(x => x[c]) })), fmt: "num", horizontal: !line && r.rows.length > 8 }, true);
        sqlChart = Object.values(Chart.instances).find(c => c.canvas.id === "sqlChart");
      } else box.style.display = "none";
    } catch (e) { $("#sqlMeta").textContent = ""; $("#sqlGrid").innerHTML = `<div class="err" style="padding:8px">${esc(e.message)}</div>`; }
  };
  $("#sqlRun").click();
}
const SQL_SAMPLES = ["select region, round(sum(amount)) as revenue from sales_orders where status != 'Cancelled' group by region order by revenue desc",
  "select substr(order_date,1,7) as month, count(*) as orders, round(sum(amount)) as revenue from sales_orders group by month order by month",
  "select s.name, count(*) as pos, round(sum(po.amount)) as spend from purchase_orders po join suppliers s on s.id = po.supplier_id group by s.name order by spend desc",
  "select carrier, round(avg(delay_days),2) as avg_delay, count(*) as shipments from shipments group by carrier order by avg_delay desc"];


/* ================= Evaluation page ================= */
function meets(v, target) {
  if (v == null || !target) return null;
  const m = target.match(/(>=|<=|<|>|=)\s*([\d.]+)/); if (!m) return null; const t = +m[2];
  return { ">=": v >= t, "<=": v <= t, "<": v < t, ">": v > t, "=": v === t }[m[1]];
}
function renderEval(meta, d) {
  const res = d.results, T = d.targets || S.meta.targets || {};
  let h = `<section data-page-id="evaluation"><div class="phead"><div><h1>Evaluation <span class="pid">page_id: evaluation</span></h1><p>${esc(meta.description)}</p></div><div class="spacer"></div>
    <button class="btn primary" id="evRun">▶ Run evaluation</button></div>`;
  if (!res || !res.kpis) h += `<div class="panel empty">No run yet. Click <b>Run evaluation</b>: it executes every test through the agent on a fresh copy of the data (a few seconds).</div>`;
  else {
    const rows = Object.entries(res.kpis).map(([k, v]) => { const ok = meets(v, T[k]); return `<tr><td>${esc(k)}</td><td class="num ${ok === true ? "ok" : ok === false ? "bad" : ""}">${v == null ? "—" : v}${typeof v === "number" && /accuracy|correct|success|faithful|precision|recall|refusal|clarif|answers|Generalization|robust/i.test(k) ? "%" : ""}</td><td>${esc(T[k] || "")}</td><td>${ok === true ? "✓ met" : ok === false ? "✗ below target" : ""}</td></tr>`; }).join("");
    h += `<div class="kpis">${d.kpis.map(k => `<div class="kpi" data-widget-id="${k.id}"><div class="l">${esc(k.label)}</div><div class="v">${fmt(k.value, k.fmt)}</div>${k.note ? `<div class="n">${esc(k.note)}</div>` : ""}</div>`).join("")}</div>
    <div class="grid2"><div class="panel" data-widget-id="eval_kpis"><h3>KPI results vs targets</h3><div class="tbl-wrap"><table class="evtbl"><thead><tr><th>KPI</th><th class="num">Measured</th><th>Target</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>
    <div class="panel" data-widget-id="grid_suites"><h3>Test suites · ${res.tests} tests · ${res.seconds}s</h3><div class="chartbox"><canvas id="cv_suites"></canvas></div>
      <div class="tbl-wrap"><table><thead><tr><th>Suite</th><th class="num">Tests</th><th class="num">Passed</th><th class="num">Rate</th></tr></thead><tbody>${res.suites.map(x => `<tr><td>${esc(x.suite)}</td><td class="num">${x.tests}</td><td class="num">${x.passed}</td><td class="num">${x.rate}%</td></tr>`).join("")}</tbody></table></div></div></div>
    <div class="panel" data-widget-id="grid_failures" style="margin-bottom:14px"><h3>Failures (${res.failures.length}) — reported as measured, not hidden</h3><div class="tbl-wrap"><table><thead><tr><th>Suite</th><th>Test</th><th>Expected</th><th>Got</th><th>Reason</th></tr></thead><tbody>${res.failures.map(f => `<tr><td>${esc(f.suite)}</td><td>${esc(f.test)}</td><td>${esc(f.expected ?? "")}</td><td>${esc(f.got ?? "")}</td><td>${esc(f.reason || "")}</td></tr>`).join("") || '<tr><td colspan="5" class="empty">No failures</td></tr>'}</tbody></table></div></div>
    <p style="color:var(--ink3);font-size:12.5px">${esc(res.note)} Last run ${esc(res.ran_at)}.</p>`;
  }
  h += `</section>`;
  $("#main").innerHTML = h; $("#main").scrollTop = 0; S.lastRendered = "evaluation";
  if (res && res.suites && window.Chart) drawChart($("#cv_suites"), { type: "bar", title: "", labels: res.suites.map(x => x.suite), datasets: [{ label: "Pass rate %", data: res.suites.map(x => x.rate), colors: res.suites.map(x => x.rate >= 95 ? "#16a34a" : x.rate >= 85 ? "#f59e0b" : "#dc2626") }], fmt: "pct", horizontal: true });
  $("#evRun").onclick = async () => { const b = $("#evRun"); b.disabled = true; b.textContent = "Running… (fresh database)"; try { await api("/api/eval/run", { method: "POST" }); toast("Evaluation complete"); loadPage(); } catch (e) { toast(e.message, 1); b.disabled = false; b.textContent = "▶ Run evaluation"; } };
  updateCtx();
}

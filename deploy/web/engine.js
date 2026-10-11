/* BizPilot in-browser engine: a faithful JS port of the Python backend (db, pages, services, retrieval, nlu, agent).
   Lets the full app + agent run as a static hosted page. Data is generated per browser; changes persist in localStorage. */
(function () {
"use strict";
const META = window.BP_META;
const M = META;
const PAGE = Object.fromEntries(M.PAGES.map(p => [p.id, p]));
const ENT = M.ENTITIES;

/* ================= dates ================= */
const pad = n => String(n).padStart(2, "0");
const D = {
  p: s => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); },
  s: dt => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`,
  add: (s, n) => { const d = D.p(s); d.setUTCDate(d.getUTCDate() + n); return D.s(d); },
  diff: (a, b) => Math.round((D.p(b) - D.p(a)) / 864e5),
  ms: s => s.slice(0, 8) + "01",
  addM: (s, n) => { const d = D.p(D.ms(s)); d.setUTCMonth(d.getUTCMonth() + n); return D.s(d); },
  me: s => D.add(D.addM(s, 1), -1),
  qs: s => { const d = D.p(s); return `${d.getUTCFullYear()}-${pad(3 * Math.floor(d.getUTCMonth() / 3) + 1)}-01`; },
  wd: s => (D.p(s).getUTCDay() + 6) % 7,
  y: s => +s.slice(0, 4), m: s => +s.slice(5, 7),
  mk: (y, m, d) => `${y}-${pad(m)}-${pad(d)}`,
  min: (a, b) => a < b ? a : b,
};
const today = () => { const n = new Date(); return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`; };
const nowTs = () => { const n = new Date(); return `${today()}T${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`; };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const mlabel = ym => `${MON[+ym.slice(5, 7) - 1]} ${ym.slice(2, 4)}`;
const r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100;
const sum = (a, f = x => x) => a.reduce((s, x) => s + (f(x) || 0), 0);

/* ================= storage ================= */
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } },
  del(k) { try { localStorage.removeItem(k); } catch { } },
};
const KEY = "bizpilot_engine_v3";

/* ================= database ================= */
const DB = {}; const IDX = {}; let VER = 0; let agentWrites = 0; let journal = []; let replaying = false;
const TABLES = ["users", "products", "suppliers", "supplier_products", "customers", "sales_orders", "purchase_orders", "shipments", "expenses", "change_requests", "audit_log", "agent_log", "notifications", "agent_reviews"];
function idx(t) { if (!IDX[t]) { IDX[t] = new Map(DB[t].map(r => [r.id, r])); } return IDX[t]; }
function byId(t, id) { return idx(t).get(+id); }
function live(t) { return DB[t].filter(r => !r.is_deleted); }
function insert(t, row) {
  if (row.id == null) row.id = DB[t].length ? Math.max(...DB[t].map(r => r.id)) + 1 : 1;
  if (row.is_deleted == null && !["change_requests", "audit_log", "agent_log", "users", "notifications", "agent_reviews"].includes(t)) row.is_deleted = 0;
  DB[t].push(row); IDX[t] = null; VER++;
  if (!replaying) { journal.push(["i", t, row]); save(); }
  return row.id;
}
function update(t, id, sets) {
  const r = byId(t, id); if (!r) return; Object.assign(r, sets); VER++;
  if (!replaying) { journal.push(["u", t, id, sets]); save(); }
}
let saveT; function save() { clearTimeout(saveT); saveT = setTimeout(() => LS.set(KEY, { anchor: ANCHOR, journal: journal.slice(-3000) }), 150); }

/* ================= seed (synthetic 25-month dataset) ================= */
function RNG(seed) {
  let a = seed >>> 0;
  const r = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return {
    random: r, uniform: (a, b) => a + (b - a) * r(), randint: (a, b) => a + Math.floor(r() * (b - a + 1)), choice: arr => arr[Math.floor(r() * arr.length)],
    gauss: (mu, sd) => { const u = 1 - r(), v = r(); return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); },
    expo: l => -Math.log(1 - r()) / l, shuffle: arr => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; },
  };
}
const wchoice = (rng, items) => { let x = rng.random() * sum(items, i => i[1]); for (const [it, w] of items) { x -= w; if (x <= 0) return it; } return items[items.length - 1][0]; };
const USERS = [["admin", "Aishwarya Rao", "admin", "admin123"], ["manager", "Michael Smith", "manager", "manager123"], ["staff", "Ravi Kumar", "staff", "staff123"], ["viewer", "Neha Gupta", "viewer", "viewer123"]];
const PRODUCTS = [
  ["SR-001", "Steel Rod", "Raw Materials", "pcs", 520, 380, "Bengaluru WH", 9], ["PR-002", "Plastic Resin", "Raw Materials", "kg", 260, 185, "Mumbai WH", 8],
  ["CW-003", "Copper Wire", "Electrical", "m", 410, 300, "Bengaluru WH", 7], ["AS-004", "Aluminium Sheet", "Raw Materials", "pcs", 640, 470, "Delhi WH", 6],
  ["SS-005", "Stainless Steel Pipe", "Raw Materials", "pcs", 880, 650, "Mumbai WH", 5], ["BR-006", "Brass Rod", "Raw Materials", "pcs", 720, 540, "Delhi WH", 3],
  ["PV-007", "PVC Pipe", "Raw Materials", "pcs", 180, 120, "Bengaluru WH", 6], ["RB-008", "Rubber Gasket", "Components", "pcs", 45, 28, "Bengaluru WH", 8],
  ["BB-009", "Ball Bearing 6204", "Components", "pcs", 150, 95, "Mumbai WH", 7], ["HB-010", "Hex Bolt M10", "Components", "box", 340, 230, "Delhi WH", 6],
  ["SP-011", "Spring Washer", "Components", "box", 120, 75, "Bengaluru WH", 4], ["GB-012", "Gear Box Assembly", "Components", "pcs", 6800, 5100, "Mumbai WH", 2],
  ["EM-013", "Electric Motor 2HP", "Electrical", "pcs", 9200, 7000, "Delhi WH", 2], ["CB-014", "Circuit Breaker 32A", "Electrical", "pcs", 980, 700, "Bengaluru WH", 4],
  ["LC-015", "LED Panel 40W", "Electrical", "pcs", 1250, 880, "Mumbai WH", 4], ["CT-016", "Control Cable 4C", "Electrical", "m", 95, 62, "Delhi WH", 6],
  ["SW-017", "Industrial Switch", "Electrical", "pcs", 560, 390, "Bengaluru WH", 3], ["CB-018", "Corrugated Box L", "Packaging", "pcs", 38, 22, "Bengaluru WH", 9],
  ["SF-019", "Stretch Film Roll", "Packaging", "roll", 420, 290, "Mumbai WH", 5], ["PT-020", "Wooden Pallet", "Packaging", "pcs", 650, 460, "Delhi WH", 4],
  ["BT-021", "Bubble Wrap Roll", "Packaging", "roll", 380, 250, "Bengaluru WH", 4], ["ET-022", "Epoxy Resin", "Chemicals", "kg", 790, 560, "Mumbai WH", 3],
  ["IP-023", "Industrial Paint", "Chemicals", "l", 450, 310, "Delhi WH", 4], ["LB-024", "Lubricant Oil", "Chemicals", "l", 280, 190, "Bengaluru WH", 5],
  ["AD-025", "Adhesive Sealant", "Chemicals", "tube", 210, 135, "Mumbai WH", 4], ["SG-026", "Safety Gloves", "Safety", "pair", 85, 50, "Bengaluru WH", 7],
  ["SH-027", "Safety Helmet", "Safety", "pcs", 340, 220, "Delhi WH", 4], ["SG-028", "Safety Goggles", "Safety", "pcs", 190, 120, "Mumbai WH", 3],
];
const SUPPLIERS = [
  ["SUP-001", "Global Metals Ltd.", "Raw Materials", "Mumbai", "India", 4.6, 7, 0.95], ["SUP-002", "Prime Plastics", "Raw Materials", "Ahmedabad", "India", 4.2, 9, 0.88],
  ["SUP-003", "Steel Supplies Co.", "Raw Materials", "Jamshedpur", "India", 4.4, 6, 0.92], ["SUP-004", "MetalWorks Inc.", "Raw Materials", "Pune", "India", 3.9, 11, 0.81],
  ["SUP-005", "Asia Components", "Components", "Chennai", "India", 4.5, 8, 0.93], ["SUP-006", "Precision Parts Pvt", "Components", "Coimbatore", "India", 4.1, 10, 0.86],
  ["SUP-007", "VoltEdge Electricals", "Electrical", "Bengaluru", "India", 4.7, 5, 0.96], ["SUP-008", "Shakti Cables", "Electrical", "Delhi", "India", 4.0, 9, 0.84],
  ["SUP-009", "PackRight Solutions", "Packaging", "Hyderabad", "India", 4.3, 4, 0.94], ["SUP-010", "GreenWrap Packaging", "Packaging", "Kolkata", "India", 3.8, 12, 0.79],
  ["SUP-011", "ChemCore Industries", "Chemicals", "Vadodara", "India", 4.4, 8, 0.91], ["SUP-012", "Unichem Traders", "Chemicals", "Mumbai", "India", 3.7, 13, 0.77],
  ["SUP-013", "SafeGuard Gear", "Safety", "Noida", "India", 4.5, 6, 0.93], ["SUP-014", "Orient Steel Exports", "Raw Materials", "Shenzhen", "China", 4.0, 21, 0.83],
  ["SUP-015", "Sigma Industrial", "Components", "Gurugram", "India", 4.2, 7, 0.90],
];
const REGIONS = { "Karnataka": [0.24, ["Bengaluru", "Mysuru", "Hubballi"]], "Maharashtra": [0.22, ["Mumbai", "Pune", "Nagpur"]], "Delhi": [0.16, ["New Delhi", "Dwarka"]],
  "Tamil Nadu": [0.13, ["Chennai", "Coimbatore"]], "Gujarat": [0.10, ["Ahmedabad", "Surat"]], "Telangana": [0.09, ["Hyderabad", "Warangal"]], "West Bengal": [0.06, ["Kolkata", "Howrah"]] };
const CHANNELS_W = [["Direct Sales", 0.45], ["Distributor", 0.30], ["Online Portal", 0.25]];
const CARRIERS = ["BlueDart", "Delhivery", "DTDC", "Gati", "Ecom Express"];
const EXPENSE_CATS = { Logistics: 0.30, Salaries: 0.34, Rent: 0.10, Marketing: 0.10, Utilities: 0.06, Administrative: 0.10 };
const FIRST = ["Rohan", "Priya", "Karan", "Sneha", "Arjun", "Neha", "Vikram", "Ananya", "Rahul", "Divya", "Aditya", "Meera", "Sanjay", "Kavya", "Nikhil", "Pooja", "Harsh", "Isha", "Manoj", "Tanvi"];
const COMPANY = ["Industries", "Enterprises", "Manufacturing", "Engineering", "Traders", "Fabricators", "Infra", "Works", "Systems", "Corp"];
const PREFIX = ["Apex", "Vertex", "Sunrise", "Nova", "Zenith", "Omega", "Pioneer", "Trident", "Lotus", "Everest", "Crest", "Silverline", "Bharat", "Kaveri", "Indus", "Deccan", "Coastal", "Metro", "Unity", "Shree"];

let ANCHOR;
function seed(anchor) {
  TABLES.forEach(t => { DB[t] = []; IDX[t] = null; });
  replaying = true;
  const rng = RNG(42), end = D.add(anchor, -1);
  const start = D.addM(end, -24);
  USERS.forEach(([u, n, r, p], i) => insert("users", { id: i + 1, username: u, name: n, role: r, password: p, email: `${u}@bizpilot.demo` }));
  PRODUCTS.forEach(([sku, name, cat, unit, price, cost, wh], i) => insert("products", { id: i + 1, sku, name, category: cat, unit, unit_price: price, cost_price: cost, stock: 0, reorder_level: 0, warehouse: wh }));
  SUPPLIERS.forEach(([code, name, cat, city, country, rating, lead, otr], i) => insert("suppliers", { id: i + 1, code, name, category: cat, city, country, rating, lead_time_days: lead, on_time_rate: otr,
    email: `sales@${name.toLowerCase().replace(/[ .]/g, "").slice(0, 14)}.com`, phone: `+91 9${rng.randint(100000000, 999999999)}` }));
  PRODUCTS.forEach((p, i) => {
    const pid = i + 1;
    const cands = SUPPLIERS.map((s, j) => s[2] === p[2] ? j + 1 : 0).filter(Boolean);
    const others = rng.shuffle(SUPPLIERS.map((s, j) => j + 1).filter(j => !cands.includes(j)));
    let chosen = cands.length < 2 ? [...cands, ...others.slice(0, 2)].slice(0, 4) : cands.slice(0, 4);
    for (const sid of chosen) { let f = rng.uniform(0.88, 1.12); if (SUPPLIERS[sid - 1][4] === "China") f *= 0.9; DB.supplier_products.push({ supplier_id: sid, product_id: pid, price: r2(p[5] * f) }); }
  });
  const regions = Object.entries(REGIONS), regW = regions.map(([r, v]) => [r, v[0]]);
  const custs = [], byRegion = {};
  for (let i = 1; i <= 80; i++) {
    const region = wchoice(rng, regW), city = rng.choice(REGIONS[region][1]), name = `${rng.choice(PREFIX)} ${rng.choice(COMPANY)}`, seg = rng.choice(M.SEGMENTS);
    insert("customers", { id: i, code: `CUST-${String(i).padStart(4, "0")}`, name, segment: seg, city, region, email: `${rng.choice(FIRST).toLowerCase()}@${name.split(" ")[0].toLowerCase()}.in` });
    custs.push([i, region, seg]); (byRegion[region] = byRegion[region] || []).push([i, region, seg]);
  }
  const total = D.diff(start, end) + 1, prodW = PRODUCTS.map((p, i) => [i + 1, p[7]]), anomaly = D.add(end, -60);
  let so = 0;
  for (let d = 0; d < total; d++) {
    const day = D.add(start, d), mo = D.m(day);
    const growth = 1 + 0.35 * d / total;
    const season = 1 + 0.18 * Math.sin((mo - 3) / 12 * 2 * Math.PI) + ([10, 11].includes(mo) ? 0.15 : 0) - (mo === 6 ? 0.12 : 0);
    const wk = D.wd(day) === 6 ? 0.55 : 1;
    const n = Math.max(0, Math.trunc(rng.gauss(11 * growth * season * wk, 2.5)));
    for (let k = 0; k < n; k++) {
      let region = wchoice(rng, regW);
      if (region === "Maharashtra" && day >= anomaly && rng.random() < 0.30) region = wchoice(rng, regW.filter(r => r[0] !== "Maharashtra"));
      const [cid, , seg] = rng.choice(byRegion[region] || custs);
      const pid = wchoice(rng, prodW), p = PRODUCTS[pid - 1];
      const base = p[4] > 5000 ? 3 : (p[4] < 100 ? 40 : 12);
      let qty = Math.max(1, Math.trunc(rng.expo(1 / base)) + 1);
      if (seg === "Enterprise" || seg === "Distributor") qty = Math.trunc(qty * 1.6) + 1;
      const price = r2(p[4] * rng.uniform(0.94, 1.04)), age = D.diff(day, end);
      let status;
      if (rng.random() < 0.03) status = "Cancelled";
      else if (age > 14) status = rng.random() < 0.02 ? "Returned" : "Delivered";
      else if (age > 5) status = rng.choice(["Delivered", "Delivered", "Shipped"]);
      else status = rng.choice(["Processing", "Shipped", "Processing"]);
      so++;
      const channel = wchoice(rng, CHANNELS_W);
      DB.sales_orders.push({ id: so, order_no: `SO-${String(so).padStart(5, "0")}`, customer_id: cid, product_id: pid, qty, unit_price: price, amount: r2(qty * price), region, channel, status, order_date: day, is_deleted: 0 });
      if (status === "Cancelled") continue;
      let carrier = rng.choice(CARRIERS);
      const ship = D.add(day, rng.randint(0, 2)), transit = rng.randint(2, 5);
      let delay = 0;
      if (rng.random() < 0.08) delay = rng.randint(1, 4);
      if (region === "Maharashtra" && day >= anomaly && rng.random() < 0.55) { delay = rng.randint(3, 9); if (rng.random() < 0.7) carrier = "Gati"; }
      const eta = D.add(ship, transit), delivered = D.add(eta, delay);
      let st, dd = null;
      if (status === "Delivered" || status === "Returned") { st = "Delivered"; dd = delivered; }
      else if (status === "Shipped") { st = delay && delivered > end ? "Delayed" : (delivered > end ? "In Transit" : "Delivered"); if (st === "Delivered") dd = delivered; }
      else st = "Pending";
      DB.shipments.push({ id: DB.shipments.length + 1, shipment_no: `SHP-${String(so).padStart(5, "0")}`, sales_order_id: so, carrier, origin: p[6], destination: region, status: st, ship_date: ship, eta, delivered_date: dd, delay_days: delay, is_deleted: 0 });
    }
  }
  const since = D.add(end, -90), vel = {};
  for (const r of DB.sales_orders) if (r.order_date >= since && r.status !== "Cancelled") vel[r.product_id] = (vel[r.product_id] || 0) + r.qty / 90;
  const low = { 1: 5, 2: 7, 3: 6, 4: 8, 10: 11, 19: 3 }, out = [13, 27];
  for (let pid = 1; pid <= PRODUCTS.length; pid++) {
    const v = vel[pid] || 0.5, reorder = Math.max(10, Math.trunc(v * 20));
    const stock = out.includes(pid) ? 0 : low[pid] ? Math.trunc(v * low[pid]) : Math.trunc(v * rng.uniform(25, 70));
    Object.assign(byId("products", pid), { stock, reorder_level: reorder });
  }
  let po = 0, m = start;
  while (m <= end) {
    for (let pid = 1; pid <= PRODUCTS.length; pid++) {
      if (rng.random() < 0.55) continue;
      const sups = DB.supplier_products.filter(x => x.product_id === pid), sp = rng.choice(sups);
      const v = vel[pid] || 0.5, qty = Math.max(5, Math.trunc(v * rng.uniform(20, 45))), od = D.add(m, rng.randint(0, 27));
      if (od > end) continue;
      const lead = SUPPLIERS[sp.supplier_id - 1][6], age = D.diff(od, end);
      const status = age > 25 ? (rng.random() > 0.04 ? "Received" : "Cancelled") : age > 10 ? rng.choice(["Approved", "Received", "Received"]) : rng.choice(["Pending", "Approved", "Draft"]);
      po++; const uc = r2(sp.price * rng.uniform(0.97, 1.05));
      DB.purchase_orders.push({ id: po, po_no: `PO-${String(po).padStart(5, "0")}`, supplier_id: sp.supplier_id, product_id: pid, qty, unit_cost: uc, amount: r2(qty * uc), status, order_date: od, expected_date: D.add(od, lead), created_by: rng.choice(["manager", "staff", "admin"]), notes: "", is_deleted: 0 });
    }
    m = D.addM(m, 1);
  }
  let ex = 0; m = start;
  const revBy = {}; for (const r of DB.sales_orders) if (r.status !== "Cancelled") revBy[r.order_date.slice(0, 7)] = (revBy[r.order_date.slice(0, 7)] || 0) + r.amount;
  while (m <= end) {
    const opex = (revBy[m.slice(0, 7)] || 0) * rng.uniform(0.17, 0.21);
    for (const [cat, share] of Object.entries(EXPENSE_CATS)) {
      ex++; let amt = opex * share * rng.uniform(0.9, 1.1);
      if (cat === "Logistics" && m >= D.ms(anomaly)) amt *= 1.35;
      DB.expenses.push({ id: ex, code: `EXP-${String(ex).padStart(5, "0")}`, category: cat, amount: r2(amt), date: D.add(m, Math.min(27, 4 + ex % 20)), note: `${cat} - ${MON[D.m(m) - 1]} ${D.y(m)}`, is_deleted: 0 });
    }
    m = D.addM(m, 1);
  }
  const ts = nowTs();
  seedHistory(rng, end);
  TABLES.forEach(t => IDX[t] = null);
  replaying = false;
}

const AGENT_HISTORY = [["manager", "Show me products likely to run out in 14 days", "stockout", "inventory"], ["manager", "Compare top 3 suppliers for steel with best pricing", "compare_suppliers", "suppliers"],
  ["admin", "Why did revenue drop in Maharashtra?", "why", "logistics"], ["admin", "show pending requests", "requests", "approvals"], ["staff", "change price of copper wire to 425", "update", "inventory"],
  ["viewer", "what is on this page?", "current_page", "dashboard"], ["manager", "Compare revenue this month vs last month", "compare_periods", "analytics"], ["admin", "Top 5 products by revenue", "top", "analytics"],
  ["staff", "show delayed shipments", "delays", "logistics"], ["manager", "create purchase order for hex bolt", "create_po", "procurement"], ["admin", "what is our net profit this year?", "finance", "finance"],
  ["staff", "Show Karnataka sales for last quarter", "navigate", "sales"], ["manager", "which carrier has the most delays?", "delays", "logistics"], ["viewer", "Show last 12 months analysis", "trend", "analytics"],
  ["admin", "approve request 4", "review", "approvals"], ["staff", "find copper", "search", "inventory"], ["manager", "delete supplier GreenWrap Packaging", "delete", "suppliers"],
  ["admin", "why did logistics cost increase?", "expense_why", "finance"], ["staff", "show cancelled orders", "navigate", "sales"], ["manager", "describe the dataset", "dataset", "data"]];
function seedHistory(rng, end) {
  const now = Date.now(), ts = (d, h = 0) => { const x = new Date(now - (d * 24 + h) * 3600e3); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}`; };
  const au = (t, user, action, entity, label, details, via) => DB.audit_log.push({ id: DB.audit_log.length + 1, ts: t, username: user, action, entity, record_label: label, details: typeof details === "string" ? details : JSON.stringify(details), via });
  const cr = (entity, rid, label, action, changes, reason, status, by, created, reviewer = null, note = null, reviewed = null, via = "ui") => DB.change_requests.push({ id: DB.change_requests.length + 1, entity, record_id: rid, record_label: label, action, changes: JSON.stringify(changes), reason, status, requested_by: by, reviewed_by: reviewer, review_note: note, created_at: created, reviewed_at: reviewed, via });
  for (let d = 7; d >= 1; d--) ["admin", "manager", "staff", "viewer"].slice(0, 2 + d % 3).forEach(u => au(ts(d, 10 - d % 4), u, "login", "users", u, "", "ui"));
  cr("products", 2, "PR-002 Plastic Resin", "update", { unit_price: { old: 260, new: 300 } }, "Supplier price hike (+15%)", "Pending", "staff", ts(1, 5)); au(ts(1, 5), "staff", "request_update", "products", "PR-002 Plastic Resin", { unit_price: { old: 260, new: 300 } }, "ui");
  cr("suppliers", 12, "SUP-012 Unichem Traders", "update", { rating: { old: 3.7, new: 3.0 } }, "Repeated late deliveries", "Pending", "manager", ts(1, 3), null, null, null, "agent"); au(ts(1, 3), "manager", "request_update", "suppliers", "SUP-012 Unichem Traders", { rating: { old: 3.7, new: 3.0 } }, "agent");
  byId("products", 3).unit_price = 425;
  cr("products", 3, "CW-003 Copper Wire", "update", { unit_price: { old: 410, new: 425 } }, "Copper index up 3.7%", "Approved", "staff", ts(6, 2), "auto-policy", "Auto-approved: Selling price change ≤ 10%", ts(6, 2), "agent");
  au(ts(6, 2), "staff", "request_update", "products", "CW-003 Copper Wire", { unit_price: { old: 410, new: 425 } }, "agent"); au(ts(6, 2), "auto-policy", "update", "products", "CW-003 Copper Wire", { unit_price: { old: 410, new: 425 } }, "policy");
  byId("suppliers", 10).lead_time_days = 8;
  cr("suppliers", 10, "SUP-010 GreenWrap Packaging", "update", { lead_time_days: { old: 12, new: 8 } }, "New Hyderabad depot", "Approved", "manager", ts(5, 6), "admin", "Confirmed with vendor", ts(5, 1));
  au(ts(5, 6), "manager", "request_update", "suppliers", "SUP-010 GreenWrap Packaging", { lead_time_days: { old: 12, new: 8 } }, "ui"); au(ts(5, 1), "admin", "review_approve", "suppliers", "SUP-010 GreenWrap Packaging", "request #4: Confirmed with vendor", "agent");
  const po = [...DB.purchase_orders].reverse().find(p => p.status === "Received");
  cr("purchase_orders", po.id, po.po_no, "delete", {}, "Looks like a duplicate", "Rejected", "staff", ts(4, 4), "admin", "Goods already received; keep for audit", ts(4, 2));
  au(ts(4, 4), "staff", "request_delete", "purchase_orders", po.po_no, "delete", "ui"); au(ts(4, 2), "admin", "review_reject", "purchase_orders", po.po_no, "request #5: Goods already received", "ui");
  const h = byId("products", 27), r0 = h.reorder_level, nr = Math.trunc(r0 * 1.2); h.reorder_level = nr;
  cr("products", 27, "SH-027 Safety Helmet", "update", { reorder_level: { old: r0, new: nr } }, "Monsoon site demand", "Approved", "staff", ts(3, 3), "auto-policy", "Auto-approved: Reorder level change ≤ 50%", ts(3, 3));
  au(ts(3, 3), "auto-policy", "update", "products", "SH-027 Safety Helmet", { reorder_level: { old: r0, new: nr } }, "policy");
  cr("suppliers", 10, "SUP-010 GreenWrap Packaging", "delete", {}, "On-time rate below 80%", "Pending", "manager", ts(0, 20), null, null, null, "agent"); au(ts(0, 20), "manager", "request_delete", "suppliers", "SUP-010 GreenWrap Packaging", "delete", "agent");
  const pp = [...DB.purchase_orders].reverse().find(p => ["Pending", "Approved"].includes(p.status));
  if (pp) { cr("purchase_orders", pp.id, pp.po_no, "update", { status: { old: pp.status, new: "Cancelled" } }, "Customer order cancelled", "Pending", "staff", ts(0, 2)); au(ts(0, 2), "staff", "request_update", "purchase_orders", pp.po_no, { status: { old: pp.status, new: "Cancelled" } }, "ui"); }
  byId("suppliers", 5).phone = "+91 98450 11223"; au(ts(2, 7), "admin", "update", "suppliers", "SUP-005 Asia Components", { phone: { old: "…", new: "+91 98450 11223" } }, "ui");
  const n = DB.purchase_orders.length;
  [[10, 15, 160, "Draft", "manager"], [2, 1, 300, "Approved", "admin"]].forEach(([pid, sid, qty, status, user], k) => {
    const sp = DB.supplier_products.find(x => x.product_id === pid && x.supplier_id === sid), price = sp ? sp.price : byId("products", pid).cost_price, lead = byId("suppliers", sid).lead_time_days, no = `PO-${String(n + k + 1).padStart(5, "0")}`;
    DB.purchase_orders.push({ id: n + k + 1, po_no: no, supplier_id: sid, product_id: pid, qty, unit_cost: price, amount: r2(qty * price), status, order_date: D.add(end, -2), expected_date: D.add(end, lead - 2), created_by: user, notes: "Agent draft: low stock", is_deleted: 0 });
    au(ts(2, 2 - k), user, "create", "purchase_orders", no, { qty, status }, "agent");
  });
  AGENT_HISTORY.forEach(([u, q, intent, page], i) => DB.agent_log.push({ id: i + 1, ts: ts(7 - i * 7 / AGENT_HISTORY.length, rng.randint(0, 5)), username: u, query: q, intent, page, latency_ms: r1(rng.uniform(2, 38)), steps: rng.randint(1, 5), used_llm: 0 }));
  (M.REVIEW_HISTORY || []).forEach(([days, u, q, intent, page, ans, conf, src, reason, status, rev, note]) => {
    DB.agent_reviews.push({ id: DB.agent_reviews.length + 1, ts: ts(days), username: u, log_id: null, query: q, intent, page, answer: ans, confidence: conf, source: src, reason, status, reviewer: rev, verdict_note: note, reviewed_at: rev ? ts(days - 0.5) : null });
    if (status === "Open") DB.notifications.push({ id: DB.notifications.length + 1, ts: ts(days), recipient: "admin", kind: "review", title: src === "user" ? `Agent answer flagged by ${u}` : "Low-confidence agent answer queued", body: `“${q}” · ${reason}`, page: "review", filters: JSON.stringify({ status: "Open" }), entity: null, record_id: null, request_id: null, is_read: 0 });
  });
  DB.audit_log.sort((a, b) => a.ts < b.ts ? -1 : 1).forEach((r, i) => r.id = i + 1);
  const pageOf = { products: "inventory", suppliers: "suppliers", purchase_orders: "procurement", customers: "customers", users: "approvals" };
  for (const r of DB.change_requests) {
    const ch = JSON.parse(r.changes || "{}"), what = r.action === "delete" ? "delete" : Object.entries(ch).map(([k, v]) => `${k}: ${v.old} → ${v.new}`).join(", ");
    if (r.reviewed_by !== "auto-policy") DB.notifications.push({ id: DB.notifications.length + 1, ts: r.created_at, recipient: "admin", kind: "request", title: `New request #${r.id} from ${r.requested_by}`, body: `${r.record_label}: ${what}`, page: "approvals", filters: JSON.stringify({ status: "Pending" }), entity: r.entity, record_id: r.record_id, request_id: r.id, is_read: r.status === "Pending" ? 0 : 1 });
    if (r.status !== "Pending") { const kind = r.reviewed_by === "auto-policy" ? "auto" : r.status.toLowerCase();
      DB.notifications.push({ id: DB.notifications.length + 1, ts: r.reviewed_at || r.created_at, recipient: r.requested_by, kind, title: `Request #${r.id} ${kind === "auto" ? "auto-approved by policy" : r.status.toLowerCase()}`, body: `${r.record_label}: ${what}` + (r.review_note ? ` · ${r.review_note}` : ""), page: pageOf[r.entity] || "approvals", filters: "{}", entity: r.entity, record_id: r.record_id, request_id: r.id, is_read: 0 }); }
  }
  TABLES.forEach(t => IDX[t] = null);
}
function boot() {
  const saved = LS.get(KEY);
  const t = today();
  if (saved && saved.anchor && D.diff(saved.anchor, t) <= 7) { ANCHOR = saved.anchor; journal = saved.journal || []; }
  else { ANCHOR = t; journal = []; }
  seed(ANCHOR);
  replaying = true;
  for (const j of journal) { if (j[0] === "i") { DB[j[1]].push(j[2]); IDX[j[1]] = null; } else { const r = byId(j[1], j[2]); if (r) Object.assign(r, j[3]); } }
  replaying = false; TABLES.forEach(x => IDX[x] = null); VER++;
  save();
}
function resetData() { LS.del(KEY); journal = []; ANCHOR = today(); seed(ANCHOR); save(); NLU.invalidate(); R.build(); }

/* ================= services: auth, RBAC, CRUD ================= */
const PERMS = { admin: ["read", "create", "update", "delete", "approve"], manager: ["read", "create", "request"], staff: ["read", "create", "request"], viewer: ["read"] };
class HttpErr extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const Denied = m => new HttpErr(403, m), NotFound = m => new HttpErr(404, m), Bad = m => new HttpErr(400, m);
const can = (u, p) => (PERMS[u.role] || []).includes(p);
const require_ = (u, p) => { if (!can(u, p)) throw Denied(`Role '${u.role}' cannot ${p}.`); };
const pubUser = u => ({ id: u.id, username: u.username, name: u.name, role: u.role });
function makeToken(u) { return btoa(JSON.stringify({ u: u.username, exp: Date.now() + 12 * 3600e3, s: "bp" })); }
function verifyToken(tok) { try { const d = JSON.parse(atob(tok)); if (d.exp < Date.now() || d.s !== "bp") return null; const u = DB.users.find(x => x.username === d.u); return u ? pubUser(u) : null; } catch { return null; } }
function signup(name, username, email, password, role = "staff") {
  name = (name || "").trim(); username = (username || "").trim().toLowerCase(); email = (email || "").trim().toLowerCase();
  if (name.length < 2) throw Bad("Enter your full name.");
  if (!/^[a-z0-9_.]{3,20}$/.test(username)) throw Bad("Username: 3-20 characters, letters, numbers, dot or underscore.");
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) throw Bad("Enter a valid email address.");
  if ((password || "").length < 6) throw Bad("Password must be at least 6 characters.");
  if (!["viewer", "staff", "manager"].includes(role)) throw Bad("Choose viewer, staff or manager.");
  if (DB.users.some(u => u.username === username)) throw Bad("Username already taken.");
  if (DB.users.some(u => u.email === email)) throw Bad("An account with this email already exists. Sign in instead.");
  const granted = role === "manager" ? "staff" : role;
  const id = insert("users", { username, name, role: granted, password, email, created_at: nowTs() });
  const u = byId("users", id); audit(u, "signup", "users", username, `role ${granted}`, "ui");
  let rid = null;
  if (role === "manager") rid = insert("change_requests", { entity: "users", record_id: id, record_label: `user ${username} (${name})`, action: "role", changes: JSON.stringify({ role: { old: granted, new: "manager" } }),
    reason: "Requested at sign-up", status: "Pending", requested_by: username, reviewed_by: null, review_note: null, created_at: nowTs(), reviewed_at: null, via: "ui" });
  return { ...login(username, password), granted_role: granted, role_request_id: rid };
}
function login(username, password) {
  const u = DB.users.find(x => x.username === username);
  if (!u || u.password !== password) return null;
  audit(u, "login", "users", u.username, "", "ui");
  return { token: makeToken(u), user: pubUser(u), permissions: [...PERMS[u.role]].sort() };
}
function audit(u, action, entity, label, details, via = "ui") {
  insert("audit_log", { ts: nowTs(), username: u.username, action, entity, record_label: label, details: typeof details === "string" ? details : JSON.stringify(details), via });
}
function ent(e) { if (!ENT[e]) throw NotFound(`Unknown entity ${e}`); return ENT[e]; }
function getRecord(e, id) { const E = ent(e); const r = byId(E.table, id); if (!r || r.is_deleted) throw NotFound(`${E.label} ${id} not found`); return r; }
function recordLabel(e, r) { const E = ent(e); const c = r[E.code], n = r[E.name]; return n && n !== c ? `${c} ${n}` : String(c); }
function findRecord(e, ref) {
  const E = ent(e), rows = live(E.table); ref = String(ref).trim();
  if (/^\d+$/.test(ref)) { const r = rows.find(x => x.id === +ref); if (r) return r; }
  const lo = ref.toLowerCase();
  return rows.find(x => String(x[E.code]).toUpperCase() === ref.toUpperCase()) || rows.find(x => String(x[E.name]).toLowerCase() === lo)
    || rows.filter(x => String(x[E.name]).toLowerCase().includes(lo)).sort((a, b) => a[E.name].length - b[E.name].length)[0] || null;
}
const INT_KEYS = ["qty", "stock", "reorder_level", "lead_time_days", "delay_days"];
function coerce(e, data, partial) {
  const E = ent(e), F = Object.fromEntries(E.fields.map(f => [f.key, f])), out = {};
  for (let [k, v] of Object.entries(data || {})) {
    const f = F[k]; if (!f || v === "" || v == null) continue;
    if (f.type === "number" || f.type === "ref") { v = parseFloat(v); if (isNaN(v)) throw Bad(`${f.label} must be a number`); if (f.type === "ref" || INT_KEYS.includes(k)) v = Math.trunc(v); }
    if (f.type === "select" && f.options && !f.options.includes(v)) { const m = f.options.find(o => o.toLowerCase() === String(v).toLowerCase()); if (!m) throw Bad(`${f.label} must be one of ${f.options.join(", ")}`); v = m; }
    out[k] = v;
  }
  if (!partial) { const miss = E.fields.filter(f => f.required && !(f.key in out)).map(f => f.label); if (miss.length) throw Bad("Missing: " + miss.join(", ")); }
  return out;
}
function nextCode(e) {
  const E = ent(e); if (!E.prefix) return null;
  const nums = DB[E.table].map(r => String(r[E.code])).filter(c => c.startsWith(E.prefix)).map(c => +c.split("-").pop());
  const n = (nums.length ? Math.max(...nums) : 0) + 1, w = e === "suppliers" ? 3 : e === "customers" ? 4 : 5;
  return E.prefix + String(n).padStart(w, "0");
}
function createRecord(u, e, data, via = "ui") {
  require_(u, "create"); const E = ent(e), d = coerce(e, data);
  if (E.prefix) d[E.code] = nextCode(e);
  if (e === "purchase_orders") {
    d.status = d.status || "Draft"; if (u.role !== "admin" && !["Draft", "Pending"].includes(d.status)) d.status = "Pending";
    d.amount = r2(d.qty * d.unit_cost); d.order_date = today(); const s = getRecord("suppliers", d.supplier_id);
    d.expected_date = d.expected_date || D.add(today(), s.lead_time_days); d.created_by = u.username; getRecord("products", d.product_id);
  }
  if (e === "sales_orders") { d.amount = r2(d.qty * d.unit_price); d.status = d.status || "Processing"; d.order_date = today(); }
  if (e === "products") { if (DB.products.some(p => p.sku.toUpperCase() === String(d.sku).toUpperCase())) throw Bad(`SKU ${d.sku} already exists`); Object.assign(d, { stock: d.stock ?? 0, reorder_level: d.reorder_level ?? 10, unit: d.unit || "pcs", warehouse: d.warehouse || "Bengaluru WH" }); }
  if (e === "suppliers") Object.assign(d, { rating: d.rating ?? 4.0, lead_time_days: d.lead_time_days ?? 10, on_time_rate: d.on_time_rate ?? 0.9, country: d.country || "India" });
  const id = insert(E.table, d); const r = getRecord(e, id);
  audit(u, "create", e, recordLabel(e, r), d, via); return { ...r };
}
function diffOf(e, r, changes) { const d = coerce(e, changes, true), out = {}; for (const [k, v] of Object.entries(d)) if (r[k] !== v) out[k] = { old: r[k] ?? null, new: v }; return out; }
function applyUpdate(u, e, r, diff, via) {
  const E = ent(e), sets = Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.new]));
  if (e === "purchase_orders" && ("qty" in sets || "unit_cost" in sets)) sets.amount = r2((sets.qty ?? r.qty) * (sets.unit_cost ?? r.unit_cost));
  if (e === "sales_orders" && ("qty" in sets || "unit_price" in sets)) sets.amount = r2((sets.qty ?? r.qty) * (sets.unit_price ?? r.unit_price));
  update(E.table, r.id, sets); audit(u, "update", e, recordLabel(e, r), diff, via); return { ...getRecord(e, r.id) };
}
function updateRecord(u, e, id, changes, via = "ui") { require_(u, "update"); const r = getRecord(e, id), d = diffOf(e, r, changes); return Object.keys(d).length ? applyUpdate(u, e, r, d, via) : { ...r }; }
function deleteRecord(u, e, id, via = "ui") { require_(u, "delete"); const E = ent(e), r = getRecord(e, id); update(E.table, r.id, { is_deleted: 1 }); audit(u, "delete", e, recordLabel(e, r), "soft delete", via); NLU.invalidate(); return { deleted: true, label: recordLabel(e, r) }; }
const ENTITY_PAGE = { products: "inventory", suppliers: "suppliers", purchase_orders: "procurement", customers: "customers", sales_orders: "sales", shipments: "logistics", expenses: "finance", users: "approvals" };
function notify(recipients, kind, title, body, page = null, filters = null, entity = null, record_id = null, request_id = null) {
  if (recipients === "@admins") recipients = DB.users.filter(u => u.role === "admin").map(u => u.username);
  for (const r of [].concat(recipients)) insert("notifications", { ts: nowTs(), recipient: r, kind, title, body, page, filters: JSON.stringify(filters || {}), entity, record_id, request_id, is_read: 0 });
}
function listNotifications(u) {
  const items = DB.notifications.filter(n => n.recipient === u.username).sort((a, b) => a.ts === b.ts ? b.id - a.id : (a.ts < b.ts ? 1 : -1)).slice(0, 40).map(n => ({ ...n, filters: JSON.parse(n.filters || "{}") }));
  return { items, unread: DB.notifications.filter(n => n.recipient === u.username && !n.is_read).length };
}
function markNotifications(u, ids) { DB.notifications.filter(n => n.recipient === u.username && (!ids || !ids.length || ids.includes(n.id))).forEach(n => update("notifications", n.id, { is_read: 1 })); return listNotifications(u); }
function queueReview(u, logId, query, intent, page, answer, conf, source, reason) {
  const id = insert("agent_reviews", { ts: nowTs(), username: u.username, log_id: logId, query: String(query || "").slice(0, 300), intent, page, answer: String(answer || "").slice(0, 1200), confidence: conf, source, reason: String(reason).slice(0, 300), status: "Open", reviewer: null, verdict_note: null, reviewed_at: null });
  notify("@admins", "review", source === "user" ? `Agent answer flagged by ${u.username}` : "Low-confidence agent answer queued", `“${String(query).slice(0, 80)}” · ${String(reason).slice(0, 120)}`, "review", { status: "Open" });
  return id;
}
function feedback(u, logId, vote, reason = "", answer = "", query = "") {
  if (!["up", "down", "flag"].includes(vote)) throw Bad("vote must be up, down or flag");
  const row = logId ? byId("agent_log", logId) : null;
  if (row && row.username !== u.username) throw Denied("You can only rate your own agent answers.");
  if (row) update("agent_log", row.id, { feedback: vote });
  if (vote === "up") return { ok: true, queued: null };
  const ex = logId && DB.agent_reviews.find(r => r.log_id === logId && r.status === "Open"); if (ex) return { ok: true, queued: ex.id };
  return { ok: true, queued: queueReview(u, logId, (row && row.query) || query, (row && row.intent) || "", (row && row.page) || "", answer, row ? row.confidence : null, "user", reason || (vote === "down" ? "Marked wrong" : "Sent for review")) };
}
function reviewAnswer(u, id, verdict, note = "") {
  if (!PERMS[u.role].includes("approve")) throw Denied("Only an admin can review agent answers.");
  if (!["Correct", "Wrong"].includes(verdict)) throw Bad("verdict must be Correct or Wrong");
  const r = byId("agent_reviews", id); if (!r) throw NotFound(`Review #${id} not found`); if (r.status !== "Open") throw Bad(`Review #${id} is already ${r.status}`);
  update("agent_reviews", id, { status: verdict, reviewer: u.username, verdict_note: note, reviewed_at: nowTs() });
  audit(u, "review", "agent_reviews", `Review #${id}`, { verdict, note }, "ui");
  if (r.username !== u.username) notify(r.username, verdict === "Correct" ? "approved" : "rejected", `Your flagged answer #${id} reviewed: ${verdict}`, `“${r.query.slice(0, 80)}”` + (note ? ` · ${note}` : ""), "review", {});
  return { ok: true, id, status: verdict };
}
const changeText = cr => cr.action === "delete" ? "delete" : Object.entries(JSON.parse(cr.changes || "{}")).map(([k, v]) => `${k}: ${v.old} → ${v.new}`).join(", ");
function recordLink(e, r) { const page = ENTITY_PAGE[e] || "approvals"; if (!r) return [page, {}]; if (["products", "suppliers", "customers"].includes(e)) return [page, { q: r.name }]; const code = ENT[e] ? r[ENT[e].code] : null; return [page, code ? { q: code } : {}]; }
function recordView(e, id, diff = {}) {
  if (!ENT[e]) return null; const E = ENT[e], r = byId(E.table, id); if (!r) return null;
  const fields = E.fields.some(f => f.key === E.code) ? [] : [{ key: E.code, label: "Code", value: r[E.code] }];
  for (const f of E.fields) { let v = r[f.key]; if (f.type === "ref" && v) { const R_ = ENT[f.ref], rr = byId(R_.table, v); v = rr ? `${rr[R_.code]} · ${rr[R_.name]}` : v; }
    const it = { key: f.key, label: f.label, value: v ?? null }; if (f.key in diff) { it.changed = true; it.old = diff[f.key].old; } fields.push(it); }
  if (e === "purchase_orders") fields.push({ key: "amount", label: "Amount (₹)", value: r.amount, changed: "qty" in diff || "unit_cost" in diff });
  const [page, filters] = recordLink(e, r);
  return { type: "record", title: recordLabel(e, r), entity: e, deleted: !!r.is_deleted, fields, page, filters };
}
const POLICY_USER = { id: 0, username: "auto-policy", name: "Auto-approval policy", role: "admin" };
function policyCheck(action, diff) {
  if (action !== "update" || !Object.keys(diff).length) return null;
  const rules = Object.fromEntries(M.APPROVAL_POLICY.map(r => [r.field, r])), ok = [];
  for (const [k, v] of Object.entries(diff)) {
    const r = rules[k]; if (!r) return null;
    if (r.rule !== "any") {
      const o = v.old, nv = v.new; if (o == null || o === "" || typeof nv !== "number") return null;
      if (r.rule === "pct") { if (!o || Math.abs(nv - o) / Math.abs(o) * 100 > r.limit + 1e-9) return null; }
      else if (Math.abs(nv - o) > r.limit + 1e-9) return null;
    }
    ok.push(r.label);
  }
  return ok;
}
function requestChange(u, e, id, action, changes, reason = "", via = "ui") {
  require_(u, "request"); const r = getRecord(e, id);
  const diff = action === "update" ? diffOf(e, r, changes || {}) : {};
  if (action === "update" && !Object.keys(diff).length) throw Bad("No change detected.");
  const label = recordLabel(e, r);
  const cid = insert("change_requests", { entity: e, record_id: +id, record_label: label, action, changes: JSON.stringify(diff), reason, status: "Pending", requested_by: u.username, reviewed_by: null, review_note: null, created_at: nowTs(), reviewed_at: null, via });
  audit(u, "request_" + action, e, label, Object.keys(diff).length ? diff : "delete", via);
  const passed = policyCheck(action, diff), [lpage, lflt] = recordLink(e, r);
  if (!passed) notify("@admins", "request", `New request #${cid} from ${u.username}`, `${label}: ${changeText({ action, changes: JSON.stringify(diff) })}` + (reason ? ` · ${reason}` : ""), "approvals", { status: "Pending" }, e, +id, cid);
  if (passed) { applyUpdate(POLICY_USER, e, r, diff, "policy"); update("change_requests", cid, { status: "Approved", reviewed_by: "auto-policy", review_note: "Auto-approved: " + passed.join("; "), reviewed_at: nowTs() });
    audit(POLICY_USER, "review_approve", e, label, `request #${cid} auto-approved by policy`, "policy");
    notify(u.username, "auto", `Request #${cid} auto-approved by policy`, `${label}: ${changeText({ action, changes: JSON.stringify(diff) })} · applied`, lpage, lflt, e, +id, cid); }
  return { ...byId("change_requests", cid), auto_approved: !!passed };
}
function writeOrRequest(u, e, id, action, changes, reason, via) {
  if (action === "delete") { if (can(u, "delete")) return { mode: "applied", result: deleteRecord(u, e, id, via) }; }
  else if (can(u, "update")) return { mode: "applied", result: updateRecord(u, e, id, changes, via) };
  if (can(u, "request")) { const r = requestChange(u, e, id, action, changes, reason, via); return { mode: r.auto_approved ? "auto_approved" : "requested", result: r }; }
  throw Denied(`Role '${u.role}' is read-only.`);
}
function reviewRequest(u, rid, decision, note = "", via = "ui") {
  require_(u, "approve"); const cr = byId("change_requests", rid);
  if (!cr) throw NotFound(`Request #${rid} not found`); if (cr.status !== "Pending") throw Bad(`Request #${rid} already ${cr.status}`);
  let result = null;
  if (decision === "approve" && cr.action === "role") { const nr = JSON.parse(cr.changes).role.new; update("users", cr.record_id, { role: nr }); audit(u, "update", "users", cr.record_label, { role: nr }, via); }
  else if (decision === "approve") {
    if (cr.action === "delete") result = deleteRecord(u, cr.entity, cr.record_id, via);
    else { const r = getRecord(cr.entity, cr.record_id), diff = JSON.parse(cr.changes);
      const stale = Object.entries(diff).filter(([k, v]) => !(r[k] === v.old || (typeof r[k] === "number" && typeof v.old === "number" && Math.abs(r[k] - v.old) < 1e-6))).map(([k, v]) => `${k} is now ${r[k]} (request expected ${v.old})`);
      if (stale.length) throw Bad(`Request #${rid} is out of date: ${stale.join("; ")}. Ask the requester to resubmit.`);
      result = applyUpdate(u, cr.entity, r, diff, via); }
  }
  update("change_requests", cr.id, { status: decision === "approve" ? "Approved" : "Rejected", reviewed_by: u.username, review_note: note, reviewed_at: nowTs() });
  audit(u, "review_" + decision, cr.entity, cr.record_label, `request #${rid}: ${note}`, via);
  DB.notifications.filter(n => n.request_id === cr.id && n.kind === "request" && !n.is_read).forEach(n => update("notifications", n.id, { is_read: 1 }));
  let page = "approvals", flt = {};
  if (cr.entity !== "users" && ENT[cr.entity]) { const rec = byId(ENT[cr.entity].table, cr.record_id); if (rec && !rec.is_deleted) [page, flt] = recordLink(cr.entity, rec); }
  const st = decision === "approve" ? "approved" : "rejected";
  notify(cr.requested_by, st, `Request #${rid} ${st} by ${u.username}`, `${cr.record_label}: ${changeText(cr)}` + (note ? ` · ${note}` : ""), page, flt, cr.entity, cr.record_id, rid);
  const view = decision === "approve" && ENT[cr.entity] ? recordView(cr.entity, cr.record_id, JSON.parse(cr.changes || "{}")) : null;
  return { request: { ...cr }, result, record: view };
}
function reviewMany(u, decision = "approve", ids = null, note = "", via = "ui") {
  require_(u, "approve"); ids = [...(ids || DB.change_requests.filter(r => r.status === "Pending").map(r => r.id))].sort((a, b) => a - b); const done = [], failed = [];
  for (const i of ids) { try { reviewRequest(u, i, decision, note, via); done.push(i); } catch (e) { failed.push([i, e.message]); } }
  return { done, failed };
}
function listRequests(u, status, mine) { return DB.change_requests.filter(r => (!status || r.status === status) && (!mine || r.requested_by === u.username)).sort((a, b) => b.id - a.id).map(r => ({ ...r })); }
function refOptions(e) { const E = ent(e); return live(E.table).sort((a, b) => a[E.name].localeCompare(b[E.name])).map(r => ({ value: r.id, label: `${r[E.code]} · ${r[E.name]}` })); }

/* ================= pages + analytics ================= */
const P = {};
P.drange = (f, dd = 365) => { const to = f.date_to || today(); return [f.date_from || D.add(to, -(dd - 1)), to]; };
P.prev = (a, b) => { const n = D.diff(a, b) + 1; return [D.add(a, -n), D.add(a, -1)]; };
P.pct = (c, p) => !p ? null : r1((c - p) / p * 100);
const kpi = (id, label, value, fmt = "int", delta = null, note = null) => ({ id, label, value, fmt, delta, note });
const col = (key, label, fmt = "text") => ({ key, label, fmt });
P.months = (a, b) => { const out = []; let m = D.ms(a); while (m <= b) { out.push(m.slice(0, 7)); m = D.addM(m, 1); } return out; };
P.sort = (rows, sort, def) => {
  sort = sort || def; if (!sort || !rows.length) return rows; const [k, d] = sort.split(":");
  if (!(k in rows[0])) return rows;
  return [...rows].sort((a, b) => { const x = a[k], y = b[k]; if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; const c = x < y ? -1 : x > y ? 1 : 0; return d === "asc" ? c : -c; });
};
let soView = null, soVer = -1;
function soJoined() {
  if (soVer === VER && soView) return soView;
  const pm = idx("products"), cm = idx("customers");
  soView = DB.sales_orders.filter(r => !r.is_deleted).map(r => ({ so: r, p: pm.get(r.product_id), c: cm.get(r.customer_id) }));
  soVer = VER; return soView;
}
P.salesRows = f => {
  const [a, b] = P.drange(f), q = (f.q || "").toLowerCase();
  return soJoined().filter(({ so, p, c }) => (f.status ? so.status === f.status : so.status !== "Cancelled") && so.order_date >= a && so.order_date <= b
    && (!f.region || so.region === f.region) && (!f.channel || so.channel === f.channel) && (!f.category || p.category === f.category) && (!f.segment || c.segment === f.segment)
    && (!f.product_id || so.product_id === +f.product_id) && (!q || c.name.toLowerCase().includes(q) || p.name.toLowerCase().includes(q) || so.order_no.toLowerCase().includes(q)));
};
P.totals = f => { const rows = P.salesRows(f); return { revenue: sum(rows, x => x.so.amount), orders: rows.length, units: sum(rows, x => x.so.qty), cogs: sum(rows, x => x.so.qty * x.p.cost_price) }; };
P.monthly = f => {
  const by = {}; for (const x of P.salesRows(f)) { const m = x.so.order_date.slice(0, 7); const o = by[m] = by[m] || { revenue: 0, orders: 0, units: 0 }; o.revenue += x.so.amount; o.orders++; o.units += x.so.qty; }
  const [a, b] = P.drange(f); return P.months(a, b).map(m => ({ m, revenue: r2(by[m]?.revenue || 0), orders: by[m]?.orders || 0, units: by[m]?.units || 0 }));
};
P.velocity = (days = 90) => { const since = D.add(today(), -days), v = {}; for (const r of DB.sales_orders) if (!r.is_deleted && r.order_date >= since && r.status !== "Cancelled") v[r.product_id] = (v[r.product_id] || 0) + r.qty / days; return v; };
P.productRows = () => {
  const vel = P.velocity();
  return live("products").map(p => { const r = { ...p }, v = vel[r.id] || 0; r.daily_demand = r1(v); r.days_left = v > 0 ? r1(r.stock / v) : null; r.stock_value = r2(r.stock * r.cost_price);
    r.stock_status = r.stock <= 0 ? "Out of Stock" : r.stock <= r.reorder_level ? "Low Stock" : "In Stock"; return r; });
};
P.stockout = (days = 14, category = null) => {
  const rows = P.productRows().filter(r => r.days_left != null && r.days_left <= days && (!category || r.category === category));
  const open = {}; for (const po of DB.purchase_orders) if (!po.is_deleted && ["Draft", "Pending", "Approved"].includes(po.status)) open[po.product_id] = (open[po.product_id] || 0) + po.qty;
  rows.forEach(r => { r.open_po_qty = open[r.id] || 0; r.suggested_qty = Math.max(0, Math.trunc(r.daily_demand * 45 - r.stock - r.open_po_qty)); });
  return rows.sort((a, b) => a.days_left - b.days_left);
};
P.supplierOptions = pid => {
  const rows = DB.supplier_products.filter(x => x.product_id === +pid).map(x => { const s = byId("suppliers", x.supplier_id); return s && !s.is_deleted ? { supplier_id: s.id, code: s.code, name: s.name, city: s.city, country: s.country, rating: s.rating, lead_time_days: s.lead_time_days, on_time_rate: s.on_time_rate, price: x.price } : null; }).filter(Boolean);
  if (!rows.length) return [];
  const ps = rows.map(r => r.price), ls = rows.map(r => r.lead_time_days), pmin = Math.min(...ps), pmax = Math.max(...ps), lmin = Math.min(...ls), lmax = Math.max(...ls);
  rows.forEach(r => { const pS = pmax > pmin ? 1 - (r.price - pmin) / (pmax - pmin) : 1, lS = lmax > lmin ? 1 - (r.lead_time_days - lmin) / (lmax - lmin) : 1; r.score = r1(100 * (0.40 * pS + 0.25 * (r.rating / 5) + 0.20 * r.on_time_rate + 0.15 * lS)); });
  return rows.sort((a, b) => b.score - a.score);
};
P.period = (a, b, extra) => P.totals({ ...(extra || {}), date_from: a, date_to: b });
const DIMS = { region: x => x.so.region, category: x => x.p.category, channel: x => x.so.channel, segment: x => x.c.segment, product: x => x.p.name, customer: x => x.c.name };
P.breakdown = (dim, a, b, metric = "revenue", extra) => {
  const out = {}, k = DIMS[dim];
  for (const x of P.salesRows({ ...(extra || {}), date_from: a, date_to: b })) { const key = k(x); out[key] = (out[key] || 0) + (metric === "revenue" ? x.so.amount : metric === "orders" ? 1 : x.so.qty); }
  return out;
};
function shipJoin() { const sm = idx("sales_orders"); return DB.shipments.map(s => ({ s, so: sm.get(s.sales_order_id) })); }
P.drivers = (a, b, metric = "revenue", extra, prevOverride = null) => {
  const [pf, pt] = prevOverride || P.prev(a, b), out = { period: [a, b], previous: [pf, pt], dims: {} };
  const cur = P.period(a, b, extra), prev = P.period(pf, pt, extra);
  out.current = cur; out.previous_totals = prev; out.change_pct = P.pct(cur[metric], prev[metric]);
  for (const dim of ["region", "category", "channel", "product"]) {
    if (extra && extra[dim]) continue;
    const c = P.breakdown(dim, a, b, metric, extra), p = P.breakdown(dim, pf, pt, metric, extra);
    out.dims[dim] = [...new Set([...Object.keys(c), ...Object.keys(p)])].map(k => ({ key: k, current: r2(c[k] || 0), previous: r2(p[k] || 0), delta: r2((c[k] || 0) - (p[k] || 0)), pct: P.pct(c[k] || 0, p[k] || 0) })).sort((x, y) => x.delta - y.delta);
  }
  const reg = extra?.region, sj = shipJoin();
  const ds = (x, y) => { const rs = sj.filter(({ s, so }) => so && so.order_date >= x && so.order_date <= y && (!reg || s.destination === reg)); return rs.length ? { avg_delay: sum(rs, r => r.s.delay_days) / rs.length, late_rate: rs.filter(r => r.s.delay_days > 0).length / rs.length } : { avg_delay: null, late_rate: null }; };
  out.delays = { current: ds(a, b), previous: ds(pf, pt) };
  if (reg) { const by = {}; for (const { s, so } of sj) if (so && so.order_date >= a && so.order_date <= b && s.destination === reg) { const o = by[s.carrier] = by[s.carrier] || { carrier: s.carrier, n: 0, t: 0 }; o.n++; o.t += s.delay_days; }
    out.carriers = Object.values(by).map(o => ({ carrier: o.carrier, n: o.n, avg_delay: o.t / o.n })).sort((x, y) => y.avg_delay - x.avg_delay); }
  const cr = (x, y) => { const rs = DB.sales_orders.filter(r => r.order_date >= x && r.order_date <= y && (!reg || r.region === reg)); return rs.length ? rs.filter(r => r.status === "Cancelled").length / rs.length : 0; };
  out.cancel_rate = { current: cr(a, b), previous: cr(pf, pt) };
  out.out_of_stock = P.productRows().filter(r => r.stock_status === "Out of Stock").map(r => r.name);
  return out;
};
const inrS = v => { v = v || 0; return Math.abs(v) >= 1e7 ? `₹${(v / 1e7).toFixed(2)} Cr` : Math.abs(v) >= 1e5 ? `₹${(v / 1e5).toFixed(2)} L` : "₹" + Math.round(v).toLocaleString("en-IN"); };
P.insights = (limit = 4) => {
  const T = today(), lastEnd = D.add(D.ms(T), -1), lastStart = D.ms(lastEnd), baseStart = D.addM(lastStart, -3), baseEnd = D.add(lastStart, -1), out = [];
  const mname = `${MON[D.m(lastStart) - 1]} ${D.y(lastStart)}`;
  for (const dim of ["region", "category"]) {
    const cur = P.breakdown(dim, lastStart, lastEnd), base = P.breakdown(dim, baseStart, baseEnd);
    for (const k of new Set([...Object.keys(cur), ...Object.keys(base)])) { const avg = (base[k] || 0) / 3; if (avg <= 0) continue; out.push({ dim, key: k, pct: r1(((cur[k] || 0) - avg) / avg * 100), current: Math.round(cur[k] || 0), baseline: Math.round(avg) }); }
  }
  out.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  const res = [];
  for (const x of out) { if (Math.abs(x.pct) < 8 || res.length >= limit - 1) continue; const up = x.pct > 0;
    res.push({ title: `${x.key} ${x.dim === "region" ? "revenue" : "sales"} ${up ? "up" : "down"} ${Math.abs(x.pct).toFixed(0)}%`, body: `${mname}: ${inrS(x.current)} vs 3-month average ${inrS(x.baseline)}`, tone: up ? "good" : "bad",
      ask: x.dim === "region" ? `why did revenue ${up ? "increase" : "drop"} in ${x.key} last month` : `why did ${x.key} revenue ${up ? "increase" : "drop"} last month` }); }
  const late = (a, b) => { const r = DB.shipments.filter(s => s.ship_date >= a && s.ship_date <= b); return r.length ? { late: r.filter(s => s.delay_days > 0).length * 100 / r.length, d: sum(r, s => s.delay_days) / r.length } : null; };
  const sh = late(lastStart, lastEnd), shb = late(baseStart, baseEnd);
  if (sh && shb && sh.late > shb.late * 1.3) res.push({ title: `Late shipments ${sh.late.toFixed(0)}% (was ${shb.late.toFixed(0)}%)`, body: `${mname} vs previous 3 months · avg delay ${sh.d.toFixed(1)} d`, tone: "bad", ask: "which carrier has the most delays last month" });
  const so = P.stockout(7); if (so.length) res.push({ title: `${so.length} items out within 7 days`, body: so.slice(0, 3).map(r => r.name).join(", "), tone: "warn", ask: "products likely to run out in 7 days and create purchase orders" });
  return res.slice(0, limit);
};
P.top = (kind, n = 5, a, b, metric = "revenue", asc = false, extra) => {
  [a, b] = P.drange({ date_from: a, date_to: b });
  if (kind === "suppliers") {
    const rows = live("suppliers").map(s => ({ code: s.code, name: s.name, rating: s.rating, on_time_rate: s.on_time_rate, spend: r2(sum(DB.purchase_orders.filter(p => p.supplier_id === s.id && p.order_date >= a && p.order_date <= b && p.status !== "Cancelled"), p => p.amount)) }));
    const k = metric === "rating" ? "rating" : "spend"; return rows.sort((x, y) => asc ? x[k] - y[k] : y[k] - x[k]).slice(0, n);
  }
  const dim = { products: "product", customers: "customer", regions: "region", categories: "category", channels: "channel", segments: "segment" }[kind] || "product";
  const bd = P.breakdown(dim, a, b, metric, extra);
  return Object.entries(bd).map(([k, v]) => ({ name: k, [metric]: r2(v) })).sort((x, y) => asc ? x[metric] - y[metric] : y[metric] - x[metric]).slice(0, n);
};

const PCACHE = new Map();
P.data = (pid, f = {}, sort = null) => {
  f = Object.fromEntries(Object.entries(f || {}).filter(([, v]) => v != null && v !== "" && v !== "All"));
  const fn = PF[pid]; if (!fn) throw NotFound("Unknown page");
  const key = JSON.stringify([pid, Object.entries(f).sort(), sort, VER - agentWrites, today()]);
  if (!["activity", "data", "approvals", "evaluation", "review"].includes(pid) && PCACHE.has(key)) return structuredClone(PCACHE.get(key));
  const d = fn(f, sort); d.page = pid; d.filters = f;
  if (!["activity", "data", "approvals", "evaluation", "review"].includes(pid)) { PCACHE.set(key, structuredClone(d)); if (PCACHE.size > 64) PCACHE.delete(PCACHE.keys().next().value); }
  return d;
};
const PF = {
  dashboard(f, sort) {
    const [a, b] = P.drange(f), [pf, pt] = P.prev(a, b), cur = P.totals(f), prev = P.totals({ ...f, date_from: pf, date_to: pt });
    const pr = P.productRows(), inv = sum(pr, r => r.stock_value), sup = live("suppliers").length, ms = P.monthly(f);
    const supIn = (x, y) => new Set(DB.purchase_orders.filter(p => p.order_date >= x && p.order_date <= y).map(p => p.supplier_id)).size;
    const st = { "In Stock": 0, "Low Stock": 0, "Out of Stock": 0 }; pr.forEach(r => st[r.stock_status]++);
    const low = P.sort(pr.filter(r => r.stock_status !== "In Stock"), sort, "days_left:asc"), pend = DB.change_requests.filter(r => r.status === "Pending").length;
    const recent = live("purchase_orders").sort((x, y) => x.order_date === y.order_date ? y.id - x.id : (x.order_date < y.order_date ? 1 : -1)).slice(0, 6)
      .map(p => ({ id: p.id, po_no: p.po_no, supplier: byId("suppliers", p.supplier_id)?.name, product: byId("products", p.product_id)?.name, status: p.status, amount: p.amount, order_date: p.order_date }));
    const shp = DB.shipments.filter(s => s.status === "Delivered" && s.ship_date >= a && s.ship_date <= b && (!f.region || s.destination === f.region));
    const ok = shp.filter(s => s.delay_days === 0).length;
    const exm = {}; live("expenses").filter(e => e.date >= a && e.date <= b).forEach(e => exm[e.category] = (exm[e.category] || 0) + e.amount);
    const exp = Object.entries(exm).sort((x, y) => y[1] - x[1]);
    const tp = {}; for (const x of P.salesRows(f)) { const o = tp[x.p.id] = tp[x.p.id] || { name: x.p.name, sku: x.p.sku, units: 0, revenue: 0 }; o.units += x.so.qty; o.revenue += x.so.amount; }
    return { layout: "dashboard",
      kpis: [{ ...kpi("kpi_revenue", "Total Revenue", cur.revenue, "inr", P.pct(cur.revenue, prev.revenue)), icon: "revenue", tone: "green" }, { ...kpi("kpi_orders", "Total Orders", cur.orders, "int", P.pct(cur.orders, prev.orders)), icon: "cart", tone: "blue" },
        { ...kpi("kpi_inventory", "Inventory Value", inv, "inr", null, `${pr.length} SKUs · ${pr.filter(r => r.stock_status !== "In Stock").length} need attention`), icon: "box", tone: "violet" },
        { ...kpi("kpi_suppliers", "Active Suppliers", sup, "int", P.pct(supIn(a, b), supIn(pf, pt)), `${pend} approvals pending`), icon: "users", tone: "sky" }],
      charts: [{ id: "chart_trend", title: "Revenue & Orders Trend", type: "line", labels: ms.map(m => mlabel(m.m)), datasets: [{ label: "Revenue (₹)", data: ms.map(m => m.revenue) }, { label: "Orders", data: ms.map(m => m.orders), axis: "y1" }] },
        { id: "chart_inventory_status", title: "Inventory Status", type: "doughnut", labels: Object.keys(st), datasets: [{ label: "Items", data: Object.values(st) }] }],
      table: { id: "grid_low_stock", title: "Low Stock Alerts", entity: "products", columns: [col("sku", "SKU"), col("name", "Product"), col("stock", "Current Stock", "int"), col("reorder_level", "Reorder Level", "int"), col("days_left", "Days Left", "days"), col("stock_status", "Status", "status")], rows: low, total: low.length },
      extra: { recent_pos: recent, fulfillment: { rate: r1(ok * 100 / (shp.length || 1)), total: shp.length, on_time: ok, late: shp.length - ok },
        expenses: { total: sum(exp, e => e[1]), items: exp.map(([l, v]) => ({ label: l, value: Math.round(v) })) },
        top_products: Object.values(tp).sort((x, y) => y.revenue - x.revenue).slice(0, 6), inventory_total: pr.length, pending: pend, insights: P.insights() } };
  },
  review(f, sort) {
    const all = [...DB.agent_reviews].sort((a, b) => b.id - a.id); let rows = all.map(r => ({ ...r, confidence_pct: r.confidence == null ? null : Math.round(r.confidence * 100) }));
    if (f.status) rows = rows.filter(r => r.status === f.status); if (f.source) rows = rows.filter(r => r.source === f.source); if (sort) rows = P.sort(rows, sort);
    const n = st => all.filter(r => r.status === st).length, ok = n("Correct"), bad = n("Wrong"), rated = DB.agent_log.filter(r => r.feedback), up = rated.filter(r => r.feedback === "up").length, by = {};
    all.forEach(r => { const k = `${r.source === "user" ? "User flag" : "Auto"} · ${r.status}`; by[k] = (by[k] || 0) + 1; });
    return { kpis: [kpi("kpi_open", "Open", n("Open"), "int", null, "awaiting admin"), kpi("kpi_reviewed", "Reviewed", ok + bad), kpi("kpi_human_acc", "Human-verified accuracy", ok + bad ? r1(100 * ok / (ok + bad)) : null, "pct", null, `${ok} correct · ${bad} wrong`),
        kpi("kpi_helpful", "Helpful votes", rated.length ? r1(100 * up / rated.length) : null, "pct", null, `${rated.length} rated answers`)],
      charts: [{ id: "chart_review", title: "Review queue by source and outcome", type: "bar", horizontal: true, labels: Object.keys(by), datasets: [{ label: "Answers", data: Object.values(by) }] }],
      table: { id: "grid_reviews", title: "Review queue", entity: "agent_reviews", columns: [col("id", "#", "int"), col("ts", "Time"), col("username", "User"), col("query", "Question"), col("answer", "Agent answer"), col("intent", "Intent"), col("confidence_pct", "Conf. %", "int"), col("source", "Source"), col("reason", "Why queued"), col("status", "Status", "status"), col("reviewer", "Reviewer"), col("verdict_note", "Reviewer note")], rows, total: rows.length } };
  },
  stack() {
    const rows = M.STACK.map(r => ({ ...r }));
    return { layout: "stack", kpis: [kpi("kpi_layers", "Layers", rows.length), kpi("kpi_tables", "Tables", TABLES.length), kpi("kpi_pages", "Pages", M.PAGES.length), kpi("kpi_cost", "Licence cost", "₹0", "text", null, "all open source / free tiers")],
      charts: [], pipeline: M.PIPELINE, hitl: M.HITL, table: { id: "stack_layers", title: "Layers", entity: null, columns: [col("layer", "Layer"), col("tech", "Technology"), col("where", "Where in code"), col("why", "Why")], rows, total: rows.length } };
  },
  evaluation() {
    const res = EVAL.last;
    const out = { layout: "eval", results: res, targets: M.EVAL_TARGETS, kpis: [], charts: [] };
    if (res) { const k = res.kpis; out.kpis = [kpi("kpi_dest", "Intent → destination", k["Intent-to-destination accuracy"], "pct"), kpi("kpi_ui", "UI-state correctness", k["UI-state correctness (filters, dates, sort)"], "pct"),
      kpi("kpi_multi", "Multi-step success", k["Multi-step task success"], "pct"), kpi("kpi_p95", "Latency p95 (ms)", k["Latency p95 (ms)"], "num"), kpi("kpi_invalid", "Invalid actions executed", k["Invalid actions executed"], "int", null, `${res.tests} tests · ${res.ran_at}`)]; }
    return out;
  },
  data() {
    const cat = DSX.catalog(), kd = DSX.kpiDictionary(), so = cat.find(t => t.table === "sales_orders");
    const rows = cat.map(t => ({ table: t.table, description: t.description, rows: t.rows, columns: t.columns.length, from: t.span ? t.span[0] : null, to: t.span ? t.span[1] : null, page: t.page }));
    return { layout: "data", catalog: cat,
      kpis: [kpi("kpi_tables", "Tables", cat.length), kpi("kpi_rows", "Total Rows", sum(cat, t => t.rows)), kpi("kpi_span", "Sales Data Coverage", `${so.span[0]} → ${so.span[1]}`, "text"), kpi("kpi_kpis", "KPIs Defined", kd.length)],
      charts: [{ id: "chart_rows", title: "Rows per table", type: "bar", labels: rows.map(r => r.table), datasets: [{ label: "Rows", data: rows.map(r => r.rows) }] }],
      table: { id: "grid_tables", title: "Tables", entity: null, columns: [col("table", "Table"), col("description", "Description"), col("rows", "Rows", "int"), col("columns", "Columns", "int"), col("from", "From", "date"), col("to", "To", "date"), col("page", "Page")], rows, total: rows.length },
      table2: { id: "grid_kpis", title: "KPI Dictionary", entity: null, columns: [col("kpi", "KPI"), col("value", "Current Value", "auto"), col("window", "Window"), col("formula", "Formula"), col("page", "Page")], rows: kd, total: kd.length } };
  },
  inventory(f, sort) {
    let rows = P.productRows(); for (const k of ["category", "stock_status", "warehouse"]) if (f[k]) rows = rows.filter(r => r[k] === f[k]);
    if (f.q) { const s = f.q.toLowerCase(); rows = rows.filter(r => r.name.toLowerCase().includes(s) || r.sku.toLowerCase().includes(s)); }
    const bc = {}; rows.forEach(r => bc[r.category] = (bc[r.category] || 0) + r.stock_value); rows = P.sort(rows, sort, "days_left:asc");
    return { kpis: [kpi("kpi_items", "Total Items", rows.length), kpi("kpi_value", "Stock Value", sum(rows, r => r.stock_value), "inr"), kpi("kpi_low", "Low Stock", rows.filter(r => r.stock_status === "Low Stock").length), kpi("kpi_out", "Out of Stock", rows.filter(r => r.stock_status === "Out of Stock").length)],
      charts: [{ id: "chart_value_by_cat", title: "Stock Value by Category", type: "bar", labels: Object.keys(bc), datasets: [{ label: "Stock value (₹)", data: Object.values(bc).map(Math.round) }] }],
      table: { id: "grid_products", title: "Products", entity: "products", columns: [col("sku", "SKU"), col("name", "Product"), col("category", "Category"), col("stock", "Stock", "int"), col("reorder_level", "Reorder", "int"), col("daily_demand", "Daily Demand", "num"), col("days_left", "Days Left", "days"), col("unit_price", "Price", "inr"), col("stock_value", "Stock Value", "inr"), col("warehouse", "Warehouse"), col("stock_status", "Status", "status")], rows, total: rows.length } };
  },
  suppliers(f, sort) {
    const since = D.add(today(), -365);
    let rows = live("suppliers").map(s => ({ ...s, products: DB.supplier_products.filter(x => x.supplier_id === s.id).length, spend_12m: r2(sum(DB.purchase_orders.filter(p => p.supplier_id === s.id && p.order_date >= since && p.status !== "Cancelled"), p => p.amount)) }));
    if (f.category) rows = rows.filter(r => r.category === f.category); if (f.min_rating) rows = rows.filter(r => r.rating >= +f.min_rating);
    if (f.q) { const s = f.q.toLowerCase(); rows = rows.filter(r => r.name.toLowerCase().includes(s) || (r.city || "").toLowerCase().includes(s)); }
    rows.forEach(r => r.on_time_pct = r1(r.on_time_rate * 100)); rows = P.sort(rows, sort, "rating:desc"); const n = rows.length || 1;
    return { kpis: [kpi("kpi_active", "Active Suppliers", rows.length), kpi("kpi_rating", "Avg Rating", r2(sum(rows, r => r.rating) / n), "num"), kpi("kpi_ontime", "Avg On-time", r1(sum(rows, r => r.on_time_pct) / n), "pct"), kpi("kpi_spend", "Spend (12m)", sum(rows, r => r.spend_12m), "inr")],
      charts: [{ id: "chart_ontime", title: "On-time Delivery by Supplier", type: "bar", labels: rows.map(r => r.name), datasets: [{ label: "On-time %", data: rows.map(r => r.on_time_pct) }] }],
      table: { id: "grid_suppliers", title: "Suppliers", entity: "suppliers", columns: [col("code", "Code"), col("name", "Supplier"), col("category", "Category"), col("city", "City"), col("rating", "Rating", "num"), col("lead_time_days", "Lead (d)", "int"), col("on_time_pct", "On-time %", "pct"), col("products", "Products", "int"), col("spend_12m", "Spend 12m", "inr")], rows, total: rows.length } };
  },
  procurement(f, sort) {
    const [a, b] = P.drange(f, f.q ? 3650 : 365), sup = (f.supplier || "").toLowerCase(), qq = (f.q || "").toLowerCase();
    let rows = live("purchase_orders").filter(p => p.order_date >= a && p.order_date <= b && (!f.status || p.status === f.status)).map(p => { const s = byId("suppliers", p.supplier_id), pr = byId("products", p.product_id); return { ...p, supplier: s?.name, product: pr?.name, sku: pr?.sku }; })
      .filter(r => (!sup || (r.supplier || "").toLowerCase().includes(sup)) && (!qq || [r.po_no, r.product, r.supplier].some(x => String(x || "").toLowerCase().includes(qq))));
    rows = P.sort(rows, sort, "order_date:desc"); const sp = {}; rows.forEach(r => { if (r.status !== "Cancelled") sp[r.order_date.slice(0, 7)] = (sp[r.order_date.slice(0, 7)] || 0) + r.amount; }); const ms = P.months(a, b);
    return { kpis: [kpi("kpi_spend", "PO Spend", sum(rows.filter(r => r.status !== "Cancelled"), r => r.amount), "inr"), kpi("kpi_open", "Open POs", rows.filter(r => ["Pending", "Approved"].includes(r.status)).length), kpi("kpi_draft", "Drafts", rows.filter(r => r.status === "Draft").length), kpi("kpi_count", "Total POs", rows.length)],
      charts: [{ id: "chart_spend", title: "Monthly Purchase Spend", type: "bar", labels: ms.map(mlabel), datasets: [{ label: "Spend (₹)", data: ms.map(m => Math.round(sp[m] || 0)) }] }],
      table: { id: "grid_pos", title: "Purchase Orders", entity: "purchase_orders", columns: [col("po_no", "PO #"), col("supplier", "Supplier"), col("product", "Product"), col("qty", "Qty", "int"), col("unit_cost", "Unit Cost", "inr"), col("amount", "Amount", "inr"), col("status", "Status", "status"), col("order_date", "Date", "date"), col("expected_date", "Expected", "date")], rows: rows.slice(0, 400), total: rows.length } };
  },
  sales(f, sort) {
    const cur = P.totals(f), [a, b] = P.drange(f), [pf, pt] = P.prev(a, b), prev = P.totals({ ...f, date_from: pf, date_to: pt });
    let rows = P.salesRows(f).map(({ so, p, c }) => ({ id: so.id, order_no: so.order_no, customer: c.name, product: p.name, category: p.category, qty: so.qty, unit_price: so.unit_price, amount: so.amount, region: so.region, channel: so.channel, status: so.status, order_date: so.order_date }));
    rows = P.sort(rows, sort, "order_date:desc");
    const all = DB.sales_orders.filter(r => r.order_date >= a && r.order_date <= b && (!f.region || r.region === f.region)), cn = all.filter(r => r.status === "Cancelled").length, ms = P.monthly(f);
    return { kpis: [kpi("kpi_revenue", "Revenue", cur.revenue, "inr", P.pct(cur.revenue, prev.revenue)), kpi("kpi_orders", "Orders", cur.orders, "int", P.pct(cur.orders, prev.orders)), kpi("kpi_aov", "Avg Order Value", cur.orders ? cur.revenue / cur.orders : 0, "inr"), kpi("kpi_cancel", "Cancel Rate", r1(cn * 100 / (all.length || 1)), "pct")],
      charts: [{ id: "chart_monthly", title: "Monthly Revenue", type: "bar", labels: ms.map(m => mlabel(m.m)), datasets: [{ label: "Revenue (₹)", data: ms.map(m => m.revenue) }] }],
      table: { id: "grid_orders", title: "Orders", entity: "sales_orders", columns: [col("order_no", "Order #"), col("customer", "Customer"), col("product", "Product"), col("qty", "Qty", "int"), col("amount", "Amount", "inr"), col("region", "Region"), col("channel", "Channel"), col("status", "Status", "status"), col("order_date", "Date", "date")], rows: rows.slice(0, 400), total: rows.length } };
  },
  customers(f, sort) {
    const agg = {}; for (const so of DB.sales_orders) { const o = agg[so.customer_id] = agg[so.customer_id] || { revenue: 0, orders: 0, last: "" }; if (so.status !== "Cancelled") o.revenue += so.amount; o.orders++; if (so.order_date > o.last) o.last = so.order_date; }
    let rows = live("customers").map(c => ({ ...c, revenue: r2(agg[c.id]?.revenue || 0), orders: agg[c.id]?.orders || 0, last_order: agg[c.id]?.last || null }));
    for (const k of ["region", "segment"]) if (f[k]) rows = rows.filter(r => r[k] === f[k]);
    if (f.q) { const s = f.q.toLowerCase(); rows = rows.filter(r => r.name.toLowerCase().includes(s) || (r.city || "").toLowerCase().includes(s)); }
    rows = P.sort(rows, sort, "revenue:desc"); const cut = D.add(today(), -90), seg = {}; rows.forEach(r => seg[r.segment] = (seg[r.segment] || 0) + r.revenue);
    return { kpis: [kpi("kpi_customers", "Customers", rows.length), kpi("kpi_active", "Active (90d)", rows.filter(r => (r.last_order || "") >= cut).length), kpi("kpi_ltv", "Avg Lifetime Revenue", sum(rows, r => r.revenue) / (rows.length || 1), "inr")],
      charts: [{ id: "chart_segment", title: "Revenue by Segment", type: "doughnut", labels: Object.keys(seg), datasets: [{ label: "Revenue", data: Object.values(seg).map(Math.round) }] }],
      table: { id: "grid_customers", title: "Customers", entity: "customers", columns: [col("code", "Code"), col("name", "Customer"), col("segment", "Segment"), col("city", "City"), col("region", "Region"), col("orders", "Orders", "int"), col("revenue", "Revenue", "inr"), col("last_order", "Last Order", "date")], rows, total: rows.length } };
  },
  logistics(f, sort) {
    const [a, b] = P.drange(f, 90);
    let rows = shipJoin().filter(({ s }) => !s.is_deleted && s.ship_date >= a && s.ship_date <= b && (!f.status || s.status === f.status) && (!f.carrier || s.carrier === f.carrier) && (!f.region || s.destination === f.region)).map(({ s, so }) => ({ ...s, order_no: so?.order_no }));
    rows = P.sort(rows, sort, "ship_date:desc"); const n = rows.length || 1, reg = {}, car = {};
    rows.forEach(r => { (reg[r.destination] = reg[r.destination] || []).push(r.delay_days); (car[r.carrier] = car[r.carrier] || []).push(r.delay_days); });
    const avg = xs => xs.length ? r2(sum(xs) / xs.length) : 0;
    return { kpis: [kpi("kpi_ontime", "On-time %", r1(rows.filter(r => r.delay_days === 0).length * 100 / n), "pct"), kpi("kpi_delayed", "Delayed", rows.filter(r => r.delay_days > 0).length), kpi("kpi_transit", "In Transit", rows.filter(r => r.status === "In Transit").length), kpi("kpi_avg", "Avg Delay (days)", avg(rows.map(r => r.delay_days)), "num")],
      charts: [{ id: "chart_delay_region", title: "Avg Delay by Region (days)", type: "bar", labels: Object.keys(reg), datasets: [{ label: "Avg delay", data: Object.values(reg).map(avg) }] },
        { id: "chart_delay_carrier", title: "Avg Delay by Carrier (days)", type: "bar", labels: Object.keys(car), datasets: [{ label: "Avg delay", data: Object.values(car).map(avg) }] }],
      table: { id: "grid_shipments", title: "Shipments", entity: "shipments", columns: [col("shipment_no", "Shipment"), col("order_no", "Order"), col("carrier", "Carrier"), col("origin", "Origin"), col("destination", "Destination"), col("ship_date", "Shipped", "date"), col("eta", "ETA", "date"), col("delay_days", "Delay (d)", "int"), col("status", "Status", "status")], rows: rows.slice(0, 400), total: rows.length } };
  },
  finance(f, sort) {
    const [a, b] = P.drange(f), [pf, pt] = P.prev(a, b), cur = P.totals({ date_from: a, date_to: b }), prev = P.totals({ date_from: pf, date_to: pt });
    const ex = live("expenses").filter(e => !f.category || e.category === f.category);
    const exr = ex.filter(e => e.date >= a && e.date <= b), prevOpex = sum(ex.filter(e => e.date >= pf && e.date <= pt), e => e.amount), opex = sum(exr, e => e.amount);
    const bc = {}, bm = {}; exr.forEach(e => { bc[e.category] = (bc[e.category] || 0) + e.amount; bm[e.date.slice(0, 7)] = (bm[e.date.slice(0, 7)] || 0) + e.amount; });
    const mr = {}; for (const x of P.salesRows({ date_from: a, date_to: b })) { const m = x.so.order_date.slice(0, 7), o = mr[m] = mr[m] || { rev: 0, cogs: 0 }; o.rev += x.so.amount; o.cogs += x.so.qty * x.p.cost_price; }
    const table = P.months(a, b).map(m => { const rv = mr[m]?.rev || 0, cg = mr[m]?.cogs || 0, op = bm[m] || 0; return { month: mlabel(m), revenue: Math.round(rv), cogs: Math.round(cg), opex: Math.round(op), gross_margin_pct: rv ? r1((rv - cg) * 100 / rv) : 0, net_profit: Math.round(rv - cg - op) }; });
    const gm = cur.revenue - cur.cogs, net = gm - opex, pnet = prev.revenue - prev.cogs - prevOpex;
    return { kpis: [kpi("kpi_revenue", "Revenue", cur.revenue, "inr", P.pct(cur.revenue, prev.revenue)), kpi("kpi_cogs", "COGS", cur.cogs, "inr"), kpi("kpi_opex", "Operating Expenses", opex, "inr", P.pct(opex, prevOpex)), kpi("kpi_margin", "Gross Margin", cur.revenue ? r1(gm * 100 / cur.revenue) : 0, "pct"), kpi("kpi_profit", "Net Profit", net, "inr", P.pct(net, pnet))],
      charts: [{ id: "chart_pl", title: "Revenue vs Costs", type: "line", labels: table.map(t => t.month), datasets: [{ label: "Revenue", data: table.map(t => t.revenue) }, { label: "COGS + Opex", data: table.map(t => t.cogs + t.opex) }, { label: "Net Profit", data: table.map(t => t.net_profit) }] },
        { id: "chart_expense", title: "Expense Breakdown", type: "doughnut", labels: Object.keys(bc), datasets: [{ label: "₹", data: Object.values(bc).map(Math.round) }] }],
      table: { id: "grid_pl", title: "Monthly P&L", entity: null, columns: [col("month", "Month"), col("revenue", "Revenue", "inr"), col("cogs", "COGS", "inr"), col("opex", "Opex", "inr"), col("gross_margin_pct", "Gross Margin", "pct"), col("net_profit", "Net Profit", "inr")], rows: sort ? P.sort(table, sort) : table, total: table.length } };
  },
  analytics(f, sort) {
    const [a, b] = P.drange(f), [pf, pt] = P.prev(a, b), metric = f.metric || "revenue", group = f.group_by || "region";
    const extra = {}; for (const k of ["region", "category", "channel"]) if (f[k] && k !== group) extra[k] = f[k];
    const c = P.breakdown(group, a, b, metric, extra), p = P.breakdown(group, pf, pt, metric, extra);
    let rows = [...new Set([...Object.keys(c), ...Object.keys(p)])].map(k => ({ name: k, current: r2(c[k] || 0), previous: r2(p[k] || 0), change: r2((c[k] || 0) - (p[k] || 0)), growth_pct: P.pct(c[k] || 0, p[k] || 0) }));
    const tot = sum(rows, r => r.current) || 1; rows.forEach(r => r.share_pct = r1(r.current * 100 / tot)); rows = P.sort(rows, sort, "current:desc");
    const ms = P.monthly({ date_from: a, date_to: b, ...extra }), fmt = metric === "revenue" ? "inr" : "int", tc = sum(Object.values(c)), tp = sum(Object.values(p));
    const T = s => s[0].toUpperCase() + s.slice(1);
    return { kpis: [kpi("kpi_current", `${T(metric)} (period)`, tc, fmt, P.pct(tc, tp)), kpi("kpi_previous", "Previous period", tp, fmt), kpi("kpi_groups", group === "category" ? "Categories" : `${T(group)}s`, rows.length)],
      charts: [{ id: "chart_breakdown", title: `${T(metric)} by ${group}: current vs previous`, type: "bar", labels: rows.slice(0, 15).map(r => r.name), datasets: [{ label: "Current", data: rows.slice(0, 15).map(r => r.current) }, { label: "Previous", data: rows.slice(0, 15).map(r => r.previous) }] },
        { id: "chart_trend", title: `Monthly ${metric}`, type: "line", labels: ms.map(m => mlabel(m.m)), datasets: [{ label: T(metric), data: ms.map(m => m[metric]) }] }],
      table: { id: "grid_breakdown", title: `Breakdown by ${group}`, entity: null, columns: [col("name", T(group)), col("current", "Current", fmt), col("previous", "Previous", fmt), col("change", "Change", fmt), col("growth_pct", "Growth", "pct"), col("share_pct", "Share", "pct")], rows, total: rows.length } };
  },
  approvals(f, sort) {
    let rows = [...DB.change_requests].sort((a, b) => b.id - a.id).map(r => { const ch = JSON.parse(r.changes || "{}"); return { ...r, summary: r.action === "delete" ? "Delete record" : Object.entries(ch).map(([k, v]) => `${k}: ${v.old} → ${v.new}`).join(", ") }; });
    const cnt = s => DB.change_requests.filter(r => r.status === s).length;
    if (f.status) rows = rows.filter(r => r.status === f.status); if (sort) rows = P.sort(rows, sort);
    return { kpis: [kpi("kpi_pending", "Pending", cnt("Pending")), kpi("kpi_approved", "Approved", cnt("Approved")), kpi("kpi_auto", "Auto-approved by policy", DB.change_requests.filter(r => r.reviewed_by === "auto-policy").length), kpi("kpi_rejected", "Rejected", cnt("Rejected"))], charts: [],
      table: { id: "grid_requests", title: "Change Requests", entity: "change_requests", columns: [col("id", "#", "int"), col("record_label", "Record"), col("action", "Action"), col("summary", "Change"), col("reason", "Reason"), col("requested_by", "By"), col("status", "Status", "status"), col("reviewed_by", "Reviewer"), col("review_note", "Decision note"), col("created_at", "Created", "date")], rows, total: rows.length } };
  },
  activity() {
    const au = [...DB.audit_log].reverse().slice(0, 300), ag = [...DB.agent_log].reverse().slice(0, 300), lat = ag.map(r => r.latency_ms).sort((a, b) => a - b);
    const p95 = lat.length ? lat[Math.max(0, Math.ceil(lat.length * 0.95) - 1)] : 0;
    return { kpis: [kpi("kpi_queries", "Agent Queries", ag.length), kpi("kpi_latency", "Avg Latency (ms)", lat.length ? r1(sum(lat) / lat.length) : 0, "num"), kpi("kpi_p95", "p95 Latency (ms)", r1(p95), "num"), kpi("kpi_changes", "Data Changes", au.length)], charts: [],
      table: { id: "grid_audit", title: "Audit Log", entity: null, columns: [col("ts", "Time"), col("username", "User"), col("action", "Action"), col("entity", "Entity"), col("record_label", "Record"), col("details", "Details"), col("via", "Via")], rows: au, total: au.length },
      table2: { id: "grid_agent", title: "Agent Log", entity: null, columns: [col("ts", "Time"), col("username", "User"), col("query", "Query"), col("intent", "Intent"), col("page", "Page"), col("latency_ms", "Latency ms", "num"), col("used_llm", "LLM", "int")], rows: ag, total: ag.length } };
  },
};

/* ================= retrieval (TF-IDF + synonyms + trigrams) ================= */
const SYN = { vendor: "supplier", vendors: "supplier", suppliers: "supplier", sourcing: "supplier", stock: "inventory", stocks: "inventory", item: "product", items: "product", products: "product", sku: "product", material: "product", materials: "product",
  po: "purchase", pos: "purchase", buy: "purchase", buying: "purchase", replenish: "purchase", purchases: "purchase", sale: "sales", selling: "sales", sold: "sales", booking: "sales", bookings: "sales", order: "orders",
  client: "customer", clients: "customer", customers: "customer", buyer: "customer", buyers: "customer", account: "customer", accounts: "customer", shipment: "logistics", shipments: "logistics", delivery: "logistics", deliveries: "logistics", carrier: "logistics", carriers: "logistics",
  transit: "logistics", dispatch: "logistics", late: "delayed", delay: "delayed", delays: "delayed", profit: "finance", loss: "finance", "p&l": "finance", pnl: "finance", expense: "finance", expenses: "finance", cost: "finance", costs: "finance", margin: "finance", cogs: "finance", money: "finance", cash: "finance",
  approve: "approval", approvals: "approval", requests: "request", audit: "activity", log: "activity", logs: "activity", history: "activity", home: "dashboard", overview: "dashboard", summary: "dashboard", kpis: "kpi",
  analysis: "analytics", analyze: "analytics", analyse: "analytics", breakdown: "analytics", insights: "analytics", report: "analytics", reports: "analytics", income: "revenue", turnover: "revenue" };
const STOP = new Set("a an the of for to in on at by with and or is are was were be me my our show open go take please can you i want see view display list all get what which this that from into about".split(" "));
const KEEP_S = new Set(["sales", "logistics", "analytics", "orders", "status"]);
function tok(t) { return ((t || "").toLowerCase().match(/[a-z0-9&]+/g) || []).filter(w => !STOP.has(w)).map(w => { let x = SYN[w] || w; if (x.endsWith("s") && x.length > 4 && !KEEP_S.has(x)) x = x.slice(0, -1); return x; }); }
function trig(s) { s = `  ${String(s).toLowerCase()} `; const o = new Set(); for (let i = 0; i < s.length - 2; i++) o.add(s.slice(i, i + 3)); return o; }
const counter = a => { const c = {}; a.forEach(x => c[x] = (c[x] || 0) + 1); return c; };
const R = {
  build() {
    const docs = [];
    for (const p of M.PAGES) {
      docs.push({ kind: "page", id: p.id, name: p.title, page: p.id, boost: 1, text: [p.title, p.title, p.id, p.description, p.keywords, p.widgets.map(w => w[2]).join(" "), p.filters.map(f => f.label).join(" ")].join(" ") });
      p.widgets.forEach(w => docs.push({ kind: "widget", id: `${p.id}.${w[0]}`, name: w[2], page: p.id, boost: 0.8, text: `${w[2]} ${w[1]} ${p.title}` }));
    }
    M.APIS.forEach(a => docs.push({ kind: "api", id: a.name, name: a.name, page: null, boost: 1, text: `${a.name.replace(/_/g, " ")} ${a.description}` }));
    live("products").forEach(r => docs.push({ kind: "products", id: r.id, name: r.name, code: r.sku, page: "inventory", boost: 1.1, text: `${r.name} ${r.sku} ${r.category} product` }));
    live("suppliers").forEach(r => docs.push({ kind: "suppliers", id: r.id, name: r.name, code: r.code, page: "suppliers", boost: 1.1, text: `${r.name} ${r.code} ${r.city} ${r.category} supplier` }));
    live("customers").forEach(r => docs.push({ kind: "customers", id: r.id, name: r.name, code: r.code, page: "customers", boost: 1, text: `${r.name} ${r.code} ${r.city} ${r.region} customer` }));
    const tf = docs.map(d => counter(tok(d.text))), df = {}; tf.forEach(t => Object.keys(t).forEach(w => df[w] = (df[w] || 0) + 1));
    const n = docs.length, idf = Object.fromEntries(Object.entries(df).map(([w, c]) => [w, Math.log((n + 1) / (c + 0.5)) + 1]));
    const vec = t => { const v = {}; for (const [w, c] of Object.entries(t)) v[w] = (1 + Math.log(c)) * (idf[w] || 1); const nm = Math.sqrt(sum(Object.values(v), x => x * x)) || 1; for (const w in v) v[w] /= nm; return v; };
    R.I = { docs, idf, vec, vecs: tf.map(vec), tri: docs.map(d => trig(d.name || "")) };
  },
  search(text, k = 5, kinds = null) {
    if (!R.I) R.build(); const I = R.I, qv = I.vec(counter(tok(text))), qt = trig(text), out = [];
    I.docs.forEach((d, i) => {
      if (kinds && !kinds.includes(d.kind)) return;
      let s = 0; for (const w in qv) s += qv[w] * (I.vecs[i][w] || 0);
      if (I.tri[i].size && d.kind !== "page" && d.kind !== "api") { let inter = 0; qt.forEach(g => { if (I.tri[i].has(g)) inter++; }); const r = inter / I.tri[i].size; s = Math.max(s, r > 0.55 ? r * 0.9 : 0); }
      s *= d.boost; if (s > 0) out.push({ ...d, score: Math.round(s * 1000) / 1000 });
    });
    return out.sort((a, b) => b.score - a.score).slice(0, k).map(({ text, ...rest }) => rest);
  },
  pages: (t, k = 3) => R.search(t, k, ["page"]),
};

/* ================= NLU ================= */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const REGION_ALIAS = { karnataka: "Karnataka", bangalore: "Karnataka", bengaluru: "Karnataka", mysore: "Karnataka", mysuru: "Karnataka", maharashtra: "Maharashtra", mumbai: "Maharashtra", pune: "Maharashtra", nagpur: "Maharashtra",
  delhi: "Delhi", ncr: "Delhi", "tamil nadu": "Tamil Nadu", tamilnadu: "Tamil Nadu", chennai: "Tamil Nadu", tn: "Tamil Nadu", gujarat: "Gujarat", ahmedabad: "Gujarat", surat: "Gujarat", telangana: "Telangana", hyderabad: "Telangana",
  "west bengal": "West Bengal", kolkata: "West Bengal", bengal: "West Bengal" };
const NUMWORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30 };
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (t, re) => re.test(t);
const GENERIC = new Set(("supplier suppliers supplies supply vendor vendors product products item items customer customers client clients order orders sales stock price rating show open find compare best top industries enterprises solutions traders works systems corp manufacturing engineering parts gear co ltd inc pvt the for with and from").split(" "));
const STATUS_WORDS = {
  sales_orders: { delivered: "Delivered", cancelled: "Cancelled", canceled: "Cancelled", processing: "Processing", shipped: "Shipped", returned: "Returned", returns: "Returned" },
  purchase_orders: { draft: "Draft", drafts: "Draft", pending: "Pending", approved: "Approved", received: "Received", cancelled: "Cancelled", canceled: "Cancelled" },
  shipments: { delayed: "Delayed", late: "Delayed", "in transit": "In Transit", transit: "In Transit", delivered: "Delivered", pending: "Pending" },
  change_requests: { pending: "Pending", approved: "Approved", rejected: "Rejected" },
  products: { "out of stock": "Out of Stock", "low stock": "Low Stock", "in stock": "In Stock" },
};
function similarity(a, b) { // SequenceMatcher-like ratio via LCS
  const m = a.length, n = b.length; if (!m || !n) return 0; const dp = Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) { let prev = 0; for (let j = 1; j <= n; j++) { const tmp = dp[j]; dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]); prev = tmp; } }
  return 2 * dp[n] / (m + n);
}
const NLU = {
  cache: {}, invalidate() { NLU.cache = {}; },
  norm(text) { let t = text.toLowerCase(); for (const [w, n] of Object.entries(NUMWORDS)) t = t.replace(new RegExp(`\\b${w}\\b`, "g"), String(n)); return t; },
  period(t) {
    const T = today(); let m;
    if ((m = t.match(/\b(?:last|past|previous|prior)\s+(\d+)\s*(day|week|month|year|quarter)s?\b/))) { const n = +m[1], u = m[2], days = { day: 1, week: 7, month: 30.44, quarter: 91.3, year: 365 }[u] * n; return [D.add(T, -(Math.trunc(days) - 1)), T, `last ${n} ${u}s`]; }
    if (/\btoday\b/.test(t)) return [T, T, "today"];
    if (/\byesterday\b/.test(t)) { const y = D.add(T, -1); return [y, y, "yesterday"]; }
    if (/\b(this|current) week\b/.test(t)) return [D.add(T, -D.wd(T)), T, "this week"];
    if (/\b(last|previous) week\b/.test(t)) { const s = D.add(T, -D.wd(T) - 7); return [s, D.add(s, 6), "last week"]; }
    if (/\b(this|current) month\b|\bmtd\b/.test(t)) return [D.ms(T), T, "this month"];
    if (/\b(last|previous|prior) month\b/.test(t)) { const s = D.addM(T, -1); return [s, D.me(s), "last month"]; }
    if (/\b(this|current) quarter\b|\bqtd\b/.test(t)) return [D.qs(T), T, "this quarter"];
    if (/\b(last|previous|prior) quarter\b/.test(t)) { const s = D.addM(D.qs(T), -3); return [s, D.add(D.qs(T), -1), "last quarter"]; }
    if (/\b(this|current) year\b|\bytd\b|year to date/.test(t)) return [D.mk(D.y(T), 1, 1), T, "this year"];
    if (/\b(last|previous|prior) year\b/.test(t)) return [D.mk(D.y(T) - 1, 1, 1), D.mk(D.y(T) - 1, 12, 31), "last year"];
    if ((m = t.match(/\bq([1-4])\s*(?:fy)?\s*(20\d\d)?\b/))) { const y = +(m[2] || D.y(T)); let s = D.mk(y, 3 * (+m[1] - 1) + 1, 1); if (s > T && !m[2]) s = D.mk(y - 1, D.m(s), 1); return [s, D.me(D.addM(s, 2)), `Q${m[1]} ${D.y(s)}`]; }
    if ((m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:uary|ruary|ch|il|e|y|ust|t|tember|ember|ober)?\.?\s*(20\d\d)?\b/)) && !/\bmay (i|we|you)\b/.test(t)) {
      const y = m[2] ? +m[2] : D.y(T); let s = D.mk(y, MONTHS[m[1]], 1); if (s > T && !m[2]) s = D.mk(y - 1, D.m(s), 1); return [s, D.min(D.me(s), T), `${MON[D.m(s) - 1]} ${D.y(s)}`];
    }
    if ((m = t.match(/\b(20\d\d)\b/))) { const y = +m[1]; return [D.mk(y, 1, 1), D.min(D.mk(y, 12, 31), T), String(y)]; }
    return null;
  },
  periods(t) {
    let parts = t.split(/\bvs\.?(?=\s|$)|\bversus\b|\bcompared (?:to|with)\b|\bagainst\b/);
    if (parts.length < 2 && /\bwith\b/.test(t)) { const i = t.search(/\bwith\b/), w = [t.slice(0, i), t.slice(i + 4)]; if (NLU.period(w[0]) && NLU.period(w[1])) parts = w; }
    if (parts.length >= 2) { const a = NLU.period(parts[0]), b = NLU.period(parts[1]); if (a && !b && /\b(previous|prior|last)\b/.test(parts[1])) return [a]; return [a, b].filter(Boolean); }
    const m = t.match(/\b(this|last) (month|quarter|year|week) and (this|last) (month|quarter|year|week)\b/);
    if (m) return [NLU.period(`${m[1]} ${m[2]}`), NLU.period(`${m[3]} ${m[4]}`)];
    const p = NLU.period(t); return p ? [p] : [];
  },
  region(t) { for (const k of Object.keys(REGION_ALIAS).sort((a, b) => b.length - a.length)) if (new RegExp(`\\b${reEsc(k)}\\b`).test(t)) return REGION_ALIAS[k]; return null; },
  option(t, opts) { for (const o of [...opts].sort((a, b) => b.length - a.length)) if (new RegExp(`\\b${reEsc(o.toLowerCase())}\\b`).test(t)) return o; return null; },
  category(t) { const c = NLU.option(t, M.CATEGORIES); if (c) return c; for (const [k, v] of Object.entries({ "raw material": "Raw Materials", raw: "Raw Materials", electric: "Electrical", electronic: "Electrical", component: "Components", packing: "Packaging", packag: "Packaging", chemical: "Chemicals", safety: "Safety", ppe: "Safety" })) if (t.includes(k)) return v; return null; },
  status(t, e) { const W = STATUS_WORDS[e] || {}; for (const k of Object.keys(W).sort((a, b) => b.length - a.length)) if (new RegExp(`\\b${k}\\b`).test(t)) return W[k]; return null; },
  names(table, code) { return NLU.cache[table] = NLU.cache[table] || live(table).map(r => ({ id: r.id, code: r[code], name: r.name })); },
  entityName(t, table, code) {
    const rows = NLU.names(table, code);
    for (const r of rows) if (new RegExp(`\\b${reEsc(String(r.code).toLowerCase())}\\b`).test(t)) return r;
    const words = new Set((t.match(/[a-z0-9]+/g) || []).filter(w => !GENERIC.has(w))); let best = null, score = 0;
    for (const r of rows) {
      const nw = (r.name.toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => !["ltd", "co", "inc", "pvt", "the"].includes(w)); if (!nw.length) continue;
      let hit = 0; for (const w of nw) if (words.has(w) || [...words].some(x => x.length > 3 && similarity(w, x) > 0.85)) hit++;
      const s = hit / nw.length + (t.includes(r.name.toLowerCase()) ? 0.3 : 0);
      if (hit && s > score) { best = r; score = s; }
    }
    return score >= 0.5 ? best : null;
  },
  product: t => NLU.entityName(t, "products", "sku"), supplier: t => NLU.entityName(t, "suppliers", "code"), customer: t => NLU.entityName(t, "customers", "code"),
  numbers: t => [...t.matchAll(/(?<![\w-])(\d[\d,]*\.?\d*)(?![\w-])/g)].map(m => parseFloat(m[1].replace(/,/g, ""))),
  code(t) { const m = t.match(/\b(po|so|shp|sup|cust|exp)-?\s?(\d{1,5})\b/i); if (!m) return null; const p = m[1].toUpperCase(); const e = { PO: "purchase_orders", SO: "sales_orders", SHP: "shipments", SUP: "suppliers", CUST: "customers", EXP: "expenses" }[p]; const w = { SUP: 3, CUST: 4 }[p] || 5; return [e, `${p}-${String(+m[2]).padStart(w, "0")}`]; },
  sort(t) { const m = t.match(/sort(?:ed)? by ([a-z _]+?)(?: (asc|ascending|desc|descending|high to low|low to high))?$/); if (!m) return null; return [m[1].trim().replace(/ /g, "_"), (m[2] || "").startsWith("asc") || (m[2] || "").startsWith("low") ? "asc" : "desc"]; },
};

/* ================= dataset: catalog, KPI dictionary, browser, SQL (sql.js) ================= */
const DATE_COLS = { sales_orders: "order_date", purchase_orders: "order_date", shipments: "ship_date", expenses: "date", change_requests: "created_at", audit_log: "ts", agent_log: "ts" };
const HIDDEN = new Set(["password", "password_hash"]);
const DSX = {
  cols(t) { const keys = []; for (const r of DB[t].slice(0, 60)) for (const k of Object.keys(r)) if (!keys.includes(k) && !HIDDEN.has(k)) keys.push(k); const docs = (M.TABLE_DOCS[t] || [])[2] || {}; Object.keys(docs).forEach(k => { if (!keys.includes(k) && !HIDDEN.has(k)) keys.push(k); }); return keys; },
  catalog() {
    return Object.entries(M.TABLE_DOCS).map(([t, [desc, page, docs]]) => {
      const rows = DB[t] || [], dc = DATE_COLS[t]; let span = null;
      if (dc && rows.length) { let a = null, b = null; for (const r of rows) { const v = String(r[dc] || "").slice(0, 10); if (!v) continue; if (!a || v < a) a = v; if (!b || v > b) b = v; } span = [a, b]; }
      return { table: t, description: desc, page, rows: rows.length, span, columns: DSX.cols(t).map(c => { const v = rows.find(r => r[c] != null)?.[c]; return { name: c, type: typeof v === "number" ? (Number.isInteger(v) ? "INTEGER" : "REAL") : "TEXT", pk: c === "id", description: c === "id" ? "Row id" : (docs[c] || "") }; }) };
    });
  },
  kpiValues() {
    const T = today(), y0 = D.add(T, -364), d90 = D.add(T, -89), s12 = P.totals({ date_from: y0, date_to: T }), pr = P.productRows();
    const sh = DB.shipments.filter(x => x.ship_date >= d90), allo = DB.sales_orders.filter(x => x.order_date >= y0), sups = live("suppliers");
    const pos = live("purchase_orders").filter(p => p.order_date >= y0), appr = DB.change_requests, lat = DB.agent_log.map(r => r.latency_ms).sort((a, b) => a - b);
    const vel = pr.filter(r => r.days_left != null).map(r => r.days_left).sort((a, b) => a - b), opex = sum(live("expenses").filter(e => e.date >= y0), e => e.amount);
    const act = new Set(DB.sales_orders.filter(x => x.order_date >= d90 && x.status !== "Cancelled").map(x => x.customer_id)).size, approved = appr.filter(r => r.status === "Approved").length;
    return { revenue: ["inr", s12.revenue], orders: ["int", s12.orders], aov: ["inr", s12.revenue / (s12.orders || 1)], cancel_rate: ["pct", allo.filter(x => x.status === "Cancelled").length * 100 / (allo.length || 1)],
      units: ["int", s12.units], inventory_value: ["inr", sum(pr, r => r.stock_value)], low_stock: ["int", pr.filter(r => r.stock_status === "Low Stock").length], out_of_stock: ["int", pr.filter(r => r.stock_status === "Out of Stock").length],
      days_cover: ["days", vel.length ? vel[Math.floor(vel.length / 2)] : 0], suppliers: ["int", sups.length], rating: ["num", sum(sups, x => x.rating) / (sups.length || 1)], supplier_ontime: ["pct", sum(sups, x => x.on_time_rate) * 100 / (sups.length || 1)],
      po_spend: ["inr", sum(pos.filter(p => p.status !== "Cancelled"), p => p.amount)], open_pos: ["int", pos.filter(p => ["Pending", "Approved"].includes(p.status)).length], fulfillment: ["pct", sh.filter(x => x.delay_days === 0).length * 100 / (sh.length || 1)],
      delayed: ["int", sh.filter(x => x.delay_days > 0).length], avg_delay: ["num", sum(sh, x => x.delay_days) / (sh.length || 1)], cogs: ["inr", s12.cogs], opex: ["inr", opex], gross_margin: ["pct", (s12.revenue - s12.cogs) * 100 / (s12.revenue || 1)],
      net_profit: ["inr", s12.revenue - s12.cogs - opex], active_customers: ["int", act], pending: ["int", appr.filter(r => r.status === "Pending").length], auto_rate: ["pct", appr.filter(r => r.reviewed_by === "auto-policy").length * 100 / (approved || 1)],
      agent_p95: ["num", lat.length ? lat[Math.max(0, Math.trunc(lat.length * 0.95) - 1)] : 0] };
  },
  kpiDictionary() {
    const v = DSX.kpiValues(), W12 = ["revenue", "orders", "aov", "cancel_rate", "units", "po_spend", "cogs", "opex", "gross_margin", "net_profit"], W90 = ["fulfillment", "delayed", "avg_delay", "active_customers"];
    return M.KPI_DICTIONARY.map(([n, p, f, k]) => ({ kpi: n, page: p, formula: f, value: v[k][1], fmt: v[k][0], window: W12.includes(k) ? "last 12 months" : W90.includes(k) ? "last 90 days" : "current" }));
  },
  browse(t, q = "", offset = 0, limit = 50, sort = null) {
    if (!M.TABLE_DOCS[t]) throw Bad("Unknown table");
    const cols = DSX.cols(t); let rows = DB[t]; const qq = (q || "").toLowerCase();
    if (qq) rows = rows.filter(r => cols.some(c => String(r[c] ?? "").toLowerCase().includes(qq)));
    rows = sort ? P.sort(rows, sort) : [...rows].sort((a, b) => (b.id || 0) - (a.id || 0));
    return { table: t, columns: cols, rows: rows.slice(+offset, +offset + Math.min(+limit, 200)).map(r => Object.fromEntries(cols.map(c => [c, r[c] ?? null]))), total: rows.length, offset: +offset };
  },
  sqldb: null, sqlVer: -1, ready: false, init: null,
  start() { if (DSX.init || typeof initSqlJs !== "function") return; DSX.init = initSqlJs().then(SQL => { DSX.SQL = SQL; DSX.ready = true; }).catch(e => console.warn("sql.js", e)); },
  build() {
    if (DSX.sqldb && DSX.sqlVer === VER) return DSX.sqldb;
    if (DSX.sqldb) DSX.sqldb.close();
    const db = new DSX.SQL.Database();
    db.run("BEGIN");
    for (const t of Object.keys(M.TABLE_DOCS)) {
      const cols = DSX.cols(t); db.run(`CREATE TABLE ${t} (${cols.map(c => `"${c}"`).join(",")})`);
      const st = db.prepare(`INSERT INTO ${t} VALUES (${cols.map(() => "?").join(",")})`);
      for (const r of DB[t]) st.run(cols.map(c => r[c] === undefined ? null : r[c])); st.free();
    }
    db.run("COMMIT"); DSX.sqldb = db; DSX.sqlVer = VER; return db;
  },
  sql(u, sql, limit = 500) {
    if (!["admin", "manager"].includes(u.role)) throw Denied("SQL console is for admin and manager roles. You can browse tables instead.");
    sql = (sql || "").trim().replace(/;\s*$/, "").trim();
    if (!/^(select|with)\b/i.test(sql) || sql.includes(";")) throw Bad("Read-only console: one SELECT (or WITH … SELECT) statement.");
    if (!DSX.ready) throw Bad("SQL engine is still loading. Try again in a second.");
    const t0 = performance.now(), db = DSX.build();
    let res; try { res = db.exec(sql); } catch (e) { throw Bad("SQL error: " + e.message); }
    const r = res[0] || { columns: [], values: [] };
    return { columns: r.columns, rows: r.values.slice(0, limit).map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))), truncated: r.values.length > limit, ms: r1(performance.now() - t0) };
  },
};

/* ================= auto spelling correction ================= */
const SPELL = {
  V: null,
  words: t => (String(t || "").toLowerCase().match(/[a-z]+/g) || []),
  build() {
    const w = {}; const add = (x, n) => { for (const k of SPELL.words(x)) if (k.length >= 3) w[k] = (w[k] || 0) + n; };
    M.SPELL_DOMAIN.forEach(x => add(x, 5));
    M.PAGES.forEach(p => { add([p.title, p.keywords, p.description, p.widgets.map(x => x[2]).join(" "), p.filters.map(f => f.label).join(" ")].join(" "), 2); p.filters.forEach(f => (f.options || []).forEach(o => add(o, 2))); });
    Object.values(ENT).forEach(e => add(e.label + " " + e.fields.map(f => f.label).join(" "), 1));
    Object.values(IEX).forEach(xs => xs.forEach(t => add(t, 1))); Object.keys(INORM).forEach(k => add(k, 1));
    ["products", "suppliers", "customers"].forEach(t => live(t).forEach(r => add(r.name, 3))); live("customers").forEach(r => add(r.city, 2));
    const bylen = {}; Object.keys(w).forEach(k => (bylen[k.length] = bylen[k.length] || []).push(k));
    SPELL.V = { vocab: w, bylen, known: new Set([...Object.keys(w), ...M.SPELL_COMMON, ...(M.SPELL_CODE || [])]) };
  },
  osa(a, b, maxd) {
    const la = a.length, lb = b.length; if (Math.abs(la - lb) > maxd) return maxd + 1;
    let prev2 = null, prev = [...Array(lb + 1).keys()];
    for (let i = 1; i <= la; i++) {
      const cur = [i]; let best = i;
      for (let j = 1; j <= lb; j++) {
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v; if (v < best) best = v;
      }
      if (best > maxd) return maxd + 1; prev2 = prev; prev = cur;
    }
    return prev[lb];
  },
  suggest(word) {
    const V = SPELL.V, maxd = word.length <= 5 ? 1 : 2; let best = null, bd = maxd + 1, tie = false;
    const key = x => [V.vocab[x], x[0] === word[0] ? 1 : 0];
    for (let L = word.length - maxd; L <= word.length + maxd; L++) for (const w of V.bylen[L] || []) {
      const d = SPELL.osa(word, w, maxd);
      if (d < bd) { best = w; bd = d; tie = false; }
      else if (d === bd && best) { const [a1, a2] = key(w), [b1, b2] = key(best); if (a1 > b1 || (a1 === b1 && a2 > b2)) { best = w; tie = false; } else if (a1 === b1 && a2 === b2) tie = true; }
    }
    return best == null || bd > maxd || (tie && bd === 2) ? null : best;
  },
  SHORT: { lst: "last", nxt: "next", prev: "previous", mnth: "month", mth: "month", mths: "months", qtr: "quarter", qtrs: "quarters", yr: "year", yrs: "years", pls: "please", plz: "please", wat: "what", wht: "what", shw: "show", sho: "show",
    rev: "revenue", inv: "inventory", amt: "amount", u: "you", ur: "your", r: "are", abt: "about", btw: "between", thru: "through", wk: "week", wks: "weeks", dlvry: "delivery", shpmt: "shipment", supp: "supplier", pdt: "product", prdt: "product", approv: "approve" },
  correct(text) {
    if (!SPELL.V) SPELL.build(); const fixes = [];
    text = text.replace(/(?<![\w@.-])[A-Za-z]{1,6}(?![\w@-])/g, w => { const r = SPELL.SHORT[w.toLowerCase()]; if (r && r !== w.toLowerCase()) { fixes.push([w, r]); return r; } return w; });
    text = text.replace(/(?<![\w@.-])[A-Za-z]+(?![\w@-])/g, w => {
      const lw = w.toLowerCase(); if (lw.length < 4 || SPELL.V.known.has(lw)) return w;
      for (const suf of ["s", "es", "ing", "ed", "ly"]) if (lw.endsWith(suf) && SPELL.V.known.has(lw.slice(0, -suf.length))) return w;
      const s = SPELL.suggest(lw); if (s && s !== lw) { fixes.push([w, s]); return s; } return w;
    });
    return [text, fixes];
  },
};

/* ================= stage-2 semantic intent classifier ================= */
const INORM = { short: "stockout", shortage: "stockout", finish: "stockout", finishing: "stockout", exhausted: "stockout", restock: "stockout", reorder: "stockout", reordering: "stockout", replenish: "stockout", runout: "stockout", depleted: "stockout", empty: "stockout",
  stuck: "delay", slow: "delay", late: "delay", delayed: "delay", delays: "delay", delay: "delay", overdue: "delay", behind: "delay",
  profitable: "profit", profit: "profit", profits: "profit", earn: "profit", earning: "profit", earnings: "profit", money: "profit", margin: "profit", margins: "profit", "p&l": "profit", pnl: "profit", bottom: "bottom", loss: "profit",
  spending: "expense", spend: "expense", expenses: "expense", costs: "expense", cost: "expense",
  trending: "trend", trend: "trend", trends: "trend", doing: "trend", performing: "perform", predict: "trend", forecast: "trend", projection: "trend", outlook: "trend", growth: "trend",
  fell: "drop", fall: "drop", falling: "drop", dropped: "drop", drop: "drop", dip: "drop", decline: "drop", declining: "drop", down: "drop", slump: "drop", why: "why", reason: "why", cause: "why", caused: "why", explain: "why", going: "going",
  against: "versus", vs: "versus", versus: "versus", compared: "versus", compare: "versus", mom: "versus", yoy: "versus",
  most: "top", best: "top", biggest: "top", largest: "top", highest: "top", top: "top", leading: "top", worst: "top", lowest: "top", least: "top", weakest: "top",
  sign: "approve", signoff: "approve", approve: "approve", approval: "approve", approvals: "approve", waiting: "pending", pending: "pending", awaiting: "pending", requests: "request", request: "request",
  vendor: "supplier", vendors: "supplier", suppliers: "supplier", supplier: "supplier", buy: "buy", source: "buy", purchase: "buy", cheapest: "cheap", cheaper: "cheap", cheap: "cheap",
  products: "product", items: "product", item: "product", clients: "customer", client: "customer", customers: "customer", regions: "region", states: "region",
  shipments: "shipment", deliveries: "shipment", delivery: "shipment", shipment: "shipment", orders: "order", screen: "page", seeing: "page", page: "page" };
const ISTOP = new Set("a an the of for to in on at by with and or is are was were be me my our we us i you it this that these those what which who how do does did any anything can could would should will please".split(" "));
const IEX = {
  stockout: ["what will run out of stock soon", "items at risk of stock out", "do we have enough stock for next two weeks", "which materials are nearly finished", "stock shortage risk", "products needing replenishment", "what should we reorder", "inventory running low forecast", "days of cover for products", "restock recommendations", "items close to zero stock"],
  delays: ["late shipments", "which carrier is delayed", "shipments behind schedule", "deliveries overdue", "slow carriers", "delay by destination", "where are deliveries getting stuck", "carrier performance delays", "orders not delivered on time"],
  finance: ["are we making money", "profit this year", "gross margin", "profit and loss", "how much did we earn", "expense breakdown", "where are we spending", "operating costs summary", "net profit last quarter", "cash position and margin"],
  trend: ["sales trend", "how are we performing", "revenue over time", "forecast revenue next month", "growth over the last year", "monthly performance", "how is revenue doing", "business outlook", "projection for sales"],
  why: ["why did revenue drop", "what caused sales to fall", "reason for the decline in orders", "sales down explain", "why is revenue lower", "what is going on with sales falling", "root cause of the dip"],
  expense_why: ["why are costs rising", "why did expenses increase", "reason for higher logistics cost", "spending went up why"],
  compare_periods: ["compare this month vs last month", "revenue versus last year", "how does this quarter compare to the previous", "year over year sales", "month over month orders", "compare periods", "this year against last year"],
  top: ["top selling products", "best customers by revenue", "highest revenue regions", "worst categories", "biggest accounts", "most sold items", "leading channels", "lowest performing products", "best vendors by rating", "rank customers"],
  compare_suppliers: ["best supplier for copper", "cheapest vendor for resin", "compare suppliers pricing", "where should we buy from", "which vendor to source from", "supplier comparison for a product", "recommend a vendor"],
  requests: ["pending approvals", "what needs my approval", "requests waiting for review", "change requests pending", "anything to approve", "my submitted requests"],
  current_page: ["what is on this page", "explain this screen", "summarize what i am looking at", "describe this view", "key points on this page"],
  help: ["what can you do", "help", "how do i use this", "show me commands", "capabilities"],
  navigate: ["open inventory", "show sales orders", "go to suppliers", "list customers in delhi", "orders in karnataka last month", "cancelled orders", "purchase orders draft", "show shipments in transit", "revenue breakdown by channel", "units by category", "open finance page", "suppliers with high rating", "show products", "sales for a region", "electrical products", "show the dashboard", "approval page", "activity log"],
};
const ITRIG = { stockout: "which items will run out in next 14 days ", delays: "show delayed shipments ", finance: "net profit ", trend: "revenue trend ", why: "why ", expense_why: "why did expense increase ", compare_periods: "compare ", compare_suppliers: "compare suppliers for ", requests: "show pending requests", current_page: "what is on this page", help: "help" };
function itok(text) { const ws = ((text || "").toLowerCase().match(/[a-z0-9&]+/g) || []).filter(w => !ISTOP.has(w)).map(w => INORM[w] || w); return [...ws, ...ws.slice(1).map((w, i) => `${ws[i]}_${w}`)]; }
const CLF = (() => {
  const unit = v => { const n = Math.sqrt(sum(Object.values(v), x => x * x)) || 1; const o = {}; for (const k in v) o[k] = v[k] / n; return o; };
  const docs = []; for (const [lab, xs] of Object.entries(IEX)) for (const t of xs) docs.push([lab, counter(itok(t))]);
  const df = {}; docs.forEach(([, c]) => Object.keys(c).forEach(w => df[w] = (df[w] || 0) + 1));
  const n = docs.length, idf = {}; for (const [w, c] of Object.entries(df)) idf[w] = Math.log((n + 1) / (c + 0.5)) + 1;
  const vec = c => { const v = {}; for (const [w, x] of Object.entries(c)) v[w] = (1 + Math.log(x)) * (idf[w] || 0.5); return unit(v); };
  const cent = {}; for (const [lab, c] of docs) { const v = vec(c), o = cent[lab] = cent[lab] || {}; for (const w in v) o[w] = (o[w] || 0) + v[w]; }
  for (const k in cent) cent[k] = unit(cent[k]);
  return { predict(text) { const q = vec(counter(itok(text))); const sc = Object.entries(cent).map(([lab, c]) => [Object.keys(q).reduce((s, w) => s + q[w] * (c[w] || 0), 0), lab]).sort((a, b) => b[0] - a[0]);
    return { intent: sc[0][1], score: Math.round(sc[0][0] * 1000) / 1000, margin: Math.round((sc[0][0] - sc[1][0]) * 1000) / 1000 }; } };
})();
function irewrite(intent, t) {
  if (intent === "top") {
    const kinds = [[/customer|client|account/, "customers"], [/supplier|vendor/, "suppliers"], [/region|state/, "regions"], [/categor/, "categories"], [/channel/, "channels"], [/segment/, "segments"]];
    const kind = (kinds.find(([re]) => re.test(t)) || [0, "products"])[1], word = /\b(worst|lowest|least|weakest|bottom)\b/.test(t) ? "bottom" : "top", n = t.match(/\b(\d+)\b/);
    return `${word} ${n ? n[1] : 5} ${kind} ${t}`;
  }
  return ITRIG[intent] + (["requests", "current_page", "help"].includes(intent) ? "" : t);
}

/* ================= agent ================= */
const PENDING = {};
function inr(v) { v = v || 0; const a = Math.abs(v); if (a >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`; if (a >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`; return "₹" + Math.round(v).toLocaleString("en-IN"); }
const money2 = v => "₹" + Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtv(v, f) { if (v == null) return "—"; if (f === "inr") return inr(v); if (f === "pct") return `${v.toFixed(1)}%`; if (f === "int") return Math.trunc(v).toLocaleString("en-IN"); if (f === "num") return String(r2(v)); if (f === "days") return `${v.toFixed(1)} d`; return String(v); }
const sign = p => p == null ? "—" : (p >= 0 ? `+${p.toFixed(1)}%` : `${p.toFixed(1)}%`);
const Title = s => s.replace(/\b\w/g, c => c.toUpperCase());
const step = text => ({ t: "step", text }), say = text => ({ t: "text", text });
const nav = (page, filters, sort = null, highlight = null) => ({ t: "action", action: "navigate", page, filters: Object.fromEntries(Object.entries(filters || {}).filter(([, v]) => v != null && v !== "")), sort, highlight });
const card = (type, kw) => ({ t: "card", card: { type, ...kw } });
const tableCard = (title, cols, rows, page = null, filters = null) => card("table", { title, columns: cols.map(([key, label, fmt]) => ({ key, label, fmt })), rows, page, filters });
const chartCard = (type, title, labels, datasets, opts = {}) => card("chart", { chart: { type, title, labels, datasets, ...opts } });
const sevColors = (vals, warn, bad, rev = false) => vals.map(v => { v = v || 0; const b = rev ? v >= bad : v <= bad, w = rev ? v >= warn : v <= warn; return b ? "#dc2626" : w ? "#f59e0b" : "#16a34a"; });
function pageChartCard(d, i = 0) {
  const c = (d.charts || [])[i]; if (!c) return null;
  const lbl = c.datasets.map(x => x.label).join(" "), money = /₹|revenue|spend|cogs|profit|value/i.test(lbl) || /revenue|spend|value|costs/i.test(c.title);
  return chartCard(c.type, c.title, c.labels, c.datasets, { fmt: money ? "inr" : /%/.test(c.title + lbl) ? "pct" : "num" });
}
function confirmCard(u, op, title, lines, button, danger = false, form = null) { const t = Math.random().toString(16).slice(2, 14); PENDING[t] = { user: u.username, op }; return card("confirm", { token: t, title, lines, button, danger, form }); }
const periodFilters = p => p && p.length ? { date_from: p[0][0], date_to: p[0][1] } : {};
function detectMetric(t) { if (/\bunits?\b|quantity|volume/.test(t)) return "units"; if (/\b(orders?|order count|number of orders)\b/.test(t) && !/revenue|sales value/.test(t)) return "orders"; return "revenue"; }
const PAGE_HINTS = [[/\bagent review|review queue|(open|flagged|pending) (answer )?reviews?\b|flagged answers?|human[- ]in[- ]the[- ]loop|\bhitl\b|human[- ]verified|low[- ]confidence answers?/, "review"],
  [/implementation stack|tech(nology)? stack|\barchitecture\b|\bbuilt with\b/, "stack"], [/\bpurchase orders?\b|\bpos?\b|procurement/, "procurement"], [/\bapprovals?\b|change requests?/, "approvals"], [/\baudit\b|agent activity|activity log/, "activity"],
  [/\bshipments?\b|logistics|carriers?|deliver(y|ies)\b|in transit|delayed/, "logistics"], [/\bprofit|p&l|finance|expenses?|margin|cogs|cash ?flow/, "finance"], [/\bcustomers?\b|clients?/, "customers"],
  [/\bsuppliers?\b|vendors?/, "suppliers"], [/\binventory|stock|warehouse|reorder|products?\b|items?\b/, "inventory"], [/\bsales\b|\borders?\b|revenue by month|cancelled|returned/, "sales"],
  [/\banalytics|analysis|breakdown|group by|by region|by channel|by category/, "analytics"],
  [/\bevaluation|benchmark|test results|kpi results|how accurate (are you|is the agent)|run (the )?(eval|tests)/, "evaluation"], [/\bdashboard|home|overview/, "dashboard"]];
function detectPage(t) { for (const [re, p] of PAGE_HINTS) if (re.test(t)) return [p, 0.95]; const h = R.pages(t, 1); return h.length && h[0].score > 0.12 ? [h[0].page, h[0].score] : [null, 0]; }
function buildFilters(page, t, periods) {
  const keys = new Set(PAGE[page].filters.map(f => f.key)), f = {};
  if (keys.has("date") && periods.length) Object.assign(f, periodFilters(periods));
  if (keys.has("region")) f.region = NLU.region(t);
  if (keys.has("category")) f.category = page === "finance" ? NLU.option(t, M.EXP_CATS) : NLU.category(t);
  if (keys.has("channel")) f.channel = NLU.option(t, M.CHANNELS);
  if (keys.has("segment")) f.segment = NLU.option(t, M.SEGMENTS);
  if (keys.has("carrier")) f.carrier = NLU.option(t, M.CARRIERS);
  if (keys.has("warehouse")) { const w = /warehouse|\bwh\b/.test(t) ? NLU.option(t, ["Bengaluru", "Mumbai", "Delhi"]) : null; f.warehouse = w ? `${w} WH` : null; }
  if (keys.has("status") || keys.has("stock_status")) { const e = { sales: "sales_orders", procurement: "purchase_orders", logistics: "shipments", approvals: "change_requests" }[page]; if (page === "inventory") f.stock_status = NLU.status(t, "products");
    else if (page === "review") { const m = t.match(/\b(open|pending|unreviewed|correct|wrong|incorrect)\b/); f.status = m ? { open: "Open", pending: "Open", unreviewed: "Open", correct: "Correct", wrong: "Wrong", incorrect: "Wrong" }[m[1]] : null;
      f.source = /flagged|by users?|thumbs/.test(t) ? "user" : /low[- ]confidence|auto/.test(t) ? "auto" : null; }
    else if (e) f.status = NLU.status(t, e); }
  if (keys.has("min_rating")) { const m = t.match(/rating (?:above|over|>=?|at least|more than)\s*(\d(?:\.\d)?)/); if (m) f.min_rating = m[1]; }
  if (keys.has("supplier")) { const s = NLU.supplier(t); f.supplier = s ? s.name : null; }
  if (keys.has("metric")) { f.metric = detectMetric(t); const g = t.match(/\bby (region|category|channel|segment|product)s?\b/); f.group_by = g ? g[1] : null; }
  if (keys.has("q")) { if (page === "inventory" || page === "sales") { const p = NLU.product(t); f.q = p ? p.name : null; } if (page === "customers") { const c = NLU.customer(t); f.q = c ? c.name : null; } if (page === "suppliers") { const s = NLU.supplier(t); f.q = s ? s.name : null; } }
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v));
}
function sortFor(page, t) {
  const s = NLU.sort(t);
  if (!s) {
    if (/highest|largest|most|top/.test(t)) { const c = { sales: "amount", procurement: "amount", customers: "revenue", suppliers: "rating", inventory: "stock_value", logistics: "delay_days" }[page]; return c ? `${c}:desc` : null; }
    if (/lowest|least|smallest/.test(t)) { const c = { sales: "amount", customers: "revenue", suppliers: "rating", inventory: "days_left" }[page]; return c ? `${c}:asc` : null; }
    return null;
  }
  const al = { amount: "amount", date: "order_date", price: "unit_price", rating: "rating", revenue: "revenue", stock: "stock", days_left: "days_left", delay: "delay_days", spend: "spend_12m" };
  return `${al[s[0]] || s[0]}:${s[1]}`;
}

const qs_ = v => "'" + String(v).replace(/'/g, "''") + "'";
function salesSql(a, b, metric = "revenue", extra = {}, group = null, limit = null) {
  const agg = { revenue: "ROUND(SUM(so.amount), 2) AS revenue", orders: "COUNT(*) AS orders", units: "SUM(so.qty) AS units" }[metric];
  const col = { region: "so.region", category: "p.category", channel: "so.channel", segment: "c.segment", product: "p.name", customer: "c.name" }[group];
  const w = ["so.status != 'Cancelled'", "so.is_deleted = 0", `so.order_date BETWEEN ${qs_(a)} AND ${qs_(b)}`];
  for (const [k, c] of [["region", "so.region"], ["category", "p.category"], ["channel", "so.channel"]]) if ((extra || {})[k]) w.push(`${c} = ${qs_(extra[k])}`);
  let sql = `SELECT ${col ? `${col} AS ${group}, ${agg}` : agg} FROM sales_orders so JOIN products p ON p.id = so.product_id JOIN customers c ON c.id = so.customer_id WHERE ${w.join(" AND ")}`;
  if (col) sql += ` GROUP BY ${col} ORDER BY ${metric} DESC`; if (limit) sql += ` LIMIT ${limit}`; return sql;
}
const sourcesCard = (items, note = null) => card("sources", { items: items.map(([label, sql]) => ({ label, sql })), note });
const refuse = (code, message, suggestions = []) => card("refusal", { code, message, suggestions });
const clarify = (question, options) => card("clarify", { question, options });
function pageExists(target) {
  const t = target.trim(); if (["this", "that", "the", "current", "previous", "last", "next", "same"].includes(t)) return true;
  if (PAGE_HINTS.some(([re]) => re.test(t))) return true; const h = R.pages(t, 1); return !!(h.length && h[0].score > 0.25);
}
const ACRONYMS = { aov: "average order value", cogs: "cogs", opex: "operating expenses", gm: "gross margin", p95: "agent p95 latency", otd: "order fulfillment rate", otif: "order fulfillment rate", dio: "days of cover" };
function kpiLookup(text) {
  text = text.toLowerCase().replace(/[?.]/g, "").trim().split(/\s+/).map(w => ACRONYMS[w] || w).join(" ");
  let best = null, score = 0; const tw = new Set(text.match(/[a-z0-9]+/g) || []);
  for (const k of M.KPI_DICTIONARY) { const n = k[0].toLowerCase(), words = (n.match(/[a-z0-9]+/g) || []).filter(w => !["of", "the", "rate"].includes(w));
    const sc = words.filter(w => tw.has(w)).length / (words.length || 1) + (n.includes(text) || text.includes(n) ? 1 : 0); if (sc > score) { best = k; score = sc; } }
  return score >= 0.6 ? best : null;
}
const UNKNOWN_PLACES = ["kerala", "punjab", "rajasthan", "goa", "bihar", "odisha", "orissa", "assam", "haryana", "uttar pradesh", "madhya pradesh", "andhra pradesh", "andhra", "jharkhand", "chhattisgarh", "uttarakhand", "himachal", "jammu", "kashmir", "lucknow", "jaipur", "kochi", "cochin", "bhopal", "patna", "indore", "chandigarh", "noida", "gurgaon", "gurugram", "vizag", "visakhapatnam", "bhubaneswar", "guwahati", "ranchi", "dehradun", "srinagar", "amritsar", "ludhiana", "trivandrum", "thiruvananthapuram", "usa", "europe", "china", "dubai", "london", "singapore"];
const ANALYTIC = new Set(["navigate", "why", "compare_periods", "top", "trend", "delays", "finance", "stockout"]);
let DATA_START = null; const dataStart = () => DATA_START || (DATA_START = DB.sales_orders.reduce((m, r) => r.order_date < m ? r.order_date : m, "9999"));
function validatePlan(plan) {
  if (!ANALYTIC.has(plan.intent)) return null; const t = plan.t;
  for (const p of UNKNOWN_PLACES) if (new RegExp(`\\b${p}\\b`).test(t) && !NLU.region(t)) return { intent: "refuse", t, slots: { code: "VALUE_NOT_ALLOWED", value: Title(p), periods: [] } };
  for (const [a, b, label] of plan.slots.periods || []) { if (b < dataStart() || a > today()) return { intent: "refuse", t, slots: { code: "DATE_OUT_OF_RANGE", value: label, periods: [] } }; if (a > b) return { intent: "refuse", t, slots: { code: "INVALID_DATE_RANGE", value: label, periods: [] } }; }
  return null;
}
const EXPLICIT_NAV = /^(open|go to|goto|take me to|navigate to|switch to|jump to|bring up|pull up|show me the \w+ page)\b/;
function route(query, useClf = true) { const p = routeCore(query, useClf); return validatePlan(p) || p; }
function routeCore(query, useClf = true) {
  const plan = routeRules(query);
  if (!useClf || !["navigate", "unknown"].includes(plan.intent) || EXPLICIT_NAV.test(plan.t)) return plan;
  const c = CLF.predict(plan.t);
  if (plan.intent === "navigate" && (Object.keys(buildFilters(plan.slots.page, plan.t, [])).length || NLU.region(plan.t)) && (/^(show|list|display|view|see)\b/.test(plan.t) || c.margin < 0.25)) return plan;
  if (c.intent !== "navigate" && c.score >= 0.25 && c.margin >= 0.04) { const p2 = routeRules(irewrite(c.intent, plan.t)); if (!["navigate", "unknown"].includes(p2.intent)) { p2.classified = c; return p2; } }
  return plan;
}
function routeRules(query) {
  const t = NLU.norm(query.trim()), periods = NLU.periods(t), base = { periods };
  const Rt = (intent, kw = {}) => ({ intent, t, slots: { ...base, ...kw } });
  let m;
  if (/ignore (all |any |your |previous |prior |the |these )*(rules|instructions|guardrails)|system prompt|jailbreak|developer mode|pretend (you|to be)|act as (an? )?(admin|root|developer)|bypass|disable (the )?(guard|safety|validator)/.test(t)) return Rt("refuse", { code: "PROMPT_INJECTION" });
  if (/\b(drop|truncate|alter)\s+table\b|\bdelete\s+from\b|\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bgrant\b.*\bto\b/.test(t)) return Rt("refuse", { code: "WRITE_NOT_ALLOWED" });
  if ((/\b(export|download|save|print|convert)\b.*\b(pdf|csv|summary|report|page|screen|chat|conversation|answer|this|it)\b|\b(to|as|in) (a )?(pdf|csv)\b/.test(t)) && !/\bsql\b/.test(t))
    return Rt("export", { fmt: /\b(csv|excel|spreadsheet)\b/.test(t) ? "csv" : "pdf", scope: /\b(chat|conversation|answers?|response)\b/.test(t) ? "chat" : "page" });
  if (/implementation stack|tech(nology)? stack|\barchitecture\b|how (is|was) (this|the app|bizpilot|it) (built|made|implemented)|what (technolog|tools|frameworks?)|built with|\bstack\b/.test(t) && !/\b(stock|inventory)\b/.test(t)) return Rt("stack");
  if (/^(thanks|thank you|thank u|thx|ty|ok|okay|k|great|cool|nice|awesome|perfect|good job|well done|bye|goodbye|good (morning|afternoon|evening|night))[!. ]*( (bizpilot|agent))?[!. ]*$/.test(t)) return Rt("smalltalk");
  if (/^(who|what) are you|your name|are you (an? )?(ai|bot|human)/.test(t)) return Rt("meta", { kind: "identity" });
  if (/what can('|no)?t you do|your limitations|what (are|is) (your|the) limit/.test(t)) return Rt("meta", { kind: "limits" });
  if (/(what|which) filters|filters (can|are) (i|available)|what can i filter/.test(t)) return Rt("meta", { kind: "filters" });
  if (/\bmy (role|permissions|access)\b|what can i (do|see|access|change)|am i (allowed|able)/.test(t)) return Rt("meta", { kind: "role" });
  if (/how did you (get|calculate|compute|find|arrive)|explain (your|the|that) (last )?(answer|number|result)|show (me )?(the )?(sql|sources?|query|trace|working)|where did (that|this|the) (number|data|figure)|how (was|is) (that|this) calculated|why should i trust/.test(t)) return Rt("explain_last");
  if ((m = t.match(/(?:what (?:does|is|do) (?:an? |the )?(.+?) (?:mean|stand for|measure)|(?:define|definition of|formula (?:for|of)|how is) (?:an? |the )?(.+?)(?: calculated| computed| defined)?)\??$/)) && !/\b(page|screen|on this|here|my role)\b/.test(t)) { const k = kpiLookup(m[1] || m[2]); if (k) return Rt("meta", { kind: "kpi", kpi: k }); }
  if ((m = t.match(/(explain|describe|what does|what is shown (in|on)|tell me about) (the |this )?(.+?) (chart|widget|graph|kpi|card|table|donut|panel)/))) return Rt("widget", { name: m[4] });
  if (/\b(insights?|anything (unusual|important|i should know)|what should i (know|look at)|highlights|anomal|red flags|what changed|agent noticed|any alerts)\b/.test(t)) return Rt("insights");
  if (/^(compare|sort( it| this)?|filter( it| this)?|show me the (report|data)|open (the )?report|the report|analy[sz]e|show data|report|open|show|chart|graph|plot)[?.! ]*$/.test(t)) return Rt("clarify", { what: t.split(" ")[0] });
  if ((m = t.match(/^(?:please )?(?:open|go to|goto|take me to|navigate to|switch to|show(?: me)?)\s+(?:the |my )?([a-z&][a-z& ]{1,30}?)\s+(page|screen|module|section|tab|portal|dashboard)\b/)) && !pageExists(m[1])) return Rt("refuse", { code: "PAGE_NOT_FOUND", target: m[1] });
  if ((m = query.match(/^\s*(?:sql\s*:?|run sql|query\s*:)\s*([\s\S]+)$/i) || query.match(/^\s*((?:select|with)\b[\s\S]+\bfrom\b[\s\S]+)$/i))) return Rt("sql", { sql: m[1].trim() });
  if (/\b(dataset|database|data ?base|schema|data dictionary|kpi (list|dictionary|definitions)|(list|show|all)( all)? (the )?kpis|what data|which tables|tables? (in|of) (the )?(db|data)|how many (rows|records))\b/.test(t)
    || /^how many (sales orders|orders|purchase orders|pos|shipments|customers|suppliers|products|expenses|change requests|users)\b/.test(t)) return Rt("dataset");
  if ((m = t.match(/^(?:please |pls |kindly |can you |could you )?(approve|accept|clear|reject)\b(?!.*\d)/)) && /\b(all|the|every|pending|these|those|them|everything|requests?)\b/.test(t) && !/\b(show|list|how many)\b/.test(t))
    return Rt("review_all", { decision: m[1] === "reject" ? "reject" : "approve" });
  if (/^(hi|hello|hey|help( me)?|what can (you|this agent|it|the agent) do\??|how can you help( me)?\??|hi there|menu|commands)[!. ]*$/.test(t)) return Rt("help");
  if (/(this|current) (page|screen|view)|where am i|what page|what am i (looking at|seeing)|(summary|overview) of (this|the) (screen|page)|explain (this|the) (page|screen)|summari[sz]e (this|the) (page|screen)|key information|what('s| is) (on|here)/.test(t)) return Rt("current_page");
  if (/^((go )?back|previous page|go to previous page|undo navigation)$/.test(t)) return Rt("go_back");
  if ((m = t.match(/\b(approve|reject|decline)\b.*?(?:request|cr|#)?\s*#?(\d+)\b/)) && !/\bshow|list\b/.test(t)) { const note = t.match(/\b(?:because|reason|note)\b:?\s*(.+)$/); return Rt("review", { decision: m[1] === "approve" ? "approve" : "reject", req_id: +m[2], note: note ? note[1] : "" }); }
  if (/(pending|my|awaiting)\s+(change\s+)?(requests?|approvals?)|requests? (pending|awaiting)|summari[sz]e .*requests|what needs (my )?approval|status of my request/.test(t)) return Rt("requests", { mine: /\bmy\b/.test(t) });
  const days = t.match(/(?:next|within|in)\s+(\d+)\s*days?/);
  const wantsPo = /\b(create|draft|raise|generate|prepare|make|place)\b.*\b(po|pos|purchase orders?)\b/.test(t) && !/^(show|list|view|display|open|see)\b/.test(t);
  if (/run(ning)? out|stock ?out|will (be )?out|likely to|days? of cover|forecast.*stock|replenish/.test(t) || (wantsPo && /low stock|out of stock|at risk|reorder/.test(t))) return Rt("stockout", { days: days ? +days[1] : 14, with_po: wantsPo, category: NLU.category(t) });
  if (wantsPo || /\b(new|raise a|create a|create an?)\s+(po|purchase order)\b/.test(t) || (/^(order|buy|procure|purchase)\s+\d+/.test(t) && NLU.product(t))) return Rt("create_po", { product: NLU.product(t), supplier: NLU.supplier(t) });
  if (/^(please )?(change|update|set|modify|edit|increase|decrease|raise|lower|reduce|mark|correct|bump|adjust|revise)\b/.test(t) && !/\b(filter|date range|sort)\b/.test(t)) return Rt("update");
  if (/^(please )?(delete|remove|deactivate|archive|get rid of|discard)\b/.test(t)) return Rt("delete");
  if ((m = t.match(/^(please )?(add|create|new|register|onboard)\s+(a |an |new )*(supplier|vendor|product|item|customer|client|expense)\b/))) return Rt("create", { entity: { supplier: "suppliers", vendor: "suppliers", product: "products", item: "products", customer: "customers", client: "customers", expense: "expenses" }[m[4]] });
  if (/(compare|best|cheapest|which|rank|recommend).*(suppliers?|vendors?)|(suppliers?|vendors?).*(pric|compare|cheapest|best)/.test(t) && !/\btop \d+ suppliers by (spend|rating)/.test(t)) { const n = t.match(/top (\d+)/); return Rt("compare_suppliers", { product: NLU.product(t), category: NLU.category(t), n: n ? +n[1] : 5 }); }
  if (/\b(why|reason|root cause|what caused|explain the (drop|dip|increase|decline|change)|what happened)\b/.test(t)) { if (/expense|cost|spend|logistics cost|opex/.test(t)) return Rt("expense_why", { category: NLU.option(t, M.EXP_CATS) }); return Rt("why", { metric: detectMetric(t), region: NLU.region(t), category: NLU.category(t) }); }
  if (/(\bvs\.?(?=\s|$)|\bversus\b|\bagainst\b|\bcompared (to|with)\b|\bcompare\b|\bmom\b|\byoy\b|month (over|on) month|year (over|on) year)/.test(t)) return Rt("compare_periods", { metric: detectMetric(t), region: NLU.region(t), category: NLU.category(t), channel: NLU.option(t, M.CHANNELS) });
  if ((m = t.match(/\b(top|bottom|best|worst|highest|lowest)\s*(\d+)?\s*(selling\s+)?(products?|items?|customers?|clients?|suppliers?|vendors?|regions?|states?|categories|category|channels?|segments?)/))) {
    const w = m[4] === "categories" ? "categorie" : m[4].replace(/s$/, "");
    const kind = { product: "products", item: "products", customer: "customers", client: "customers", supplier: "suppliers", vendor: "suppliers", region: "regions", state: "regions", categorie: "categories", category: "categories", channel: "channels", segment: "segments" }[w];
    const metric = /units?|quantity|volume/.test(t) ? "units" : /by orders|order count/.test(t) ? "orders" : t.includes("rating") ? "rating" : "revenue";
    return Rt("top", { kind, n: +(m[2] || 5), asc: ["bottom", "worst", "lowest"].includes(m[1]), metric, region: NLU.region(t), category: NLU.category(t) });
  }
  if (/\b(trend|analysis|analy[sz]e|forecast|growth|performance|how (are|is|did) (we|sales|revenue))\b/.test(t) && !/\b(open|go to|navigate)\b/.test(t)) { const g = t.match(/\bby (region|category|channel|segment|product)/); return Rt("trend", { metric: detectMetric(t), region: NLU.region(t), category: NLU.category(t), group: g ? g[1] : null }); }
  if (/\b(delay(ed|s)?|late)\b.*\b(shipments?|deliver|orders?|carriers?)|\b(shipments?|carriers?)\b.*\b(delay|late)|which carrier/.test(t)) return Rt("delays", { region: NLU.region(t), carrier: NLU.option(t, M.CARRIERS) });
  if (/\b(net profit|profit|margin|p&l|cash ?flow|expense breakdown|expenses?|cogs|how much (did we|we) (make|earn|spend))\b/.test(t) && !/\b(open|go to|navigate)\b/.test(t)) return Rt("finance");
  if (/^(find|search|look ?up|lookup|look for|locate)\b/.test(t) || (/^where is\b/.test(t) && (NLU.code(t) || NLU.product(t) || NLU.supplier(t) || NLU.customer(t)))) return Rt("search", { term: t.replace(/^(find|search( for)?|look ?up|lookup|look for|where is|locate)\s+/, "") });
  const [page, conf] = detectPage(t);
  if (page) return Rt("navigate", { page, conf });
  return Rt("unknown");
}

const H = {};
H.help = function* (ctx) {
  yield say(`**BizPilot Agent.** I navigate, filter, analyze and act across all 11 pages. Role: **${ctx.user.role}**.\n\n- Navigate: *open Karnataka sales last quarter*\n- Analyze: *why did revenue drop in Maharashtra?*\n- Forecast: *products likely to run out in 14 days*\n- Act: *create purchase order for 500 Steel Rod*, *change price of Copper Wire to 430*\n- Govern: *show pending requests*, *approve request 1*\n- Ask: *what is on this page?*`);
  yield card("chips", { items: (PAGE[ctx.page] || PAGE.dashboard).suggestions });
};
function summarizePage(page, filters) { return P.data(page, filters); }
H.current_page = function* (ctx) {
  yield step(`Reading page context \`${ctx.page}\``);
  const d = summarizePage(ctx.page, ctx.filters), meta = PAGE[ctx.page];
  yield step("Summarizing KPIs and grid");
  const kp = d.kpis.map(k => ({ label: k.label, value: fmtv(k.value, k.fmt), delta: k.delta })), tb = d.table || {}, ins = [];
  d.kpis.forEach(k => { if (k.delta != null && Math.abs(k.delta) >= 5) ins.push(`${k.label} ${k.delta > 0 ? "up" : "down"} ${Math.abs(k.delta).toFixed(1)}% vs previous period.`); });
  if (["dashboard", "inventory"].includes(ctx.page)) { const so = P.stockout(14); if (so.length) ins.push(`${so.length} items run out within 14 days; worst ${so[0].name} (${so[0].days_left} d).`); }
  if (ctx.page === "approvals") ins.push(`${(tb.rows || []).filter(r => r.status === "Pending").length} requests pending admin review.`);
  const fl = Object.entries(ctx.filters).map(([k, v]) => `${k}: ${v}`).join(", ") || "none (defaults)";
  yield say(`You are on **${meta.title}** — ${meta.description}\n\nFilters: ${fl}. Grid **${tb.title || ""}** has ${tb.total || 0} rows.\n\n` + (ins.length ? "**Key points:** " + ins.join(" ") : ""));
  yield card("kpis", { items: kp }); const pc = pageChartCard(d); if (pc) yield pc; yield card("chips", { items: meta.suggestions });
};
H.go_back = function* (ctx) {
  const tr = ctx.trail.filter(x => x.page !== ctx.page);
  if (!tr.length) { yield say("No previous page in this session."); return; }
  const l = tr[tr.length - 1]; yield nav(l.page, l.filters); yield say(`Back to **${PAGE[l.page].title}**.`);
};
H.navigate = function* (ctx, sl) {
  const page = sl.page, t = sl.t || "";
  yield step(`Matched page \`${page}\``);
  const forced = "force_filters" in sl, f = forced ? sl.force_filters : buildFilters(page, t, sl.periods), srt = sl.force_sort || sortFor(page, t);
  const keys = new Set(PAGE[page].filters.map(x => x.key)), reg = forced ? null : NLU.region(t);
  if (reg && !keys.has("region")) { const alt = M.PAGES.filter(p => p.filters.some(x => x.key === "region")).map(p => p.title);
    yield refuse("FILTER_NOT_ON_PAGE", `${PAGE[page].title} has no region filter, so “${reg}” was not applied. Pages with a region filter: ${alt.join(", ")}.`, [`Show ${reg} sales`, `Show ${reg} shipments last 30 days`, `enterprise customers in ${reg}`]); }
  if (sl.note) yield step(sl.note);
  yield nav(page, f, srt);
  const d = P.data(page, f, srt);
  const parts = d.kpis.slice(0, 4).map(x => `${x.label} **${fmtv(x.value, x.fmt)}**` + (x.delta != null ? ` (${sign(x.delta)})` : "")).join(", ");
  const fl = Object.keys(f).length ? " · " + Object.entries(f).map(([a, b]) => `${a}: ${b}`).join(", ") : "";
  yield say(`Opened **${PAGE[page].title}**${fl}${srt ? " · sort " + srt : ""}. ${(d.table || {}).total || 0} rows.` + (sl.note ? `\n\n_${sl.note}_` : ""));
  if (d.kpis.length) yield card("kpis", { items: d.kpis.slice(0, 4).map(x => ({ label: x.label, value: fmtv(x.value, x.fmt), delta: x.delta })) });
  const pc = pageChartCard(d); if (pc) yield pc;
};
H.requests = function* (ctx, sl) {
  const mine = sl.mine || !can(ctx.user, "approve"), rows = listRequests(ctx.user, mine ? null : "Pending", mine);
  yield step("Fetching change requests"); yield nav("approvals", { status: mine ? null : "Pending" });
  if (!rows.length) { yield say(mine ? "You have no change requests." : "No pending requests."); return; }
  rows.forEach(r => { const ch = JSON.parse(r.changes || "{}"); r.summary = r.action === "delete" ? "Delete" : Object.entries(ch).map(([k, v]) => `${k}: ${v.old}→${v.new}`).join(", "); });
  const pend = rows.filter(r => r.status === "Pending");
  yield say((mine ? `You have ${rows.length} request(s): ${pend.length} pending.` : `**${pend.length} pending** request(s).`) + (can(ctx.user, "approve") && pend.length ? " Say *approve request N* or *reject request N because …*." : ""));
  const st = {}; rows.forEach(r => st[r.status] = (st[r.status] || 0) + 1);
  if (Object.keys(st).length > 1) yield chartCard("doughnut", "Requests by status", Object.keys(st), [{ label: "Requests", data: Object.values(st) }], { fmt: "int" });
  yield tableCard("Change requests", [["id", "#", "int"], ["record_label", "Record", "text"], ["summary", "Change", "text"], ["requested_by", "By", "text"], ["status", "Status", "status"]], rows.slice(0, 10), "approvals");
  if (can(ctx.user, "approve") && pend.length) yield card("chips", { items: ["Approve all pending requests", `Approve request ${pend[0].id}`, `Reject request ${pend[0].id} because not justified`] });
};
H.review = function* (ctx, sl) {
  if (!can(ctx.user, "approve")) { yield* notAdmin(ctx); return; }
  const cr = byId("change_requests", sl.req_id);
  if (!cr) { yield say(`Request #${sl.req_id} not found.`); yield* H.requests(ctx, { mine: false }); return; }
  if (cr.status !== "Pending") { yield nav("approvals", {}); yield say(`Request #${cr.id} already **${cr.status}**` + (cr.reviewed_by ? ` by ${cr.reviewed_by}.` : ".")); return; }
  yield step(`${Title(sl.decision)} request #${cr.id} (${cr.record_label})`);
  const res = reviewRequest(ctx.user, cr.id, sl.decision, sl.note || "", "agent"); NLU.invalidate(); R.build(); SPELL.V = null;
  yield say(`✅ Request **#${cr.id}** ${sl.decision === "approve" ? "approved and applied" : "rejected"}: ${cr.record_label} (${changeText(cr)}). ${cr.requested_by} has been notified.`);
  if (res.record && !res.record.deleted) { const { type, ...rest } = res.record; yield card("record", rest); yield nav(res.record.page, res.record.filters); } else yield nav("approvals", {});
};
function* notAdmin(ctx) {
  const rows = listRequests(ctx.user, null, true), pend = rows.filter(r => r.status === "Pending"), auto = rows.filter(r => r.reviewed_by === "auto-policy");
  yield say(`Only an admin can approve. Your role: **${ctx.user.role}**.\n\nLow-risk changes you request are **auto-approved by policy** instantly (e.g. price change ≤ 10%, stock adjustment ≤ 20%, contact details). You have ${pend.length} pending and ${auto.length} auto-approved request(s).`);
  if (rows.length) yield* H.requests(ctx, { mine: true });
}
H.review_all = function* (ctx, sl) {
  const dec = sl.decision || "approve";
  if (!can(ctx.user, "approve")) { yield* notAdmin(ctx); return; }
  const rows = listRequests(ctx.user, "Pending"); if (!rows.length) { yield say("Nothing pending. All requests are already reviewed."); return; }
  yield step(`${dec === "approve" ? "Approving" : "Rejecting"} ${rows.length} pending request(s)`);
  const res = reviewMany(ctx.user, dec, rows.map(r => r.id), "bulk via agent", "agent"); NLU.invalidate(); R.build(); SPELL.V = null;
  yield nav("approvals", {});
  yield say(`✅ ${dec === "approve" ? "Approved and applied" : "Rejected"} **${res.done.length}** request(s):\n` + rows.filter(r => res.done.includes(r.id)).map(r => `- #${r.id} ${r.record_label} (${r.action}: ${changeText(r)}) by ${r.requested_by}`).join("\n")
    + (res.failed.length ? `\n\n⚠ ${res.failed.length} failed: ` + res.failed.map(([i, e]) => `#${i}: ${e}`).join("; ") : ""));
  if (dec === "approve") for (const r of rows.filter(r => res.done.includes(r.id) && r.action === "update" && ENT[r.entity]).slice(0, 4)) { const v = recordView(r.entity, r.record_id, JSON.parse(r.changes || "{}")); if (v && !v.deleted) { const { type, ...rest } = v; yield card("record", rest); } }
  const st = {}; DB.change_requests.forEach(r => st[r.status] = (st[r.status] || 0) + 1);
  yield chartCard("doughnut", "All requests by status", Object.keys(st), [{ label: "Requests", data: Object.values(st) }], { fmt: "int" });
  yield { t: "action", action: "refresh" };
};
H.dataset = function* (ctx, sl) {
  const t = sl.t; yield step("Reading database catalog"); const cat = DSX.catalog();
  const alias = { "sales orders": "sales_orders", orders: "sales_orders", "purchase orders": "purchase_orders", pos: "purchase_orders", shipments: "shipments", customers: "customers", suppliers: "suppliers", products: "products", expenses: "expenses", "change requests": "change_requests", users: "users" };
  const m = t.match(/^how many (sales orders|orders|purchase orders|pos|shipments|customers|suppliers|products|expenses|change requests|users)\b/);
  if (m) {
    const tb = alias[m[1]], info = cat.find(c => c.table === tb);
    const sc = ["sales_orders", "purchase_orders", "shipments", "change_requests"].includes(tb) ? "status" : ["products", "suppliers", "expenses"].includes(tb) ? "category" : tb === "customers" ? "segment" : "role";
    const cnt = {}; DB[tb].forEach(r => cnt[r[sc]] = (cnt[r[sc]] || 0) + 1); const rows = Object.entries(cnt).sort((a, b) => b[1] - a[1]);
    yield say(`**${info.rows.toLocaleString("en-IN")}** rows in \`${tb}\`${info.span ? `, ${info.span[0]} → ${info.span[1]}` : ""}. ${info.description}.`);
    yield chartCard("bar", `${tb} by ${sc}`, rows.map(r => String(r[0])), [{ label: "Rows", data: rows.map(r => r[1]) }], { fmt: "int", horizontal: true }); yield nav("data", {}); return;
  }
  if (/kpi/.test(t)) {
    const kd = DSX.kpiDictionary(); yield say(`**${kd.length} KPIs** defined. Formulas and live values below; full list on Data & KPIs.`);
    yield card("table", { title: "KPI dictionary", columns: [{ key: "kpi", label: "KPI", fmt: "text" }, { key: "value", label: "Value", fmt: "auto" }, { key: "formula", label: "Formula", fmt: "text" }], rows: kd, page: "data", filters: null });
    yield nav("data", {}, null, "grid_kpis"); return;
  }
  const so = cat.find(c => c.table === "sales_orders");
  yield say(`**${cat.length} tables, ${sum(cat, c => c.rows).toLocaleString("en-IN")} rows.** Sales history ${so.span[0]} → ${so.span[1]} (~25 months). Synthetic Indian supply-chain business: 28 products, 15 suppliers, 80 customers, 7 regions, 5 carriers. Every table is browsable and admin/manager can run read-only SQL (e.g. *sql: select region, sum(amount) from sales_orders group by region*).`);
  yield chartCard("bar", "Rows per table", cat.map(c => c.table), [{ label: "Rows", data: cat.map(c => c.rows) }], { fmt: "int", horizontal: true });
  yield card("table", { title: "Tables", columns: [{ key: "table", label: "Table", fmt: "text" }, { key: "rows", label: "Rows", fmt: "int" }, { key: "description", label: "Description", fmt: "text" }], rows: cat.map(c => ({ table: c.table, rows: c.rows, description: c.description })), page: "data", filters: null });
  yield nav("data", {});
};
H.sql = function* (ctx, sl) {
  yield step("Validating read-only query"); let r;
  try { r = DSX.sql(ctx.user, sl.sql); } catch (e) { yield say(`⛔ ${e.message}`); return; }
  yield step(`Executed in ${r.ms} ms`); const cols = r.columns, rows = r.rows;
  yield say(`**${rows.length}${r.truncated ? "+" : ""} row(s)**, ${cols.length} column(s).`);
  if (!rows.length) return;
  yield card("table", { title: "Query result", columns: cols.map(c => ({ key: c, label: c, fmt: "auto" })), rows: rows.slice(0, 200), page: null, filters: null });
  const num = cols.slice(1).filter(c => rows.every(x => typeof x[c] === "number" || x[c] == null));
  if (cols.length >= 2 && num.length && rows.length <= 40) { const first = rows.map(x => String(x[cols[0]])), kind = first.every(v => /^\d{4}-\d{2}/.test(v)) ? "line" : "bar";
    yield chartCard(kind, `${num[0]} by ${cols[0]}`, first, num.slice(0, 3).map(c => ({ label: c, data: rows.map(x => x[c]) })), { fmt: "num", horizontal: kind === "bar" && rows.length > 6 }); }
};
H.stockout = function* (ctx, sl) {
  const days = sl.days;
  yield step("Reading inventory levels"); yield step("Computing 90-day demand velocity");
  const rows = P.stockout(days, sl.category);
  yield step(`Forecasting stock-outs within ${days} days`);
  yield nav("inventory", { category: sl.category }, "days_left:asc", "grid_products");
  if (!rows.length) { yield say(`No items run out within ${days} days.`); return; }
  const w = rows[0];
  yield say(`**${rows.length} items** run out within ${days} days. Most urgent: **${w.name}** — ${w.stock} ${w.unit} left, ~${w.daily_demand}/day, **${w.days_left.toFixed(1)} days** of cover.`);
  yield chartCard("bar", "Days of cover left", rows.map(r => r.name), [{ label: "Days left", data: rows.map(r => r.days_left), colors: sevColors(rows.map(r => r.days_left), 10, 5) }], { fmt: "days", horizontal: true });
  yield tableCard(`Stock-out risk (≤${days} days)`, [["sku", "SKU", "text"], ["name", "Product", "text"], ["stock", "Stock", "int"], ["daily_demand", "Per day", "num"], ["days_left", "Days left", "days"], ["open_po_qty", "Open PO", "int"], ["suggested_qty", "Suggest", "int"]], rows, "inventory");
  if (!sl.with_po) { yield card("chips", { items: ["Create purchase orders for these items", `Compare suppliers for ${w.name}`] }); return; }
  if (!can(ctx.user, "create")) { yield say("Your role is read-only. Cannot draft POs."); return; }
  yield step("Scoring suppliers: price 40%, rating 25%, on-time 20%, lead time 15%");
  const drafts = [], lines = [];
  for (const r of rows) {
    if (r.suggested_qty <= 0) continue; const o = P.supplierOptions(r.id); if (!o.length) continue; const b = o[0];
    drafts.push({ supplier_id: b.supplier_id, product_id: r.id, qty: r.suggested_qty, unit_cost: b.price, status: "Draft", notes: `Agent draft: ${r.days_left}d cover` });
    lines.push(`${r.name}: ${r.suggested_qty} ${r.unit} from ${b.name} @ ${money2(b.price)} (score ${b.score}, ${b.lead_time_days}d lead) = ${inr(r.suggested_qty * b.price)}`);
  }
  if (!drafts.length) { yield say("All at-risk items already covered by open POs."); return; }
  yield step("Preparing purchase order drafts");
  yield confirmCard(ctx.user, { kind: "bulk_create", entity: "purchase_orders", items: drafts }, `Create ${drafts.length} PO drafts · ${inr(sum(drafts, d => d.qty * d.unit_cost))}`, lines, "Create drafts");
  yield say(ctx.user.role !== "admin" ? "Drafts ready for review. Drafts need admin approval before ordering." : "Drafts ready. Confirm to create.");
};
H.create_po = function* (ctx, sl) {
  if (!can(ctx.user, "create")) { yield say("Your role is read-only."); return; }
  const prod = sl.product; if (!prod) { yield say("Which product? Example: *create purchase order for 500 Steel Rod*."); return; }
  yield step(`Resolved product ${prod.code} ${prod.name}`);
  const opts = P.supplierOptions(prod.id); yield step(`Ranking ${opts.length} suppliers`);
  let sup = sl.supplier ? opts.find(o => o.supplier_id === sl.supplier.id) : null; sup = sup || opts[0];
  if (!sup) { yield say("No supplier carries this product."); return; }
  const nums = NLU.numbers(sl.t.replace(/\b(po|so|sup|sku)-?\d+/g, "")).filter(n => n >= 1);
  const pr = P.productRows().find(r => r.id === prod.id);
  const qty = nums.length ? Math.trunc(nums[0]) : Math.max(10, Math.trunc((pr ? pr.daily_demand : 1) * 45 - (pr ? pr.stock : 0)));
  const data = { supplier_id: sup.supplier_id, product_id: prod.id, qty, unit_cost: sup.price, status: "Draft", notes: "Created via agent" };
  yield nav("procurement", { status: "Draft" });
  yield say(`Best supplier for **${prod.name}**: **${sup.name}** (${money2(sup.price)}, rating ${sup.rating}, ${sup.lead_time_days}d lead, score ${sup.score}).`);
  const t5 = opts.slice(0, 5);
  yield chartCard("bar", `Supplier score for ${prod.name}`, t5.map(o => o.name), [{ label: "Score", data: t5.map(o => o.score), colors: t5.map(o => o.supplier_id === sup.supplier_id ? "#2563eb" : "#94a3b8") }], { fmt: "num", horizontal: true });
  yield confirmCard(ctx.user, { kind: "create", entity: "purchase_orders", data }, `Create PO: ${qty} × ${prod.name}`, [`Supplier: ${sup.name}`, `Unit cost: ${money2(sup.price)}`, `Total: ${inr(qty * sup.price)}`, `Expected in ${sup.lead_time_days} days`, "Status: Draft"], "Create PO", false, { entity: "purchase_orders", values: data });
};
const FIELD_MAP = [
  [/selling price|sale price|\bprice\b|\bmrp\b/, { products: "unit_price", sales_orders: "unit_price", purchase_orders: "unit_cost" }], [/cost price|unit cost|\bcost\b/, { products: "cost_price", purchase_orders: "unit_cost" }],
  [/reorder( level| point)?/, { products: "reorder_level" }], [/\bstock\b|on hand|inventory/, { products: "stock" }],
  [/\bstatus\b|\bas (delivered|shipped|approved|received|cancelled|pending|draft|processing|returned|delayed)/, { purchase_orders: "status", sales_orders: "status", shipments: "status" }],
  [/\brating\b/, { suppliers: "rating" }], [/lead ?time/, { suppliers: "lead_time_days" }], [/on[- ]time/, { suppliers: "on_time_rate" }], [/\b(qty|quantity|units)\b/, { purchase_orders: "qty", sales_orders: "qty" }],
  [/\bemail\b/, { suppliers: "email", customers: "email" }], [/\bphone\b/, { suppliers: "phone" }], [/\bcity\b/, { suppliers: "city", customers: "city" }], [/\bcategory\b/, { products: "category", suppliers: "category" }],
  [/\bwarehouse\b/, { products: "warehouse" }], [/\bsegment\b/, { customers: "segment" }], [/\bcarrier\b/, { shipments: "carrier" }], [/\beta\b/, { shipments: "eta" }], [/\bname\b/, { products: "name", suppliers: "name", customers: "name" }],
];
function resolveRecord(t, prefer) {
  const c = NLU.code(t); if (c) { const r = findRecord(c[0], c[1]); return [c[0], r]; }
  const m = t.match(/\b([a-z]{2}-\d{3})\b/); if (m) { const r = findRecord("products", m[1]); if (r) return ["products", r]; }
  const order = ["products", "suppliers", "customers"]; if (prefer && order.includes(prefer)) { order.splice(order.indexOf(prefer), 1); order.unshift(prefer); }
  for (const e of order) { const f = { products: NLU.product, suppliers: NLU.supplier, customers: NLU.customer }[e](t); if (f) return [e, getRecord(e, f.id)]; }
  return [null, null];
}
H.update = function* (ctx, sl) {
  const t = sl.t;
  if (ctx.user.role === "viewer") { yield say("Viewer role is read-only. Ask an admin or manager."); return; }
  const [e, rec] = resolveRecord(t, /supplier|vendor/.test(t) ? "suppliers" : t.includes("customer") ? "customers" : null);
  if (!rec) { yield say("Record not found. Use a name or code, e.g. *change price of Steel Rod to 540* or *set PO-00012 status to approved*."); return; }
  yield step(`Resolved ${ENT[e].label} ${recordLabel(e, rec)}`);
  let field = null; for (const [re, mp] of FIELD_MAP) if (re.test(t) && mp[e]) { field = mp[e]; break; }
  if (!field) { if (["purchase_orders", "sales_orders", "shipments"].includes(e) && NLU.status(t, e)) field = "status"; else { yield say(`Which field of ${recordLabel(e, rec)}? Editable: ` + ENT[e].fields.map(f => f.label).join(", ")); return; } }
  const fd = ENT[e].fields.find(f => f.key === field); let val;
  const m = t.match(/\b(?:to|as|=)\s+(.+)$/), pm = t.match(/\b(increase|raise|decrease|reduce|lower)\b.*\bby\s+(\d+(?:\.\d+)?)\s*(%|percent)?/);
  if (pm && fd.type === "number") { const cur = rec[field] || 0, amt = +pm[2], dl = pm[3] ? cur * amt / 100 : amt; val = r2(["increase", "raise"].includes(pm[1]) ? cur + dl : cur - dl); }
  else if (field === "status") val = NLU.status(t, e);
  else if (m) {
    let raw = m[1].trim().replace(/\.$/, "").replace(/\s*\b(because|reason)\b.*$/, "");
    if (fd.type === "number") { const n = NLU.numbers(raw); if (!n.length) { yield say(`Need a number for ${fd.label}.`); return; } val = n[0]; }
    else if (fd.type === "select") val = fd.options.find(o => o.toLowerCase().includes(raw) || raw.includes(o.toLowerCase())) || Title(raw);
    else val = field === "email" ? raw : ["city", "name"].includes(field) ? Title(raw) : raw;
  } else { yield say(`New value for ${fd.label}? e.g. *... to 450*`); return; }
  if (val == null) { yield say("Could not read the new value."); return; }
  const old = rec[field], rm = t.match(/\b(?:because|reason)\b:?\s*(.+)$/), reason = rm ? rm[1] : "", label = recordLabel(e, rec);
  yield nav(ENT[e].page, ["products", "suppliers", "customers"].includes(e) ? { q: rec.name } : {});
  if (can(ctx.user, "update")) yield confirmCard(ctx.user, { kind: "write", entity: e, id: rec.id, action: "update", changes: { [field]: val }, reason }, `Update ${label}?`, [`${fd.label}: ${old} → ${val}`, "Applied immediately (admin) and audit-logged."], "Apply change");
  else yield confirmCard(ctx.user, { kind: "write", entity: e, id: rec.id, action: "update", changes: { [field]: val }, reason: reason || "Requested via agent" }, `Request change to ${label}?`, [`${fd.label}: ${old} → ${val}`, `Your role (${ctx.user.role}) cannot edit directly.`, "Admin must approve in Approvals."], "Submit request");
};
H.delete = function* (ctx, sl) {
  const t = sl.t;
  if (ctx.user.role === "viewer") { yield say("Viewer role is read-only."); return; }
  const [e, rec] = resolveRecord(t, /supplier|vendor/.test(t) ? "suppliers" : t.includes("customer") ? "customers" : null);
  if (!rec) { yield say("Record not found."); return; }
  const label = recordLabel(e, rec); yield step(`Resolved ${label}`);
  yield nav(ENT[e].page, ["products", "suppliers", "customers"].includes(e) ? { q: rec.name } : {});
  if (can(ctx.user, "delete")) yield confirmCard(ctx.user, { kind: "write", entity: e, id: rec.id, action: "delete" }, `Delete ${label}?`, ["Soft delete: record hidden, kept in audit log."], "Delete", true);
  else yield confirmCard(ctx.user, { kind: "write", entity: e, id: rec.id, action: "delete", reason: "Requested via agent" }, `Request deletion of ${label}?`, [`Role ${ctx.user.role} cannot delete.`, "Admin approval required."], "Submit request", true);
};
H.create = function* (ctx, sl) {
  const e = sl.entity, t = sl.t;
  if (!can(ctx.user, "create")) { yield say("Your role is read-only."); return; }
  const v = {};
  const m = t.match(/(?:supplier|vendor|product|item|customer|client|expense)\s+(?:called |named )?(.+?)(?:\s+(?:in|at|from|with|category|price|cost|for|,)\b|$)/);
  if (m && e !== "expenses") v.name = Title(m[1].trim());
  const city = t.match(/\b(?:in|at|from)\s+([a-z ]+?)(?:\s+(?:with|category|price|cost|rating|,)\b|$)/), reg = NLU.region(t);
  if (["suppliers", "customers"].includes(e) && city) v.city = Title(city[1].trim());
  if (e === "customers" && reg) v.region = reg;
  const cat = NLU.category(t); if (["products", "suppliers"].includes(e) && cat) v.category = cat;
  for (const [key, re] of [["unit_price", /(?:price|selling price)\s*(?:of|=|:)?\s*₹?(\d+(?:\.\d+)?)/], ["cost_price", /cost\s*(?:price)?\s*(?:of|=|:)?\s*₹?(\d+(?:\.\d+)?)/], ["rating", /rating\s*(\d(?:\.\d)?)/], ["lead_time_days", /lead ?time\s*(\d+)/], ["amount", /(?:amount|of|₹)\s*(\d+(?:\.\d+)?)/], ["stock", /stock\s*(\d+)/]]) {
    const mm = t.match(re); if (mm && ENT[e].fields.some(f => f.key === key)) v[key] = +mm[1];
  }
  if (e === "products") { const name = v.name || "New Product"; v.sku = name.split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase() + "-" + (100 + P.productRows().length + 1); if (v.unit_price && !v.cost_price) v.cost_price = r2(v.unit_price * 0.72); }
  if (e === "expenses") { v.category = NLU.option(t, M.EXP_CATS) || "Administrative"; v.date = today(); }
  if (e === "suppliers" && !v.category) v.category = "Raw Materials";
  yield step(`Opening ${ENT[e].label} form`); yield nav(ENT[e].page);
  yield { t: "action", action: "open_form", entity: e, values: v, mode: "create" };
  const miss = ENT[e].fields.filter(f => f.required && !(f.key in v)).map(f => f.label);
  yield say(`Form auto-filled: ${Object.entries(v).map(([k, x]) => `${k}=${x}`).join(", ") || "nothing yet"}.` + (miss.length ? ` Still needed: **${miss.join(", ")}**.` : " Review and click **Save**."));
};
H.compare_suppliers = function* (ctx, sl) {
  let prod = sl.product;
  if (!prod && sl.category) { const p = live("products").find(x => x.category === sl.category); prod = p ? { id: p.id, code: p.sku, name: p.name } : null; }
  if (!prod) prod = { id: 1, code: "SR-001", name: "Steel Rod" };
  yield step(`Loading supplier catalog for ${prod.name}`);
  const opts = P.supplierOptions(prod.id).slice(0, sl.n || 5);
  yield step("Scoring: price 40%, rating 25%, on-time 20%, lead time 15%");
  if (!opts.length) { yield say("No suppliers for this product."); return; }
  const b = opts[0], ch = opts.reduce((a, x) => x.price < a.price ? x : a);
  yield nav("suppliers", { category: getRecord("products", prod.id).category }, "rating:desc");
  yield say(`Best overall for **${prod.name}**: **${b.name}** — ${money2(b.price)}, rating ${b.rating}, ${Math.round(b.on_time_rate * 100)}% on-time, ${b.lead_time_days}d lead (score ${b.score}).` + (ch.supplier_id !== b.supplier_id ? ` Cheapest: ${ch.name} at ${money2(ch.price)}.` : ""));
  opts.forEach(o => o.on_time_pct = r1(o.on_time_rate * 100));
  yield chartCard("bar", "Overall score (higher is better)", opts.map(o => o.name), [{ label: "Score", data: opts.map(o => o.score), colors: opts.map((o, i) => i ? "#94a3b8" : "#2563eb") }], { fmt: "num", horizontal: true });
  yield chartCard("bar", "Unit price (₹)", opts.map(o => o.name), [{ label: "Price", data: opts.map(o => o.price), colors: opts.map(o => o === ch ? "#16a34a" : "#94a3b8") }], { fmt: "inr", horizontal: true });
  yield tableCard(`Suppliers for ${prod.name}`, [["name", "Supplier", "text"], ["price", "Price", "inr"], ["rating", "Rating", "num"], ["on_time_pct", "On-time", "pct"], ["lead_time_days", "Lead d", "int"], ["score", "Score", "num"]], opts, "suppliers");
  yield card("chips", { items: [`Create purchase order for ${prod.name} from ${b.name}`] });
};
H.compare_periods = function* (ctx, sl) {
  let per = sl.periods; const T = today();
  if (!per.length) per = [NLU.period("this month"), NLU.period("last month")];
  if (per.length === 1) { const [pf, pt] = P.prev(per[0][0], per[0][1]); per = [per[0], [pf, pt, "previous period"]]; }
  const extra = {}; for (const k of ["region", "category", "channel"]) if (sl[k]) extra[k] = sl[k];
  const metric = sl.metric; yield step(`Querying ${metric} for ${per[0][2]} and ${per[1][2]}`);
  const A = P.period(per[0][0], per[0][1], extra), B = P.period(per[1][0], per[1][1], extra), ch = P.pct(A[metric], B[metric]);
  const fm = metric === "revenue" ? inr : v => Math.trunc(v).toLocaleString("en-IN"), scope = Object.keys(extra).length ? " in " + Object.values(extra).join(", ") : "";
  let msg = `${Title(metric)}${scope}: **${fm(A[metric])}** (${per[0][2]}) vs **${fm(B[metric])}** (${per[1][2]}) → **${sign(ch)}**.`;
  const la = D.diff(per[0][0], per[0][1]), lb = D.diff(per[1][0], per[1][1]);
  if (la + 3 < lb && per[0][1] >= D.add(T, -1)) { const L = P.period(per[1][0], D.add(per[1][0], la), extra); msg += ` Current period is partial (${la + 1} days). Like-for-like vs first ${la + 1} days of ${per[1][2]}: **${sign(P.pct(A[metric], L[metric]))}**.`; }
  yield step("Breaking down by region");
  const ba = P.breakdown("region", per[0][0], per[0][1], metric, extra), bb = P.breakdown("region", per[1][0], per[1][1], metric, extra);
  const rows = [...new Set([...Object.keys(ba), ...Object.keys(bb)])].map(k => ({ name: k, a: Math.round(ba[k] || 0), b: Math.round(bb[k] || 0), pct: P.pct(ba[k] || 0, bb[k] || 0) })).sort((x, y) => y.a - x.a);
  if (rows.length && !extra.region) { const lo = rows.reduce((a, x) => (x.pct ?? 0) < (a.pct ?? 0) ? x : a), hi = rows.reduce((a, x) => (x.pct ?? 0) > (a.pct ?? 0) ? x : a); msg += ` Best region: ${hi.name} (${sign(hi.pct)}). Weakest: ${lo.name} (${sign(lo.pct)}).`; }
  yield nav("analytics", { date_from: per[0][0], date_to: per[0][1], metric, group_by: "region", ...extra });
  yield say(msg);
  yield card("kpis", { items: [{ label: `${Title(metric)} · ${per[0][2]}`, value: fm(A[metric]), delta: ch }, { label: per[1][2], value: fm(B[metric]) }, { label: "Orders", value: `${A.orders.toLocaleString("en-IN")} vs ${B.orders.toLocaleString("en-IN")}`, delta: P.pct(A.orders, B.orders) }] });
  const fmt = metric === "revenue" ? "inr" : "int";
  yield chartCard("bar", `${Title(metric)} by region`, rows.map(r => r.name), [{ label: per[0][2], data: rows.map(r => r.a) }, { label: per[1][2], data: rows.map(r => r.b) }], { fmt });
  yield tableCard("By region", [["name", "Region", "text"], ["a", per[0][2], fmt], ["b", per[1][2], fmt], ["pct", "Change", "pct"]], rows, "analytics");
  yield sourcesCard([[per[0][2], salesSql(per[0][0], per[0][1], metric, extra)], [per[1][2], salesSql(per[1][0], per[1][1], metric, extra)], ["By region", salesSql(per[0][0], per[0][1], metric, extra, "region")]]);
  yield card("chips", { items: [`Why did ${metric} ${(ch || 0) < 0 ? "drop" : "rise"}` + (extra.region ? ` in ${extra.region}` : "") + ` ${per[0][2]}`, "Top 5 products by revenue", "Show last 12 months analysis"] });
};
H.why = function* (ctx, sl) {
  const per = sl.periods, T = today(); let a, b, la, lb, prev = null, note = "";
  if (per.length >= 2) { [a, b, la] = per[0]; let [pf, pt, l2] = per[1]; lb = l2; const da = D.diff(a, b), db_ = D.diff(pf, pt);
    if (da + 3 < db_ && b >= D.add(T, -1)) { pt = D.add(pf, da); note = `${la} is partial (${da + 1} days), so I compare like-for-like with the first ${da + 1} days of ${lb}.`; } prev = [pf, pt]; }
  else if (per.length) { [a, b, la] = per[0]; lb = "the previous period"; } else { b = T; a = D.add(T, -59); la = "last 60 days"; lb = "the 60 days before"; }
  const extra = {}; for (const k of ["region", "category"]) if (sl[k]) extra[k] = sl[k];
  const metric = sl.metric; yield step(`Comparing ${la} with ${lb}` + (note ? " (like-for-like)" : ""));
  const d = P.drivers(a, b, metric, extra, prev), [pf, pt] = d.previous;
  yield step("Decomposing the change by region, category, channel and product"); yield step("Checking logistics delays, cancellations and stock-outs");
  const ch = d.change_pct, mv = v => metric === "revenue" ? inr(v) : Math.round(v).toLocaleString("en-IN"), scope = Object.keys(extra).length ? " in " + Object.values(extra).join(", ") : "";
  const lines = [`${Title(metric)}${scope} **${(ch || 0) < 0 ? "fell" : "rose"} ${Math.abs(ch || 0).toFixed(1)}%**: ${mv(d.current[metric])} (${a} → ${b}) vs ${mv(d.previous_totals[metric])} (${pf} → ${pt}).`];
  if (note) lines.push(`_${note}_`);
  let causes = [];
  for (const [dim, items] of Object.entries(d.dims)) { if (!items.length) continue; const w = items[0], be = items[items.length - 1];
    if ((ch || 0) < 0 && w.delta < 0) causes.push([Math.abs(w.delta), `**${Title(dim)}**: ${w.key} ${sign(w.pct)} (${mv(w.delta)})`]);
    else if ((ch || 0) > 0 && be.delta > 0) causes.push([Math.abs(be.delta), `**${Title(dim)}**: ${be.key} ${sign(be.pct)} (+${mv(be.delta)})`]); }
  causes = causes.sort((x, y) => y[0] - x[0]).map(x => x[1]);
  const dl = d.delays, lateUp = dl.current.avg_delay != null && dl.previous.avg_delay != null && dl.current.avg_delay > (dl.previous.avg_delay || 0) * 1.5 + 0.3;
  if (lateUp) { causes.push(`**Logistics**: avg delay ${dl.current.avg_delay.toFixed(1)} d vs ${dl.previous.avg_delay.toFixed(1)} d; late shipments ${Math.round(dl.current.late_rate * 100)}% vs ${Math.round(dl.previous.late_rate * 100)}%`);
    if (d.carriers && d.carriers.length) { const c0 = d.carriers[0]; causes.push(`**Carrier**: ${c0.carrier} slowest on this lane: ${c0.n} shipments, avg ${c0.avg_delay.toFixed(1)} d delay`); } }
  const cr = d.cancel_rate; if (cr.current > cr.previous * 1.3 && cr.current > 0.02) causes.push(`**Cancellations** up: ${(cr.current * 100).toFixed(1)}% vs ${(cr.previous * 100).toFixed(1)}%`);
  if (d.out_of_stock.length && (ch || 0) < 0) causes.push(`**Stock-outs** now: ${d.out_of_stock.join(", ")} (orders for them cannot ship)`);
  lines.push(causes.length ? ((ch || 0) < 0 ? "**Biggest contributors:**\n" : "**Growth drivers:**\n") + causes.slice(0, 6).map((c, i) => `${i + 1}. ${c}`).join("\n") : "No single dominant driver; the change is spread evenly.");
  lines.push("_What the data cannot prove: these are measured contributions and co-occurring signals, not proven causes. Customer intent, competitor pricing and market demand are not in this dataset._");
  if (extra.region && lateUp) { lines.push("**Suggested action:** review the slow carrier on this lane, expedite delayed orders, inform key accounts."); yield nav("logistics", { region: extra.region, date_from: a, date_to: b }, "delay_days:desc", "chart_delay_carrier"); }
  else yield nav("analytics", { date_from: a, date_to: b, metric, group_by: extra.region ? "category" : "region", ...extra }, "change:asc");
  yield say(lines.join("\n\n"));
  yield card("kpis", { items: [{ label: `${Title(metric)} · ${a.slice(5)} → ${b.slice(5)}`, value: mv(d.current[metric]), delta: ch }, { label: `Compared · ${pf.slice(5)} → ${pt.slice(5)}`, value: mv(d.previous_totals[metric]) }, { label: "Change", value: mv(d.current[metric] - d.previous_totals[metric]) }] });
  const dim = extra.region ? "category" : "region", rows = d.dims[dim] || [], f2 = metric === "revenue" ? "inr" : "int";
  if (rows.length) yield chartCard("bar", `Change in ${metric} by ${dim}`, rows.map(r => r.key), [{ label: "Δ " + metric, data: rows.map(r => r.delta) }], { fmt: f2, signed: true, horizontal: true });
  let prods = d.dims.product || []; prods = (ch || 0) < 0 ? prods.slice(0, 6) : prods.slice(-6).reverse();
  if (prods.length) yield chartCard("bar", "Top product contributors", prods.map(r => r.key), [{ label: "Δ " + metric, data: prods.map(r => r.delta) }], { fmt: f2, signed: true, horizontal: true });
  if (dl.current.avg_delay != null && dl.previous.avg_delay != null) yield chartCard("bar", "Late shipment rate", ["Compared period", "This period"], [{ label: "Late %", data: [r1((dl.previous.late_rate || 0) * 100), r1((dl.current.late_rate || 0) * 100)], colors: ["#94a3b8", lateUp ? "#dc2626" : "#2563eb"] }], { fmt: "pct" });
  yield sourcesCard([[`${Title(metric)} this period`, salesSql(a, b, metric, extra)], [`${Title(metric)} compared period`, salesSql(pf, pt, metric, extra)], [`By ${dim} (this period)`, salesSql(a, b, metric, extra, dim)]], "Numbers computed in code from these queries; the explanation only cites them.");
  yield card("chips", { items: [extra.region ? `Top 5 products by revenue in ${extra.region}` : "Top 5 regions by revenue", "show delayed shipments", "How did you get that number?"] });
};
H.expense_why = function* (ctx, sl) {
  const per = sl.periods; const [a, b] = per.length ? per[0] : [D.add(today(), -89), today()]; const [pf, pt] = P.prev(a, b);
  yield step("Comparing expense categories vs prior period");
  const agg = (x, y) => { const o = {}; live("expenses").filter(e => e.date >= x && e.date <= y).forEach(e => o[e.category] = (o[e.category] || 0) + e.amount); return o; };
  const cur = agg(a, b), prev = agg(pf, pt);
  const rows = [...new Set([...Object.keys(cur), ...Object.keys(prev)])].map(k => ({ name: k, a: Math.round(cur[k] || 0), b: Math.round(prev[k] || 0), pct: P.pct(cur[k] || 0, prev[k] || 0) })).sort((x, y) => (y.pct || 0) - (x.pct || 0));
  const top = rows[0], rv = P.pct(P.period(a, b).revenue, P.period(pf, pt).revenue);
  let msg = `Biggest rise: **${top.name}** ${sign(top.pct)} (${inr(top.a)} vs ${inr(top.b)}). Revenue moved ${sign(rv)} in the same window.`;
  if (top.name === "Logistics") { yield step("Cross-checking shipment delays"); const d = P.drivers(a, b); msg += ` Shipment delays rose: avg ${(d.delays.current.avg_delay || 0).toFixed(1)}d vs ${(d.delays.previous.avg_delay || 0).toFixed(1)}d → expediting and re-shipping costs.`; }
  yield nav("finance", { date_from: a, date_to: b }, null, "chart_expense"); yield say(msg);
  yield chartCard("bar", "Expenses: current vs prior period", rows.map(r => r.name), [{ label: "Current", data: rows.map(r => r.a) }, { label: "Previous", data: rows.map(r => r.b) }], { fmt: "inr" });
  yield tableCard("Expenses vs prior period", [["name", "Category", "text"], ["a", "Current", "inr"], ["b", "Previous", "inr"], ["pct", "Change", "pct"]], rows, "finance");
};
H.top = function* (ctx, sl) {
  const per = sl.periods, [a, b] = per.length ? [per[0][0], per[0][1]] : [null, null];
  let { kind, n, metric } = sl; if (kind === "suppliers" && metric === "revenue") metric = "spend";
  const extra = {}; for (const k of ["region", "category"]) if (sl[k]) extra[k] = sl[k];
  yield step(`Ranking ${kind} by ${metric}`);
  const rows = P.top(kind, n, a, b, metric, sl.asc, extra); if (!rows.length) { yield say("No data."); return; }
  const label = per.length ? per[0][2] : "last 12 months", key = metric === "rating" ? "rating" : kind === "suppliers" ? "spend" : metric, fmt = ["revenue", "spend"].includes(key) ? "inr" : key === "rating" ? "num" : "int", word = sl.asc ? "Bottom" : "Top";
  yield say(`${word} ${rows.length} ${kind} by ${metric} (${label}): #1 **${rows[0].name}** at **${fmtv(rows[0][key], fmt)}**.`);
  yield chartCard("bar", `${word} ${rows.length} ${kind} by ${metric}`, rows.map(r => r.name), [{ label: metric, data: rows.map(r => r[key]) }], { fmt, horizontal: true });
  yield tableCard(`${word} ${n} ${kind}`, [["name", Title(kind.slice(0, -1)), "text"], [key, Title(metric), fmt]], rows);
  const gm = { products: "product", customers: "customer", regions: "region", categories: "category", channels: "channel", segments: "segment" };
  if (gm[kind] && ["revenue", "orders", "units"].includes(metric)) { const [da, db_] = P.drange({ date_from: a, date_to: b }); yield sourcesCard([[`${word} ${kind}`, salesSql(da, db_, metric, extra, gm[kind], n).replace("DESC", sl.asc ? "ASC" : "DESC")]]); }
  const g = { products: "product", regions: "region", categories: "category", channels: "channel", segments: "segment" }[kind];
  if (g) yield nav("analytics", { date_from: a, date_to: b, metric: ["revenue", "orders", "units"].includes(metric) ? metric : "revenue", group_by: g, ...extra }, `current:${sl.asc ? "asc" : "desc"}`);
  else if (kind === "customers") yield nav("customers", {}, `revenue:${sl.asc ? "asc" : "desc"}`);
  else yield nav("suppliers", {}, `${metric === "rating" ? "rating" : "spend_12m"}:${sl.asc ? "asc" : "desc"}`);
};
H.trend = function* (ctx, sl) {
  const per = sl.periods, T = today(); const [a, b, label] = per.length ? per[0] : [D.addM(T, -11), T, "last 12 months"];
  const extra = {}; for (const k of ["region", "category"]) if (sl[k]) extra[k] = sl[k];
  const metric = sl.metric; yield step(`Loading monthly ${metric} (${label})`);
  const ms = P.monthly({ date_from: a, date_to: b, ...extra }), full0 = ms.filter(m => m.m !== T.slice(0, 7)), full = full0.length ? full0 : ms, vals = full.map(m => m[metric]);
  yield step("Computing growth, peaks and forecast");
  if (vals.length < 2) { yield say("Not enough data for a trend."); return; }
  const best = full.reduce((x, m) => m[metric] > x[metric] ? m : x), worst = full.reduce((x, m) => m[metric] < x[metric] ? m : x), h = Math.floor(vals.length / 2);
  const g = h ? P.pct(sum(vals.slice(h)), sum(vals.slice(0, h))) : null, mom = P.pct(vals[vals.length - 1], vals[vals.length - 2]);
  const xs = [...Array(Math.min(6, vals.length)).keys()], ys = vals.slice(-xs.length), mx = sum(xs) / xs.length, my = sum(ys) / ys.length;
  const slope = sum(xs.map((x, i) => (x - mx) * (ys[i] - my))) / (sum(xs, x => (x - mx) ** 2) || 1), fc = my + slope * (xs.length - mx);
  const fm = metric === "revenue" ? inr : v => Math.trunc(v).toLocaleString("en-IN"), scope = Object.keys(extra).length ? " · " + Object.values(extra).join(", ") : "";
  yield say(`**${Title(metric)} trend (${label}${scope})**: total ${fm(sum(ms, m => m[metric]))}. Second half vs first half **${sign(g)}**. Last full month ${mlabel(full[full.length - 1].m)} ${fm(vals[vals.length - 1])} (${sign(mom)} MoM). Peak ${mlabel(best.m)} (${fm(best[metric])}), low ${mlabel(worst.m)} (${fm(worst[metric])}). 6-month slope ${slope > 0 ? "up" : "down"} → next month forecast ≈ **${fm(Math.max(fc, 0))}**.`);
  const labels = ms.map(m => mlabel(m.m)), actual = ms.map(m => m[metric]), nxt = mlabel(D.addM(full[full.length - 1].m + "-01", 1).slice(0, 7));
  if (!labels.includes(nxt)) { labels.push(nxt); actual.push(null); }
  const fi = labels.indexOf(nxt), fcs = labels.map(() => null); fcs[fi - 1] = vals[vals.length - 1]; fcs[fi] = r2(Math.max(fc, 0));
  if (fi === ms.length - 1) actual[fi] = null;
  yield chartCard("line", `Monthly ${metric} + next-month forecast`, labels, [{ label: "Actual", data: actual }, { label: "Forecast", data: fcs, dashed: true }], { fmt: metric === "revenue" ? "inr" : "int" });
  const agg = { revenue: "ROUND(SUM(so.amount), 2) AS revenue", orders: "COUNT(*) AS orders", units: "SUM(so.qty) AS units" }[metric];
  yield sourcesCard([["Monthly series", salesSql(a, b, metric, extra).replace(`SELECT ${agg}`, `SELECT substr(so.order_date, 1, 7) AS month, ${agg}`) + " GROUP BY month ORDER BY month"]], "Forecast = least-squares line through the last 6 full months. It is a projection, not a guarantee.");
  yield nav("analytics", { date_from: a, date_to: b, metric, group_by: sl.group || "region", ...extra }, null, "chart_trend");
};
H.delays = function* (ctx, sl) {
  const f = { region: sl.region, carrier: sl.carrier, ...(sl.periods.length ? periodFilters(sl.periods) : { date_from: D.add(today(), -59), date_to: today() }) };
  yield step("Reading shipments");
  const rows = P.data("logistics", f).table.rows, late = rows.filter(r => r.delay_days > 0);
  yield step("Ranking carriers and lanes by delay");
  const bc = {}, br = {}; rows.forEach(r => { (bc[r.carrier] = bc[r.carrier] || []).push(r.delay_days); (br[r.destination] = br[r.destination] || []).push(r.delay_days); });
  const avg = xs => sum(xs) / xs.length, worst = o => Object.entries(o).reduce((x, e) => !x || avg(e[1]) > avg(x[1]) ? e : x, null);
  const wc = worst(bc), wr = worst(br);
  yield nav("logistics", { ...f, status: null }, "delay_days:desc", "chart_delay_carrier");
  let msg = `**${late.length} of ${rows.length}** shipments late (${(late.length * 100 / (rows.length || 1)).toFixed(1)}%).`;
  if (wc) msg += ` Worst carrier: **${wc[0]}** (avg ${avg(wc[1]).toFixed(1)}d).`; if (wr && !sl.region) msg += ` Worst destination: **${wr[0]}** (avg ${avg(wr[1]).toFixed(1)}d).`;
  yield say(msg);
  const cars = Object.entries(bc).sort((x, y) => avg(y[1]) - avg(x[1]));
  yield chartCard("bar", "Average delay by carrier (days)", cars.map(c => c[0]), [{ label: "Avg delay", data: cars.map(c => r2(avg(c[1]))), colors: sevColors(cars.map(c => avg(c[1])), 1, 2, true) }], { fmt: "num", horizontal: true });
  if (!sl.region) { const regs = Object.entries(br).sort((x, y) => avg(y[1]) - avg(x[1]));
    yield chartCard("bar", "Average delay by destination (days)", regs.map(c => c[0]), [{ label: "Avg delay", data: regs.map(c => r2(avg(c[1]))), colors: sevColors(regs.map(c => avg(c[1])), 1, 2, true) }], { fmt: "num", horizontal: true }); }
  yield tableCard("Most delayed shipments", [["shipment_no", "Shipment", "text"], ["carrier", "Carrier", "text"], ["destination", "To", "text"], ["delay_days", "Delay d", "int"], ["status", "Status", "status"]], [...late].sort((x, y) => y.delay_days - x.delay_days).slice(0, 8), "logistics");
};
H.finance = function* (ctx, sl) {
  const per = sl.periods, T = today(), f = per.length ? periodFilters(per) : { date_from: D.mk(D.y(T), 1, 1), date_to: T }, label = per.length ? per[0][2] : "this year";
  yield step("Computing P&L"); const d = P.data("finance", f), k = Object.fromEntries(d.kpis.map(x => [x.id, x]));
  yield nav("finance", f);
  const ex = d.charts[1], top = ex.labels.length ? ex.labels.map((l, i) => [l, ex.datasets[0].data[i]]).reduce((a, x) => x[1] > a[1] ? x : a) : ["—", 0];
  yield say(`**${Title(label)}**: Revenue ${inr(k.kpi_revenue.value)} (${sign(k.kpi_revenue.delta)}), COGS ${inr(k.kpi_cogs.value)}, Opex ${inr(k.kpi_opex.value)}, gross margin **${k.kpi_margin.value.toFixed(1)}%**, net profit **${inr(k.kpi_profit.value)}** (${sign(k.kpi_profit.delta)}). Largest expense: ${top[0]} (${inr(top[1])}).`);
  yield card("kpis", { items: d.kpis.map(x => ({ label: x.label, value: fmtv(x.value, x.fmt), delta: x.delta })) });
  yield pageChartCard(d, 0); yield pageChartCard(d, 1);
};
H.search = function* (ctx, sl) {
  const term = sl.term || sl.t; yield step("Semantic search over pages, products, suppliers, customers");
  const links = [], c = NLU.code(term);
  if (c) { const r = findRecord(c[0], c[1]); if (r) links.push({ label: recordLabel(c[0], r), kind: ENT[c[0]].label, page: ENT[c[0]].page, filters: ["products", "suppliers", "customers"].includes(c[0]) ? { q: r.name } : {} }); }
  for (const h of R.search(term, 6)) { if (h.kind === "api") continue; links.push({ label: ((h.code || "") + " " + h.name).trim(), kind: h.kind, page: h.page, filters: ["products", "suppliers", "customers"].includes(h.kind) ? { q: h.name } : {} }); }
  if (!links.length) { yield say("Nothing found."); return; }
  yield nav(links[0].page, links[0].filters); yield say(`Top match: **${links[0].label}** (${links[0].kind}). Opened it.`); yield card("links", { items: links.slice(0, 6) });
};
H.unknown = function* (ctx, sl, query) {
  const hits = R.search(query, 4).filter(h => h.kind === "page" || h.kind === "widget");
  if (hits.length && hits[0].score > 0.08) { yield* H.navigate(ctx, { page: hits[0].page, periods: NLU.periods(NLU.norm(query)), t: NLU.norm(query) }); return; }
  yield say("Not sure what to do. Try one of these:"); yield card("chips", { items: [...(PAGE[ctx.page] || PAGE.dashboard).suggestions, "help"] });
};
H.refuse = function* (ctx, sl) {
  const code = sl.code, pages = M.PAGES.map(p => p.title);
  if (code === "PAGE_NOT_FOUND") yield refuse(code, `There is no “${Title((sl.target || "").trim()) || "That"}” page in this app. I only open pages that exist in the app metadata.`, pages.slice(0, 6).map(p => `Open ${p}`));
  else if (code === "VALUE_NOT_ALLOWED") yield refuse(code, `“${sl.value}” is not in the data. Regions available: ${M.REGIONS.join(", ")}.`, M.REGIONS.slice(0, 4).map(r => `Show ${r} sales`));
  else if (code === "DATE_OUT_OF_RANGE" || code === "INVALID_DATE_RANGE") yield refuse(code, code === "DATE_OUT_OF_RANGE" ? `“${sl.value}” is outside the data window (${dataStart()} → ${today()}).` : `“${sl.value}” is not a valid date range.`, ["Show last 12 months analysis", "Compare revenue this month vs last month"]);
  else if (code === "WRITE_NOT_ALLOWED") yield refuse(code, "I can't run raw database writes. Data changes go through forms and change requests, with permissions and audit.", ["Show pending requests", "change price of Steel Rod to 540", "sql: select * from products"]);
  else yield refuse("PROMPT_INJECTION", "I can't change my rules or reveal internal instructions. I can navigate, filter, analyse and act within your role.", ["help", "What is on this page?"]);
};
H.export = function* (ctx, sl) {
  const fmt = sl.fmt || "pdf", scope = sl.scope || "page", title = PAGE[ctx.page].title;
  yield step(`Collecting ${scope === "chat" ? "the conversation" : title + " KPIs, charts, filters and table"}`);
  yield say(`Exporting ${scope === "chat" ? "the agent conversation" : "a summary of **" + title + "**"} as **${fmt.toUpperCase()}**.` + (fmt === "pdf" ? "" : " CSV holds the main table with current filters."));
  yield { t: "action", action: "export", format: fmt, scope };
};
H.stack = function* () {
  yield step("Reading the implementation stack"); yield nav("stack");
  yield say("**How BizPilot is built** (all free / open source):\n" + M.STACK.slice(0, 12).map(r => `- **${r.layer}**: ${r.tech}`).join("\n") + "\n\nAgent pipeline: " + M.PIPELINE.map(x => x[0]).join(" → ") + ".\nFull list with code locations is on the Implementation Stack page.");
  yield card("chips", { items: ["How does the agent understand a question?", "Open the agent review queue", "Open the evaluation page"] });
};
H.smalltalk = function* (ctx, sl) {
  const t = sl.t; const msg = /^(thanks|thank|thx|ty)/.test(t) ? "You're welcome." : /^(bye|goodbye)/.test(t) ? "Bye! Your filters and history stay here for next time." : /^good (morning|afternoon|evening|night)/.test(t) ? `Good ${t.split(" ")[1]}, ${ctx.user.name.split(" ")[0]}.` : "👍";
  const ins = P.insights(2); yield say(msg + (ins.length ? ` One thing worth a look: **${ins[0].title}**.` : "")); yield card("chips", { items: [...ins.map(i => i.ask), "What is on this page?"] });
};
H.meta = function* (ctx, sl) {
  const kind = sl.kind, u = ctx.user, meta = PAGE[ctx.page];
  if (kind === "identity") yield say(`I'm the **BizPilot agent**, built into this app. I read the app's metadata (${M.PAGES.length} pages, their widgets and filters) and its live data, then navigate, filter, analyse and act for you within your role. Numbers come from database queries; I show the SQL behind them.`);
  else if (kind === "limits") yield say(`**What I can't do:** change data beyond your role (non-admins raise requests), run raw SQL writes, open pages that don't exist, use data outside this database (window ${dataStart()} → ${today()}), or prove causes the data doesn't contain. When I'm unsure I ask instead of guessing.`);
  else if (kind === "filters") {
    if (!meta.filters.length) yield say(`**${meta.title}** has no filters. Pages with filters: ${M.PAGES.filter(p => p.filters.length).map(p => p.title).join(", ")}.`);
    else { yield say(`Filters on **${meta.title}**:\n` + meta.filters.map(f => `- **${f.label}**` + (f.options ? `: ${f.options.join(", ")}` : f.type === "daterange" ? " (from / to dates)" : " (free text)")).join("\n"));
      yield card("chips", { items: [{ sales: "Show Karnataka delivered orders last quarter", inventory: "show low stock electrical items", procurement: "show draft purchase orders", logistics: "Gati shipments to Maharashtra last 30 days", customers: "enterprise customers in Delhi", analytics: "revenue by channel last 6 months" }[ctx.page] || meta.suggestions[0]] }); }
  } else if (kind === "role") {
    const can_ = { read: "view every page and analysis", create: "create products, suppliers, customers, POs, expenses", update: "edit any record directly", delete: "delete records (soft)", approve: "approve or reject change requests", request: "request updates/deletes (low-risk ones auto-approve)" };
    yield say(`You are **${u.name}**, role **${u.role}**. You can:\n` + ["read", "create", "update", "delete", "approve", "request"].filter(p => PERMS[u.role].includes(p)).map(p => `- ${can_[p]}`).join("\n") + (u.role !== "admin" ? "\n\nAdmin-only actions are refused for your role, and I'll offer a change request instead." : ""));
  } else if (kind === "kpi") { const [name, page, formula] = sl.kpi, v = DSX.kpiDictionary().find(k => k.kpi === name);
    yield say(`**${name}** = ${formula}. Current value: **${fmtv(v.value, v.fmt)}** (${v.window}). Shown on **${PAGE[page].title}**.`); yield card("chips", { items: [`Open ${PAGE[page].title}`, "List all KPIs"] }); }
};
H.widget = function* (ctx, sl) {
  const nw = new Set(sl.name.toLowerCase().match(/[a-z]+/g) || []); let best = null, sc = 0;
  for (const p of M.PAGES) for (const [wid, wtype, title] of p.widgets) { const tw = new Set(title.toLowerCase().match(/[a-z]+/g) || []); const score = [...tw].filter(w => nw.has(w)).length / (tw.size || 1) + (p.id === ctx.page ? 0.5 : 0); if (score > sc) { best = [p, wid, wtype, title]; sc = score; } }
  if (!best || sc < 0.5) { yield clarify("Which widget do you mean?", PAGE[ctx.page].widgets.slice(0, 5).map(w => `Explain the ${w[2]} widget`)); return; }
  const [p, wid, wtype, title] = best, d = P.data(p.id, p.id === ctx.page ? ctx.filters : {});
  const k = (d.kpis || []).find(x => x.id === wid), c_ = (d.charts || []).find(x => x.id === wid); let detail = "";
  if (k) detail = `Current value **${fmtv(k.value, k.fmt)}**` + (k.delta != null ? ` (${sign(k.delta)} vs previous period)` : "") + ".";
  else if (c_) { const v = c_.datasets[0].data; if (v.length) { let i = 0; v.forEach((x, j) => { if ((x || 0) > (v[i] || 0)) i = j; }); detail = `It plots ${v.length} points; highest is **${c_.labels[i]}**.`; } }
  else if (d.table && d.table.id === wid) detail = `It lists ${d.table.total} rows, columns: ${d.table.columns.map(c => c.label).join(", ")}.`;
  const kp = kpiLookup(title); yield nav(p.id, p.id === ctx.page ? ctx.filters : {}, null, wid);
  yield say(`**${title}** (${wtype}, \`${wid}\`) on **${p.title}**. ${detail}` + (kp ? ` Formula: ${kp[2]}.` : "")); if (c_) yield pageChartCard({ charts: [c_] });
};
H.insights = function* () {
  yield step("Comparing last month with the 3-month average for every region and category"); const ins = P.insights(5);
  if (!ins.length) { yield say("Nothing unusual: every region and category is within 8% of its 3-month average."); return; }
  yield say("**Agent noticed:**\n" + ins.map(i => `- **${i.title}** · ${i.body}`).join("\n")); yield card("chips", { items: ins.map(i => i.ask) });
};
H.clarify = function* (ctx, sl) {
  const w = sl.what, page = PAGE[ctx.page];
  if (w === "compare") yield clarify("What would you like to compare?", ["Compare revenue this month vs last month", "Compare revenue 2026 vs 2025", "Compare suppliers for Steel Rod", "Top 5 regions by revenue"]);
  else if (w === "sort") { const d = P.data(ctx.page, ctx.filters), cols = ((d.table || {}).columns || []).filter(c => ["inr", "int", "num", "days", "pct", "date"].includes(c.fmt)).slice(0, 4); yield clarify(`Sort ${page.title} by which column?`, cols.length ? cols.map(c => `sort by ${c.key.replace(/_/g, " ")} desc`) : ["Open Sales & Orders"]); }
  else if (w === "filter") yield clarify(`Which filter on ${page.title}?`, ["What filters can I use here?", ...page.suggestions.slice(0, 3)]);
  else yield clarify("Which report do you need?", ["Open Sales & Orders", "Open Finance", "Open Inventory", "Open Analytics", "Show last 12 months analysis"]);
};
H.explain_last = function* (ctx) {
  const last = LAST[ctx.user.username]; if (!last) { yield say("There's no previous answer in this session yet. Ask me something and then ask how I got it."); return; }
  const lines = [`For “${last.query}” I detected intent **${last.intent}**` + (PAGE[last.page] ? ` and opened **${PAGE[last.page].title}**` : "") + "."];
  if (last.filters && Object.keys(last.filters).length) lines.push("Filters applied: " + Object.entries(last.filters).map(([k, v]) => `${k}=${v}`).join(", ") + ".");
  if (last.steps.length) lines.push("Steps:\n" + last.steps.map((s_, i) => `${i + 1}. ${s_}`).join("\n"));
  lines.push("Every number was computed by queries on the live database (below), not written by a language model."); yield say(lines.join("\n\n"));
  if (last.sources.length) yield sourcesCard(last.sources.map(x => [x.label, x.sql]));
  else { const f = last.filters || {}, [a, b] = P.drange(f), ex_ = {}; for (const k of ["region", "category", "channel"]) if (f[k]) ex_[k] = f[k]; yield sourcesCard([["Equivalent query", salesSql(a, b, "revenue", ex_)]]); }
};
const LAST = {};
const PERIOD_RX = /\b(this|last|previous|prior|current) (week|month|quarter|year)\b|\blast \d+ (days?|weeks?|months?|years?|quarters?)\b|\bq[1-4]( 20\d\d)?\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*( 20\d\d)?\b|\b20\d\d\b|\bytd\b|\btoday\b|\byesterday\b|\b(vs|versus|compared (to|with))\b/g;
function substitute(lastq, x) {
  let q = NLU.norm(lastq); const orig = q, reg = NLU.region(x);
  if (reg) { let found = false; for (const k of Object.keys(REGION_ALIAS).sort((a, b) => b.length - a.length)) { const re = new RegExp(`\\b${reEsc(k)}\\b`); if (re.test(q)) { q = q.replace(re, reg.toLowerCase()); found = true; break; } } if (!found) q += ` in ${reg.toLowerCase()}`; }
  if (NLU.period(x)) { q = q.replace(PERIOD_RX, " ").replace(/\s+/g, " ").trim(); q += " " + x.trim().replace(/^(for|in|over|during)\s+/, ""); }
  const cat = NLU.category(x); if (cat) { const old = NLU.category(q); q = old ? q.replace(old.toLowerCase(), cat.toLowerCase()) : q + ` ${cat.toLowerCase()}`; }
  const prod = NLU.product(x); if (prod && !reg) { const op = NLU.product(q); q = op ? q.replace(op.name.toLowerCase(), prod.name.toLowerCase()) : q + ` for ${prod.name.toLowerCase()}`; }
  return q !== orig ? q : null;
}
function followup(query, ctx) {
  const t = NLU.norm(query.trim().replace(/[?.!]+$/, "")), last = LAST[ctx.user.username]; let m;
  if (/^(clear|reset|remove)( all)?( the)? filters?( please)?$/.test(t)) return { steps: [[query, { intent: "navigate", t, slots: { page: ctx.page, periods: [], force_filters: {}, note: "Cleared all filters." } }]] };
  if ((m = t.match(/^(?:only|just|filter (?:by|to|for|on)|limit (?:it )?to|restrict to|narrow (?:it )?to)\s+(.+)$/))) {
    const add = buildFilters(ctx.page, m[1], NLU.periods(m[1]));
    if (!Object.keys(add).length) return { steps: [[query, { intent: "clarify", t, slots: { what: "filter", periods: [] } }]] };
    return { steps: [[query, { intent: "navigate", t, slots: { page: ctx.page, periods: [], force_filters: { ...ctx.filters, ...add }, force_sort: null, note: "Kept current filters and added " + Object.entries(add).map(([k, v]) => `${k}=${v}`).join(", ") + "." } }]] };
  }
  m = t.match(/^(?:ok |okay |and |so )?(?:same|do the same|repeat that|the same)(?: thing| analysis| report)? (?:for|in|with|but for) (.+)$|^(?:what|how) about (.+)$|^(?:and|now) (?:for|in) (.+)$|^(?:and )?for (.+?) instead$/);
  if (m && last) {
    const x = m.slice(1).find(g => g);
    if (last.intent === "navigate" && PAGE[last.page]) {
      const keys = new Set(PAGE[last.page].filters.map(f => f.key)), nf = { ...(last.filters || {}) }, reg = NLU.region(x), cat = NLU.category(x), per = NLU.period(x);
      if (reg && keys.has("region")) nf.region = reg; if (cat && keys.has("category")) nf.category = cat; if (per && keys.has("date")) { nf.date_from = per[0]; nf.date_to = per[1]; }
      if (JSON.stringify(nf) !== JSON.stringify(last.filters || {})) return { steps: [[query, { intent: "navigate", t, slots: { page: last.page, periods: [], force_filters: nf, force_sort: null, note: `Same view as before with ${x}.` } }]] };
    }
    const nq = substitute(last.query, x); if (nq) return { steps: [[nq, route(nq)]], note: `Follow-up: re-ran “${last.query}” as “${nq}”.`, query: nq };
  }
  if ((m = t.match(/^(?:now|and|then|also|next)\s+(?:show|open|list|display|see|give)?\s*(?:me\s+)?(?:the\s+|my\s+)?(.+)$/)) && Object.keys(ctx.filters || {}).length) {
    const target = m[1], carry = Object.fromEntries(Object.entries(ctx.filters).filter(([k]) => ["date_from", "date_to", "region", "category", "channel", "segment"].includes(k)));
    const grp = [[/^products?\b|^items?\b/, "product"], [/^categor/, "category"], [/^regions?\b|^states?\b/, "region"], [/^channels?\b/, "channel"], [/^segments?\b/, "segment"]].find(([re]) => re.test(target));
    if (grp) { const g = grp[1], f = { ...Object.fromEntries(Object.entries(carry).filter(([k]) => k !== g)), metric: "revenue", group_by: g };
      return { steps: [[query, { intent: "navigate", t, slots: { page: "analytics", periods: [], force_filters: f, force_sort: "current:desc", note: "Kept your filters: " + (Object.entries(carry).map(([k, v]) => `${k}=${v}`).join(", ") || "none") + `; showing ${g}s.` } }]] }; }
    const [page] = detectPage(target);
    if (page && page !== ctx.page) { const keys = new Set(PAGE[page].filters.map(x => x.key)); if (keys.has("date")) { keys.add("date_from"); keys.add("date_to"); }
      const kept = Object.fromEntries(Object.entries(carry).filter(([k]) => keys.has(k))), dropped = Object.keys(carry).filter(k => !keys.has(k));
      const note = (Object.keys(kept).length ? "Kept: " + Object.entries(kept).map(([k, v]) => `${k}=${v}`).join(", ") : "No filters carried") + (dropped.length ? `. Dropped (not on ${PAGE[page].title}): ${dropped.join(", ")}.` : ".");
      return { steps: [[query, { intent: "navigate", t, slots: { page, periods: [], force_filters: { ...kept, ...buildFilters(page, target, NLU.periods(target)) }, note } }]] }; }
  }
  return null;
}
function* dispatch(plan, ctx, query) { const sl = { ...plan.slots, t: plan.t }; if (plan.intent === "unknown") yield* H.unknown(ctx, sl, query); else yield* H[plan.intent](ctx, sl); }
const SPLIT = /\s*(?:;|\band then\b|,\s*then\b|\bafter that\b|\bthen\b)\s*/i;
function planSteps(query) {
  const parts = query.split(SPLIT).map(p => p.trim().replace(/^[ ,.]+|[ ,.]+$/g, "")).filter(Boolean);
  if (parts.length < 2) return [[query, route(query)]];
  const plans = parts.map(p => [p, route(p)]);
  return plans.some(([, p]) => p.intent === "unknown") ? [[query, route(query)]] : plans;
}
function runAgent(query, ctx) {
  const t0 = performance.now(); let fixes = [];
  if (!/^\s*(sql\s*:|run sql|query\s*:|select\b|with\b)/i.test(query)) [query, fixes] = SPELL.correct(query);
  const fu = followup(query, ctx); if (fu && fu.query) query = fu.query;
  const stepsP = fu ? fu.steps : planSteps(query), multi = stepsP.length > 1;
  const plan = multi ? { intent: "multi:" + stepsP.map(([, p]) => p.intent).join("+") } : stepsP[0][1];
  const out = [{ t: "intent", intent: plan.intent }]; let page = ctx.page, steps = 0;
  if (fixes.length) out.push(step("Understood as: " + fixes.map(([a, b]) => `“${a}” → “${b}”`).join(", ")));
  if (fu && fu.note) out.push(step(fu.note));
  const trace = [], srcs = [], texts = []; let lastFilters = null;
  try {
    for (let i = 0; i < stepsP.length; i++) {
      const [text, pl] = stepsP[i];
      if (multi) { out.push(step(`Task ${i + 1}/${stepsP.length}: ${text}`)); steps++; }
      for (const ev of dispatch(pl, ctx, text)) { if (ev.t === "step") { steps++; trace.push(ev.text); } if (ev.t === "action" && ev.action === "navigate") { page = ev.page; lastFilters = ev.filters; ctx.trail && ctx.trail.push({ page: ctx.page, filters: ctx.filters }); ctx.page = ev.page; ctx.filters = ev.filters || {}; }
        if (ev.t === "card" && ev.card.type === "sources") srcs.push(...ev.card.items); if (ev.t === "text") texts.push(ev.text); out.push(ev); }
    }
  }
  catch (e) { out.push(say(`⛔ ${e.message}`)); console.error(e); }
  const ms = r1(performance.now() - t0);
  if (!["explain_last", "smalltalk", "meta", "help", "clarify", "refuse", "unknown", "export"].includes(plan.intent)) LAST[ctx.user.username] = { query, intent: plan.intent, page, filters: lastFilters, steps: trace, sources: srcs };
  const [conf, whyLow] = confidence(stepsP);
  agentWrites++; const logId = insert("agent_log", { ts: nowTs(), username: ctx.user.username, query: query.slice(0, 300), intent: plan.intent, page, latency_ms: ms, steps, used_llm: 0, confidence: conf, feedback: null });
  let reviewId = null;
  if (conf < M.REVIEW_CONFIDENCE) { agentWrites += 2; reviewId = queueReview(ctx.user, logId, query, plan.intent, page, texts.join(" "), conf, "auto", `Low confidence (${conf.toFixed(2)}): ${whyLow}`); out.push(step(`Low confidence (${conf.toFixed(2)}) — sent to an admin for human review (#${reviewId})`)); }
  out.push({ t: "done", intent: plan.intent, latency_ms: ms, page, log_id: logId, confidence: conf, review_id: reviewId }); return out;
}
function confidence(stepsP) {
  let worst = 1, why = "";
  for (const [, p] of stepsP) { let c = 1, w = "";
    if (p.intent === "unknown") { c = 0.2; w = "no rule or classifier match"; }
    else if (p.classified) { c = r2(Math.min(0.95, 0.35 + p.classified.score)); w = "understood by the semantic classifier, not an exact rule"; }
    else if (p.intent === "navigate" && (p.slots.conf ?? 1) < 0.5) { c = r2(0.3 + p.slots.conf); w = "page guessed by search, no exact keyword"; }
    if (c < worst) { worst = c; why = w; } }
  return [worst, why];
}
function confirmOp(token, u) {
  const p = PENDING[token]; delete PENDING[token];
  if (!p || p.user !== u.username) return [say("This confirmation expired. Ask again.")];
  const op = p.op, out = [];
  try {
    if (op.kind === "create") { const r = createRecord(u, op.entity, op.data, "agent"); out.push(say(`✅ Created **${recordLabel(op.entity, r)}**.`), nav(ENT[op.entity].page, op.entity === "purchase_orders" ? { status: r.status } : {})); }
    else if (op.kind === "bulk_create") { const made = op.items.map(d => createRecord(u, op.entity, d, "agent")); out.push(say(`✅ Created ${made.length} PO drafts: ${made.map(m => m.po_no).join(", ")}.` + (u.role !== "admin" ? " Admin approval needed to place them." : "")), nav("procurement", { status: "Draft" })); }
    else if (op.kind === "write") {
      const res = writeOrRequest(u, op.entity, op.id, op.action, op.changes, op.reason || "", "agent");
      const show = diff => { const v = recordView(op.entity, op.id, diff); if (v && !v.deleted) out.push({ t: "card", card: v }, nav(v.page, v.filters)); else out.push({ t: "action", action: "refresh" }); };
      if (res.mode === "applied") { out.push(say(`✅ ${op.action === "delete" ? "Deleted" : "Updated"} **${op.action === "delete" ? res.result.label : recordLabel(op.entity, res.result)}**. Audit-logged.`)); show(Object.fromEntries(Object.entries(op.changes || {}).map(([k, v]) => [k, { old: null, new: v }]))); }
      else if (res.mode === "auto_approved") { out.push(say(`✅ Change request **#${res.result.id}** **auto-approved by policy** and applied (${res.result.review_note.replace("Auto-approved: ", "")}).`)); show(JSON.parse(res.result.changes || "{}")); }
      else out.push(say(`📨 Change request **#${res.result.id}** submitted. It is above the auto-approval limits, so an admin will review it.`), nav("approvals", {}));
    }
    else if (op.kind === "review") { reviewRequest(u, op.req_id, op.decision, op.note || "", "agent"); out.push(say(`✅ Request #${op.req_id} ${op.decision === "approve" ? "approved and applied" : "rejected"}.`), nav("approvals", {})); }
    else if (op.kind === "review_all") { op.ids.forEach(i => reviewRequest(u, i, "approve", "bulk approve", "agent")); out.push(say(`✅ Approved ${op.ids.length} requests.`), nav("approvals", {})); }
    NLU.invalidate(); R.build();
  } catch (e) { out.push(say(`⛔ ${e.message}`)); }
  return out;
}

/* ================= Evaluation harness (same suites and scoring as eval/evaluate.py) ================= */
const EVAL = { last: (() => { try { return JSON.parse(localStorage.getItem("bizpilot_eval_v1")); } catch { return null; } })() };
EVAL.run = async function () {
  const E = M.EVAL, admin = { ...pubUser(DB.users.find(u => u.username === "admin")) };
  const snap = { db: structuredClone(DB), journal: [...journal], last: { ...LAST } };
  replaying = true;
  const ctx0 = () => ({ user: admin, page: "dashboard", filters: {}, trail: [{ page: "inventory", filters: {} }] });
  const auditMark = () => DB.audit_log.length ? Math.max(...DB.audit_log.map(a => a.id)) : 0;
  const wrote = m => DB.audit_log.filter(a => a.id > m && ["create", "update", "delete"].includes(a.action)).length;
  const run1 = (text, ctx) => { const t0 = performance.now(), evs = runAgent(text, ctx), ms = performance.now() - t0, navs = evs.filter(e => e.t === "action" && e.action === "navigate"), cards = evs.filter(e => e.t === "card").map(e => e.card);
    return { intent: evs[evs.length - 1].intent, page: navs.length ? navs[navs.length - 1].page : null, filters: navs.length ? navs[navs.length - 1].filters : {}, ms, steps: evs.filter(e => e.t === "step").length,
      tools: navs.length + cards.filter(c => ["chart", "table", "kpis", "sources", "record"].includes(c.type)).length, cards, evs }; };
  const clr = () => Object.keys(LAST).forEach(k => delete LAST[k]);
  const pctOf = xs => xs.length ? r1(100 * xs.filter(Boolean).length / xs.length) : null;
  try {
    const t0 = performance.now(), core = [], gen = [], typos = [], safety = [], follow = [], retr = [], anal = [];
    for (const it of E.core) { clr(); const mk = auditMark(), r = run1(it.utterance, ctx0()), f = r.filters;
      const okI = r.intent === it.intent, okP = it.page == null || r.page === it.page;
      const okF = Object.entries(it.filters).every(([k, v]) => String(f[k]) === String(v)) && (!it.has_date || "date_from" in f || ["why", "delays", "top", "expense_why"].includes(it.intent));
      core.push({ suite: "core", test: it.utterance, expected: it.intent, got: r.intent, intent_ok: okI, page_ok: okP, has_page: it.page != null, filters_ok: okF, has_filters: !!(Object.keys(it.filters).length || it.has_date),
        pass: okI && okP && okF, ms: r1(r.ms), steps: r.steps, tools: r.tools, unrequested_write: wrote(mk) > 0 && !["review", "review_all"].includes(r.intent), reason: [!okI && `intent ${r.intent}≠${it.intent}`, !okP && `page ${r.page}≠${it.page}`, !okF && `filters ${JSON.stringify(f)}`].filter(Boolean).join("; ") }); }
    for (const [name, set] of [["paraphrase", E.paraphrase], ["blind", E.blind]]) for (const it of set) { clr(); const r = run1(it.utterance, ctx0()), ok = r.intent === it.intent; gen.push({ suite: name, test: it.utterance, expected: it.intent, got: r.intent, pass: ok, ms: r1(r.ms), reason: ok ? "" : `got ${r.intent} / ${r.page}` }); }
    for (const it of E.typos) { clr(); const r = run1(it.utterance, ctx0()), ok = r.intent === it.intent && (it.page == null || r.page === it.page); typos.push({ suite: "typos", test: it.utterance, expected: it.intent, got: r.intent, pass: ok, ms: r1(r.ms), reason: ok ? "" : `${r.intent} / ${r.page}` }); }
    for (const it of E.safety) { clr(); const mk = auditMark(), r = run1(it.utterance, ctx0()), codes = r.cards.filter(c => c.type === "refusal").map(c => c.code);
      const ok = r.intent === it.intent && (it.code == null || codes.includes(it.code)), invalid = (it.intent === "refuse" && (r.page != null || wrote(mk) > 0)) || (it.intent === "clarify" && r.page != null);
      safety.push({ suite: "safety", test: it.utterance, expected: it.intent + (it.code ? ":" + it.code : ""), got: r.intent + (codes[0] ? ":" + codes[0] : ""), pass: ok && !invalid, invalid_action: invalid, kind: it.intent, ms: r1(r.ms), reason: ok ? "" : "wrong handling" }); }
    for (const it of E.followups) { clr(); const ctx = { user: admin, page: "dashboard", filters: {}, trail: [] }; let ms = 0, st = 0, r = null;
      for (const turn of it.turns) { r = run1(turn, ctx); ms += r.ms; st += r.steps; }
      let ok = true; if (it.page) ok = ok && ctx.page === it.page;
      if (it.filters) ok = ok && Object.entries(it.filters).every(([k, v]) => String(ctx.filters[k]) === String(v)) && (Object.keys(it.filters).length > 0 || !Object.keys(ctx.filters).filter(k => !["metric", "group_by"].includes(k)).length);
      if (it.intent) ok = ok && (r.intent === it.intent || r.intent.startsWith("multi"));
      follow.push({ suite: "multi_step", test: it.turns.join(" → "), expected: it.page || it.intent, got: `${ctx.page} ${JSON.stringify(ctx.filters)}`, pass: ok, ms: r1(ms), steps: st, reason: ok ? "" : "final state differs" }); }
    for (const it of E.retrieval) { const hits = R.search(it.query, 10, ["page", "widget"]), ranked = []; hits.forEach(h => { if (!ranked.includes(h.page)) ranked.push(h.page); });
      const rank = ranked.includes(it.page) ? ranked.indexOf(it.page) + 1 : null; retr.push({ suite: "retrieval", test: it.query, expected: it.page, got: ranked[0], pass: rank === 1, rank, reason: rank === 1 ? "" : `rank ${rank}` }); }
    if (DSX.init) await DSX.init;
    const regions = ["Karnataka", "Maharashtra", "Delhi", "Tamil Nadu", "Gujarat", "Telangana", "West Bengal"], months = ["January", "February", "March", "April", "May", "June", "July", "August", "September"], rng = RNG(3);
    const parseInr = x => { const m = String(x || "").match(/₹\s?([-\d,.]+)\s*(Cr|L)?/); if (!m) return null; return parseFloat(m[1].replace(/,/g, "")) * (m[2] === "Cr" ? 1e7 : m[2] === "L" ? 1e5 : 1); };
    for (let i = 0; i < 20; i++) { const reg = rng.choice(regions), m1 = rng.choice(months.slice(1)), m0 = months[months.indexOf(m1) - 1]; clr();
      const yr = D.y(today()) - (months.indexOf(m1) + 1 > D.m(today()) - 1 ? 1 : 0), r = run1(`compare revenue ${m1} ${yr} vs ${m0} ${yr} in ${reg}`, ctx0());
      const k = r.cards.find(c => c.type === "kpis"), src = r.cards.find(c => c.type === "sources"), mi = String(months.indexOf(m1) + 1).padStart(2, "0"), a = `${yr}-${mi}-01`, b = `${yr}-${mi}-31`;
      const truth = sum(DB.sales_orders.filter(x => x.order_date >= a && x.order_date <= b && x.region === reg && x.status !== "Cancelled" && !x.is_deleted), x => x.amount);
      const shown = k ? parseInr(k.items[0].value) : null; let sqlV = null; try { sqlV = src ? Object.values(DSX.sql(admin, src.items[0].sql).rows[0])[0] : null; } catch { }
      const okN = shown != null && truth && Math.abs(shown - truth) / truth <= 0.01, okS = sqlV != null && Math.abs(sqlV - truth) <= 1;
      const txt = r.evs.filter(e => e.t === "text").map(e => e.text).join(" "), nums = (txt.match(/₹\s?[-\d,.]+\s*(?:Cr|L)?/g) || []).map(parseInr), other = k ? parseInr(k.items[1].value) : 0;
      const faithful = nums.every(n => n == null || [truth, sqlV || 0, other || 0].some(v => Math.abs(n - v) / Math.max(Math.abs(v), 1) <= 0.01));
      anal.push({ suite: "analytical", test: `${reg}: ${m1} vs ${m0}`, expected: Math.round(truth), got: Math.round(shown || 0), pass: !!(okN && okS), faithful, reason: okN && okS ? "" : `shown ${shown}, sql ${sqlV}` }); }
    const lat = core.map(r => r.ms).sort((a, b) => a - b), ranks = retr.map(r => r.rank), mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
    const kpis = { "Intent-to-destination accuracy": pctOf(core.filter(r => r.has_page).map(r => r.page_ok)), "Intent accuracy (core)": pctOf(core.map(r => r.intent_ok)),
      "UI-state correctness (filters, dates, sort)": pctOf(core.filter(r => r.has_filters).map(r => r.filters_ok)), "Task success (core, strict)": pctOf(core.map(r => r.pass)), "Multi-step task success": pctOf(follow.map(r => r.pass)),
      "Avg steps per request": r2(mean(core.map(r => r.steps))), "Avg tool calls per request": r2(mean(core.map(r => r.tools))), "Latency p50 (ms)": r1(lat[Math.floor(lat.length / 2)]), "Latency p95 (ms)": r1(lat[Math.floor(lat.length * 0.95) - 1]),
      "Analytical correctness (within 1%)": pctOf(anal.map(r => r.pass)), "Explanation faithfulness": pctOf(anal.map(r => r.faithful)), "Retrieval precision@1": pctOf(ranks.map(r => r === 1)), "Retrieval recall@3": pctOf(ranks.map(r => r != null && r <= 3)),
      "Retrieval MRR": Math.round(1000 * sum(ranks.filter(Boolean), r => 1 / r) / ranks.length) / 1000, "Correct refusals": pctOf(safety.filter(r => r.kind === "refuse").map(r => r.pass)), "Correct clarifications": pctOf(safety.filter(r => r.kind === "clarify").map(r => r.pass)),
      "Meta / help answers": pctOf(safety.filter(r => !["refuse", "clarify"].includes(r.kind)).map(r => r.pass)), "Invalid actions executed": safety.filter(r => r.invalid_action).length + core.filter(r => r.unrequested_write).length,
      "Generalization: paraphrases (tuned on)": pctOf(gen.filter(r => r.suite === "paraphrase").map(r => r.pass)), "Generalization: blind set (never tuned)": pctOf(gen.filter(r => r.suite === "blind").map(r => r.pass)), "Typo robustness": pctOf(typos.map(r => r.pass)) };
    const all = [...core, ...gen, ...typos, ...safety, ...follow, ...retr, ...anal], suites = {};
    for (const r of all) { const x = suites[r.suite] = suites[r.suite] || { suite: r.suite, tests: 0, passed: 0 }; x.tests++; x.passed += r.pass ? 1 : 0; }
    Object.values(suites).forEach(x => x.rate = r1(100 * x.passed / x.tests));
    EVAL.last = { ran_at: nowTs().replace("T", " "), seconds: r1((performance.now() - t0) / 1000), kpis, suites: Object.values(suites), failures: all.filter(r => !r.pass), tests: all.length,
      note: "Test sets are synthetic and written by the BizPilot team. 'paraphrase' was used for tuning; 'blind' was never tuned on. Runs in your browser on a snapshot of the data; nothing you see in the app is changed." };
  } finally {
    TABLES.forEach(t => { DB[t] = snap.db[t]; IDX[t] = null; }); journal = snap.journal; Object.keys(LAST).forEach(k => delete LAST[k]); Object.assign(LAST, snap.last);
    replaying = false; VER++; PCACHE.clear(); NLU.invalidate(); R.build(); SPELL.V = null;
  }
  try { localStorage.setItem("bizpilot_eval_v1", JSON.stringify(EVAL.last)); } catch { }
  return EVAL.last;
};

/* ================= API router (same contract as the FastAPI server) ================= */
function publicMeta() {
  return { nav: M.NAV.map(g => ({ group: g.group, pages: g.pages.map(p => ({ id: p, title: PAGE[p].title, icon: PAGE[p].icon })) })),
    pages: M.PAGES.map(p => ({ ...p, widgets: p.widgets.map(w => ({ id: w[0], type: w[1], title: w[2] })) })), entities: ENT, apis: M.APIS, llm: { enabled: false, model: null }, mode: "browser", policy: M.APPROVAL_POLICY, policy_note: M.APPROVAL_POLICY_NOTE, targets: M.EVAL_TARGETS, quick_prompts: M.QUICK_PROMPTS, review_threshold: M.REVIEW_CONFIDENCE };
}
function handle(method, path, query, body, token) {
  const user = () => { const u = token ? verifyToken(token) : null; if (!u) throw new HttpErr(401, "Login required"); return u; };
  let m;
  if (method === "POST" && path === "/api/auth/signup") return signup(body.name, body.username, body.email, body.password, body.role);
  if (method === "POST" && path === "/api/auth/login") { const r = login(String(body.username || "").trim().toLowerCase(), body.password); if (!r) throw new HttpErr(401, "Invalid username or password"); return r; }
  if (path === "/api/health") return { ok: true, llm: false, mode: "browser" };
  const u = user();
  if (path === "/api/auth/me") return { user: u, permissions: [...PERMS[u.role]].sort() };
  if (path === "/api/meta") return publicMeta();
  if (path === "/api/admin/reset" && method === "POST") { if (u.role !== "admin") throw Denied("Admin only"); resetData(); return { ok: true }; }
  if ((m = path.match(/^\/api\/pages\/([a-z_]+)\/data$/))) { const f = { ...query }, s = f.sort || null; delete f.sort; return P.data(m[1], f, s); }
  if ((m = path.match(/^\/api\/refs\/([a-z_]+)$/))) return refOptions(m[1]);
  if ((m = path.match(/^\/api\/entities\/([a-z_]+)\/(\d+)$/))) {
    if (method === "GET") return { ...getRecord(m[1], +m[2]) };
    if (method === "PUT") { const r = updateRecord(u, m[1], +m[2], body); NLU.invalidate(); R.build(); return r; }
    if (method === "DELETE") { const r = deleteRecord(u, m[1], +m[2]); R.build(); return r; }
  }
  if ((m = path.match(/^\/api\/entities\/([a-z_]+)$/)) && method === "POST") { const r = createRecord(u, m[1], body); NLU.invalidate(); R.build(); return r; }
  if (path === "/api/requests" && method === "POST") return requestChange(u, body.entity, body.record_id, body.action, body.changes, body.reason || "");
  if (path === "/api/requests") return listRequests(u, query.status, query.mine === "true");
  if ((m = path.match(/^\/api\/requests\/(\d+)\/review$/))) { const r = reviewRequest(u, +m[1], body.decision, body.note || ""); NLU.invalidate(); R.build(); return r; }
  if (path === "/api/search") return R.search(query.q || "", 8);
  if (path === "/api/notifications/read") return markNotifications(u, body.ids);
  if (path === "/api/notifications") return listNotifications(u);
  if (path === "/api/eval/run") return { __async: EVAL.run() };
  if (path === "/api/eval/results") return EVAL.last || {};
  if (path === "/api/data/catalog") return { tables: DSX.catalog(), kpis: DSX.kpiDictionary(), sql_allowed: ["admin", "manager"].includes(u.role) };
  if ((m = path.match(/^\/api\/data\/table\/([a-z_]+)$/))) return DSX.browse(m[1], query.q, query.offset || 0, query.limit || 50, query.sort);
  if (path === "/api/data/sql") return { __async: (DSX.init || Promise.resolve()).then(() => DSX.sql(u, body.sql)) };
  if (path === "/api/requests/review-all") { const r = reviewMany(u, body.decision || "approve", null, body.note || ""); NLU.invalidate(); R.build(); return r; }
  if (path === "/api/agent/chat") { const pg = PAGE[body.page] ? body.page : "dashboard"; return { __stream: runAgent(String(body.message || ""), { user: u, page: pg, filters: body.filters || {}, trail: body.trail || [] }) }; }
  if (path === "/api/agent/confirm") return { events: confirmOp(body.token, u) };
  if (path === "/api/agent/route") return route(String(body.message || ""));
  if (path === "/api/agent/feedback") return feedback(u, body.log_id, body.vote, body.reason || "", body.answer || "", body.query || "");
  if ((m = path.match(/^\/api\/reviews\/(\d+)$/))) return reviewAnswer(u, +m[1], body.verdict, body.note || "");
  throw NotFound("Not found: " + path);
}

boot(); R.build(); DSX.start();
window.BizEngine = { handle, route, runAgent, P, DB, resetData, HttpErr };

/* fetch shim: /api/* is served in-page; everything else goes to the network */
const realFetch = window.fetch.bind(window);
window.fetch = async function (input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url, location.href);
  if (!url.pathname.startsWith("/api/") && !url.pathname.includes("/api/")) return realFetch(input, init);
  const path = url.pathname.slice(url.pathname.indexOf("/api/")), method = (init.method || "GET").toUpperCase();
  const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || "";
  const token = auth.replace("Bearer ", "").trim();
  let body = {}; try { body = init.body ? JSON.parse(init.body) : {}; } catch { }
  const query = Object.fromEntries(url.searchParams.entries());
  await new Promise(r => setTimeout(r, 0));
  try {
    let res = handle(method, path, query, body, token === "null" ? "" : token);
    if (res && res.__async) res = await res.__async;
    if (res && res.__stream) {
      const evs = res.__stream, enc = new TextEncoder();
      const stream = new ReadableStream({ async start(ctrl) { for (const ev of evs) { ctrl.enqueue(enc.encode(JSON.stringify(ev) + "\n")); await new Promise(r => setTimeout(r, ev.t === "step" ? 70 : 15)); } ctrl.close(); } });
      return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
    }
    return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    if (!(e instanceof HttpErr)) console.error(e);
    return new Response(JSON.stringify({ detail: e.message }), { status: e.status || 500, headers: { "content-type": "application/json" } });
  }
};
})();

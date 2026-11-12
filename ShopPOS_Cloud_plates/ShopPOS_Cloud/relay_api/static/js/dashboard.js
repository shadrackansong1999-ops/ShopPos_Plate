"use strict";

let trendChart = null, reportsChart = null;
let lastTrend = null, lastByDay = null;
let salesPage = 1, salesTotal = 0, salesPageSize = 50;
let logsPage = 1, logsTotal = 0, logsPageSize = 50;
let inventoryCache = [], invFilter = "all";

const $ = (id) => document.getElementById(id);

/* ── Formatting ───────────────────────────────────────────────────────── */
// Everything synced from a till (product names, customers, notes) is typed by
// staff, so it is escaped before going into HTML.
function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function money(n) {
  return (Number(n) || 0).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function ghs(n) { return "GH\u20B5" + money(n); }
function qty(n) { return (Number(n) || 0).toLocaleString("en-GH", { maximumFractionDigits: 2 }); }

function minutesSince(iso) {
  if (!iso) return Infinity;
  const then = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  return (Date.now() - then.getTime()) / 60000;
}
function timeAgo(iso) {
  if (!iso) return "never";
  const secs = Math.floor(minutesSince(iso) * 60);
  if (secs < 60) return "just now";
  if (secs < 3600) return Math.floor(secs / 60) + "m ago";
  if (secs < 86400) return Math.floor(secs / 3600) + "h ago";
  return Math.floor(secs / 86400) + "d ago";
}
function localIso(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
// "Today 14:32", "Yesterday 09:10", "9 Nov 16:45". Parsed from the string so
// the shop's own clock time is shown, not converted to the viewer's zone.
function fmtDateTime(s) {
  if (!s) return "-";
  const day = s.slice(0, 10), time = s.slice(11, 16);
  const now = new Date(), y = new Date(); y.setDate(now.getDate() - 1);
  if (day === localIso(now)) return "Today " + time;
  if (day === localIso(y)) return "Yesterday " + time;
  const d = new Date(day + "T00:00:00");
  if (isNaN(d)) return s.slice(0, 16).replace("T", " ");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + " " + time;
}
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

/* ── Tables ───────────────────────────────────────────────────────────── */
function setTable(tableId, emptyId, rows, rowFn) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  const empty = $(emptyId);
  const table = $(tableId);
  tbody.innerHTML = rows.map(rowFn).join("");
  if (table) table.closest(".tbl-wrap").classList.toggle("hidden", !rows.length);
  if (empty) empty.classList.toggle("hidden", rows.length > 0);
}
// Shimmer rows while a table loads for the first time (not on 15s refreshes)
function setLoading(tableId) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  if (!tbody || tbody.children.length) return;
  const widths = ["86%", "64%", "75%", "52%"];
  tbody.innerHTML = widths.map((w) =>
    `<tr class="sk"><td colspan="9"><div class="skeleton-row" style="width:${w}"></div></td></tr>`).join("");
}
function pill(kind, text) { return `<span class="pill ${kind}">${esc(text)}</span>`; }

/* ── Sync status ──────────────────────────────────────────────────────── */
function setSync(lastSeen) {
  const el = $("last-seen"), txt = $("sync-text");
  const mins = minutesSince(lastSeen);
  let state, msg;
  if (!lastSeen) { state = "none"; msg = "Waiting for first sync"; }
  else if (mins < 5) { state = "fresh"; msg = "Synced " + timeAgo(lastSeen); }
  else if (mins < 60) { state = "stale"; msg = "Last synced " + timeAgo(lastSeen); }
  else { state = "off"; msg = "No sync for " + timeAgo(lastSeen).replace(" ago", "") + ". Check the till is on and online."; }
  el.dataset.state = state;
  txt.textContent = msg;
}

/* ── Themes and sheets ────────────────────────────────────────────────── */
function buildThemeSheet() {
  const groups = [["Light", "light"], ["Dark", "dark"]];
  $("theme-groups").innerHTML = groups.map(([label, mode]) => `
    <h3>${label}</h3>
    <div class="theme-grid">
      ${ShopTheme.list.filter((t) => t.mode === mode).map((t) => `
        <button class="theme-tile" data-theme="${t.id}" aria-pressed="false">
          <span class="swatches" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
          <span class="nm">${esc(t.name)}<svg class="check" aria-hidden="true"><use href="#i-check"/></svg></span>
        </button>`).join("")}
    </div>`).join("");
  $("theme-groups").addEventListener("click", (e) => {
    const b = e.target.closest(".theme-tile");
    if (b) ShopTheme.set(b.dataset.theme);
  });
}
function syncThemeUI() {
  const id = ShopTheme.get();
  document.querySelectorAll(".theme-tile").forEach((t) => t.setAttribute("aria-pressed", String(t.dataset.theme === id)));
}
document.addEventListener("themechange", () => {
  syncThemeUI();
  if (lastTrend) renderTrend(lastTrend);
  if (lastByDay) renderReportsChart(lastByDay);
});

function openSheet(id) {
  closeSheets();
  const d = $(id);
  if (d && !d.open) d.showModal();
}
function closeSheets() { document.querySelectorAll("dialog.sheet[open]").forEach((d) => d.close()); }
document.addEventListener("click", (e) => {
  // a click on the dimmed backdrop (the <dialog> itself) closes the sheet
  if (e.target.matches && e.target.matches("dialog.sheet")) e.target.close();
  const shop = e.target.closest && e.target.closest("[data-shop]");
  if (shop && shop.closest("#sheet-shops")) switchShop(shop.dataset.shop);
});

function switchShop(shopId) {
  if (!shopId || shopId === SHOP_ID) { closeSheets(); return; }
  const url = new URL(window.location.href);
  url.searchParams.set("shop", shopId);
  window.location.href = url.toString();
}

/* ── Tabs ─────────────────────────────────────────────────────────────── */
const TAB_LOADERS = {
  overview: refreshOverview,
  sales: () => loadSales(1),
  inventory: loadInventory,
  logs: () => loadLogs(1),
  users: loadUsers,
  reports: loadReports,
  allshops: loadAllShops,
};
const MORE_TABS = ["logs", "users", "allshops"];
let activeTab = "overview";

function showTab(name, opts) {
  if (!TAB_LOADERS[name] || !$("panel-" + name)) name = "overview";
  activeTab = name;
  document.querySelectorAll("[data-tab]").forEach((b) => {
    if (b.dataset.tab === name) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  const more = $("tab-more");
  if (more) { if (MORE_TABS.includes(name)) more.setAttribute("aria-current", "page"); else more.removeAttribute("aria-current"); }
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.id !== `panel-${name}`));
  $("page-title").textContent = TAB_TITLES[name] || "";
  if (!(opts && opts.noHistory)) history.pushState({ tab: name }, "", "#" + name);
  window.scrollTo(0, 0);
  TAB_LOADERS[name]();
}
window.addEventListener("popstate", () => showTab((location.hash || "#overview").slice(1), { noHistory: true }));

function refreshActiveTab() {
  const b = $("refresh-btn");
  b.classList.remove("spin"); void b.offsetWidth; b.classList.add("spin");
  TAB_LOADERS[activeTab]();
}

/* ── Date ranges: quick chips + manual dates, applied as soon as they change */
function rangeDates(key) {
  const to = new Date(), from = new Date();
  if (key === "month") from.setDate(1);
  else if (key === "today") { /* same day */ }
  else from.setDate(to.getDate() - (Number(key) - 1));
  return [localIso(from), localIso(to)];
}
const RANGE_LOADERS = { sales: () => loadSales(1), logs: () => loadLogs(1), reports: loadReports };

function markChips(prefix, key) {
  document.querySelectorAll(`[data-range="${prefix}"] .chip`).forEach((c) =>
    c.setAttribute("aria-pressed", String(c.dataset.key === key)));
}
function applyRange(prefix, key) {
  const [from, to] = rangeDates(key);
  $(`${prefix}-from`).value = from;
  $(`${prefix}-to`).value = to;
  markChips(prefix, key);
  RANGE_LOADERS[prefix]();
}
function rangeEdited(prefix) {
  const f = $(`${prefix}-from`), t = $(`${prefix}-to`);
  if (!f.value || !t.value) return;
  if (f.value > t.value) { const x = f.value; f.value = t.value; t.value = x; }
  markChips(prefix, null);
  RANGE_LOADERS[prefix]();
}
document.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-range] .chip");
  if (chip) applyRange(chip.closest("[data-range]").dataset.range, chip.dataset.key);
});
(function initDates() {
  const [from, to] = rangeDates("30");
  for (const p of ["sales", "logs", "reports"]) { $(`${p}-from`).value = from; $(`${p}-to`).value = to; }
})();

/* ── Network (with offline fallback) ──────────────────────────────────── */
function setOfflineBanner(show, when) {
  const el = $("offline-banner");
  if (!el) return;
  if (show) {
    el.textContent = `Offline. Showing data saved from ${when ? new Date(when).toLocaleString() : "an earlier visit"}.`;
    el.classList.remove("hidden");
  } else el.classList.add("hidden");
}
async function apiGet(path, params) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("shop_id", SHOP_ID);
  for (const k in (params || {})) url.searchParams.set(k, params[k]);
  const key = url.pathname + url.search;
  try {
    const r = await fetch(url);
    const d = await r.json();
    if (d && d.ok) { setOfflineBanner(false); idbSet(key, d); }
    return d;
  } catch (networkError) {
    const cached = await idbGet(key);
    if (cached) { setOfflineBanner(true, cached.ts); return cached.data; }
    setOfflineBanner(true);
    return { ok: false, error: "Offline, and no saved data for this view yet" };
  }
}

/* ── Overview ─────────────────────────────────────────────────────────── */
function renderTrend(trend) {
  lastTrend = trend;
  if (typeof Chart === "undefined") return;
  const ink = cssVar("--on-p1"), mute = cssVar("--mute-p1");
  const ctx = $("trend-chart").getContext("2d");
  if (trendChart) trendChart.destroy();
  Chart.defaults.font.family = "Inter, system-ui, sans-serif";
  trendChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: trend.map((t) => t.date.slice(5)),
      datasets: [{ label: "Revenue", data: trend.map((t) => t.total_revenue), borderColor: ink,
        backgroundColor: ink + "26", fill: true, tension: 0.35, borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 5, pointBackgroundColor: ink }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false },
        tooltip: { displayColors: false, callbacks: { label: (c) => ghs(c.parsed.y) } } },
      scales: { x: { grid: { display: false }, border: { display: false }, ticks: { color: mute, maxTicksLimit: 6, maxRotation: 0 } },
                y: { display: false, beginAtZero: true } },
    },
  });
}

async function refreshOverview() {
  setLoading("recent-table"); setLoading("cashier-table");
  const d = await apiGet("/api/dashboard/data");
  if (!d.ok) { if (d.error === "Not authenticated") window.location.href = "/login"; return; }

  setSync(d.last_seen);
  $("kpi-revenue").textContent = money(d.today.revenue);
  $("kpi-sales").textContent = d.today.num_sales;
  $("kpi-discounts").textContent = money(d.today.discounts);
  $("kpi-lowstock").textContent = d.low_stock_count;

  // Yesterday's total as a plain fact. A percentage would compare a part-day
  // with a full day and mislead.
  const y = new Date(); y.setUTCDate(y.getUTCDate() - 1);
  const prev = d.trend.find((t) => t.date === y.toISOString().slice(0, 10));
  const yp = $("kpi-yesterday");
  yp.classList.toggle("hidden", !prev);
  if (prev) yp.textContent = "Yesterday " + ghs(prev.total_revenue);

  renderTrend(d.trend);

  const plate = $("stock-plate");
  plate.classList.toggle("warn", d.low_stock_count > 0);
  plate.classList.toggle("p2", d.low_stock_count === 0);
  $("lowstock-list").innerHTML = d.low_stock.slice(0, 4).map((p) =>
    `<li><span>${esc(p.name || "-")}</span>${pill(p.quantity <= 0 ? "bad" : "", qty(p.quantity) + " " + (p.unit || "left"))}</li>`).join("");
  $("lowstock-empty").classList.toggle("hidden", d.low_stock_count > 0);

  setTable("cashier-table", "cashier-empty", d.today.by_cashier, (c) => `
    <tr><td class="c-title">${esc(c.cashier || "-")}</td><td class="c-sub" data-label="Sales">${esc(c.txn)}</td><td class="num c-amount">${ghs(c.revenue)}</td></tr>`);

  setTable("recent-table", "recent-empty", d.recent_sales, (s) => `
    <tr>
      <td class="c-title">${esc(s.invoice_number || "-")}</td>
      <td class="c-sub">${esc(s.customer_name || "Walk-in")}</td>
      <td class="c-sub" data-label="Cashier">${esc(s.cashier || "-")}</td>
      <td class="c-sub">${esc(s.payment_method || "-")}</td>
      <td class="c-sub nowrap">${esc(fmtDateTime(s.created_at))}</td>
      <td class="num c-amount">${ghs(s.total)}</td>
    </tr>`);
}

function openStock(filter) {
  setInvFilter(filter);
  showTab("inventory");
}

/* ── Sales history ────────────────────────────────────────────────────── */
async function loadSales(page) {
  salesPage = page;
  setLoading("sales-table");
  const d = await apiGet("/api/dashboard/sales", { from: $("sales-from").value, to: $("sales-to").value, page, page_size: salesPageSize });
  if (!d.ok) return;
  salesTotal = d.total;
  setTable("sales-table", "sales-empty", d.sales, (s) => `
    <tr>
      <td class="c-title">${esc(s.invoice_number || "-")}</td>
      <td class="c-sub">${esc(s.customer_name || "Walk-in")}</td>
      <td class="c-sub" data-label="Cashier">${esc(s.cashier || "-")}</td>
      <td class="c-sub">${esc(s.payment_method || "-")}</td>
      <td class="c-sub nowrap">${esc(fmtDateTime(s.created_at))}</td>
      <td class="num c-extra">${ghs(s.subtotal)}</td>
      <td class="num c-extra">${ghs(s.discount)}</td>
      <td class="num c-amount">${ghs(s.total)}</td>
      <td class="c-pill">${pill(s.status === "completed" ? "ok" : s.status === "voided" ? "bad" : "warn", s.status || "-")}</td>
    </tr>`);
  setPager("sales", salesPage, salesTotal, salesPageSize, "sale");
}
function setPager(prefix, page, total, size, noun) {
  const pages = Math.max(1, Math.ceil(total / size));
  $(`${prefix}-pageinfo`).textContent = total ? `Page ${page} of ${pages}, ${total} ${noun}${total === 1 ? "" : "s"}` : "";
  $(`${prefix}-prev`).disabled = page <= 1;
  $(`${prefix}-next`).disabled = page >= pages;
  document.querySelector(`#panel-${prefix} .pager`).classList.toggle("hidden", total <= size);
}
function pageSales(delta) {
  const pages = Math.max(1, Math.ceil(salesTotal / salesPageSize));
  const next = Math.min(pages, Math.max(1, salesPage + delta));
  if (next !== salesPage) { loadSales(next); window.scrollTo(0, 0); }
}

/* ── Inventory ────────────────────────────────────────────────────────── */
async function loadInventory() {
  setLoading("inventory-table");
  const d = await apiGet("/api/dashboard/inventory");
  if (!d.ok) return;
  inventoryCache = d.inventory;
  renderInventory();
}
function setInvFilter(f) {
  invFilter = f;
  document.querySelectorAll("#inv-chips .chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.f === f)));
  renderInventory();
}
document.addEventListener("click", (e) => {
  const c = e.target.closest("#inv-chips .chip");
  if (c) setInvFilter(c.dataset.f);
});
function stockState(p) {
  if ((p.quantity || 0) <= 0) return "out";
  return p.quantity <= (p.reorder_level || 0) ? "low" : "ok";
}
function renderInventory() {
  const q = ($("inv-search").value || "").toLowerCase();
  const counts = { all: inventoryCache.length, low: 0, out: 0 };
  inventoryCache.forEach((p) => { const s = stockState(p); if (s === "out") counts.out++; if (s !== "ok") counts.low++; });
  const labels = { all: "All", low: "Low", out: "Out of stock" };
  document.querySelectorAll("#inv-chips .chip").forEach((c) => {
    c.textContent = inventoryCache.length ? `${labels[c.dataset.f]} ${counts[c.dataset.f]}` : labels[c.dataset.f];
  });
  let rows = inventoryCache;
  if (q) rows = rows.filter((p) => (p.name || "").toLowerCase().includes(q) || (p.sku || "").toLowerCase().includes(q));
  if (invFilter === "low") rows = rows.filter((p) => stockState(p) !== "ok");
  if (invFilter === "out") rows = rows.filter((p) => stockState(p) === "out");
  $("inventory-empty-msg").textContent = inventoryCache.length
    ? "No products match. Clear the search or switch the stock filter."
    : "Inventory appears after the till's next sync.";
  setTable("inventory-table", "inventory-empty", rows, (p) => {
    const s = stockState(p);
    return `<tr>
      <td class="c-title">${esc(p.name || "-")}</td>
      <td class="c-sub">${esc(p.sku || "-")}</td>
      <td class="num c-sub" data-label="Qty">${qty(p.quantity)}</td>
      <td class="num c-extra">${esc(p.reorder_level)}</td>
      <td class="c-extra">${esc(p.unit || "-")}</td>
      <td class="num c-amount">${ghs(p.selling_price)}</td>
      <td class="c-pill">${pill(s === "ok" ? "ok" : s === "out" ? "bad" : "warn", s === "ok" ? "In stock" : s === "out" ? "Out" : "Low")}</td>
    </tr>`;
  });
}

/* ── Product logs ─────────────────────────────────────────────────────── */
async function loadLogs(page) {
  logsPage = page;
  setLoading("logs-table");
  const d = await apiGet("/api/dashboard/product-logs", { from: $("logs-from").value, to: $("logs-to").value, page, page_size: logsPageSize });
  if (!d.ok) return;
  logsTotal = d.total;
  setTable("logs-table", "logs-empty", d.logs, (m) => `
    <tr>
      <td class="c-title">${esc(m.product_name || "-")}</td>
      <td class="c-pill">${pill("", m.movement_type || "-")}</td>
      <td class="c-sub">${esc(m.reference || "")}</td>
      <td class="c-sub">${esc(m.notes || "")}</td>
      <td class="c-sub nowrap">${esc(fmtDateTime(m.created_at))}</td>
      <td class="num c-amount">${qty(m.quantity)}</td>
    </tr>`);
  setPager("logs", logsPage, logsTotal, logsPageSize, "entr");
  $("logs-pageinfo").textContent = logsTotal ? `Page ${logsPage} of ${Math.max(1, Math.ceil(logsTotal / logsPageSize))}, ${logsTotal} ${logsTotal === 1 ? "entry" : "entries"}` : "";
}
function pageLogs(delta) {
  const pages = Math.max(1, Math.ceil(logsTotal / logsPageSize));
  const next = Math.min(pages, Math.max(1, logsPage + delta));
  if (next !== logsPage) { loadLogs(next); window.scrollTo(0, 0); }
}

/* ── Users ────────────────────────────────────────────────────────────── */
async function loadUsers() {
  setLoading("users-table");
  const d = await apiGet("/api/dashboard/users");
  if (!d.ok) return;
  setTable("users-table", "users-empty", d.users, (u) => `
    <tr>
      <td class="c-title">${esc(u.username || "-")}</td>
      <td class="c-sub">${esc(u.full_name || "-")}</td>
      <td class="c-sub">${esc(u.role || "-")}</td>
      <td class="c-sub nowrap" data-label="Last login">${u.last_login ? esc(fmtDateTime(u.last_login)) : "never"}</td>
      <td class="c-pill">${pill(u.is_active ? "ok" : "bad", u.is_active ? "Active" : "Inactive")}</td>
    </tr>`);
}

/* ── Reports ──────────────────────────────────────────────────────────── */
function renderReportsChart(byDay) {
  lastByDay = byDay;
  if (typeof Chart === "undefined") return;
  const ctx = $("reports-chart").getContext("2d");
  if (reportsChart) reportsChart.destroy();
  const mute = cssVar("--paper-mute"), edge = cssVar("--paper-edge");
  reportsChart = new Chart(ctx, {
    type: "bar",
    data: { labels: byDay.map((r) => r.date.slice(5)),
      datasets: [{ label: "Revenue", data: byDay.map((r) => r.total_revenue), backgroundColor: cssVar("--accent"), borderRadius: 6, maxBarThickness: 28 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { displayColors: false, callbacks: { label: (c) => ghs(c.parsed.y) } } },
      scales: { x: { grid: { display: false }, border: { display: false }, ticks: { color: mute, maxTicksLimit: 8, maxRotation: 0 } },
                y: { beginAtZero: true, border: { display: false }, grid: { color: edge }, ticks: { color: mute, maxTicksLimit: 5 } } },
    },
  });
}
async function loadReports() {
  setLoading("payment-table"); setLoading("top-products-table");
  const d = await apiGet("/api/dashboard/reports", { from: $("reports-from").value, to: $("reports-to").value });
  if (!d.ok) return;

  $("rep-revenue").textContent = money(d.totals.revenue);
  $("rep-sales").textContent = d.totals.num_sales;
  $("rep-discounts").textContent = money(d.totals.discounts);
  renderReportsChart(d.by_day);

  const payTotal = d.by_payment.reduce((a, p) => a + p.revenue, 0) || 1;
  setTable("payment-table", "payment-empty", d.by_payment, (p) => {
    const share = Math.round((p.revenue / payTotal) * 100);
    return `<tr>
      <td class="c-title">${esc(p.method)}</td>
      <td class="c-sub" style="min-width:7rem"><div class="meter" role="img" aria-label="${share} percent"><span style="width:${share}%"></span></div></td>
      <td class="num c-amount">${ghs(p.revenue)}</td></tr>`;
  });
  setTable("top-products-table", "top-products-empty", d.top_products, (p) => `
    <tr><td class="c-title">${esc(p.product_name)}</td><td class="num c-sub" data-label="Sold">${qty(p.qty)}</td><td class="num c-amount">${ghs(p.revenue)}</td></tr>`);
}

/* ── All shops ────────────────────────────────────────────────────────── */
async function loadAllShops() {
  const grid = $("allshops-grid");
  if (!grid) return;
  const d = await apiGet("/api/dashboard/all-shops");
  if (!d.ok) return;
  $("allshops-empty").classList.toggle("hidden", d.shops.length > 0);
  const tones = ["p1", "p2", "p3"];
  grid.innerHTML = d.shops.map((s, i) => `
    <button class="plate shop-card ${tones[i % 3]}" data-shop="${esc(s.shop_id)}">
      <h3>${esc(s.shop_name)}</h3>
      <span class="plate-note" style="margin:0">${s.shop_id === SHOP_ID ? "Viewing now. " : ""}Synced ${timeAgo(s.last_seen)}</span>
      ${s.low_stock_count > 0 ? `<span><span class="pill">${s.low_stock_count} low on stock</span></span>` : ""}
      <p class="kpi-num"><span class="cur">GH&#8373;</span>${money(s.today_revenue)}</p>
      <span class="plate-note" style="margin:0">${s.today_sales} sale${s.today_sales === 1 ? "" : "s"} today</span>
    </button>`).join("");
  grid.querySelectorAll(".shop-card").forEach((c) => c.addEventListener("click", () => switchShop(c.dataset.shop)));
}

/* ── Storage durability check ────────────────────────────────────────── */
fetch("/api/health").then((r) => r.json()).then((d) => {
  if (d.ok && d.durable === false) $("durability-warning").classList.remove("hidden");
}).catch(() => {});

/* ── Boot ─────────────────────────────────────────────────────────────── */
buildThemeSheet();
syncThemeUI();
showTab((location.hash || "#overview").slice(1), { noHistory: true });
setInterval(() => { if (activeTab === "overview" && !document.hidden) refreshOverview(); }, 15000);

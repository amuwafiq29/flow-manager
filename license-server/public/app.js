// FlowManager Admin Dashboard (vanilla, tanpa build)
const $ = (id) => document.getElementById(id);
function showFatal(msg) {
  let el = document.getElementById("fatal-error");
  if (!el) {
    el = document.createElement("div");
    el.id = "fatal-error";
    el.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:999;background:#ffebee;color:#b71c1c;border:1px solid #ef9a9a;border-radius:12px;padding:10px 14px;font-size:12px;white-space:pre-wrap";
    document.body.appendChild(el);
  }
  el.textContent = "Error: " + msg;
}
window.addEventListener("error", (e) => showFatal(String((e && e.message) || e)));
window.addEventListener("unhandledrejection", (e) => {
  const r = e && e.reason;
  showFatal("Async: " + String((r && (r.stack || r.message)) || r));
});
const api = async (method, path, body) => {
  const r = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch {}
  if (r.status === 401 && !path.startsWith("/admin/login")) { showLogin(); throw new Error("unauthorized"); }
  if (!r.ok) throw new Error((data && data.error) || ("HTTP " + r.status));
  return data;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? "—" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};
const GRACE_MS = 30 * 86400000;
function statusOf(l, now) {
  if (l.consumed) return ["consumed", "Consumed", "b-grey"];
  if (l.revoked) return ["revoked", "Revoked", "b-red"];
  if (l.lifetime) return ["lifetime", "Lifetime", "b-purple"];
  if (!l.expiresAt) return ["active", "Active", "b-green"];
  const exp = new Date(l.expiresAt).getTime();
  if (exp > now) return exp - now <= 7 * 86400000 ? ["expiring", "Expiring ≤7d", "b-yellow"] : ["active", "Active", "b-green"];
  return now - exp <= GRACE_MS ? ["expired", "Expired (revivable)", "b-yellow"] : ["dead", "Dead", "b-grey"];
}

let licenses = [];
let plans = [];
let currentKey = null;

function showLogin() {
  $("login-view").hidden = false;
  $("app-view").hidden = true;
}
function showApp(user) {
  $("login-view").hidden = true;
  $("app-view").hidden = false;
  $("admin-user").textContent = user;
}

async function boot() {
  try {
    const me = await api("GET", "/admin/me");
    showApp(me.user);
    await refreshAll();
  } catch (err) {
    if (String((err && err.message) || err) !== "unauthorized") showFatal("boot: " + String((err && err.message) || err));
    showLogin();
  }
}

async function refreshAll() {
  try {
    const [st, lic, pl] = await Promise.all([
      api("GET", "/admin/stats"),
      api("GET", "/admin/licenses"),
      api("GET", "/admin/plans"),
    ]);
    plans = pl.plans;
    renderStats(st.stats);
    licenses = lic.licenses;
    renderPlanFilter();
    renderTable();
    renderPlans();
  } catch (err) {
    showFatal("refresh: " + String((err && err.message) || err));
    throw err;
  }
}

function renderStats(s) {
  const cards = [
    ["Active", s.active, "b-green"], ["Expiring ≤7d", s.expiring7d, "b-yellow"],
    ["Revivable", s.expiredRevivable, "b-yellow"], ["Dead", s.dead, "b-grey"],
    ["Revoked", s.revoked, "b-red"], ["Lifetime", s.lifetime, "b-purple"],
  ];
  $("stats").innerHTML = cards.map(([l, v]) => `<div class="card"><b>${v}</b><span>${l}</span></div>`).join("");
}

function renderPlanFilter() {
  const sel = $("filter-plan");
  const cur = sel.value;
  sel.innerHTML = '<option value="">Semua plan</option>' + plans.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  sel.value = cur;
}

function filtered() {
  const q = $("search").value.trim().toLowerCase();
  const fp = $("filter-plan").value;
  const fs = $("filter-status").value;
  const now = Date.now();
  return licenses
    .filter((l) => !fp || l.plan === fp)
    .filter((l) => !fs || statusOf(l, now)[0] === fs)
    .filter((l) => !q || l.key.toLowerCase().includes(q) || (l.buyer || "").toLowerCase().includes(q) || (l.telegram || "").toLowerCase().includes(q))
    .sort((a, b) => (a.expiresAt || "9").localeCompare(b.expiresAt || "9"));
}

function renderTable() {
  const now = Date.now();
  $("license-rows").innerHTML = filtered().map((l) => {
    const [code, label, cls] = statusOf(l, now);
    return `<tr>
      <td class="mono">${esc(l.key)}</td>
      <td>${esc(l.buyer || "—")}<br><small style="color:var(--muted)">${esc(l.telegram || "")}</small></td>
      <td>${esc(l.plan)}</td>
      <td><span class="badge ${cls}">${label}</span></td>
      <td>${fmtDate(l.expiresAt)}${l.lifetime ? " (∞)" : ""}</td>
      <td class="mono">${l.boundDeviceId ? esc(l.boundDeviceId.slice(0, 8)) + "…" : "—"}</td>
      <td><div class="row-actions">
        <button class="secondary sm" data-act="open" data-key="${esc(l.key)}">Detail</button>
      </div></td>
    </tr>`;
  }).join("") || `<tr><td colspan="7" style="text-align:center;color:var(--muted)">Tidak ada data.</td></tr>`;
  $("license-rows").querySelectorAll("[data-act=open]").forEach((b) =>
    b.addEventListener("click", () => openDrawer(b.dataset.key)));
}

function findKey(k) { return licenses.find((l) => l.key === k); }

function openDrawer(key) {
  currentKey = key;
  const l = findKey(key);
  if (!l) return;
  const now = Date.now();
  const [code, label, cls] = statusOf(l, now);
  $("drawer-title").textContent = key;
  $("drawer-body").innerHTML = `<dl class="kv">
    <dt>Status</dt><dd><span class="badge ${cls}">${label}</span></dd>
    <dt>Plan</dt><dd>${esc(l.plan)}${l.lifetime ? " (lifetime)" : ""}</dd>
    <dt>Expires</dt><dd>${fmtDate(l.expiresAt)}${l.lifetime ? " — never" : ""}</dd>
    <dt>Buyer</dt><dd>${esc(l.buyer || "—")} ${esc(l.telegram || "")}</dd>
    <dt>Note</dt><dd>${esc(l.note || "—")}</dd>
    <dt>Device</dt><dd class="mono">${esc(l.boundDeviceId || "—")}</dd>
    <dt>Created</dt><dd>${fmtDate(l.createdAt)}</dd>
    <dt>Fails</dt><dd>${l.failedAttempts || 0}${l.lastFailAt ? " (last " + fmtDate(l.lastFailAt) + ")" : ""}</dd>
  </dl>`;
  const rev = $("act-revoke");
  rev.textContent = l.revoked ? "Unrevoke" : "Revoke";
  rev.className = l.revoked ? "secondary sm" : "danger sm";
  $("drawer-history").innerHTML = (l.history || []).slice().reverse().map((h) =>
    `<li><b>${esc(h.action)}</b> · ${esc(h.by || "")} · ${fmtDate(h.at)}${h.detail ? " · " + esc(h.detail) : ""}</li>`
  ).join("") || "<li>Tidak ada history.</li>";
  $("drawer").hidden = false;
}

// modal generik: field [{id,label,value,placeholder,type,options[]}]
// type "select" -> dropdown dari options [{value,label}] atau [string]
function modal(title, fields) {
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = fields.map((f) => {
    if (f.type === "select") {
      const opts = (f.options || []).map((o) => {
        const v = typeof o === "string" ? o : o.value;
        const l = typeof o === "string" ? o : (o.label || o.value);
        return `<option value="${esc(v)}"${String(v) === String(f.value) ? " selected" : ""}>${esc(l)}</option>`;
      }).join("");
      return `<label>${esc(f.label)}<select id="mf-${f.id}">${opts}</select></label>`;
    }
    return `<label>${esc(f.label)}<input id="mf-${f.id}" value="${esc(f.value ?? "")}" placeholder="${esc(f.placeholder || "")}" ${f.type ? `type="${f.type}"` : ""} /></label>`;
  }).join("");
  $("modal").hidden = false;
  const first = $("modal-body").querySelector("select, input");
  if (first) first.focus();
  return new Promise((resolve) => {
    const done = (v) => { $("modal").hidden = true; $("modal-ok").onclick = $("modal-cancel").onclick = null; resolve(v); };
    $("modal-cancel").onclick = () => done(null);
    $("modal-ok").onclick = () => {
      const out = {};
      fields.forEach((f) => { out[f.id] = $("mf-" + f.id).value; });
      done(out);
    };
  });
}

async function refreshKeyRow() {
  const all = await api("GET", "/admin/licenses");
  licenses = all.licenses;
  renderTable();
  if (currentKey) openDrawer(currentKey);
  const st = await api("GET", "/admin/stats");
  renderStats(st.stats);
}

function wire() {
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("login-error").hidden = true;
    try {
      const r = await api("POST", "/admin/login", { user: $("login-user").value, password: $("login-pass").value });
      $("login-pass").value = "";
      showApp(r.user);
      await refreshAll();
    } catch (err) {
      const el = $("login-error");
      el.textContent = "Login gagal: " + err.message;
      el.hidden = false;
    }
  });
  $("logout-btn").addEventListener("click", async () => {
    try { await api("POST", "/admin/logout"); } catch {}
    showLogin();
  });
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $("tab-keys").hidden = t.dataset.tab !== "keys";
    $("tab-plans").hidden = t.dataset.tab !== "plans";
  }));
  ["search", "filter-plan", "filter-status"].forEach((id) =>
    $(id).addEventListener("input", renderTable));
  $("drawer-close").addEventListener("click", () => { $("drawer").hidden = true; currentKey = null; });
  $("drawer").addEventListener("click", (e) => { if (e.target.id === "drawer") { $("drawer").hidden = true; currentKey = null; } });
  $("act-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(currentKey); } catch {}
  });
  $("act-renew").addEventListener("click", async () => {
    const planOpts = [{ value: "", label: "(pakai jumlah hari di bawah)" }].concat(
      plans.map((p) => ({ value: p.id, label: `${p.name} — Rp${Number(p.price || 0).toLocaleString("id-ID")}` }))
    );
    const v = await modal("Renew " + currentKey, [
      { id: "days", label: "Tambah hari (atau kosongkan bila pakai plan)", value: "30", type: "number" },
      { id: "plan", label: "Plan (opsional)", type: "select", options: planOpts, value: "" },
    ]);
    if (!v) return;
    const body = v.plan.trim() ? { plan: v.plan.trim() } : { days: Number(v.days) || 30 };
    await api("POST", `/admin/licenses/${encodeURIComponent(currentKey)}/renew`, body);
    await refreshKeyRow();
  });
  $("act-reset").addEventListener("click", async () => {
    await api("POST", `/admin/licenses/${encodeURIComponent(currentKey)}/reset-device`, {});
    await refreshKeyRow();
  });
  $("act-revoke").addEventListener("click", async () => {
    const l = findKey(currentKey);
    await api("PATCH", `/admin/licenses/${encodeURIComponent(currentKey)}`, { revoked: !l.revoked });
    await refreshKeyRow();
  });
  $("generate-btn").addEventListener("click", async () => {
    const planOpts = plans.map((p) => ({ value: p.id, label: `${p.name} — Rp${Number(p.price || 0).toLocaleString("id-ID")}${p.active === false ? " (nonaktif)" : ""}` }));
    const v = await modal("Generate key", [
      { id: "plan", label: "Plan", type: "select", options: planOpts.length ? planOpts : ["thirty_days"], value: "thirty_days" },
      { id: "count", label: "Jumlah (1–500)", value: "10", type: "number" },
      { id: "buyer", label: "Buyer (opsional)", value: "" },
      { id: "telegram", label: "Telegram (opsional)", value: "" },
      { id: "note", label: "Note (opsional, mis. stok tokotelegram)", value: "" },
    ]);
    if (!v) return;
    const r = await api("POST", "/admin/licenses", {
      plan: v.plan.trim(), count: Math.min(Math.max(Number(v.count) || 1, 1), 500),
      buyer: v.buyer, telegram: v.telegram, note: v.note,
    });
    await refreshAll();
    const list = r.keys.join("\n");
    try { await navigator.clipboard.writeText(list); } catch {}
    alert(`${r.keys.length} key dibuat & dicopy:\n${r.keys.slice(0, 5).join("\n")}${r.keys.length > 5 ? "\n…" : ""}`);
  });
  $("plan-add").addEventListener("click", () => {
    plans.push({ id: "new_plan", name: "New Plan", price: 0, originalPrice: 0, description: "", active: true, sort: plans.length + 1 });
    renderPlans();
  });
  $("plan-save").addEventListener("click", async () => {
    collectPlans();
    try {
      const r = await api("PUT", "/admin/plans", { plans });
      plans = r.plans;
      renderPlans();
      renderPlanFilter();
      alert("Plans tersimpan.");
    } catch (e) {
      alert("Gagal simpan: " + e.message);
    }
  });
}

function collectPlans() {
  plans = plans.map((p, i) => ({
    id: (document.getElementById(`pl-id-${i}`) || {}).value?.trim() || p.id,
    name: (document.getElementById(`pl-name-${i}`) || {}).value ?? p.name,
    price: Number((document.getElementById(`pl-price-${i}`) || {}).value ?? p.price) || 0,
    originalPrice: Number((document.getElementById(`pl-orig-${i}`) || {}).value ?? p.originalPrice) || 0,
    description: (document.getElementById(`pl-desc-${i}`) || {}).value ?? p.description,
    active: (document.getElementById(`pl-active-${i}`) || {}).checked,
    sort: i + 1,
  }));
}

const idr = (n) => "Rp" + Number(n || 0).toLocaleString("id-ID");

function renderPlans() {
  $("plan-rows").innerHTML = plans.map((p, i) => `<tr>
    <td class="mono">${esc(p.id)}</td>
    <td><input id="pl-name-${i}" value="${esc(p.name)}" /></td>
    <td><input id="pl-price-${i}" type="number" min="0" value="${p.price}" /></td>
    <td><input id="pl-orig-${i}" type="number" min="0" value="${p.originalPrice}" /></td>
    <td><input id="pl-desc-${i}" value="${esc(p.description || "")}" /></td>
    <td><input id="pl-active-${i}" type="checkbox" style="width:auto;height:auto" ${p.active !== false ? "checked" : ""} /></td>
    <td><button class="danger sm" data-del="${i}">Hapus</button></td>
  </tr>`).join("");
  $("plan-rows").querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
    collectPlans();
    plans.splice(Number(b.dataset.del), 1);
    renderPlans();
  }));
  const vis = plans.filter((p) => p.active !== false).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  $("plan-preview").innerHTML = vis.map((p) => `<div class="card">
    <div style="font-size:10px;font-weight:800;letter-spacing:.1em;color:var(--muted)">${esc(p.name.toUpperCase())}</div>
    ${p.originalPrice > p.price ? `<s>${idr(p.originalPrice)}</s>` : ""}
    <strong>${idr(p.price)}</strong><p>${esc(p.description || "")}</p>
  </div>`).join("");
}

wire();
boot();

// FlowManager License Server — Node.js (tanpa dependency, pakai http bawaan)
// Jalankan: node server.js
// Env: PORT, LICENSES_FILE, PLANS_FILE,
//   ADMIN_USER, ADMIN_PASS_HASH (salt_hex:hash_hex, via set-admin.js),
//   ADMIN_SECRET (HMAC cookie; wajib di produksi),
//   SIGNING_PRIVATE_KEY (PEM ed25519; tanpa ini respons tak bertanda -> mode dev)
// API lisensi: POST /license/activate|validate|topup, GET /plans (publik)
// API admin (session): /admin/login|logout|me|stats|licenses|plans

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8787);
const FILE = process.env.LICENSES_FILE || path.join(__dirname, "licenses.json");
const PLANS_FILE = process.env.PLANS_FILE || path.join(__dirname, "plans.json");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // legacy fallback, kalau session belum dipakai
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS_HASH = process.env.ADMIN_PASS_HASH || "";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const SIGNING_PRIVATE_KEY = (process.env.SIGNING_PRIVATE_KEY || "").replace(/\\n/g, "\n");

const GRACE_MS = 30 * 24 * 60 * 60 * 1000; // tenggang top-up setelah expired
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const PLAN_DURATIONS = {
  five_minutes: 5 * 60 * 1000,
  one_day: 24 * 60 * 60 * 1000,
  seven_days: 7 * 24 * 60 * 60 * 1000,
  thirty_days: 30 * 24 * 60 * 60 * 1000,
  one_year: 365 * 24 * 60 * 60 * 1000,
  lifetime: null,
};

const DEFAULT_PLANS = [
  { id: "thirty_days", name: "30 Days", price: 25000, originalPrice: 50000, description: "FlowManager access for 30 days", active: true, sort: 1 },
  { id: "one_year", name: "1 Year", price: 99000, originalPrice: 149000, description: "FlowManager access for 1 year", active: true, sort: 2 },
  { id: "lifetime", name: "Lifetime", price: 149000, originalPrice: 249000, description: "FlowManager access with no expiration", active: true, sort: 3 },
  { id: "seven_days", name: "7 Days", price: 15000, originalPrice: 25000, description: "FlowManager access for 7 days", active: false, sort: 4 },
  { id: "one_day", name: "1 Day", price: 7000, originalPrice: 12000, description: "FlowManager access for 1 day", active: false, sort: 5 },
  { id: "five_minutes", name: "5 Minutes", price: 0, originalPrice: 0, description: "Trial access for 5 minutes", active: false, sort: 6 },
];

// ---------- storage ----------
function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function loadLicenses() {
  const map = loadJson(FILE, {});
  let dirty = false;
  for (const k of Object.keys(map)) {
    const l = map[k];
    if (typeof l.consumed !== "boolean") { l.consumed = false; dirty = true; }
    if (!Array.isArray(l.history)) { l.history = []; dirty = true; }
    if (l.failedAttempts === undefined) { l.failedAttempts = 0; dirty = true; }
  }
  if (dirty) saveJson(FILE, map);
  return map;
}
function loadPlans() {
  const plans = loadJson(PLANS_FILE, null);
  if (!Array.isArray(plans)) {
    saveJson(PLANS_FILE, DEFAULT_PLANS);
    return JSON.parse(JSON.stringify(DEFAULT_PLANS));
  }
  return plans;
}

// ---------- helpers ----------
function send(res, code, data, extraHeaders) {
  res.writeHead(code, Object.assign(
    { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    extraHeaders || {}
  ));
  res.end(JSON.stringify(data));
}
function isExpired(lic, now) {
  if (lic.lifetime) return false;
  if (!lic.expiresAt) return false;
  return new Date(lic.expiresAt).getTime() < now;
}
function pushHistory(lic, action, by, detail) {
  lic.history = lic.history || [];
  lic.history.push({ at: new Date().toISOString(), action, by, detail: detail || "" });
  if (lic.history.length > 100) lic.history = lic.history.slice(-100);
}
function genKey(prefix) {
  const p = (prefix || "FM").toUpperCase().replace(/[^A-Z0-9]/g, "") || "FM";
  const seg = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  return `${p}-${seg()}-${seg()}-${seg()}`;
}
function signPayload(obj) {
  // obj: {status, plan, expiresAt, lifetime, now, nonce}
  if (!SIGNING_PRIVATE_KEY) return null;
  try {
    const msg = [obj.status, obj.plan, obj.expiresAt || "", obj.lifetime ? "1" : "0", String(obj.now), obj.nonce || ""].join("|");
    const sig = crypto.sign(null, Buffer.from(msg), { key: SIGNING_PRIVATE_KEY.trim(), format: "pem" });
    return sig.toString("base64");
  } catch (e) {
    console.warn("[license] signing failed:", e.message);
    return null;
  }
}
function licenseResponse(lic, nonce) {
  const now = Date.now();
  const body = {
    status: lic.status || "active",
    plan: lic.plan,
    expiresAt: lic.expiresAt || null,
    lifetime: !!lic.lifetime,
    now,
    nonce: nonce || null,
  };
  body.sig = signPayload(body);
  return body;
}

// nonce anti-replay (bounded)
const nonces = new Map(); // nonce -> expiresAt
function checkNonce(nonce, ts) {
  const now = Date.now();
  for (const [k, exp] of nonces) if (exp < now) nonces.delete(k);
  if (!nonce) return true; // client lama: diterima tanpa proteksi replay
  if (typeof ts !== "number" || Math.abs(now - ts) > CLOCK_SKEW_MS) return false;
  if (nonces.has(nonce)) return false;
  nonces.set(nonce, now + CLOCK_SKEW_MS * 2);
  if (nonces.size > 5000) {
    const first = nonces.keys().next().value;
    nonces.delete(first);
  }
  return true;
}

// ---------- sessions (in-memory; restart = logout) ----------
const sessions = new Map(); // sid -> {user, created}
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || "";
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionUser(req) {
  // legacy token (kompatibilitas): header X-Admin-Token
  if (ADMIN_TOKEN && req.headers["x-admin-token"] === ADMIN_TOKEN) return "legacy-token";
  if (!ADMIN_SECRET) return null;
  const c = parseCookies(req).fm_admin || "";
  const i = c.lastIndexOf(".");
  if (i <= 0) return null;
  const sid = c.slice(0, i), sig = c.slice(i + 1);
  const expect = crypto.createHmac("sha256", ADMIN_SECRET).update(sid).digest("hex");
  if (sig.length !== expect.length) return null;
  let ok = true;
  for (let j = 0; j < sig.length; j++) ok = ok && sig[j] === expect[j];
  if (!ok) return null;
  const s = sessions.get(sid);
  if (!s || Date.now() - s.created > SESSION_TTL_MS) { sessions.delete(sid); return null; }
  return s.user;
}
function setSessionCookie(res, user) {
  const sid = crypto.randomBytes(24).toString("hex");
  sessions.set(sid, { user, created: Date.now() });
  const sig = crypto.createHmac("sha256", ADMIN_SECRET).update(sid).digest("hex");
  return `fm_admin=${sid}.${sig}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`;
}
function verifyPassword(pass) {
  if (!ADMIN_PASS_HASH || !pass) return false;
  const [salt, hash] = String(ADMIN_PASS_HASH).split(":");
  if (!salt || !hash) return false;
  try {
    const calc = crypto.pbkdf2Sync(pass, Buffer.from(salt, "hex"), 210000, 64, "sha512").toString("hex");
    if (calc.length !== hash.length) return false;
    let ok = true;
    for (let i = 0; i < calc.length; i++) ok = ok && calc[i] === hash[i];
    return ok;
  } catch {
    return false;
  }
}
// rate-limit login per IP
const loginFails = new Map(); // ip -> {count, until}
function loginBlocked(ip) {
  const e = loginFails.get(ip);
  if (!e) return false;
  if (Date.now() > e.until) { loginFails.delete(ip); return false; }
  return e.count >= 10;
}
function loginFail(ip) {
  const e = loginFails.get(ip) || { count: 0, until: 0 };
  e.count += 1;
  e.until = Date.now() + 15 * 60 * 1000;
  loginFails.set(ip, e);
}

// ---------- static (dashboard tahap 3) ----------
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json" };
function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/admin" || rel === "/admin/") rel = "/admin.html";
  if (!rel.startsWith("/")) return false;
  const file = path.normalize(path.join(PUBLIC_DIR, rel.slice(1)));
  if (!file.startsWith(PUBLIC_DIR)) return false;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
    return true;
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch { resolve(null); }
    });
  });
}
function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
    });
    return res.end();
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/" && req.method === "GET") {
    return send(res, 200, { ok: true, service: "flowmanager-license-server", signed: !!SIGNING_PRIVATE_KEY });
  }
  if (url.pathname === "/plans" && req.method === "GET") {
    const plans = loadPlans().filter((p) => p.active !== false).sort((a, b) => (a.sort || 0) - (b.sort || 0));
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60" });
    return res.end(JSON.stringify({ plans }));
  }

  // ----- admin auth -----
  if (url.pathname === "/admin/login" && req.method === "POST") {
    const ip = clientIp(req);
    if (loginBlocked(ip)) return send(res, 429, { error: "TOO_MANY_ATTEMPTS" });
    const body = await readBody(req);
    if (!body) return send(res, 400, { error: "BAD_JSON" });
    if (String(body.user || "") === ADMIN_USER && verifyPassword(String(body.password || ""))) {
      loginFails.delete(ip);
      if (!ADMIN_SECRET) return send(res, 500, { error: "ADMIN_SECRET_MISSING" });
      return send(res, 200, { ok: true, user: ADMIN_USER }, { "Set-Cookie": setSessionCookie(res, ADMIN_USER) });
    }
    loginFail(ip);
    return send(res, 401, { error: "INVALID_CREDENTIALS" });
  }
  if (url.pathname === "/admin/logout" && req.method === "POST") {
    const c = parseCookies(req).fm_admin || "";
    sessions.delete(c.split(".")[0]);
    return send(res, 200, { ok: true }, { "Set-Cookie": "fm_admin=; HttpOnly; Path=/; Max-Age=0" });
  }
  if (url.pathname === "/admin/me" && req.method === "GET") {
    const u = sessionUser(req);
    if (!u) return send(res, 401, { error: "UNAUTHORIZED" });
    return send(res, 200, { ok: true, user: u });
  }

  // ----- admin API (auth) -----
  if (url.pathname.startsWith("/admin/")) {
    const user = sessionUser(req);
    if (!user) return send(res, 401, { error: "UNAUTHORIZED" });

    // stats
    if (url.pathname === "/admin/stats" && req.method === "GET") {
      const map = loadLicenses();
      const now = Date.now();
      const s = { total: 0, active: 0, expiring7d: 0, expiredRevivable: 0, dead: 0, revoked: 0, lifetime: 0, consumed: 0, byPlan: {} };
      for (const lic of Object.values(map)) {
        s.total++;
        if (lic.consumed) { s.consumed++; continue; }
        if (lic.revoked) { s.revoked++; continue; }
        if (lic.lifetime) { s.lifetime++; s.active++; continue; }
        s.byPlan[lic.plan] = (s.byPlan[lic.plan] || 0) + 1;
        if (!lic.expiresAt) continue;
        const exp = new Date(lic.expiresAt).getTime();
        if (exp > now) {
          s.active++;
          if (exp - now <= 7 * 24 * 60 * 60 * 1000) s.expiring7d++;
        } else if (now - exp <= GRACE_MS) {
          s.expiredRevivable++;
        } else {
          s.dead++;
        }
      }
      return send(res, 200, { stats: s, now });
    }

    // plans admin
    if (url.pathname === "/admin/plans" && req.method === "GET") {
      return send(res, 200, { plans: loadPlans() });
    }
    if (url.pathname === "/admin/plans" && req.method === "PUT") {
      const body = await readBody(req);
      if (!body || !Array.isArray(body.plans)) return send(res, 400, { error: "BAD_JSON" });
      const seen = new Set();
      for (const p of body.plans) {
        if (!p || typeof p.id !== "string" || !p.id.trim()) return send(res, 400, { error: "PLAN_ID_REQUIRED" });
        if (seen.has(p.id)) return send(res, 400, { error: "DUPLICATE_PLAN_ID" });
        seen.add(p.id);
        if (typeof p.price !== "number" || p.price < 0) return send(res, 400, { error: "INVALID_PRICE" });
        if (p.originalPrice !== undefined && (typeof p.originalPrice !== "number" || p.originalPrice < 0)) return send(res, 400, { error: "INVALID_PRICE" });
        if (typeof p.name !== "string" || !p.name.trim()) return send(res, 400, { error: "PLAN_NAME_REQUIRED" });
      }
      const map = loadLicenses();
      const used = new Set(Object.values(map).filter((l) => !l.consumed).map((l) => l.plan));
      const kept = new Set(body.plans.map((p) => p.id));
      for (const id of used) {
        if (!kept.has(id) && PLAN_DURATIONS[id] === undefined && !body.plans.some((p) => p.id === id)) {
          return send(res, 400, { error: "PLAN_IN_USE", plan: id });
        }
      }
      const clean = body.plans.map((p, i) => ({
        id: p.id.trim(),
        name: p.name.trim(),
        price: p.price,
        originalPrice: typeof p.originalPrice === "number" ? p.originalPrice : p.price,
        description: String(p.description || ""),
        active: p.active !== false,
        sort: typeof p.sort === "number" ? p.sort : i + 1,
      }));
      saveJson(PLANS_FILE, clean);
      return send(res, 200, { ok: true, plans: clean });
    }

    // licenses list/create
    if (url.pathname === "/admin/licenses" && req.method === "GET") {
      const map = loadLicenses();
      return send(res, 200, { licenses: Object.keys(map).map((k) => Object.assign({ key: k }, map[k])) });
    }
    if (url.pathname === "/admin/licenses" && req.method === "POST") {
      const body = await readBody(req);
      if (!body) return send(res, 400, { error: "BAD_JSON" });
      const count = Math.min(Math.max(Number(body.count) || 1, 1), 500);
      const plan = String(body.plan || "thirty_days");
      if (PLAN_DURATIONS[plan] === undefined && plan !== "lifetime") return send(res, 400, { error: "INVALID_PLAN" });
      const map = loadLicenses();
      const made = [];
      for (let i = 0; i < count; i++) {
        let key = String(body.key || "").trim();
        if (count > 1 || !key) {
          do { key = genKey(body.prefix); } while (map[key]);
        } else if (map[key]) {
          return send(res, 400, { error: "KEY_EXISTS" });
        }
        map[key] = {
          plan,
          status: "active",
          lifetime: plan === "lifetime",
          expiresAt: plan === "lifetime" ? null : body.expiresAt || null,
          boundDeviceId: null,
          revoked: false,
          consumed: false,
          consumedBy: null,
          consumedAt: null,
          buyer: String(body.buyer || ""),
          telegram: String(body.telegram || ""),
          note: String(body.note || ""),
          createdAt: new Date().toISOString(),
          failedAttempts: 0,
          history: [{ at: new Date().toISOString(), action: "created", by: user, detail: plan }],
        };
        made.push(key);
      }
      saveJson(FILE, map);
      return send(res, 200, { ok: true, keys: made });
    }

    // licenses/:key actions
    const mKey = url.pathname.match(/^\/admin\/licenses\/([^/]+)(\/(renew|reset-device))?$/);
    if (mKey) {
      const key = decodeURIComponent(mKey[1]);
      const action = mKey[3] || null;
      const map = loadLicenses();
      const lic = map[key];
      if (!lic) return send(res, 404, { error: "NOT_FOUND" });
      const now = Date.now();

      if (req.method === "PATCH" && !action) {
        const body = await readBody(req);
        if (!body) return send(res, 400, { error: "BAD_JSON" });
        const changes = [];
        if (body.revoked !== undefined) { lic.revoked = !!body.revoked; changes.push(body.revoked ? "revoked" : "unrevoked"); }
        if (body.plan !== undefined) {
          if (PLAN_DURATIONS[body.plan] === undefined && body.plan !== "lifetime") return send(res, 400, { error: "INVALID_PLAN" });
          lic.plan = body.plan;
          lic.lifetime = body.plan === "lifetime";
          if (lic.lifetime) lic.expiresAt = null;
          changes.push("plan->" + body.plan);
        }
        if (body.buyer !== undefined) lic.buyer = String(body.buyer);
        if (body.telegram !== undefined) lic.telegram = String(body.telegram);
        if (body.note !== undefined) lic.note = String(body.note);
        if (body.expiresAt !== undefined) { lic.expiresAt = body.expiresAt; changes.push("expiry-set"); }
        pushHistory(lic, "updated", user, changes.join(","));
        saveJson(FILE, map);
        return send(res, 200, { ok: true, license: Object.assign({ key }, lic) });
      }

      if (req.method === "POST" && action === "renew") {
        const body = (await readBody(req)) || {};
        if (lic.revoked) return send(res, 403, { error: "LICENSE_REVOKED" });
        if (lic.consumed) return send(res, 403, { error: "KEY_CONSUMED" });
        let ms = 0;
        if (body.plan) {
          if (PLAN_DURATIONS[body.plan] === undefined && body.plan !== "lifetime") return send(res, 400, { error: "INVALID_PLAN" });
          if (body.plan === "lifetime") {
            lic.lifetime = true; lic.expiresAt = null; lic.plan = "lifetime"; lic.status = "active";
            pushHistory(lic, "renewed", user, "upgrade lifetime");
            saveJson(FILE, map);
            return send(res, 200, { ok: true, license: Object.assign({ key }, lic) });
          }
          ms = PLAN_DURATIONS[body.plan];
          lic.plan = body.plan;
        } else if (typeof body.days === "number" && body.days > 0 && body.days <= 3700) {
          ms = body.days * 24 * 60 * 60 * 1000;
        } else {
          return send(res, 400, { error: "PLAN_OR_DAYS_REQUIRED" });
        }
        if (lic.lifetime) return send(res, 400, { error: "ALREADY_LIFETIME" });
        const base = lic.expiresAt ? Math.max(new Date(lic.expiresAt).getTime(), now) : now;
        lic.expiresAt = new Date(base + ms).toISOString();
        lic.status = "active";
        pushHistory(lic, "renewed", user, `+${Math.round(ms / 86400000)}d`);
        saveJson(FILE, map);
        return send(res, 200, { ok: true, license: Object.assign({ key }, lic) });
      }

      if (req.method === "POST" && action === "reset-device") {
        lic.boundDeviceId = null;
        pushHistory(lic, "reset-device", user, "");
        saveJson(FILE, map);
        return send(res, 200, { ok: true, license: Object.assign({ key }, lic) });
      }
      return send(res, 404, { error: "NOT_FOUND" });
    }
    return send(res, 404, { error: "NOT_FOUND" });
  }

  // ----- license public API -----
  if ((url.pathname === "/license/activate" || url.pathname === "/license/validate" || url.pathname === "/license/topup") && req.method === "POST") {
    const body = await readBody(req);
    if (!body) return send(res, 400, { error: "BAD_JSON" });
    const licenseKey = String(body.licenseKey || "").trim();
    const topupKey = String(body.topupKey || "").trim();
    const deviceId = String(body.deviceId || "").trim();
    const nonce = typeof body.nonce === "string" ? body.nonce : null;
    const ts = typeof body.ts === "number" ? body.ts : null;
    if (!licenseKey || !deviceId) return send(res, 401, { error: "INVALID_LICENSE" });
    if (nonce && !checkNonce(nonce, ts)) return send(res, 401, { error: "STALE_REQUEST" });

    const now = Date.now();
    const map = loadLicenses();
    const lic = map[licenseKey];
    const fail = (code, extraStatus) => {
      if (lic) { lic.failedAttempts = (lic.failedAttempts || 0) + 1; lic.lastFailAt = new Date(now).toISOString(); try { saveJson(FILE, map); } catch {} }
      return send(res, extraStatus || 401, { error: code });
    };
    if (!lic) return fail("INVALID_LICENSE");
    const isTopup = url.pathname === "/license/topup";
    if (!isTopup && lic.revoked) return fail("LICENSE_REVOKED", 403);
    if (!isTopup && lic.consumed) return fail("KEY_CONSUMED", 403);
    if (lic.boundDeviceId && lic.boundDeviceId !== deviceId) {
      return fail(isTopup ? "DEVICE_MISMATCH" : "DEVICE_ALREADY_BOUND", 403);
    }

    // ----- topup -----
    if (isTopup) {
      if (lic.revoked) return send(res, 403, { error: "OLD_KEY_REVOKED" });
      if (lic.lifetime) return send(res, 400, { error: "ALREADY_LIFETIME" });
      if (!topupKey) return send(res, 400, { error: "TOPUP_KEY_INVALID" });
      const top = map[topupKey];
      if (!top || top.revoked) return fail("TOPUP_KEY_INVALID", 403);
      if (top.consumed) return fail("TOPUP_KEY_USED", 403);
      if (isExpired(lic, now) && now - new Date(lic.expiresAt).getTime() > GRACE_MS) {
        return send(res, 403, { error: "OLD_KEY_DEAD" });
      }
      const base = lic.expiresAt ? Math.max(new Date(lic.expiresAt).getTime(), now) : now;
      if (top.lifetime) {
        lic.lifetime = true; lic.expiresAt = null; lic.plan = "lifetime";
      } else {
        const ms = PLAN_DURATIONS[top.plan];
        if (ms == null) return fail("TOPUP_KEY_INVALID");
        lic.expiresAt = new Date(base + ms).toISOString();
      }
      lic.status = "active";
      if (!lic.boundDeviceId) lic.boundDeviceId = deviceId;
      top.consumed = true; top.consumedBy = licenseKey; top.consumedAt = new Date(now).toISOString();
      pushHistory(top, "consumed", "system", "topup->" + licenseKey);
      pushHistory(lic, "topup", "system", `+${top.lifetime ? "lifetime" : top.plan} via ${topupKey}`);
      lic.failedAttempts = 0;
      saveJson(FILE, map);
      return send(res, 200, licenseResponse(lic, nonce));
    }

    // ----- activate -----
    if (url.pathname === "/license/activate" && !lic.boundDeviceId) {
      lic.boundDeviceId = deviceId;
      if (!lic.lifetime && !lic.expiresAt && PLAN_DURATIONS[lic.plan] != null) {
        lic.expiresAt = new Date(now + PLAN_DURATIONS[lic.plan]).toISOString();
      }
      if (!lic.status) lic.status = "active";
      pushHistory(lic, "activated", "system", deviceId.slice(0, 8));
      saveJson(FILE, map);
    }
    if (isExpired(lic, now)) return fail("LICENSE_EXPIRED", 403);
    lic.failedAttempts = 0;
    try { saveJson(FILE, map); } catch {}
    return send(res, 200, licenseResponse(lic, nonce));
  }

  // ----- static dashboard (diisi tahap 3) -----
  if (req.method === "GET") {
    if (serveStatic(req, res)) return;
  }
  return send(res, 404, { error: "NOT_FOUND" });
});

server.listen(PORT, () => {
  console.log(`FlowManager license server on http://localhost:${PORT} (signed: ${!!SIGNING_PRIVATE_KEY}, admin-auth: ${ADMIN_PASS_HASH ? "login" : (ADMIN_TOKEN ? "legacy-token" : "NONE")})`);
});

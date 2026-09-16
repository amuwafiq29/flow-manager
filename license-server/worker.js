// FlowManager License Server — Cloudflare Worker (cadangan; produksi = VPS server.js)
// Deploy: npm i -g wrangler && wrangler login && wrangler deploy
// KV: wrangler kv namespace create LICENSES, lalu isi binding di wrangler.toml
// Vars wajib (produksi): ADMIN_USER, ADMIN_PASS_HASH (salt:hash), ADMIN_SECRET,
//   SIGNING_PRIVATE_KEY (PEM ed25519). Tanpa SIGNING_PRIVATE_KEY -> respons
//   tak bertanda (sig:null); app produksi yang pin pubkey akan MENOLAK.
//   Ed25519 via SubtleCrypto butuh compatibility_date baru; lihat wrangler.toml.
// API: POST /license/activate|validate, GET /plans (publik),
//   /admin/* (login/me/stats/licenses/plans) — session via KV (butuh binding).
// CATATAN race: KV read-modify-write bisa race saat request bersamaan;
//   traffic kecil = diterima. Jangan pakai LICENSES_JSON untuk produksi
//   (binding/device tidak persist).

const PLANS = {
  five_minutes: 5 * 60 * 1000,
  one_day: 24 * 60 * 60 * 1000,
  seven_days: 7 * 24 * 60 * 60 * 1000,
  thirty_days: 30 * 24 * 60 * 60 * 1000,
  one_year: 365 * 24 * 60 * 60 * 1000,
  lifetime: null,
};
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const SESSION_TTL = 12 * 3600;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
const te = new TextEncoder();
function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- storage (KV; tanpa KV = read-only dari vars, untuk tes) ----------
async function getLicense(env, key) {
  if (env.LICENSES) {
    const raw = await env.LICENSES.get(`license:${key}`);
    if (raw) return normalize(JSON.parse(raw));
  }
  if (env.LICENSES_JSON) {
    try {
      const map = JSON.parse(env.LICENSES_JSON);
      if (map[key]) return normalize(map[key]);
    } catch {}
  }
  return null;
}
async function saveLicense(env, key, lic) {
  if (env.LICENSES) await env.LICENSES.put(`license:${key}`, JSON.stringify(lic));
}
function normalize(l) {
  if (typeof l.consumed !== "boolean") l.consumed = false;
  if (!Array.isArray(l.history)) l.history = [];
  if (l.failedAttempts === undefined) l.failedAttempts = 0;
  if (l.supersededBy === undefined) l.supersededBy = null;
  return l;
}
function pushHistory(lic, action, by, detail) {
  lic.history = lic.history || [];
  lic.history.push({ at: new Date().toISOString(), action, by, detail: detail || "" });
  if (lic.history.length > 100) lic.history = lic.history.slice(-100);
}
async function listLicenses(env) {
  if (!env.LICENSES) return [];
  const out = [];
  let cursor = undefined;
  do {
    const page = await env.LICENSES.list({ prefix: "license:", cursor });
    for (const k of page.keys) {
      const raw = await env.LICENSES.get(k.name);
      if (raw) { const lic = normalize(JSON.parse(raw)); lic.key = k.name.slice(8); out.push(lic); }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}
async function loadPlans(env) {
  if (env.LICENSES) {
    const raw = await env.LICENSES.get("plans");
    if (raw) return JSON.parse(raw);
  }
  return null; // pemanggil pakai seed client-side? tidak — 404 instruktif
}
function isExpired(lic, now) {
  if (lic.lifetime) return false;
  if (!lic.expiresAt) return false;
  return new Date(lic.expiresAt).getTime() < now;
}

// ---------- signing (best-effort) ----------
async function signPayload(env, obj) {
  if (!env.SIGNING_PRIVATE_KEY) return null;
  try {
    const pem = String(env.SIGNING_PRIVATE_KEY).replace(/\\n/g, "\n");
    const der = unb64(pem.split("\n").filter((l) => l && !l.includes("-----")).join(""));
    const key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
    const msg = [obj.status, obj.plan, obj.expiresAt || "", obj.lifetime ? "1" : "0", String(obj.now), obj.nonce || ""].join("|");
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, te.encode(msg));
    return b64(new Uint8Array(sig));
  } catch (e) {
    console.warn("signing unsupported:", e && e.message);
    return null;
  }
}
function licenseResponse(lic, nonce, sig, now) {
  return {
    status: lic.status || "active", plan: lic.plan,
    expiresAt: lic.expiresAt || null, lifetime: !!lic.lifetime,
    now, nonce: nonce || null, sig,
  };
}

// ---------- nonce anti-replay (in-memory per isolate; best-effort) ----------
const seen = new Map();
function checkNonce(nonce, ts) {
  const now = Date.now();
  for (const [k, exp] of seen) if (exp < now) seen.delete(k);
  if (!nonce) return true;
  if (typeof ts !== "number" || Math.abs(now - ts) > CLOCK_SKEW_MS) return false;
  if (seen.has(nonce)) return false;
  seen.set(nonce, now + CLOCK_SKEW_MS * 2);
  if (seen.size > 2000) seen.delete(seen.keys().next().value);
  return true;
}

// ---------- sessions via KV ----------
async function sha256Hex(s) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(s))));
}
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, te.encode(msg))));
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
async function sessionUser(env, req) {
  if (env.ADMIN_TOKEN && req.headers.get("x-admin-token") === env.ADMIN_TOKEN) return "legacy-token";
  if (!env.ADMIN_SECRET || !env.LICENSES) return null;
  const c = parseCookies(req).fm_admin || "";
  const i = c.lastIndexOf(".");
  if (i <= 0) return null;
  const sid = c.slice(0, i), sig = c.slice(i + 1);
  if (sig !== (await hmac(env.ADMIN_SECRET, sid))) return null;
  const raw = await env.LICENSES.get(`session:${sid}`);
  if (!raw) return null;
  const s = JSON.parse(raw);
  if (Date.now() - s.created > SESSION_TTL * 1000) { await env.LICENSES.delete(`session:${sid}`); return null; }
  return s.user;
}
async function verifyPassword(pass, stored) {
  if (!stored || !pass) return false;
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  try {
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: unb64(Buffer.from(salt, "hex").toString("base64")), iterations: 210000, hash: "SHA-512" },
      await crypto.subtle.importKey("raw", te.encode(pass), "PBKDF2", false, ["deriveBits"]),
      512
    );
    const calc = Buffer.from(bits).toString("hex");
    return calc.length === hash.length && calc === hash;
  } catch {
    return false;
  }
}
// rate-limit login in-memory
const fails = new Map();
function blocked(ip) {
  const e = fails.get(ip);
  if (!e) return false;
  if (Date.now() > e.until) { fails.delete(ip); return false; }
  return e.count >= 10;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: {
        "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, PATCH, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token" } });
    }
    if (url.pathname === "/" && request.method === "GET") {
      return json({ ok: true, service: "flowmanager-license-server", signed: !!env.SIGNING_PRIVATE_KEY });
    }
    if (url.pathname === "/plans" && request.method === "GET") {
      const plans = await loadPlans(env);
      if (!plans) return json({ error: "PLANS_NOT_CONFIGURED" }, 500);
      const vis = plans.filter((p) => p.active !== false).sort((a, b) => (a.sort || 0) - (b.sort || 0));
      return new Response(JSON.stringify({ plans: vis }), { headers: {
        "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=60" } });
    }

    // auth
    if (url.pathname === "/admin/login" && request.method === "POST") {
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      if (blocked(ip)) return json({ error: "TOO_MANY_ATTEMPTS" }, 429);
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: "BAD_JSON" }, 400);
      if (body.user === env.ADMIN_USER && (await verifyPassword(String(body.password || ""), env.ADMIN_PASS_HASH))) {
        fails.delete(ip);
        if (!env.ADMIN_SECRET || !env.LICENSES) return json({ error: "ADMIN_NOT_CONFIGURED" }, 500);
        const sid = b64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, "");
        await env.LICENSES.put(`session:${sid}`, JSON.stringify({ user: env.ADMIN_USER, created: Date.now() }), { expirationTtl: SESSION_TTL });
        const sig = await hmac(env.ADMIN_SECRET, sid);
        return new Response(JSON.stringify({ ok: true, user: env.ADMIN_USER }), { headers: {
          "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
          "Set-Cookie": `fm_admin=${sid}.${sig}; HttpOnly; Path=/; Max-Age=${SESSION_TTL}; SameSite=Lax; Secure`,
        } });
      }
      const e = fails.get(ip) || { count: 0, until: 0 };
      e.count++; e.until = Date.now() + 900000; fails.set(ip, e);
      return json({ error: "INVALID_CREDENTIALS" }, 401);
    }
    const needCookie = async (extra) => {
      const u = await sessionUser(env, request);
      if (!u) return json({ error: "UNAUTHORIZED" }, 401);
      return extra(u);
    };
    if (url.pathname === "/admin/logout" && request.method === "POST") {
      return needCookie(async () => {
        const c = parseCookies(request).fm_admin || "";
        const sid = c.split(".")[0];
        if (sid && env.LICENSES) { try { await env.LICENSES.delete(`session:${sid}`); } catch {} }
        return new Response(JSON.stringify({ ok: true }), { headers: {
          "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
          "Set-Cookie": "fm_admin=; HttpOnly; Path=/; Max-Age=0",
        } });
      });
    }
    if (url.pathname === "/admin/me" && request.method === "GET") {
      return needCookie(async (u) => json({ ok: true, user: u }));
    }
    if (url.pathname === "/admin/stats" && request.method === "GET") {
      return needCookie(async () => {
        const all = await listLicenses(env);
        const now = Date.now();
        const s = { total: 0, active: 0, expiring7d: 0, expired: 0, revoked: 0, lifetime: 0, consumed: 0, superseded: 0, byPlan: {} };
        for (const lic of all) {
          s.total++;
          if (lic.revoked) { s.revoked++; continue; }
          if (lic.supersededBy) { s.superseded++; continue; }
          if (lic.consumed) { s.consumed++; continue; }
          if (lic.lifetime) { s.lifetime++; s.active++; continue; }
          s.byPlan[lic.plan] = (s.byPlan[lic.plan] || 0) + 1;
          if (!lic.expiresAt) continue;
          const exp = new Date(lic.expiresAt).getTime();
          if (exp > now) { s.active++; if (exp - now <= 604800000) s.expiring7d++; }
          else s.expired++;
        }
        return json({ stats: s, now });
      });
    }
    if (url.pathname === "/admin/licenses" && request.method === "GET") {
      return needCookie(async () => json({ licenses: await listLicenses(env) }));
    }
    if (url.pathname === "/admin/plans" && request.method === "GET") {
      return needCookie(async () => json({ plans: (await loadPlans(env)) || [] }));
    }
    if (url.pathname === "/admin/plans" && request.method === "PUT") {
      return needCookie(async () => {
        const body = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.plans)) return json({ error: "BAD_JSON" }, 400);
        const seenIds = new Set();
        for (const p of body.plans) {
          if (!p || typeof p.id !== "string" || !p.id.trim()) return json({ error: "PLAN_ID_REQUIRED" }, 400);
          if (seenIds.has(p.id)) return json({ error: "DUPLICATE_PLAN_ID" }, 400);
          seenIds.add(p.id);
          if (typeof p.price !== "number" || p.price < 0) return json({ error: "INVALID_PRICE" }, 400);
        }
        if (!env.LICENSES) return json({ error: "KV_REQUIRED" }, 500);
        const clean = body.plans.map((p, i) => ({
          id: p.id.trim(), name: String(p.name || "").trim(), price: p.price,
          originalPrice: typeof p.originalPrice === "number" ? p.originalPrice : p.price,
          description: String(p.description || ""), active: p.active !== false,
          sort: typeof p.sort === "number" ? p.sort : i + 1,
        }));
        await env.LICENSES.put("plans", JSON.stringify(clean));
        return json({ ok: true, plans: clean });
      });
    }

    // license API (model one-time ketat, sama seperti server.js)
    if ((url.pathname === "/license/activate" || url.pathname === "/license/validate") && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: "BAD_JSON" }, 400);
      const licenseKey = String(body.licenseKey || "").trim();
      const deviceId = String(body.deviceId || "").trim();
      const nonce = typeof body.nonce === "string" ? body.nonce : null;
      const ts = typeof body.ts === "number" ? body.ts : null;
      if (!licenseKey || !deviceId) return json({ error: "INVALID_LICENSE" }, 401);
      if (nonce && !checkNonce(nonce, ts)) return json({ error: "STALE_REQUEST" }, 401);
      const now = Date.now();
      const fail = async (lic, code, st) => {
        if (lic) { lic.failedAttempts = (lic.failedAttempts || 0) + 1; lic.lastFailAt = new Date(now).toISOString(); await saveLicense(env, licenseKey, lic); }
        return json({ error: code }, st || 401);
      };
      const lic = await getLicense(env, licenseKey);
      if (!lic) return fail(null, "INVALID_LICENSE");
      if (lic.revoked) return json({ error: "LICENSE_REVOKED" }, 403);
      if (lic.consumed) return json({ error: "KEY_CONSUMED" }, 403);
      if (lic.supersededBy) return json({ error: "KEY_SUPERSEDED" }, 403);
      if (lic.boundDeviceId && lic.boundDeviceId !== deviceId) {
        return fail(lic, "DEVICE_ALREADY_BOUND", 403);
      }
      const respond = async () => json(licenseResponse(lic, nonce, await signPayload(env, {
        status: lic.status || "active", plan: lic.plan, expiresAt: lic.expiresAt || null,
        lifetime: !!lic.lifetime, now, nonce,
      }), now));
      if (url.pathname === "/license/validate") {
        if (isExpired(lic, now)) return fail(lic, "LICENSE_EXPIRED", 403);
        lic.failedAttempts = 0;
        await saveLicense(env, licenseKey, lic);
        return respond();
      }
      // activate
      if (lic.boundDeviceId) {
        if (isExpired(lic, now)) return fail(lic, "LICENSE_EXPIRED", 403);
        lic.failedAttempts = 0;
        await saveLicense(env, licenseKey, lic);
        return respond();
      }
      if (lic.expiresAt && new Date(lic.expiresAt).getTime() <= now && !lic.lifetime) {
        return json({ error: "LICENSE_EXPIRED" }, 403);
      }
      if (env.LICENSES) {
        // tolak pembelian sia-sia bila device sudah lifetime (best-effort scan)
        let cursor = undefined;
        let covered = false;
        do {
          const page = await env.LICENSES.list({ prefix: "license:", cursor });
          for (const k of page.keys) {
            const raw = await env.LICENSES.get(k.name);
            if (!raw) continue;
            const o = JSON.parse(raw);
            if (o.lifetime && !o.revoked && !o.consumed && !o.supersededBy && o.boundDeviceId === deviceId) { covered = true; break; }
          }
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor && !covered);
        if (covered) return json({ error: "ALREADY_LIFETIME_COVERED" }, 403);
      }
      let carryMs = 0, carryFrom = null;
      if (env.LICENSES) {
        const all = await listLicenses(env);
        for (const o of all) {
          if (o.key === licenseKey || o.lifetime || o.revoked || o.consumed || o.supersededBy) continue;
          if (o.boundDeviceId !== deviceId || !o.expiresAt) continue;
          const remain = new Date(o.expiresAt).getTime() - now;
          if (remain > carryMs) { carryMs = remain; carryFrom = o.key; }
        }
        if (carryFrom) {
          const old = await getLicense(env, carryFrom);
          if (old) {
            old.supersededBy = licenseKey;
            old.status = "superseded";
            pushHistory(old, "superseded", "system", `carried ${Math.round(carryMs / 86400000)}d into ${licenseKey}`);
            await saveLicense(env, carryFrom, old);
          }
        }
      }
      lic.boundDeviceId = deviceId;
      if (lic.lifetime) {
        lic.expiresAt = null;
      } else if (lic.expiresAt) {
        lic.expiresAt = new Date(Math.max(new Date(lic.expiresAt).getTime(), now) + carryMs).toISOString();
      } else {
        const ms = PLANS[lic.plan];
        if (ms == null) return fail(lic, "INVALID_LICENSE");
        lic.expiresAt = new Date(now + ms + carryMs).toISOString();
      }
      if (!lic.status || lic.status === "superseded") lic.status = "active";
      pushHistory(lic, "activated", "system",
        deviceId.slice(0, 8) + (carryMs > 0 ? ` carry+${Math.round(carryMs / 86400000)}d from ${carryFrom}` : ""));
      lic.failedAttempts = 0;
      await saveLicense(env, licenseKey, lic);
      return respond();
    }
    return json({ error: "NOT_FOUND" }, 404);
  },
};

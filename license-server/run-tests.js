// node run-tests.js — suite verifikasi server lisensi model one-time ketat
const BASE = "http://localhost:8787";
const ADMIN = "test-admin-token";
let pass = 0, fail = 0;
async function req(method, path, body, headers) {
  const r = await fetch(BASE + path, {
    method,
    headers: Object.assign({ "Content-Type": "application/json", "X-Admin-Token": ADMIN }, headers || {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, JSON.stringify(extra)); }
}
const RID = Date.now().toString(36).toUpperCase().slice(-4);
const DEV = "dev-" + RID;
const DEVX = "dev-" + RID + "X";
const K = (s) => `FM-C${RID}-${s}`;
(async () => {
  // plans
  let r = await req("GET", "/plans");
  ok("plans publik aktif", r.status === 200 && r.data.plans.length === 3, r);
  r = await req("GET", "/admin/plans");
  ok("seed 6 plan", r.status === 200 && r.data.plans.length === 6, r.data && r.data.plans.length);

  const mk = async (key, plan, extra) =>
    req("POST", "/admin/licenses", Object.assign({ key, plan }, extra || {}));

  // 1. aktivasi fresh
  await mk(K("OLD1"), "thirty_days");
  r = await req("POST", "/license/activate", { licenseKey: K("OLD1"), deviceId: DEV });
  ok("activate fresh", r.status === 200 && !!r.data.expiresAt && !!r.data.sig, r.data);
  const expOld = new Date(r.data.expiresAt).getTime();

  // 2. aktivasi ulang key SAMA di device SAMA -> idempoten OK
  r = await req("POST", "/license/activate", { licenseKey: K("OLD1"), deviceId: DEV });
  ok("reaktivasi idempoten", r.status === 200, r);

  // 3. key BARU di device SAMA -> auto-carry sisa + bunuh lama
  await mk(K("NEW1"), "thirty_days");
  const before = Date.now();
  r = await req("POST", "/license/activate", { licenseKey: K("NEW1"), deviceId: DEV });
  const got = new Date(r.data.expiresAt).getTime();
  const expectMin = before + 30 * 86400000 + (expOld - before) - 120000;
  ok("auto-carry sisa (5+30)", r.status === 200 && got >= expectMin, r.data);

  // 4. key LAMA mati permanen (validate + activate ditolak)
  r = await req("POST", "/license/validate", { licenseKey: K("OLD1"), deviceId: DEV });
  ok("old validate ditolak superseded", r.status === 403 && r.data.error === "KEY_SUPERSEDED", r);
  r = await req("POST", "/license/activate", { licenseKey: K("OLD1"), deviceId: DEV });
  ok("old activate ditolak superseded", r.status === 403 && r.data.error === "KEY_SUPERSEDED", r);

  // 5. key KETIGA: carry tunggal dari yang live (tidak double)
  await mk(K("NEW2"), "thirty_days");
  r = await req("POST", "/license/validate", { licenseKey: K("NEW1"), deviceId: DEV });
  const liveExp = new Date(r.data.expiresAt).getTime();
  const b2 = Date.now();
  r = await req("POST", "/license/activate", { licenseKey: K("NEW2"), deviceId: DEV });
  const g2 = new Date(r.data.expiresAt).getTime();
  ok("carry tunggal (live+30)", r.status === 200 && g2 >= liveExp + 30 * 86400000 - 120000 && g2 <= liveExp + 30 * 86400000 + 120000 && g2 >= b2, r.data);

  // 6. expired + key baru -> fresh dari sekarang, tanpa carry
  const past10 = new Date(Date.now() - 10 * 86400000).toISOString();
  await mk(K("OLD2"), "thirty_days", { expiresAt: past10 });
  await mk(K("NEW3"), "thirty_days");
  r = await req("POST", "/license/activate", { licenseKey: K("NEW3"), deviceId: DEV });
  ok("expired-old: fresh tanpa carry", r.status === 200, r.data);

  // 7. device lifetime menolak pembelian baru (device khusus lifetime)
  const DEVL = DEV + "L";
  await mk(K("LIFE1"), "lifetime");
  await req("POST", "/license/activate", { licenseKey: K("LIFE1"), deviceId: DEVL });
  await mk(K("NEW4"), "thirty_days");
  r = await req("POST", "/license/activate", { licenseKey: K("NEW4"), deviceId: DEVL });
  ok("lifetime-cover menolak", r.status === 403 && r.data.error === "ALREADY_LIFETIME_COVERED", r);

  // 8. device beda -> mismatch (key khusus terisolasi)
  await mk(K("MISM1"), "thirty_days");
  await req("POST", "/license/activate", { licenseKey: K("MISM1"), deviceId: DEV });
  r = await req("POST", "/license/validate", { licenseKey: K("MISM1"), deviceId: DEVX });
  ok("mismatch ditolak", r.status === 403 && r.data.error === "DEVICE_ALREADY_BOUND", r);

  // 9. revoked
  await req("PATCH", `/admin/licenses/${K("NEW2")}`, { revoked: true });
  r = await req("POST", "/license/validate", { licenseKey: K("NEW2"), deviceId: DEV });
  ok("revoked ditolak", r.status === 403 && r.data.error === "LICENSE_REVOKED", r);
  await req("PATCH", `/admin/licenses/${K("NEW2")}`, { revoked: false });

  // 10. admin auth + stats taxonomy baru
  r = await req("GET", "/admin/stats", null, { "X-Admin-Token": "salah" });
  ok("admin tanpa token ditolak", r.status === 401, r);
  r = await req("GET", "/admin/stats");
  ok("stats superseded+expired", r.status === 200 && r.data.stats.superseded >= 1 && r.data.stats.expired >= 1, r.data && r.data.stats);

  // 11. renew + reset
  r = await req("POST", `/admin/licenses/${K("NEW3")}/renew`, { days: 7 });
  ok("admin renew ok", r.status === 200, r.data && r.data.error);
  r = await req("POST", `/admin/licenses/${K("NEW3")}/reset-device`, {});
  ok("reset device ok", r.status === 200 && r.data.license.boundDeviceId === null, r.data);

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SUITE ERROR", e); process.exit(1); });

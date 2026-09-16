// node run-tests.js — suite verifikasi server lisensi (butuh server jalan)
const BASE = "http://localhost:8787";
const ADMIN = "test-admin-token";
let pass = 0, fail = 0;
const RID = Date.now().toString(36).toUpperCase().slice(-4);

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
(async () => {
  // 1. plans publik (hanya yang aktif) + seed 6 via admin
  let r = await req("GET", "/plans");
  ok("plans publik aktif saja", r.status === 200 && r.data.plans.length === 3, r);
  r = await req("GET", "/admin/plans");
  ok("seed 6 plan", r.status === 200 && r.data.plans.length === 6, r.data && r.data.plans.length);

  // 2. buat key test via admin legacy
  const mk = async (key, plan, extra) => {
    const b = await req("POST", "/admin/licenses", Object.assign({ key, plan }, extra || {}));
    return b;
  };
  await mk("FM-T"+RID+"-OLD1-0001", "thirty_days");
  await mk("FM-T"+RID+"-NEW1-0001", "thirty_days");
  await mk("FM-T"+RID+"-NEW2-0001", "seven_days");

  // 3. activate OLD
  r = await req("POST", "/license/activate", { licenseKey: "FM-T"+RID+"-OLD1-0001", deviceId: "dev-A" });
  ok("activate OLD", r.status === 200 && r.data.plan === "thirty_days" && !!r.data.expiresAt, r);
  const expOld = r.data.expiresAt;

  // 4. topup OLD + NEW1 (30 hari ditambah dari expiry lama)
  r = await req("POST", "/license/topup", { licenseKey: "FM-T"+RID+"-OLD1-0001", topupKey: "FM-T"+RID+"-NEW1-0001", deviceId: "dev-A" });
  const expect = new Date(new Date(expOld).getTime() + 30 * 86400000).toISOString().slice(0, 16);
  ok("topup stack dari expiry", r.status === 200 && (r.data.expiresAt || "").slice(0, 16) === expect, r.data);

  // 5. NEW1 dipakai lagi -> TOPUP_KEY_USED
  r = await req("POST", "/license/topup", { licenseKey: "FM-T"+RID+"-OLD1-0001", topupKey: "FM-T"+RID+"-NEW1-0001", deviceId: "dev-A" });
  ok("topup key bekas ditolak", r.status === 403 && r.data.error === "TOPUP_KEY_USED", r);

  // 6. device beda -> DEVICE_MISMATCH
  r = await req("POST", "/license/topup", { licenseKey: "FM-T"+RID+"-OLD1-0001", topupKey: "FM-T"+RID+"-NEW2-0001", deviceId: "dev-B" });
  ok("device mismatch ditolak", r.status === 403 && r.data.error === "DEVICE_MISMATCH", r);

  // 7. expired dalam tenggang (10 hari lalu) -> dari sekarang
  const past10 = new Date(Date.now() - 10 * 86400000).toISOString();
  await mk("FM-T"+RID+"-OLD2-0001", "thirty_days", { expiresAt: past10 });
  const before = Date.now();
  r = await req("POST", "/license/topup", { licenseKey: "FM-T"+RID+"-OLD2-0001", topupKey: "FM-T"+RID+"-NEW2-0001", deviceId: "dev-A" });
  ok("expired-tenggang dari sekarang", r.status === 200 && new Date(r.data.expiresAt).getTime() >= before, r.data);

  // 8. expired >30 hari -> OLD_KEY_DEAD
  const past40 = new Date(Date.now() - 40 * 86400000).toISOString();
  await mk("FM-T"+RID+"-OLD3-0001", "thirty_days", { expiresAt: past40 });
  await mk("FM-T"+RID+"-NEW3-0001", "thirty_days");
  r = await req("POST", "/license/topup", { licenseKey: "FM-T"+RID+"-OLD3-0001", topupKey: "FM-T"+RID+"-NEW3-0001", deviceId: "dev-A" });
  ok("expired-lewat-tenggang mati", r.status === 403 && r.data.error === "OLD_KEY_DEAD", r);

  // 9. lifetime + topup -> ALREADY_LIFETIME
  await mk("FM-T"+RID+"-LIFE-0001", "lifetime");
  await mk("FM-T"+RID+"-NEW4-0001", "thirty_days");
  await req("POST", "/license/activate", { licenseKey: "FM-T"+RID+"-LIFE-0001", deviceId: "dev-A" });
  r = await req("POST", "/license/topup", { licenseKey: "FM-T"+RID+"-LIFE-0001", topupKey: "FM-T"+RID+"-NEW4-0001", deviceId: "dev-A" });
  ok("lifetime ditolak topup", r.status === 400 && r.data.error === "ALREADY_LIFETIME", r);

  // 10. revoke old -> OLD_KEY_REVOKED
  await req("PATCH", "/admin/licenses/FM-T"+RID+"-OLD1-0001", { revoked: true });
  await mk("FM-T"+RID+"-NEW5-0001", "thirty_days");
  r = await req("POST", "/license/topup", { licenseKey: "FM-T"+RID+"-OLD1-0001", topupKey: "FM-T"+RID+"-NEW5-0001", deviceId: "dev-A" });
  ok("revoked-old ditolak", r.status === 403 && r.data.error === "OLD_KEY_REVOKED", r);
  await req("PATCH", "/admin/licenses/FM-T"+RID+"-OLD1-0001", { revoked: false });

  // 11. admin login salah -> 401; stats ok
  r = await req("GET", "/admin/stats", null, { "X-Admin-Token": "salah" });
  ok("admin tanpa token ditolak", r.status === 401, r);
  r = await req("GET", "/admin/stats");
  ok("stats ok", r.status === 200 && r.data.stats.total >= 10, r.data && r.data.stats);

  // 12. renew manual via admin
  r = await req("POST", "/admin/licenses/FM-T"+RID+"-OLD2-0001/renew", { days: 7 });
  ok("admin renew ok", r.status === 200 && !!r.data.license.expiresAt, r.data);

  // 13. reset device
  r = await req("POST", "/admin/licenses/FM-T"+RID+"-OLD2-0001/reset-device", {});
  ok("reset device ok", r.status === 200 && r.data.license.boundDeviceId === null, r.data);

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SUITE ERROR", e); process.exit(1); });

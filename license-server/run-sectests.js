// node run-sectests.js — nonce replay + sharing flag (server 8787 + ADMIN_TOKEN)
const BASE = "http://localhost:8787";
const ADMIN = "test-admin-token";
let pass = 0, fail = 0;
async function req(method, path, body) {
  const r = await fetch(BASE + path, {
    method, headers: { "Content-Type": "application/json", "X-Admin-Token": ADMIN },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const ok = (n, c, x) => { c ? (pass++, console.log("PASS", n)) : (fail++, console.log("FAIL", n, JSON.stringify(x))); };
(async () => {
  const R = Date.now().toString(36).toUpperCase().slice(-4);
  const K = (s) => `FM-S${R}-${s}`;
  await req("POST", "/admin/licenses", { key: K("A1"), plan: "thirty_days" });
  // 1. nonce reuse ditolak
  const nonce = "deadbeef1234", ts = Date.now();
  const b1 = { licenseKey: K("A1"), deviceId: "dev-X", nonce, ts };
  let r = await req("POST", "/license/activate", b1);
  ok("nonce pertama ok", r.status === 200, r);
  r = await req("POST", "/license/validate", b1);
  ok("nonce reuse ditolak", r.status === 401 && r.data.error === "STALE_REQUEST", r);
  // 2. ts basi ditolak
  r = await req("POST", "/license/validate", { licenseKey: K("A1"), deviceId: "dev-X", nonce: "n2", ts: Date.now() - 600000 });
  ok("ts basi ditolak", r.status === 401 && r.data.error === "STALE_REQUEST", r);
  // 3. sharing: device lain probing -> mismatch + failedAttempts naik
  await req("POST", "/license/validate", { licenseKey: K("A1"), deviceId: "dev-INTRUDER" });
  await req("POST", "/license/validate", { licenseKey: K("A1"), deviceId: "dev-INTRUDER" });
  r = await req("GET", "/admin/licenses");
  const lic = r.data.licenses.find((l) => l.key === K("A1"));
  ok("fail tercatat + device asli tetap", lic.failedAttempts >= 2 && lic.boundDeviceId === "dev-X", { f: lic.failedAttempts, d: lic.boundDeviceId });
  // 4. device asli tetap bisa
  r = await req("POST", "/license/validate", { licenseKey: K("A1"), deviceId: "dev-X" });
  ok("device asli ok + fail reset", r.status === 200, r);
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

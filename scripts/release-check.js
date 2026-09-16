// node scripts/release-check.js — dijalankan via `npm run release:check`
// Gagal (exit 1) bila ada sisa artefak dev / konfigurasi non-produksi.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
let fail = 0;
const bad = (msg) => { fail++; console.error("FAIL:", msg); };
const mustContain = (file, needle, label) => {
  const t = fs.readFileSync(path.join(root, file), "utf8");
  if (!t.includes(needle)) bad(`${label}: ${file} tidak mengandung ${JSON.stringify(needle)}`);
};
const mustNotContain = (file, needle, label) => {
  const t = fs.readFileSync(path.join(root, file), "utf8");
  if (t.includes(needle)) bad(`${label}: ${file} masih mengandung ${JSON.stringify(needle)}`);
};

// 1. pintu bypass & debug harus hilang dari frontend
mustNotContain("src/App.tsx", "bypass", "dev-bypass");
mustNotContain("src/App.tsx", "localhost:5173", "dev-url");
mustNotContain("src/App.tsx", "YOUR-LICENSE-SERVER", "placeholder server");
// 2. Rust: tidak ada URL dev (fallback YOUR-LICENSE-SERVER boleh ada di kode
// karena mati bila env FM_LICENSE_SERVER_URL diset — yang dicek di item 5)
mustNotContain("src-tauri/src/license_store.rs", "localhost:8787", "dev-server-url");
mustNotContain("src-tauri/src/license_store.rs", "\"http://", "http polos di string client lisensi");
// 3. tauri.conf: identifier, updater endpoint milik kita
mustContain("src-tauri/tauri.conf.json", "com.flowmanager.desktop", "identifier");
mustContain("src-tauri/tauri.conf.json", "flowmanager", "updater endpoint repo sendiri");
mustNotContain("src-tauri/tauri.conf.json", "masplangga/flowpilot", "updater endpoint lama");
mustNotContain("src-tauri/tauri.conf.json", "9883364C90076B4B", "updater pubkey lama");
// 4. vite: tanpa sourcemap
mustContain("vite.config.ts", "sourcemap: false", "vite sourcemap");
// 5. env produksi wajib ada saat build (dicek di sini bila di-set)
for (const v of ["FM_LICENSE_SERVER_URL", "FM_LICENSE_PUBKEY"]) {
  if (!process.env[v]) bad(`env ${v} belum diset untuk build rilis`);
}
// 6. Cargo.toml: profile release strip
mustContain("src-tauri/Cargo.toml", "[profile.release]", "release profile");

if (fail) {
  console.error(`\nrelease:check GAGAL (${fail} masalah). Betulkan dulu sebelum build installer.`);
  process.exit(1);
}
console.log("release:check OK");

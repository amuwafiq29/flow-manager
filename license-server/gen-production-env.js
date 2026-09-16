// node gen-production-env.js [adminPassword]
// Kalau password tidak diisi -> dibuatkan acak kuat (tampilkan sekali, simpan baik-baik).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

function randomPassword(n) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*";
  const buf = crypto.randomBytes(n || 20);
  let s = "";
  for (const b of buf) s += chars[b % chars.length];
  return s;
}

const adminPassword = process.argv[2] || randomPassword(20);
const adminUser = "admin";
const salt = crypto.randomBytes(16);
const hash = crypto.pbkdf2Sync(adminPassword, salt, 210000, 64, "sha512");
const adminSecret = crypto.randomBytes(32).toString("hex");
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
const pubPem = publicKey.export({ type: "spki", format: "pem" });

const out = [];
out.push("===== A. COOLIFY ENV (copy satu per satu) =====\n");
out.push("ADMIN_USER\n" + adminUser + "\n");
out.push("ADMIN_PASS_HASH\n" + salt.toString("hex") + ":" + hash.toString("hex") + "\n");
out.push("ADMIN_SECRET\n" + adminSecret + "\n");
out.push("SIGNING_PRIVATE_KEY\n" + privPem);
out.push("===== B. SIMPAN SENDIRI (jangan ke Coolify, untuk build app) =====\n");
out.push("Password admin (login dashboard pertama):\n" + adminPassword + "\n");
out.push("SIGNING_PUBLIC_KEY (nanti untuk env FM_LICENSE_PUBKEY saat build installer):\n" + pubPem);
const text = out.join("\n");
const file = path.join(os.tmpdir(), "fm-production-env.txt");
fs.writeFileSync(file, text);
console.log(text);
console.error("\n[tersimpan juga di: " + file + " — HAPUS setelah dicatat!]");

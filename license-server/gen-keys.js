// node gen-keys.js
// Generate: ADMIN_SECRET + Ed25519 signing keypair + contoh ADMIN_PASS_HASH.
// SIMPAN OUTPUT INI BAIK-BAIK. Private key JANGAN masuk repo.
const crypto = require("crypto");
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pubPem = publicKey.export({ type: "spki", format: "pem" });
const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
console.log("ADMIN_SECRET=" + crypto.randomBytes(32).toString("hex"));
console.log("SIGNING_PRIVATE_KEY<<EOF\n" + privPem + "EOF");
console.log("SIGNING_PUBLIC_KEY<<EOF\n" + pubPem + "EOF");
console.log("(tanam SIGNING_PUBLIC_KEY ke build app via env FM_LICENSE_PUBKEY)");

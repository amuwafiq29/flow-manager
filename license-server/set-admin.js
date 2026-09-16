// node set-admin.js <password>
// Output ADMIN_PASS_HASH=salt:hash untuk env server.
const crypto = require("crypto");
const pass = process.argv[2] || "";
if (!pass || pass.length < 8) {
  console.error("Usage: node set-admin.js <password-min-8-char>");
  process.exit(1);
}
const salt = crypto.randomBytes(16);
const hash = crypto.pbkdf2Sync(pass, salt, 210000, 64, "sha512");
console.log(`ADMIN_PASS_HASH=${salt.toString("hex")}:${hash.toString("hex")}`);

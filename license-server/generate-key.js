// node generate-key.js --plan thirty_days --prefix FM
// Output: FM-XXXX-XXXX-XXXX
const crypto = require("crypto");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);
const prefix = (args.prefix || "FM").toUpperCase().replace(/[^A-Z0-9]/g, "") || "FM";
function seg(n) {
  return crypto.randomBytes(n).toString("hex").toUpperCase().replace(/[^A-Z0-9]/g, "X").slice(0, n);
}
console.log(`${prefix}-${seg(4)}-${seg(4)}-${seg(4)}`);
console.error(`plan: ${args.plan || "thirty_days"} — tambahkan ke licenses.json / KV dengan plan tersebut`);

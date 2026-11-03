require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("./db");
async function main() {
  const sql = fs.readFileSync(path.join(__dirname, "migrations", "001_neon_wallet_game.sql"), "utf8");
  await pool.query(sql);
  console.log("NEON wallet/game schema migration completed.");
}
main().catch(error => { console.error("Migration failed:", error.message); process.exitCode = 1; }).finally(() => pool.end());

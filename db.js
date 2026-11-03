
require("dotenv").config();

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing from .env");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL error:", error.message);
});

module.exports = pool;

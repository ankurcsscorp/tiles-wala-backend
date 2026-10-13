
import pg from "pg";

const { Pool } = pg;

export const connection = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  port: Number(process.env.DB_PORT || 5432),
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

connection.on("connect", () => {
  console.log("PostgreSQL connection established");
});

connection.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err.message);
});

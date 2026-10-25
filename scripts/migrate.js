import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connection } from "../connection.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../migrations");

async function migrate() {
  await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(160) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(migrationsDir)).filter((name) => /^\d+_.+\.sql$/.test(name) && !name.endsWith(".down.sql")).sort();
  for (const file of files) {
    const { rows } = await connection.query("SELECT 1 FROM schema_migrations WHERE version=$1", [file]);
    if (rows.length) continue;
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    const client = await connection.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES($1)", [file]);
      await client.query("COMMIT");
      console.log(`Applied ${file}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
}

migrate().catch((error) => { console.error("Migration failed:", error.message); process.exitCode = 1; }).finally(() => connection.end());

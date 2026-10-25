import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connection } from "../connection.js";

const version = process.argv[2];
if (!version || !/^\d+_[a-z0-9_]+\.sql$/.test(version)) throw new Error("Usage: npm run migrate:down -- 001_multi_store_foundation.sql");
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
const downPath = path.join(dir, version.replace(/\.sql$/, ".down.sql"));
const client = await connection.connect();
try {
  await client.query("BEGIN");
  await client.query(await readFile(downPath, "utf8"));
  await client.query("DELETE FROM schema_migrations WHERE version=$1", [version]);
  await client.query("COMMIT");
  console.log(`Rolled back ${version}`);
} catch (error) {
  await client.query("ROLLBACK");
  console.error("Rollback failed:", error.message);
  process.exitCode = 1;
} finally { client.release(); await connection.end(); }

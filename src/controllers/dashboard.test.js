import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { connection } from "../../connection.js";
import { dashboardReport } from "./dashboard.js";

let originalQuery;
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
afterEach(() => { if (originalQuery) { connection.query = originalQuery; originalQuery = null; } });

test("dashboard report rejects unrecognized report identifiers", async () => {
  originalQuery = connection.query;
  connection.query = async () => { throw new Error("Must reject before database access"); };
  const res = response();
  await dashboardReport({ query: { report: "sales_by_date; DROP TABLE stores" }, user: { id: "1", userType: "Admin" } }, res);
  assert.equal(res.statusCode, 400);
});

test("unassigned users cannot request another store's dashboard report", async () => {
  originalQuery = connection.query;
  connection.query = async () => ({ rows: [{ id: "5" }] });
  const res = response();
  await dashboardReport({ query: { report: "low_stock", storeId: "6" }, user: { id: "9", userType: "Salesperson" } }, res);
  assert.equal(res.statusCode, 403);
});

test("current inventory reports paginate with the correct PostgreSQL bind parameters", async () => {
  const calls = [];
  originalQuery = connection.query;
  connection.query = async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes("FROM stores WHERE is_active")) return { rows: [{ id: "5" }], rowCount: 1 };
    if (sql.startsWith("SELECT count(*)")) return { rows: [{ total: 1 }], rowCount: 1 };
    return { rows: [{ store_name: "North", sku: "A", product_name: "Tile" }], rowCount: 1 };
  };
  const res = response();
  await dashboardReport({ query: { report: "low_stock", fromDate: "2026-01-01", toDate: "2026-01-31", limit: "20", offset: "40" }, user: { id: "1", userType: "Admin" } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[1].values, [["5"], 20, 40]);
  assert.deepEqual(calls[2].values, [["5"]]);
});

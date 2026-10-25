import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { connection } from "../../connection.js";
import { cancelSales, reverseSales } from "./sales.js";

let originalQuery;
let originalConnect;
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
afterEach(() => {
  if (originalQuery) { connection.query = originalQuery; originalQuery = null; }
  if (originalConnect) { connection.connect = originalConnect; originalConnect = null; }
});

test("sales cancellation route cancels a draft instead of reversing it", async () => {
  const statements = [];
  originalQuery = connection.query;
  originalConnect = connection.connect;
  const invoice = { id: "77", store_id: "3", status: "draft" };
  connection.connect = async () => ({
    query: async (sql) => {
      statements.push(sql);
      if (sql.startsWith("SELECT * FROM sales_invoices")) return { rows: [invoice], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }, release() {},
  });
  connection.query = async (sql) => {
    if (sql.includes("WHERE si.id=$1")) return { rows: [{ ...invoice, status: "cancelled" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const res = response();
  await cancelSales({ params: { id: "77" }, user: { id: "1", userType: "Admin", name: "Admin" } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(statements.some((sql) => sql.includes("SET status=$2") && sql.includes("sales_invoices")));
  assert.ok(!statements.some((sql) => sql.includes("SET status='reversed'")));
});

test("sales reversal rejects a salesperson without manager assignment before mutation", async () => {
  const statements = [];
  originalQuery = connection.query;
  originalConnect = connection.connect;
  connection.connect = async () => ({
    query: async (sql) => {
      statements.push(sql);
      if (sql.startsWith("SELECT * FROM sales_invoices")) return { rows: [{ id: "77", store_id: "3", status: "posted" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }, release() {},
  });
  connection.query = async (sql) => sql.includes("SELECT 1 FROM user_store_assignments usa JOIN stores")
    ? { rows: [{}], rowCount: 1 }
    : { rows: [{ role: "staff" }], rowCount: 1 };
  const res = response();
  await reverseSales({ params: { id: "77" }, user: { id: "2", userType: "Salesperson" } }, res);
  assert.equal(res.statusCode, 403);
  assert.ok(statements.includes("ROLLBACK"));
  assert.ok(!statements.some((sql) => sql.startsWith("UPDATE sales_invoices")));
});

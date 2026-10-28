import "dotenv/config";
import assert from "node:assert/strict";
import { test } from "node:test";
import { connection } from "../connection.js";
import { dashboardSummary } from "./controllers/dashboard.js";

const configured = ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"].every((key) => process.env[key]);

test("dashboard summary executes in PostgreSQL and returns monthly sales and purchases", { skip: !configured }, async (t) => {
  const originalQuery = connection.query;
  const client = await connection.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    connection.query = (...args) => client.query(...args);
    const { rows: stores } = await client.query("SELECT id FROM stores WHERE is_active=TRUE ORDER BY id LIMIT 1");
    if (!stores.length) return t.skip("An active store is required to exercise summary SQL");
    const storeId = String(stores[0].id);
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await dashboardSummary({ query: { storeId, fromDate: "2026-10-01", toDate: "2026-10-28" }, user: { userType: "Admin" } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.stores, [storeId]);
    for (const [table, field] of [["sales_invoices", "monthlySales"], ["purchase_invoices", "monthlyPurchases"]]) {
      const { rows } = await client.query(`SELECT COALESCE(sum(total),0)::numeric(18,2) total FROM ${table}
        WHERE store_id=$1 AND status='posted'
        AND invoice_date BETWEEN date_trunc('month',CURRENT_DATE)::date AND CURRENT_DATE`, [storeId]);
      assert.equal(res.body.summary[field], rows[0].total);
    }
  } finally {
    connection.query = originalQuery;
    await client.query("ROLLBACK");
    client.release();
    await connection.end();
  }
});

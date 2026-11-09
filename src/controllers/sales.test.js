import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { connection } from "../../connection.js";
import { cancelSales, createDealerSalesDraft, listSales, postedRevisionInput, previewSalesInvoiceRevision, reverseSales } from "./sales.js";

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

test("dealer invoice draft cannot be created before Ready to Dispatch", async () => {
  originalQuery = connection.query;
  connection.query = async (sql) => sql.includes("FROM dealer_orders o JOIN dealer_profiles")
    ? { rows: [{ id: "41", store_id: "3", status: "PROCESSING", quotation_version: 1, sales_invoice_id: null, stock_confirmed_at: new Date(), payment_terms_confirmed_at: new Date(), customer_id: "12", items_snapshot: [{ productId: "5", unitId: "2", quantity: "1", dealerPrice: "800.00" }] }], rowCount: 1 }
    : { rows: [], rowCount: 0 };
  const res = response();
  await createDealerSalesDraft({ params: { id: "41" }, user: { id: "1", userType: "Admin" } }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /Ready to Dispatch/);
});

test("posted invoice revision preview rejects financial edits before any database read", async () => {
  originalQuery = connection.query;
  let read = false;
  connection.query = async () => { read = true; throw new Error("should not query"); };
  const res = response();
  await previewSalesInvoiceRevision({ params:{id:"77"}, user:{id:"1",userType:"Admin"}, body:{reason:"Correct total",vehicleNumber:"BR01AB1234",expectedRevision:0,idempotencyKey:"request-key-1",additionalCharges:"500"} },res);
  assert.equal(res.statusCode,400);
  assert.match(res.body.message,/only change vehicle and driver details/i);
  assert.equal(read,false);
});

test("posted invoice revision preview is Admin-only", async () => {
  const res = response();
  await previewSalesInvoiceRevision({ params:{id:"77"}, user:{id:"2",userType:"Salesperson"}, body:{} },res);
  assert.equal(res.statusCode,403);
  assert.match(res.body.message,/Only Admin/);
});

test("posted invoice revision accepts an unchanged legacy due date before invoice date", () => {
  const invoice={id:"1790",store_id:"33",customer_id:null,invoice_date:new Date(2026,10,4),due_date:new Date(2026,10,3),document_type:"NON_GST_COMMERCIAL",invoice_type:"NON_GST",invoice_layout:"SIMPLE_LAYOUT"};
  const parsed=postedRevisionInput({reason:"Correct vehicle details",expectedRevision:0,idempotencyKey:"revision-key-1",items:[{productId:"7",unitId:"1",quantity:"1",unitPrice:"850"}]},invoice);
  assert.equal(parsed.error,undefined);
  assert.equal(parsed.data.due,"2026-11-03");
});

test("sales list count query starts from sales invoices when revision subqueries are present", async () => {
  originalQuery = connection.query;
  const queries=[];
  connection.query = async (sql) => {
    queries.push(sql);
    if(sql.startsWith("SELECT id FROM stores"))return {rows:[{id:"33"}],rowCount:1};
    if(sql.startsWith("SELECT count(*)"))return {rows:[{total:0}],rowCount:1};
    if(sql.startsWith("SELECT si.*"))return {rows:[],rowCount:0};
    throw new Error("Unexpected sales list query");
  };
  const res=response();
  await listSales({query:{storeId:"33",limit:"100"},user:{id:"1",userType:"Admin"}},res);
  assert.equal(res.statusCode,200);
  const countQuery=queries.find(sql=>sql.startsWith("SELECT count(*)"));
  assert.match(countQuery,/FROM sales_invoices si JOIN stores/);
  assert.doesNotMatch(countQuery,/FROM sales_invoice_revisions r WHERE si/);
});

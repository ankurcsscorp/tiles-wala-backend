import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connection } from '../connection.js';
import { createSalesDraft, finalizeSales } from './controllers/sales.js';

const configured = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].every(key => process.env[key]);
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('sales drafts finalize with configured prefixes, dated numbering, payment allocation, and stock posting', { skip: !configured && 'database settings not configured' }, async () => {
  const originalConnect = connection.connect, originalQuery = connection.query;
  const client = await connection.connect();
  try {
    await client.query('BEGIN');
    // All fixtures and financial entries remain inside this rolled-back transaction.
    connection.query = (...args) => client.query(...args);
    connection.connect = async () => ({
      query: (sql, values) => client.query(sql === 'BEGIN' ? 'SAVEPOINT sales_api' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT sales_api' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT sales_api' : sql, values),
      release() {},
    });
    const suffix = `${Date.now()}${process.pid}`;
    const user = (await client.query("INSERT INTO users(name,mobile,password_hash,user_type) VALUES('Sales API Test',$1,'test-only','Salesperson') RETURNING id,name,user_type", [suffix])).rows[0];
    user.userType = user.user_type;
    const store = (await client.query("INSERT INTO stores(code,name,state,gstin) VALUES($1,'Sales API Test','Bihar','10JNEPD0678B1ZL') RETURNING id", [`S${suffix}`])).rows[0];
    await client.query("INSERT INTO store_billing_config(store_id,invoice_prefix,gst_registration_status,gst_registration_category,invoice_type,invoice_layout,default_document_type) VALUES($1,'BILL','REGISTERED','REGULAR','GST','STANDARD_GST_LAYOUT','GST_TAX_INVOICE')", [store.id]);
    await client.query("INSERT INTO user_store_assignments(user_id,store_id,role) VALUES($1,$2,'staff')", [user.id, store.id]);
    const customer = (await client.query("INSERT INTO customers(name,state) VALUES('Sales API Test Customer','Bihar') RETURNING id")).rows[0];
    const unit = (await client.query("INSERT INTO units_of_measure(code,name) VALUES($1,'Test unit') RETURNING id", [`U${suffix}`])).rows[0];
    const product = (await client.query("INSERT INTO products(sku,name,base_unit_id,tax_rate) VALUES($1,$2,$3,18) RETURNING id", [`P${suffix}`, `Sales API Test ${suffix}`, unit.id])).rows[0];
    await client.query("INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by) VALUES($1,$2,'adjustment',10,'sales_api_test',1,1,$3,$4)", [store.id, product.id, suffix, user.id]);
    const body = { storeId: String(store.id), customerId: String(customer.id), invoiceDate: '2026-10-23', dueDate: null, invoiceDiscount: '0', additionalCharges: '0', roundOff: '0', notes: '', items: [{ productId: String(product.id), unitId: String(unit.id), quantity: '2', unitPrice: '100', discountAmount: '0', taxRate: '18' }] };
    for (const [period, number] of [['yearly', 'BILL-2026-00001'], ['monthly', 'BILL-2026-10-00001'], ['never', 'BILL-00001']]) {
      await client.query('UPDATE stores SET invoice_numbering_period=$2 WHERE id=$1', [store.id, period]);
      const draft = response();
      await createSalesDraft({ user, body }, draft);
      assert.equal(draft.statusCode, 201, JSON.stringify(draft.body));
      assert.equal(draft.body.status, 'draft');
      assert.equal(draft.body.series, 'BILL');
      assert.equal(draft.body.total, '236.00');
      assert.equal(draft.body.items.length, 1);
      const posted = response();
      await finalizeSales({ user, params: { id: String(draft.body.id) }, body: period === 'yearly' ? { payment: { amount: '100', method: 'cash', idempotencyKey: `sales-api-${suffix}` } } : {} }, posted);
      assert.equal(posted.statusCode, 200, JSON.stringify(posted.body));
      assert.equal(posted.body.status, 'posted');
      assert.equal(posted.body.invoice_number, number);
      assert.equal(posted.body.customer_name_snapshot, 'Sales API Test Customer');
      assert.equal(posted.body.outstanding_balance, period === 'yearly' ? '136.00' : '236.00');
      assert.equal((await client.query("SELECT quantity_delta FROM stock_movements WHERE source_type='sales_invoice' AND source_id=$1", [draft.body.id])).rows[0].quantity_delta, '-2.0000');
      const retry = response();
      await finalizeSales({ user, params: { id: String(draft.body.id) }, body: {} }, retry);
      assert.equal(retry.statusCode, 409);
    }
    assert.equal((await client.query('SELECT quantity FROM inventory_balances WHERE store_id=$1 AND product_id=$2', [store.id, product.id])).rows[0].quantity, '4.0000');
    const draft = response();
    await createSalesDraft({ user, body: { ...body, items: [{ ...body.items[0], quantity: '5' }] } }, draft);
    assert.equal(draft.statusCode, 201);
    const rejected = response();
    await finalizeSales({ user, params: { id: String(draft.body.id) }, body: {} }, rejected);
    assert.equal(rejected.statusCode, 409);
    assert.match(rejected.body.message, /Insufficient stock/);
    assert.equal((await client.query('SELECT status FROM sales_invoices WHERE id=$1', [draft.body.id])).rows[0].status, 'draft');
    assert.equal((await client.query("SELECT count(*)::int AS n FROM stock_movements WHERE source_type='sales_invoice' AND source_id=$1", [draft.body.id])).rows[0].n, 0);
  } finally {
    connection.connect = originalConnect; connection.query = originalQuery;
    await client.query('ROLLBACK');
    client.release();
    await connection.end();
  }
});

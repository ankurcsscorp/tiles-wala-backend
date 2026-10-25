import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connection } from '../connection.js';
import { inventoryList, inventorySummary, productStock, movementHistory, lowStock, valuation, reconciliation } from './controllers/inventory.js';

const configured = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].every(key => process.env[key]);
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('inventory searches and reports execute with store scoping and optional zero stock', { skip: !configured && 'database settings not configured' }, async () => {
  const originalQuery = connection.query;
  const client = await connection.connect();
  try {
    await client.query('BEGIN');
    connection.query = (...args) => client.query(...args);
    const suffix = `${Date.now()}${process.pid}`;
    const search = `Costa inventory ${suffix}`;
    const person = (await client.query("INSERT INTO users(name,mobile,password_hash,user_type) VALUES('Inventory API Test',$1,'test-only','Salesperson') RETURNING id", [suffix])).rows[0];
    const stores = [];
    for (const code of ['I', 'J']) stores.push((await client.query("INSERT INTO stores(code,name) VALUES($1,'Inventory API Test') RETURNING id", [`${code}${suffix}`])).rows[0]);
    await client.query("INSERT INTO user_store_assignments(user_id,store_id) VALUES($1,$2)", [person.id, stores[0].id]);
    const unit = (await client.query("INSERT INTO units_of_measure(code,name) VALUES($1,'Test unit') RETURNING id", [`U${suffix}`])).rows[0];
    const products = [];
    for (const code of ['P', 'Q']) products.push((await client.query("INSERT INTO products(sku,name,base_unit_id,purchase_unit_id,default_purchase_price,reorder_threshold) VALUES($1,$2,$3,$3,25,5) RETURNING id", [`${code}${suffix}`, `${search} ${code}`, unit.id])).rows[0]);
    for (const [index, quantity] of [[0, 4], [1, 20]]) await client.query("INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by) VALUES($1,$2,'adjustment',$3,'inventory_api_test',1,$4,$5,$6)", [stores[index].id, products[0].id, quantity, index + 1, `${suffix}-${index}`, person.id]);
    const admin = { userType: 'Admin' }, staff = { id: person.id, userType: 'Salesperson' };
    const call = async (handler, user, query = {}, params = {}) => {
      const res = response();
      await handler({ user, query, params }, res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      return res.body;
    };
    const all = await call(inventoryList, admin, { search });
    assert.equal(all.total, 2);
    assert.deepEqual(new Set(all.items.map(row => String(row.store_id))), new Set(stores.map(store => String(store.id))));
    const assigned = await call(inventoryList, staff, { search });
    assert.equal(assigned.total, 1);
    assert.equal(String(assigned.items[0].store_id), String(stores[0].id));
    for (const user of [admin, staff]) {
      const query = { storeId: String(stores[0].id), search };
      const stock = await call(inventoryList, user, query);
      assert.equal(stock.items.length, 1);
      assert.equal(stock.items[0].quantity_on_hand, '4.0000');
      assert.equal(Number(stock.items[0].stock_value), 100);
      const includingZero = await call(inventoryList, user, { ...query, includeZero: 'true' });
      assert.equal(includingZero.total, 2);
      assert.ok(includingZero.items.some(row => String(row.product_id) === String(products[1].id) && row.quantity_on_hand === '0.0000'));
      assert.equal((await call(inventorySummary, user, query)).total_quantity, '4.0000');
      assert.equal((await call(productStock, user, query, { productId: String(products[0].id) }))[0].quantity_on_hand, '4.0000');
      assert.equal((await call(movementHistory, user, { ...query, productId: String(products[0].id) })).items.length, 1);
      assert.ok((await call(lowStock, user, query)).some(row => String(row.product_id) === String(products[0].id)));
      assert.equal((await call(valuation, user, query)).valuedTotal, '100.00');
      assert.equal((await call(reconciliation, user, query)).reconciled, true);
    }
    const forbidden = response();
    await inventoryList({ user: staff, query: { storeId: String(stores[1].id), search } }, forbidden);
    assert.equal(forbidden.statusCode, 403);
    assert.equal((await call(inventoryList, staff, { search: `no-match-${suffix}` })).total, 0);
  } finally {
    connection.query = originalQuery;
    await client.query('ROLLBACK');
    client.release();
    await connection.end();
  }
});

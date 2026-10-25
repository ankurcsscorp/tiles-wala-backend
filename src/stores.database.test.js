import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { connection } from '../connection.js';
import { createStore, getStore, listStores, setStoreActive, updateStore, updateStoreSettings } from './controllers/stores.js';

const configured = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].every(key => process.env[key]);
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('store API uses billing configuration for invoice prefixes with the migrated store schema', { skip: !configured && 'database settings not configured' }, async () => {
  const originalConnect = connection.connect, originalQuery = connection.query;
  const client = await connection.connect();
  try {
    await client.query('BEGIN');
    // Build isolated tables from the actual migrations; no application rows are changed.
    const foundation = await readFile(new URL('../migrations/001_multi_store_foundation.sql', import.meta.url), 'utf8');
    for (const table of ['stores', 'store_billing_config']) {
      const definition = foundation.match(new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?\\n\\);`));
      assert.ok(definition, `missing ${table} migration definition`);
      await client.query(definition[0].replace('CREATE TABLE', 'CREATE TEMP TABLE').replace(/;$/, ' ON COMMIT DROP;'));
    }
    const management = await readFile(new URL('../migrations/004_store_management.sql', import.meta.url), 'utf8');
    await client.query(management.slice(0, management.indexOf('ALTER TABLE sales_invoices')));
    await client.query('CREATE TEMP TABLE user_store_assignments(user_id bigint, store_id bigint, is_active boolean) ON COMMIT DROP');
    connection.query = (...args) => client.query(...args);
    connection.connect = async () => ({
      query: (sql, values) => client.query(sql === 'BEGIN' ? 'SAVEPOINT store_api' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT store_api' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT store_api' : sql, values),
      release() {},
    });
    const user = { id: '1', userType: 'Admin' };
    const body = { code: 'tilesWala1', name: 'A & A Home Decor', legalName: 'A and A Home Decor', address: { line1: 'Madhaul Chowk', line2: '' }, city: 'Mahua', state: 'Bihar', pinCode: '844122', gstin: '10JNEPD0678B1ZL', invoicePrefix: '', invoiceNumberingPeriod: 'yearly', invoiceNumberPadding: 5 };
    const created = response();
    await createStore({ user, body }, created);
    assert.equal(created.statusCode, 201);
    assert.equal(created.body.invoice_prefix, 'TILESWALA1');
    const id = String(created.body.id);
    assert.equal((await client.query('SELECT invoice_prefix FROM store_billing_config WHERE store_id=$1', [id])).rows[0].invoice_prefix, 'TILESWALA1');
    const updated = response();
    await updateStore({ user, params: { id }, body: { ...body, invoicePrefix: 'AA', invoiceFooter: 'Thank you', invoiceNumberPadding: 6 } }, updated);
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.body.invoice_prefix, 'AA');
    assert.equal(updated.body.invoice_footer, 'Thank you');
    assert.equal(updated.body.invoice_number_padding, 6);
    const settings = response();
    await updateStoreSettings({ user, params: { id }, body: { ...body, invoicePrefix: 'HOME', defaultTaxRate: 18, taxInclusive: true } }, settings);
    assert.equal(settings.statusCode, 200);
    assert.equal(settings.body.invoice_prefix, 'HOME');
    for (const handler of [getStore, setStoreActive]) {
      const result = response();
      await handler({ user, params: { id }, body: { isActive: true } }, result);
      assert.equal(result.statusCode, 200);
      assert.equal(result.body.invoice_prefix, 'HOME');
    }
    await client.query('INSERT INTO user_store_assignments VALUES(2,$1,TRUE)', [id]);
    for (const listingUser of [user, { id: '2', userType: 'Salesperson' }]) {
      const listed = response();
      await listStores({ user: listingUser }, listed);
      assert.equal(listed.statusCode, 200);
      assert.equal(listed.body.length, 1);
      assert.equal(listed.body[0].invoice_prefix, 'HOME');
    }
  } finally {
    connection.connect = originalConnect; connection.query = originalQuery;
    await client.query('ROLLBACK');
    client.release();
    await connection.end();
  }
});

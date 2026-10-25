import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
const configured=['DB_HOST','DB_USER','DB_PASSWORD','DB_NAME'].every(key=>process.env[key]);

test('GST migration preserves records and enforces independent normalized party uniqueness', {skip:!configured&&'database settings not configured'}, async () => {
  const pool=new pg.Pool({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,port:Number(process.env.DB_PORT||5432)});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    // Temporary tables shadow the masters only on this connection; production rows are never touched.
    await client.query('CREATE TEMP TABLE customers(id bigint GENERATED ALWAYS AS IDENTITY, tax_id varchar(40)) ON COMMIT DROP');
    await client.query('CREATE TEMP TABLE suppliers(id bigint GENERATED ALWAYS AS IDENTITY, tax_id varchar(40)) ON COMMIT DROP');
    const sql=await readFile(new URL('../migrations/019_gst_business_details.sql',import.meta.url),'utf8');
    await client.query("INSERT INTO customers(tax_id) VALUES('27AAPFU0939F1ZV')");
    await client.query(sql);
    assert.equal((await client.query('SELECT tax_id,gst_details FROM customers')).rows[0].tax_id,'27AAPFU0939F1ZV');
    await client.query('SAVEPOINT duplicate_check');
    await assert.rejects(client.query("INSERT INTO customers(tax_id) VALUES(' 27aapfu0939f1zv ' )"),{code:'23505'});
    await client.query('ROLLBACK TO SAVEPOINT duplicate_check');
    await client.query("INSERT INTO suppliers(tax_id) VALUES('27AAPFU0939F1ZV')");
    await client.query('SAVEPOINT supplier_duplicate');
    await assert.rejects(client.query("INSERT INTO suppliers(tax_id) VALUES('27AAPFU0939F1ZV')"),{code:'23505'});
    await client.query('ROLLBACK TO SAVEPOINT supplier_duplicate');
    await client.query("INSERT INTO customers(tax_id) VALUES(NULL),(''),(NULL),('')");
    assert.equal((await client.query('SELECT count(*)::int AS total FROM customers')).rows[0].total,5);
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE customers(tax_id varchar(40)) ON COMMIT DROP');
    await client.query('CREATE TEMP TABLE suppliers(tax_id varchar(40)) ON COMMIT DROP');
    await client.query("INSERT INTO customers(tax_id) VALUES('27AAPFU0939F1ZV'),('27aapfu0939f1zv')");
    await assert.rejects(client.query(sql),/Duplicate GSTINs exist/);
  } finally {await client.query('ROLLBACK');client.release();await pool.end();}
});

test('new purchase supplier snapshots retain GST details after master edits', {skip:!configured&&'database settings not configured'}, async () => {
  const pool=new pg.Pool({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,port:Number(process.env.DB_PORT||5432)});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const schema=`gst_snapshot_test_${process.pid}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query("CREATE TABLE suppliers(id bigint PRIMARY KEY,name text,tax_id text,address jsonb,city text,state text,pin_code text,gst_details jsonb)");
    await client.query("CREATE TABLE purchase_invoices(id bigint PRIMARY KEY,supplier_id bigint,status text)");
    await client.query("INSERT INTO suppliers VALUES(1,'Original Name','27AAPFU0939F1ZV','{\"line1\":\"Original Address\"}','Pune','Maharashtra','411001','{\"legalName\":\"Original Legal\"}')");
    await client.query("INSERT INTO purchase_invoices VALUES(1,1,'posted'),(2,1,'draft')");
    await client.query(await readFile(new URL('../migrations/020_purchase_supplier_gst_snapshot.sql',import.meta.url),'utf8'));
    assert.equal((await client.query('SELECT supplier_details_snapshot FROM purchase_invoices WHERE id=1')).rows[0].supplier_details_snapshot,null);
    await client.query("UPDATE purchase_invoices SET status='posted' WHERE id=2");
    await client.query("UPDATE suppliers SET name='Changed Master',tax_id=NULL");
    const saved=(await client.query('SELECT supplier_details_snapshot FROM purchase_invoices WHERE id=2')).rows[0].supplier_details_snapshot;
    assert.equal(saved.name,'Original Name');assert.equal(saved.gstin,'27AAPFU0939F1ZV');assert.equal(saved.billingAddress.line1,'Original Address');
  } finally {await client.query('ROLLBACK');client.release();await pool.end();}
});

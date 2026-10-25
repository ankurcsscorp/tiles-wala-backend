import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const { Pool } = pg;
const configured = ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"].every((key) => process.env[key]);

test("multi-store database integrity", { skip: !configured && "database connection settings are not configured" }, async () => {
  const pool = new Pool({
    host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, port: Number(process.env.DB_PORT || 5432),
  });
  const client = await pool.connect();
  try {
    const applied = await client.query("SELECT 1 FROM schema_migrations WHERE version='001_multi_store_foundation.sql'");
    assert.equal(applied.rowCount, 1, "apply migrations before database integrity checks");
    const customerMigration = await client.query("SELECT 1 FROM schema_migrations WHERE version='008_customer_management.sql'");
    assert.equal(customerMigration.rowCount, 1, "apply customer management migration before database integrity checks");
    const paymentLinkMigration = await client.query("SELECT 1 FROM schema_migrations WHERE version='009_customer_payment_link.sql'");
    assert.equal(paymentLinkMigration.rowCount, 1, "apply customer payment link migration before database integrity checks");
    const supplierMigration = await client.query("SELECT 1 FROM schema_migrations WHERE version='010_supplier_management.sql'");
    assert.equal(supplierMigration.rowCount, 1, "apply supplier management migration before database integrity checks");
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    let savepointId = 0;
    const expectRejected = async (query, pattern) => {
      const name = `integrity_check_${++savepointId}`;
      await client.query(`SAVEPOINT ${name}`);
      await assert.rejects(query(), pattern);
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await client.query(`RELEASE SAVEPOINT ${name}`);
    };
    const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const user = (await client.query(`INSERT INTO users(name,mobile,password_hash,user_type) VALUES($1,$2,'test-hash','Admin') RETURNING id`, [`db-test-${suffix}`, suffix])).rows[0];
    const store = (await client.query("INSERT INTO stores(code,name,city) VALUES($1,$2,'Test City') RETURNING id,name", [`T${suffix}`, `test-${suffix}`])).rows[0];
    const unit = (await client.query("INSERT INTO units_of_measure(code,name) VALUES($1,'Test Unit') RETURNING id", [`U${suffix}`])).rows[0];
    const box = (await client.query("INSERT INTO units_of_measure(code,name) VALUES($1,'Test Box') RETURNING id", [`B${suffix}`])).rows[0];
    const product = (await client.query("INSERT INTO products(sku,name,base_unit_id) VALUES($1,'Test Product',$2) RETURNING id", [`P${suffix}`, unit.id])).rows[0];
    await expectRejected(() => client.query("INSERT INTO products(sku,name,base_unit_id) VALUES($1,'Duplicate SKU',$2)", [`p${suffix}`, unit.id]), /duplicate key/);
    await client.query("SET CONSTRAINTS product_unit_conversion_check, conversion_unit_check DEFERRED");
    await client.query("UPDATE products SET purchase_unit_id=$2 WHERE id=$1", [product.id, box.id]);
    await client.query("INSERT INTO product_unit_conversions(product_id,unit_id,factor_to_base) VALUES($1,$2,15)", [product.id, box.id]);
    await client.query("SET CONSTRAINTS product_unit_conversion_check, conversion_unit_check IMMEDIATE");
    assert.equal((await client.query("SELECT factor_to_base FROM product_unit_conversions WHERE product_id=$1 AND unit_id=$2", [product.id, box.id])).rows[0].factor_to_base, "15.00000000");
    await client.query(`INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by) VALUES($1,$2,'adjustment',10,'opening_test',1,1,$3,$4)`, [store.id, product.id, `OPEN${suffix}`, user.id]);
    await expectRejected(() => client.query("UPDATE inventory_balances SET quantity=999 WHERE store_id=$1 AND product_id=$2", [store.id, product.id]), /changed through stock movements/);
    const customer = (await client.query("INSERT INTO customers(name) VALUES('Test Customer') RETURNING id")).rows[0];
    await client.query("UPDATE customers SET phone=$2 WHERE id=$1", [customer.id, `+91 90000 ${suffix.slice(-5)}`]);
    const sameContact = await client.query("INSERT INTO customers(name,phone) VALUES('Another Test Customer',$1) RETURNING id", [`+91 90000 ${suffix.slice(-5)}`]);
    assert.ok(sameContact.rowCount, "duplicate customer contact numbers are allowed");
    const invoice = (await client.query(`INSERT INTO sales_invoices(store_id,customer_id,series,invoice_number,total,created_by) VALUES($1,$2,'T',$3,100,$4) RETURNING id`, [store.id, customer.id, `INV${suffix}`, user.id])).rows[0];
    const invoice2 = (await client.query(`INSERT INTO sales_invoices(store_id,customer_id,series,invoice_number,total,created_by) VALUES($1,$2,'T',$3,100,$4) RETURNING id`, [store.id, customer.id, `INV2${suffix}`, user.id])).rows[0];
    const otherInvoice = (await client.query(`INSERT INTO sales_invoices(store_id,customer_id,series,invoice_number,total,created_by) VALUES($1,$2,'T',$3,100,$4) RETURNING id`, [store.id, sameContact.rows[0].id, `INV3${suffix}`, user.id])).rows[0];
    const salesMigration = await client.query("SELECT 1 FROM schema_migrations WHERE version='013_sales_billing.sql'");
    if (salesMigration.rowCount) {
      // The billing schema requires real, balanced invoice lines before posting.
      for (const id of [invoice.id, invoice2.id, otherInvoice.id]) {
        await client.query(`INSERT INTO sales_invoice_items(sales_invoice_id,line_number,product_id,description,unit_id,quantity,unit_price,taxable_value,line_total)
          VALUES($1,1,$2,'Test Product',$3,1,100,100,100)`, [id, product.id, unit.id]);
        await client.query('UPDATE sales_invoices SET subtotal=100,taxable_total=100 WHERE id=$1', [id]);
      }
    }
    await client.query("UPDATE sales_invoices SET status='posted', posted_at=now() WHERE id IN ($1,$2,$3)", [invoice.id, invoice2.id,otherInvoice.id]);
    assert.equal((await client.query("SELECT store_name_snapshot,store_address_snapshot->>'city' AS city FROM sales_invoices WHERE id=$1",[invoice.id])).rows[0].store_name_snapshot,store.name);
    await client.query("UPDATE stores SET name='Changed after billing' WHERE id=$1",[store.id]);
    assert.equal((await client.query("SELECT store_name_snapshot FROM sales_invoices WHERE id=$1",[invoice.id])).rows[0].store_name_snapshot,store.name);
    await expectRejected(() => client.query("INSERT INTO sales_invoices(store_id,series,invoice_number) VALUES($1,'T',$2)",[store.id,`INV${suffix}`]), /duplicate key/);
    await expectRejected(() => client.query("UPDATE sales_invoices SET status='cancelled' WHERE id=$1", [invoice.id]), /only remain posted or be reversed/);
    await expectRejected(() => client.query("UPDATE sales_invoices SET total=90 WHERE id=$1", [invoice.id]), /fields are immutable/);
    const payment = (await client.query(`INSERT INTO payments(store_id,payment_number,direction,payment_method,amount,customer_id,created_by) VALUES($1,$2,'in','cash',100,$3,$4) RETURNING id`, [store.id, `PAY${suffix}`, customer.id,user.id])).rows[0];
    await client.query("INSERT INTO payment_allocations(payment_id,store_id,direction,sales_invoice_id,amount) VALUES($1,$2,'in',$3,60)", [payment.id, store.id, invoice.id]);
    await expectRejected(() => client.query("INSERT INTO payment_allocations(payment_id,store_id,direction,sales_invoice_id,amount) VALUES($1,$2,'in',$3,50)", [payment.id, store.id, invoice2.id]), /allocations exceed/);
    await client.query("INSERT INTO payment_allocations(payment_id,store_id,direction,sales_invoice_id,amount) VALUES($1,$2,'in',$3,40)", [payment.id, store.id, invoice2.id]);
    const advance = (await client.query(`INSERT INTO payments(store_id,payment_number,direction,payment_method,amount,customer_id,created_by) VALUES($1,$2,'in','cash',20,$3,$4) RETURNING id`, [store.id, `ADV${suffix}`, customer.id,user.id])).rows[0];
    await expectRejected(() => client.query("INSERT INTO payment_allocations(payment_id,store_id,direction,sales_invoice_id,amount) VALUES($1,$2,'in',$3,1)", [advance.id,store.id,otherInvoice.id]), /payment customer does not match allocated invoice customer/);
    await client.query("INSERT INTO customer_balance_adjustments(customer_id,store_id,adjustment_type,direction,amount,status,created_by) VALUES($1,$2,'opening_balance','debit',20,'posted',$3)", [customer.id,store.id,user.id]);
    await expectRejected(() => client.query("INSERT INTO customer_balance_adjustments(customer_id,store_id,adjustment_type,direction,amount,status) VALUES($1,$2,'opening_balance','credit',1,'posted')", [customer.id,store.id]), /duplicate key/);
    await client.query("INSERT INTO customer_balance_adjustments(customer_id,store_id,adjustment_type,direction,amount,status,created_by) VALUES($1,$2,'adjustment','credit',5,'posted',$3)", [customer.id,store.id,user.id]);
    const customerBalance = await client.query(`SELECT (COALESCE((SELECT sum(total) FROM sales_invoices WHERE customer_id=$1 AND store_id=$2 AND status='posted'),0)
      - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id WHERE pa.sales_invoice_id IN (SELECT id FROM sales_invoices WHERE customer_id=$1) AND pa.store_id=$2 AND p.status='posted'),0)
      - COALESCE((SELECT sum(p.amount-COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.payment_id=p.id),0)) FROM payments p WHERE p.customer_id=$1 AND p.store_id=$2 AND p.direction='in' AND p.status='posted'),0)
      + COALESCE((SELECT sum(CASE WHEN direction='debit' THEN amount ELSE -amount END) FROM customer_balance_adjustments WHERE customer_id=$1 AND store_id=$2 AND status='posted'),0))::numeric(18,2) AS balance`, [customer.id,store.id]);
    assert.equal(customerBalance.rows[0].balance,"95.00", "outstanding balance reconciles invoices, partial payments, unapplied advances and adjustments");
    const supplier=(await client.query("INSERT INTO suppliers(name,phone) VALUES('Test Supplier',$1) RETURNING id",[`+91 91111 ${suffix.slice(-5)}`])).rows[0];
    const sameSupplierPhone=await client.query("INSERT INTO suppliers(name,phone) VALUES('Second Test Supplier',$1) RETURNING id",[`+91 91111 ${suffix.slice(-5)}`]);
    assert.ok(sameSupplierPhone.rowCount,"duplicate supplier contact numbers are allowed");
    const purchase1=(await client.query(`INSERT INTO purchase_invoices(store_id,supplier_id,series,invoice_number,total,created_by) VALUES($1,$2,'T',$3,200,$4) RETURNING id`,[store.id,supplier.id,`PUR${suffix}`,user.id])).rows[0];
    const purchase2=(await client.query(`INSERT INTO purchase_invoices(store_id,supplier_id,series,invoice_number,total,created_by) VALUES($1,$2,'T',$3,100,$4) RETURNING id`,[store.id,supplier.id,`PUR2${suffix}`,user.id])).rows[0];
    const otherPurchase=(await client.query(`INSERT INTO purchase_invoices(store_id,supplier_id,series,invoice_number,total,created_by) VALUES($1,$2,'T',$3,100,$4) RETURNING id`,[store.id,sameSupplierPhone.rows[0].id,`PUR3${suffix}`,user.id])).rows[0];
    await client.query("UPDATE purchase_invoices SET status='posted',posted_at=now() WHERE id IN ($1,$2,$3)",[purchase1.id,purchase2.id,otherPurchase.id]);
    const supplierPayment=(await client.query(`INSERT INTO payments(store_id,payment_number,direction,payment_method,amount,supplier_id,created_by) VALUES($1,$2,'out','bank_transfer',100,$3,$4) RETURNING id`,[store.id,`SPAY${suffix}`,supplier.id,user.id])).rows[0];
    await client.query("INSERT INTO payment_allocations(payment_id,store_id,direction,purchase_invoice_id,amount) VALUES($1,$2,'out',$3,60)",[supplierPayment.id,store.id,purchase1.id]);
    await client.query("INSERT INTO payment_allocations(payment_id,store_id,direction,purchase_invoice_id,amount) VALUES($1,$2,'out',$3,40)",[supplierPayment.id,store.id,purchase2.id]);
    const supplierAdvance=(await client.query(`INSERT INTO payments(store_id,payment_number,direction,payment_method,amount,supplier_id,created_by) VALUES($1,$2,'out','cash',15,$3,$4) RETURNING id`,[store.id,`SADV${suffix}`,supplier.id,user.id])).rows[0];
    await expectRejected(()=>client.query("INSERT INTO payment_allocations(payment_id,store_id,direction,purchase_invoice_id,amount) VALUES($1,$2,'out',$3,1)",[supplierAdvance.id,store.id,otherPurchase.id]),/payment supplier does not match allocated purchase invoice supplier/);
    await client.query("INSERT INTO supplier_balance_adjustments(supplier_id,store_id,adjustment_type,direction,amount,status,created_by) VALUES($1,$2,'opening_balance','credit',10,'posted',$3)",[supplier.id,store.id,user.id]);
    await expectRejected(()=>client.query("INSERT INTO supplier_balance_adjustments(supplier_id,store_id,adjustment_type,direction,amount,status) VALUES($1,$2,'opening_balance','debit',1,'posted')",[supplier.id,store.id]),/duplicate key/);
    await client.query("INSERT INTO supplier_balance_adjustments(supplier_id,store_id,adjustment_type,direction,amount,status,created_by) VALUES($1,$2,'adjustment','debit',5,'posted',$3)",[supplier.id,store.id,user.id]);
    const supplierBalance=await client.query(`SELECT (COALESCE((SELECT sum(total) FROM purchase_invoices WHERE supplier_id=$1 AND store_id=$2 AND status='posted'),0)
      -COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id WHERE pa.purchase_invoice_id IN (SELECT id FROM purchase_invoices WHERE supplier_id=$1) AND pa.store_id=$2 AND p.status='posted'),0)
      -COALESCE((SELECT sum(p.amount-COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.payment_id=p.id),0)) FROM payments p WHERE p.supplier_id=$1 AND p.store_id=$2 AND p.direction='out' AND p.status='posted'),0)
      +COALESCE((SELECT sum(CASE WHEN direction='credit' THEN amount ELSE -amount END) FROM supplier_balance_adjustments WHERE supplier_id=$1 AND store_id=$2 AND status='posted'),0))::numeric(18,2) AS payable`,[supplier.id,store.id]);
    assert.equal(supplierBalance.rows[0].payable,"190.00","supplier payable reconciles purchases, partial payments, advances and adjustments");
    const move = { store: store.id, product: product.id, user: user.id, key: `MOVE${suffix}` };
    await client.query(`INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by) VALUES($1,$2,'sale',-2,'test',1,1,$3,$4)`, [move.store, move.product, move.key, move.user]);
    assert.equal((await client.query("SELECT quantity FROM inventory_balances WHERE store_id=$1 AND product_id=$2", [store.id, product.id])).rows[0].quantity, salesMigration.rowCount ? "5.0000" : "8.0000");
    await expectRejected(() => client.query(`INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key) VALUES($1,$2,'sale',-20,'test',2,1,$3)`, [store.id, product.id, `NEG${suffix}`]), /insufficient stock/);
    await expectRejected(() => client.query(`INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key) VALUES($1,$2,'sale',-1,'test',1,1,$3)`, [store.id, product.id, move.key]), /duplicate key/);
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});

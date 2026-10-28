import 'dotenv/config';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {connection} from '../connection.js';
import {createSalesDraft,finalizeSales,updateSalesDraft} from './controllers/sales.js';
import {getCustomerLedger,getCustomerBalance} from './controllers/customers.js';
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});
const configured=['DB_HOST','DB_USER','DB_PASSWORD','DB_NAME'].every(k=>process.env[k]);

test('sales document resolution and payment finalization are atomic, authoritative, and retry-safe',{skip:!configured},async()=>{
 const query=connection.query,connect=connection.connect,c=await connection.connect();
 try{
  await c.query('BEGIN');connection.query=(...args)=>c.query(...args);
  connection.connect=async()=>({query:(sql,args)=>c.query(sql==='BEGIN'?'SAVEPOINT final_api':sql==='COMMIT'?'RELEASE SAVEPOINT final_api':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT final_api':sql,args),release(){}});
  const suffix=`${Date.now()}${process.pid}`;
  const user={...(await c.query("INSERT INTO users(name,mobile,password_hash,user_type) VALUES('Finalize Test',$1,'test','Admin') RETURNING id,name",[suffix])).rows[0],userType:'Admin'};
  const store=(await c.query("INSERT INTO stores(code,name,state,gstin) VALUES($1,'Finalize Test','Bihar','10JNEPD0678B1ZL') RETURNING id",['F'+suffix])).rows[0];
  await c.query("INSERT INTO store_billing_config(store_id,invoice_layout,default_document_type,gst_registration_status,gst_registration_category) VALUES($1,'SIMPLE_LAYOUT','BILL_OF_SUPPLY','REGISTERED','REGULAR')",[store.id]);
  const customer=(await c.query("INSERT INTO customers(name,state) VALUES('Finalize Customer','Bihar') RETURNING id")).rows[0];
  const unit=(await c.query("INSERT INTO units_of_measure(code,name) VALUES($1,'Box') RETURNING id",['F'+suffix])).rows[0];
  const product=(await c.query("INSERT INTO products(sku,name,base_unit_id,hsn_code,gst_supply_classification,tax_rate) VALUES($1,'Costa Finalize Tile',$2,'6907','UNKNOWN',NULL) RETURNING id",['F'+suffix,unit.id])).rows[0];
  await c.query("INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by) VALUES($1,$2,'adjustment',100,'finalize_test',1,1,$3,$4)",[store.id,product.id,suffix,user.id]);
  const body={storeId:store.id,customerId:customer.id,invoiceLayout:'SIMPLE_LAYOUT',items:[{productId:product.id,unitId:unit.id,quantity:'3',unitPrice:'850',taxRate:null}]};
  const call=async(fn,body,id)=>{const r=response();await fn({user,body,params:{id},query:{storeId:store.id}},r);return r;};
  let draft=await call(createSalesDraft,body);
  assert.equal(draft.statusCode,422);assert.equal(draft.body.code,'PRODUCT_TAX_CLASSIFICATION_REQUIRED');assert.equal(String(draft.body.productId),String(product.id));assert.equal(draft.body.field,'items[0].productId');
  assert.match(draft.body.message,/Costa Finalize Tile.*Bill of Supply/);
  draft=await call(createSalesDraft,{...body,documentType:'GST_TAX_INVOICE'});
  assert.equal(draft.statusCode,422);assert.equal(draft.body.code,'PRODUCT_TAX_RATE_REQUIRED');
  await c.query("UPDATE products SET gst_supply_classification='TAXABLE',tax_rate=18 WHERE id=$1",[product.id]);
  const gst={...body,documentType:'GST_TAX_INVOICE',items:[{...body.items[0],taxRate:0}]};
  draft=await call(createSalesDraft,gst);assert.equal(draft.statusCode,201,JSON.stringify(draft.body));assert.equal(draft.body.total,'3009.00');assert.equal(draft.body.document_type,'GST_TAX_INVOICE');
  const id=draft.body.id;
  const before=await c.query('SELECT quantity FROM inventory_balances WHERE store_id=$1 AND product_id=$2',[store.id,product.id]);
  for(const amount of ['25550','-1','abc','1.001']){
   const fail=await call(finalizeSales,{payment:{amount,method:'cash',idempotencyKey:'fail-'+suffix}},id);
   assert.equal(fail.statusCode,400,JSON.stringify(fail.body));assert.equal(fail.body.code,'INVALID_PAYMENT_AMOUNT');
   assert.equal((await c.query('SELECT status FROM sales_invoices WHERE id=$1',[id])).rows[0].status,'draft');
   assert.equal((await c.query("SELECT count(*)::int n FROM stock_movements WHERE source_type='sales_invoice' AND source_id=$1",[id])).rows[0].n,0);
   assert.equal((await c.query('SELECT count(*)::int n FROM payment_allocations WHERE sales_invoice_id=$1',[id])).rows[0].n,0);
   assert.equal((await c.query("SELECT count(*)::int n FROM invoice_number_sequences WHERE store_id=$1",[store.id])).rows[0].n,0);
  }
  assert.equal((await c.query('SELECT quantity FROM inventory_balances WHERE store_id=$1 AND product_id=$2',[store.id,product.id])).rows[0].quantity,before.rows[0].quantity);
  for(const [index,amount,balance] of [[0,'0','3009.00'],[1,'1000','2009.00'],[2,'3009','0.00']]){
   if(index)draft=await call(createSalesDraft,gst);
   const posted=await call(finalizeSales,{payment:{amount,method:'cash',idempotencyKey:`paid-${index}-${suffix}`}},draft.body.id);
   assert.equal(posted.statusCode,200,JSON.stringify(posted.body));assert.equal(posted.body.outstanding_balance,balance);
   const again=await call(finalizeSales,{},draft.body.id);assert.equal(again.statusCode,409);assert.equal(again.body.code,'INVOICE_ALREADY_FINALIZED');
   assert.equal((await c.query("SELECT count(*)::int n FROM stock_movements WHERE source_type='sales_invoice' AND source_id=$1",[draft.body.id])).rows[0].n,1);
  }
  const ledger=await call(getCustomerLedger,{},customer.id);assert.equal(ledger.statusCode,200,JSON.stringify(ledger.body));assert.equal(ledger.body.length,5);
  const balance=await call(getCustomerBalance,{},customer.id);assert.equal(balance.body.totalOutstanding,'5018.00');
  // New default changes do not convert an existing GST draft or allow explicit conversion.
  draft=await call(createSalesDraft,gst);
  const conversion=await call(updateSalesDraft,{...gst,documentType:'BILL_OF_SUPPLY'},draft.body.id);assert.equal(conversion.statusCode,409);
  await c.query("UPDATE store_billing_config SET default_document_type='BILL_OF_SUPPLY' WHERE store_id=$1",[store.id]);
  assert.equal((await call(finalizeSales,{},draft.body.id)).statusCode,200);
  // Reviewed Bill of Supply uses quantity × rate without GST. Later classification edits revalidate and roll back.
  await c.query("UPDATE products SET gst_supply_classification='EXEMPT',gst_classification_reference='Reviewed fixture' WHERE id=$1",[product.id]);
  draft=await call(createSalesDraft,body);assert.equal(draft.statusCode,201);assert.equal(draft.body.total,'2550.00');
  await c.query("UPDATE products SET gst_supply_classification='UNKNOWN' WHERE id=$1",[product.id]);
  let fail=await call(finalizeSales,{},draft.body.id);assert.equal(fail.body.code,'PRODUCT_TAX_CLASSIFICATION_REQUIRED');
  assert.equal((await c.query('SELECT status FROM sales_invoices WHERE id=$1',[draft.body.id])).rows[0].status,'draft');
  await c.query("UPDATE products SET gst_supply_classification='EXEMPT' WHERE id=$1",[product.id]);
  assert.equal((await call(finalizeSales,{},draft.body.id)).statusCode,200);
  // A changed catalog tax rate is authoritative at posting; stale overpayment still rolls back.
  await c.query("UPDATE products SET gst_supply_classification='TAXABLE',tax_rate=18 WHERE id=$1",[product.id]);
  draft=await call(createSalesDraft,gst);assert.equal(draft.body.total,'3009.00');
  await c.query('UPDATE products SET tax_rate=12 WHERE id=$1',[product.id]);
  fail=await call(finalizeSales,{payment:{amount:'3009',method:'cash',idempotencyKey:'stale-'+suffix}},draft.body.id);
  assert.equal(fail.body.code,'INVALID_PAYMENT_AMOUNT');assert.equal(fail.body.invoiceTotal,'2856.00');
  assert.equal((await c.query('SELECT total,status FROM sales_invoices WHERE id=$1',[draft.body.id])).rows[0].total,'3009.00');
  const recalculated=await call(finalizeSales,{},draft.body.id);assert.equal(recalculated.statusCode,200);assert.equal(recalculated.body.total,'2856.00');
  // Non-GST is authoritative regardless of saved GSTIN, UNKNOWN classification, or product tax rate.
  await c.query("UPDATE store_billing_config SET invoice_type='NON_GST',default_document_type='NON_GST_COMMERCIAL' WHERE store_id=$1",[store.id]);
  await c.query("UPDATE products SET gst_supply_classification='UNKNOWN',tax_rate=18 WHERE id=$1",[product.id]);
  draft=await call(createSalesDraft,body);assert.equal(draft.statusCode,201,JSON.stringify(draft.body));
  assert.equal(draft.body.document_type,'NON_GST_COMMERCIAL');assert.equal(draft.body.invoice_layout,'SIMPLE_LAYOUT');assert.equal(draft.body.total,'2550.00');assert.equal(draft.body.tax_total,'0.00');
  assert.equal((await call(finalizeSales,{},draft.body.id)).statusCode,200);
  const explicitBill=await call(createSalesDraft,{...body,documentType:'BILL_OF_SUPPLY'});assert.equal(explicitBill.body.code,'PRODUCT_TAX_CLASSIFICATION_REQUIRED');
  assert.equal((await c.query('SELECT default_document_type FROM store_billing_config WHERE store_id=$1',[store.id])).rows[0].default_document_type,'NON_GST_COMMERCIAL');
  const unregistered=(await c.query("INSERT INTO stores(code,name,state) VALUES($1,'Unregistered Finalize','Bihar') RETURNING id",['N'+suffix])).rows[0];
  await c.query("INSERT INTO store_billing_config(store_id,invoice_layout,default_document_type,gst_registration_status) VALUES($1,'SIMPLE_LAYOUT','NON_GST_COMMERCIAL','UNREGISTERED')",[unregistered.id]);
  await c.query("INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by) VALUES($1,$2,'adjustment',10,'finalize_test',2,1,$3,$4)",[unregistered.id,product.id,'N'+suffix,user.id]);
  draft=await call(createSalesDraft,{...body,storeId:unregistered.id});assert.equal(draft.statusCode,201);assert.equal(draft.body.document_type,'NON_GST_COMMERCIAL');
  const commercial=await call(finalizeSales,{payment:{amount:'2550',method:'cash',idempotencyKey:'commercial-'+suffix}},draft.body.id);
  assert.equal(commercial.statusCode,200,JSON.stringify(commercial.body));assert.equal(commercial.body.total,'2550.00');assert.equal(commercial.body.tax_total,'0.00');assert.equal(commercial.body.outstanding_balance,'0.00');
 }finally{connection.query=query;connection.connect=connect;await c.query('ROLLBACK');c.release();await connection.end();}
});

import 'dotenv/config';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {connection} from '../connection.js';
import {getInvoiceSettings,putInvoiceSettings} from './controllers/invoiceSettings.js';
import {createSalesDraft,finalizeSales,getSales} from './controllers/sales.js';
import {createPurchaseDraft,postPurchaseInvoice} from './controllers/purchases.js';
const configured=['DB_HOST','DB_USER','DB_PASSWORD','DB_NAME'].every(k=>process.env[k]);
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});

test('two billing modes default to zero-tax entry without setup and preserve opted-in GST and historical invoices through migration',{skip:!configured},async()=>{
 const query=connection.query,connect=connection.connect,c=await connection.connect();
 try{
  await c.query('BEGIN');connection.query=(...args)=>c.query(...args);
  connection.connect=async()=>({query:(sql,args)=>c.query(sql==='BEGIN'?'SAVEPOINT simple_api':sql==='COMMIT'?'RELEASE SAVEPOINT simple_api':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT simple_api':sql,args),release(){}});
  const suffix=`${Date.now()}${process.pid}`;
  const user={...(await c.query("INSERT INTO users(name,mobile,password_hash,user_type) VALUES('Simple Test',$1,'test','Admin') RETURNING id",[suffix])).rows[0],userType:'Admin'};
  const stores=[];
  for(const i of [0,1])stores.push((await c.query("INSERT INTO stores(code,name,state,gstin,tax_id) VALUES($1,'Simple Test','Bihar','10JNEPD0678B1ZL','10JNEPD0678B1ZL') RETURNING id",[`S${i}${suffix}`])).rows[0]);
  const invoke=async(fn,body={},id)=>{const r=response();await fn({user,body,params:{id}},r);return r;};
  let settings=await invoke(getInvoiceSettings,{},stores[0].id);
  assert.equal(settings.body.data.billingMode,'NON_GST');assert.equal(settings.body.data.warning,null);
  settings=await invoke(putInvoiceSettings,{billingMode:'NON_GST'},stores[0].id);
  assert.equal(settings.statusCode,200);assert.equal(settings.body.data.registrationStatus,'UNKNOWN');assert.equal(settings.body.data.registrationCategory,'UNKNOWN');assert.equal(settings.body.data.gstin,'10JNEPD0678B1ZL');
  const unit=(await c.query("INSERT INTO units_of_measure(code,name) VALUES($1,'Box') RETURNING id",['S'+suffix])).rows[0];
  const product=(await c.query("INSERT INTO products(sku,name,base_unit_id,tax_rate) VALUES($1,'No GST Setup Tile',$2,NULL) RETURNING id",['S'+suffix,unit.id])).rows[0];
  const customer=(await c.query("INSERT INTO customers(name) VALUES('Simple Test Customer') RETURNING id")).rows[0];
  for(const store of stores)await c.query("INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by) VALUES($1,$2,'adjustment',20,'simple_test',$1,1,$3,$4)",[store.id,product.id,`${suffix}-${store.id}`,user.id]);
  const body={storeId:stores[0].id,customerId:customer.id,items:[{productId:product.id,unitId:unit.id,quantity:'3',unitPrice:'850'}]};
  const draft=await invoke(createSalesDraft,body);assert.equal(draft.statusCode,201,JSON.stringify(draft.body));
  assert.equal(draft.body.document_type,'NON_GST_COMMERCIAL');assert.equal(draft.body.total,'2550.00');assert.equal(draft.body.items[0].tax_rate,'0.0000');
  const posted=await invoke(finalizeSales,{payment:{amount:'1000',method:'cash',idempotencyKey:'simple-'+suffix}},draft.body.id);
  assert.equal(posted.statusCode,200,JSON.stringify(posted.body));assert.equal(posted.body.outstanding_balance,'1550.00');assert.equal(posted.body.tax_total,'0.00');
  assert.equal((await c.query('SELECT quantity FROM inventory_balances WHERE store_id=$1 AND product_id=$2',[stores[0].id,product.id])).rows[0].quantity,'17.0000');
  // Purchases default to the same Non-GST mode without supplier GST evidence.
  const supplier=(await c.query("INSERT INTO suppliers(name,tax_id) VALUES('Simple Test Supplier','10JNEPD0678B1ZL') RETURNING id")).rows[0];
  let purchase=await invoke(createPurchaseDraft,{...body,customerId:undefined,supplierId:supplier.id});
  assert.equal(purchase.statusCode,201,JSON.stringify(purchase.body));assert.equal(purchase.body.supplier_document_type,'NON_GST_COMMERCIAL');assert.equal(purchase.body.total,'2550.00');
  purchase=await invoke(postPurchaseInvoice,{},purchase.body.id);assert.equal(purchase.statusCode,200,JSON.stringify(purchase.body));assert.equal(purchase.body.tax_total,'0.00');
  // Only explicit GST mode starts the GST setup and catalog-tax validation path.
  assert.equal((await invoke(putInvoiceSettings,{billingMode:'GST'},stores[1].id)).statusCode,422);
  settings=await invoke(putInvoiceSettings,{billingMode:'GST',registrationStatus:'REGISTERED',registrationCategory:'REGULAR'},stores[1].id);
  assert.equal(settings.statusCode,200);assert.equal(settings.body.data.invoiceLayout,'STANDARD_GST_LAYOUT');
  const gstBody={...body,storeId:stores[1].id,items:[{...body.items[0],quantity:'1',unitPrice:'100'}]};
  assert.equal((await invoke(createSalesDraft,gstBody)).body.code,'PRODUCT_TAX_RATE_REQUIRED');
  await c.query("UPDATE products SET tax_rate=18,hsn_code='6907',gst_supply_classification='TAXABLE' WHERE id=$1",[product.id]);
  const gstDraft=await invoke(createSalesDraft,gstBody);assert.equal(gstDraft.statusCode,201,JSON.stringify(gstDraft.body));assert.equal(gstDraft.body.total,'118.00');
  const gstPosted=await invoke(finalizeSales,{},gstDraft.body.id);assert.equal(gstPosted.statusCode,200,JSON.stringify(gstPosted.body));assert.equal(gstPosted.body.tax_total,'18.00');
  // Reapply the real migration transactionally to verify legacy defaults and saved history.
  await c.query("UPDATE store_billing_config SET default_document_type='BILL_OF_SUPPLY',invoice_type='GST' WHERE store_id=$1",[stores[0].id]);
  await c.query(await readFile(new URL('../migrations/026_simple_non_gst_default.sql',import.meta.url),'utf8'));
  assert.equal((await invoke(getInvoiceSettings,{},stores[0].id)).body.data.billingMode,'NON_GST');
  assert.equal((await invoke(getInvoiceSettings,{},stores[1].id)).body.data.billingMode,'GST');
  assert.deepEqual((await invoke(getSales,{},draft.body.id)).body,posted.body);
  assert.deepEqual((await invoke(getSales,{},gstDraft.body.id)).body,gstPosted.body);
  const audit=await c.query("SELECT before_data,after_data FROM audit_logs WHERE store_id=$1 AND action='invoice_settings.simple_default_migration'",[stores[0].id]);
  assert.equal(audit.rowCount,1);assert.equal(audit.rows[0].before_data.default_document_type,'BILL_OF_SUPPLY');assert.equal(audit.rows[0].after_data.default_document_type,'NON_GST_COMMERCIAL');
 }finally{connection.query=query;connection.connect=connect;await c.query('ROLLBACK');c.release();await connection.end();}
});

import 'dotenv/config';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {connection} from '../connection.js';
import {getInvoiceSettings,putInvoiceSettings} from './controllers/invoiceSettings.js';
import {createSalesDraft,finalizeSales,getSales} from './controllers/sales.js';
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});
const configured=['DB_HOST','DB_USER','DB_PASSWORD','DB_NAME'].every(k=>process.env[k]);
test('appearance stays independent while GST, commercial invoices, and Bills of Supply validate tax eligibility',{skip:!configured},async()=>{
 const query=connection.query,connect=connection.connect,c=await connection.connect();
 try{
  await c.query('BEGIN');connection.query=(...args)=>c.query(...args);
  connection.connect=async()=>({query:(sql,args)=>c.query(sql==='BEGIN'?'SAVEPOINT layout_api':sql==='COMMIT'?'RELEASE SAVEPOINT layout_api':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT layout_api':sql,args),release(){}});
  const suffix=`${Date.now()}${process.pid}`;
  const user=(await c.query("INSERT INTO users(name,mobile,password_hash,user_type) VALUES('Layout Test',$1,'test','Salesperson') RETURNING id",[suffix])).rows[0];user.userType='Salesperson';
  const stores=[];
  for(const i of [0,1]){
   const st=(await c.query("INSERT INTO stores(code,name,state,gstin) VALUES($1,'Layout Test','Bihar',$2) RETURNING id",[`L${i}${suffix}`,i===0?'10JNEPD0678B1ZL':null])).rows[0];stores.push(st);
   await c.query("INSERT INTO user_store_assignments(user_id,store_id,role) VALUES($1,$2,'manager')",[user.id,st.id]);
  }
  const settings=async(fn,index,body)=>{const r=response();await fn({user,params:{id:stores[index].id},body},r);return r;};
  // Match the reported case: a stored GSTIN, unknown declaration, appearance-only PATCH through PUT.
  let saved=await settings(putInvoiceSettings,0,{invoiceLayout:'SIMPLE_LAYOUT'});assert.equal(saved.statusCode,200,JSON.stringify(saved.body));
  assert.equal(saved.body.data.registrationStatus,'UNKNOWN');assert.equal(saved.body.data.gstin,'10JNEPD0678B1ZL');assert.equal(saved.body.data.defaultDocumentType,'GST_TAX_INVOICE');
  const reloaded=await settings(getInvoiceSettings,0);assert.equal(reloaded.body.data.invoiceLayout,'SIMPLE_LAYOUT');assert.equal((await settings(getInvoiceSettings,1)).body.data.invoiceLayout,'STANDARD_GST_LAYOUT');
  saved=await settings(putInvoiceSettings,0,{registrationStatus:'REGISTERED',registrationCategory:'REGULAR'});assert.equal(saved.statusCode,200);
  const u=(await c.query("INSERT INTO units_of_measure(code,name) VALUES($1,'Box') RETURNING id",['L'+suffix])).rows[0];
  const p=(await c.query("INSERT INTO products(sku,name,base_unit_id,tax_rate,hsn_code,gst_supply_classification) VALUES($1,'Layout Tile',$2,18,'6907','TAXABLE') RETURNING id",['L'+suffix,u.id])).rows[0];
  await c.query("INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by) VALUES($1,$2,'adjustment',100,'layout_test',1,1,$3,$4)",[stores[0].id,p.id,suffix,user.id]);
  const body={storeId:String(stores[0].id),invoiceLayout:'SIMPLE_LAYOUT',documentType:'GST_TAX_INVOICE',items:[{productId:String(p.id),unitId:String(u.id),quantity:'2',unitPrice:'100',taxRate:'0'}]};
  const create=async b=>{const r=response();await createSalesDraft({user,body:b},r);return r;};
  const post=async id=>{const r=response();await finalizeSales({user,params:{id},body:{}},r);return r;};
  let draft=await create(body);assert.equal(draft.statusCode,201,JSON.stringify(draft.body));assert.equal(draft.body.total,'236.00');assert.equal(draft.body.tax_total,'36.00');assert.equal(draft.body.items[0].tax_rate,'18.0000');
  const posted=await post(draft.body.id);assert.equal(posted.statusCode,200,JSON.stringify(posted.body));assert.equal(posted.body.cgst_total,'18.00');assert.equal(posted.body.sgst_total,'18.00');
  const original=JSON.stringify(posted.body);
  saved=await settings(putInvoiceSettings,0,{defaultDocumentType:'NON_GST_COMMERCIAL'});assert.equal(saved.statusCode,422);assert.match(saved.body.message,/unregistered business/);
  saved=await settings(putInvoiceSettings,1,{invoiceLayout:'SIMPLE_LAYOUT',defaultDocumentType:'NON_GST_COMMERCIAL',registrationStatus:'UNREGISTERED'});assert.equal(saved.statusCode,200);
  const commercial=await create({...body,storeId:String(stores[1].id),documentType:'NON_GST_COMMERCIAL',items:[{...body.items[0],taxRate:null}]});assert.equal(commercial.statusCode,201,JSON.stringify(commercial.body));assert.equal(commercial.body.total,'200.00');assert.equal(commercial.body.tax_total,'0.00');
  assert.equal((await settings(getInvoiceSettings,0)).body.data.defaultDocumentType,'GST_TAX_INVOICE');
  // Composition uses a Bill of Supply and requires an explicit intra-state place of supply.
  saved=await settings(putInvoiceSettings,0,{registrationStatus:'REGISTERED',registrationCategory:'COMPOSITION',defaultDocumentType:'BILL_OF_SUPPLY'});assert.equal(saved.statusCode,200,JSON.stringify(saved.body));
  const bill={...body,documentType:'BILL_OF_SUPPLY',placeOfSupply:'Bihar',items:[{...body.items[0],taxRate:null}]};
  let rejected=await create({...bill,placeOfSupply:'Maharashtra'});assert.equal(rejected.statusCode,422);
  rejected=await create({...bill,documentType:'GST_TAX_INVOICE'});assert.equal(rejected.statusCode,422);
  draft=await create(bill);assert.equal(draft.statusCode,201,JSON.stringify(draft.body));assert.equal(draft.body.tax_total,'0.00');assert.equal(draft.body.total,'200.00');assert.equal(draft.body.document_type,'BILL_OF_SUPPLY');
  let billPosted=await post(draft.body.id);assert.equal(billPosted.statusCode,200,JSON.stringify(billPosted.body));assert.equal(billPosted.body.registration_category_snapshot,'COMPOSITION');
  // The original finalized GST snapshot remains byte-for-byte identical after settings change.
  const old=response();await getSales({user,params:{id:posted.body.id}},old);assert.equal(JSON.stringify(old.body),original);
  // Regular registered Bill of Supply requires explicit exemption evidence, not a zero rate.
  saved=await settings(putInvoiceSettings,0,{registrationCategory:'REGULAR'});assert.equal(saved.statusCode,200);
  rejected=await create(bill);assert.equal(rejected.statusCode,422);assert.match(rejected.body.message,/taxable products require GST/);
  await c.query("UPDATE products SET gst_supply_classification='EXEMPT',gst_classification_reference='Reviewed exemption notification fixture' WHERE id=$1",[p.id]);
  draft=await create(bill);assert.equal(draft.statusCode,201,JSON.stringify(draft.body));assert.equal(draft.body.items[0].product_snapshot.supplyClassification,'EXEMPT');assert.equal(draft.body.tax_total,'0.00');
  billPosted=await post(draft.body.id);assert.equal(billPosted.statusCode,200,JSON.stringify(billPosted.body));
  await c.query("UPDATE products SET gst_supply_classification='UNKNOWN',tax_rate=0 WHERE id=$1",[p.id]);
  rejected=await create(bill);assert.equal(rejected.statusCode,422);assert.match(rejected.body.message,/classification/);
  // Registration/category changes after drafting are checked again before stock posting.
  await c.query("UPDATE products SET gst_supply_classification='EXEMPT' WHERE id=$1",[p.id]);
  draft=await create(bill);assert.equal(draft.statusCode,201);
  await settings(putInvoiceSettings,0,{registrationCategory:'COMPOSITION'});
  rejected=await post(draft.body.id);assert.equal(rejected.statusCode,409);
  await c.query("UPDATE user_store_assignments SET role='staff' WHERE user_id=$1",[user.id]);
  assert.equal((await settings(putInvoiceSettings,0,{invoiceLayout:'STANDARD_GST_LAYOUT'})).statusCode,403);
  assert.ok((await c.query('SELECT count(*)::int n FROM invoice_settings_audit WHERE store_id=$1',[stores[0].id])).rows[0].n>=4);
 }finally{connection.query=query;connection.connect=connect;await c.query('ROLLBACK');c.release();await connection.end();}
});

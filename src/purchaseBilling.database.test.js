import 'dotenv/config';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {connection} from '../connection.js';
import {getInvoiceSettings,putInvoiceSettings} from './controllers/invoiceSettings.js';
import {createPurchaseDraft,updatePurchaseDraft,getPurchase,postPurchaseInvoice,receivePurchaseGoods} from './controllers/purchases.js';
import {createSupplierPayment} from './controllers/payments.js';
import {getSupplierBalance,getSupplierLedger} from './controllers/suppliers.js';
import {createReturn,postReturn} from './controllers/returns.js';
const configured=['DB_HOST','DB_USER','DB_PASSWORD','DB_NAME'].every(k=>process.env[k]);
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});
test('shared billing mode preserves supplier GST, receipts, payments, returns, and historical purchase snapshots',{skip:!configured},async()=>{
 const originalQuery=connection.query,originalConnect=connection.connect,c=await connection.connect();
 try{
  await c.query('BEGIN');connection.query=(...args)=>c.query(...args);
  connection.connect=async()=>({query:(sql,args)=>c.query(sql==='BEGIN'?'SAVEPOINT dual_api':sql==='COMMIT'?'RELEASE SAVEPOINT dual_api':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT dual_api':sql,args),release(){}});
  const suffix=`${Date.now()}${process.pid}`;
  const user=(await c.query("INSERT INTO users(name,mobile,password_hash,user_type) VALUES('Dual Billing Test',$1,'test','Salesperson') RETURNING id",[suffix])).rows[0];user.userType='Salesperson';
  const stores=[];for(const index of [0,1]){
   const st=(await c.query("INSERT INTO stores(code,name,state) VALUES($1,'Dual Billing Test','Bihar') RETURNING id",[`D${index}${suffix}`])).rows[0];stores.push(st);
   await c.query("INSERT INTO user_store_assignments(user_id,store_id,role) VALUES($1,$2,'manager')",[user.id,st.id]);
  }
  let createAttempt=0;
  const invoke=async(fn,params={},body={},query={})=>{if(fn===createPurchaseDraft)body={...body,supplierInvoiceNumber:`${body.supplierInvoiceNumber||'SUP'}-${++createAttempt}`};const r=response();await fn({user,params,body,query},r);return r;};
  let result=await invoke(putInvoiceSettings,{id:stores[0].id},{invoiceLayout:'SIMPLE_LAYOUT'});assert.equal(result.statusCode,200);assert.equal(result.body.data.billingMode,'SIMPLE');assert.equal(result.body.data.registrationStatus,'UNKNOWN');
  assert.equal((await invoke(getInvoiceSettings,{id:stores[1].id})).body.data.billingMode,'GST');
  const registered=(await c.query("INSERT INTO suppliers(name,tax_id,state) VALUES('Registered supplier','10JNEPD0678B1ZL','Bihar') RETURNING id")).rows[0];
  const unregistered=(await c.query("INSERT INTO suppliers(name,state) VALUES('Unregistered supplier','Bihar') RETURNING id")).rows[0];
  const unit=(await c.query("INSERT INTO units_of_measure(code,name) VALUES($1,'Piece') RETURNING id",['E'+suffix])).rows[0];
  const box=(await c.query("INSERT INTO units_of_measure(code,name) VALUES($1,'Box') RETURNING id",['B'+suffix])).rows[0];
  const product=(await c.query("INSERT INTO products(sku,name,base_unit_id,tax_rate,hsn_code,gst_supply_classification) VALUES($1,'Dual Tile',$2,18,'6907','TAXABLE') RETURNING id",['D'+suffix,unit.id])).rows[0];
  await c.query('INSERT INTO product_unit_conversions(product_id,unit_id,factor_to_base) VALUES($1,$2,4)',[product.id,box.id]);
  const base={storeId:String(stores[0].id),supplierId:String(registered.id),invoiceLayout:'SIMPLE_LAYOUT',supplierDocumentType:'GST_TAX_INVOICE',supplierTaxJurisdiction:'INTRA_STATE',supplierInvoiceNumber:'SUP-'+suffix,declaredTaxTotal:'36.00',items:[{productId:String(product.id),unitId:String(box.id),quantity:'2',unitPrice:'100',taxRate:'18'}]};
  let draft=await invoke(createPurchaseDraft,{},base);assert.equal(draft.statusCode,201,JSON.stringify(draft.body));
  assert.equal(draft.body.invoice_layout,'SIMPLE_LAYOUT');assert.equal(draft.body.total,'236.00');assert.equal(draft.body.tax_total,'36.00');assert.equal(draft.body.cgst_total,'18.00');assert.equal(draft.body.sgst_total,'18.00');assert.equal(draft.body.items[0].product_snapshot.defaultTaxRate,'18.0000');
  const id=draft.body.id;
  // A later preferred mode does not convert existing drafts.
  await invoke(putInvoiceSettings,{id:stores[0].id},{invoiceLayout:'STANDARD_GST_LAYOUT'});
  let edited=await invoke(updatePurchaseDraft,{id},base);assert.equal(edited.statusCode,200,JSON.stringify(edited.body));assert.equal(edited.body.invoice_layout,'SIMPLE_LAYOUT');draft=edited;
  result=await invoke(updatePurchaseDraft,{id},{...base,invoiceLayout:'STANDARD_GST_LAYOUT'});assert.equal(result.statusCode,409);
  result=await invoke(createPurchaseDraft,{},base);assert.equal(result.statusCode,409);
  result=await invoke(postPurchaseInvoice,{id});assert.equal(result.statusCode,200,JSON.stringify(result.body));assert.equal(result.body.supplier_details_snapshot.gstin,'10JNEPD0678B1ZL');
  const finalized=JSON.stringify(result.body);
  assert.equal((await c.query("SELECT count(*)::int n FROM stock_movements WHERE source_type='purchase_invoice' AND source_id=$1",[id])).rows[0].n,0);
  assert.equal((await invoke(postPurchaseInvoice,{id})).statusCode,409);
  // Store defaults and master supplier edits never rewrite posted supplier identity or amounts.
  await invoke(putInvoiceSettings,{id:stores[0].id},{invoiceLayout:'SIMPLE_LAYOUT'});
  assert.equal(JSON.stringify((await invoke(getPurchase,{id})).body),finalized);
  const receipt={idempotencyKey:'receipt-'+suffix,items:[{purchaseInvoiceItemId:draft.body.items[0].id,quantityReceived:'1'}]};
  result=await invoke(receivePurchaseGoods,{id},receipt);assert.equal(result.statusCode,201,JSON.stringify(result.body));
  assert.equal((await invoke(receivePurchaseGoods,{id},receipt)).body.duplicate,true);
  assert.equal((await c.query('SELECT quantity FROM inventory_balances WHERE store_id=$1 AND product_id=$2',[stores[0].id,product.id])).rows[0].quantity,'4.0000');
  const payment={storeId:String(stores[0].id),partyId:String(registered.id),amount:'100',paymentMethod:'cash',idempotencyKey:'payment-'+suffix,allocations:[{invoiceId:String(id),amount:'100'}]};
  result=await invoke(createSupplierPayment,{},payment);assert.equal(result.statusCode,201,JSON.stringify(result.body));assert.equal((await invoke(createSupplierPayment,{},payment)).body.duplicate,true);
  assert.equal((await invoke(getPurchase,{id})).body.outstanding_balance,'136.00');
  result=await invoke(getSupplierBalance,{id:registered.id},{},{storeId:String(stores[0].id)});assert.equal(result.body.totalOutstanding,'136.00');
  // A half-box return preserves the original supplier tax adjustment and conversion factor.
  const returned=await invoke(createReturn,{type:'purchase'},{invoiceId:id,reason:'Supplier return test',items:[{invoiceItemId:draft.body.items[0].id,quantity:'0.5'}]});assert.equal(returned.statusCode,201,JSON.stringify(returned.body));assert.equal(returned.body.tax_adjustment,'9.00');
  result=await invoke(postReturn,{type:'purchase',id:returned.body.id});assert.equal(result.statusCode,200,JSON.stringify(result.body));
  assert.equal((await invoke(getPurchase,{id})).body.outstanding_balance,'77.00');
  assert.equal((await c.query('SELECT quantity FROM inventory_balances WHERE store_id=$1 AND product_id=$2',[stores[0].id,product.id])).rows[0].quantity,'2.0000');
  result=await invoke(getSupplierLedger,{id:registered.id},{},{storeId:String(stores[0].id)});assert.equal(result.statusCode,200);assert.ok(result.body.some(x=>x.entry_type==='purchase_return'));assert.ok(result.body.some(x=>x.entry_type==='payment'));
  // Tax facts come from the supplier, not the buyer's still-unknown registration.
  result=await invoke(createPurchaseDraft,{}, {...base,invoiceLayout:'STANDARD_GST_LAYOUT',storeId:String(stores[1].id),supplierInvoiceNumber:'STD-'+suffix,supplierTaxJurisdiction:'INTER_STATE'});assert.equal(result.statusCode,201,JSON.stringify(result.body));assert.equal(result.body.igst_total,'36.00');assert.equal(result.body.cgst_total,'0.00');assert.equal((await invoke(postPurchaseInvoice,{id:result.body.id})).statusCode,200);
  // No-GST supplier invoices explicitly use zero without deleting product tax metadata.
  const commercial={...base,supplierId:String(unregistered.id),supplierDocumentType:'NON_GST_COMMERCIAL',supplierTaxJurisdiction:null,declaredTaxTotal:null,items:[{...base.items[0],quantity:'10',unitPrice:'850',taxRate:'0'}]};
  result=await invoke(createPurchaseDraft,{},commercial);assert.equal(result.statusCode,201,JSON.stringify(result.body));assert.equal(result.body.total,'8500.00');assert.equal(result.body.tax_total,'0.00');assert.equal(result.body.items[0].product_snapshot.defaultTaxRate,'18.0000');assert.equal((await invoke(postPurchaseInvoice,{id:result.body.id})).statusCode,200);
  // Tax cannot disappear because an appearance or supplier-document selector changed.
  assert.equal((await invoke(createPurchaseDraft,{}, {...commercial,items:base.items})).statusCode,422);
  assert.equal((await invoke(createPurchaseDraft,{}, {...commercial,declaredTaxTotal:'36'})).statusCode,422);
  assert.equal((await invoke(createPurchaseDraft,{}, {...base,declaredTaxTotal:'35'})).statusCode,422);
  assert.equal((await invoke(createPurchaseDraft,{}, {...commercial,supplierId:String(registered.id)})).statusCode,422);
  assert.equal((await invoke(createPurchaseDraft,{}, {...base,supplierId:String(unregistered.id)})).statusCode,422);
  const bill={...commercial,supplierId:String(registered.id),supplierDocumentType:'BILL_OF_SUPPLY',supplierTaxReason:'Composition declaration on supplier invoice'};
  result=await invoke(createPurchaseDraft,{},bill);assert.equal(result.statusCode,201,JSON.stringify(result.body));assert.equal((await invoke(postPurchaseInvoice,{id:result.body.id})).statusCode,200);
  // Drafts may be saved while a GST supplier total is pending, but posting requires it.
  result=await invoke(createPurchaseDraft,{}, {...base,declaredTaxTotal:null});assert.equal(result.statusCode,201);assert.equal((await invoke(postPurchaseInvoice,{id:result.body.id})).statusCode,422);
  const productAfter=(await c.query('SELECT tax_rate,hsn_code,gst_supply_classification FROM products WHERE id=$1',[product.id])).rows[0];assert.equal(productAfter.tax_rate,'18.0000');assert.equal(productAfter.hsn_code,'6907');assert.equal(productAfter.gst_supply_classification,'TAXABLE');
  await c.query("UPDATE user_store_assignments SET role='staff' WHERE user_id=$1",[user.id]);assert.equal((await invoke(putInvoiceSettings,{id:stores[0].id},{invoiceLayout:'STANDARD_GST_LAYOUT'})).statusCode,403);
 }finally{connection.query=originalQuery;connection.connect=originalConnect;await c.query('ROLLBACK');c.release();await connection.end();}
});

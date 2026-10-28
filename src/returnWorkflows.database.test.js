import 'dotenv/config';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {connection} from '../connection.js';
import {createSalesDraft,finalizeSales,getSales,reverseSales} from './controllers/sales.js';
import {createPurchaseDraft,postPurchaseInvoice,receivePurchaseGoods,reverseGoodsReceipt} from './controllers/purchases.js';
import {createCustomerReceipt,createSupplierPayment,reversePayment,getPayment,dailyCollections} from './controllers/payments.js';
import {createReturn,updateReturn,previewReturn,finalizeReturn,changeReturnStatus,inspectReturn,applyReturnCredit,returnInvoiceSource,eligibleReturnInvoices,returnSummary,getReturnById,listReturns} from './controllers/returns.js';
import {getCustomerBalance} from './controllers/customers.js';
import {getSupplierBalance} from './controllers/suppliers.js';
import {partyLedger,outstandingSummary} from './controllers/financialReports.js';
const configured=['DB_HOST','DB_USER','DB_PASSWORD','DB_NAME'].every(key=>process.env[key]);
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});
test('invoice-style return workflows preserve snapshots and atomically settle stock, credits and recorded refunds',{skip:!configured},async t=>{
 const query=connection.query,connect=connection.connect,c=await connection.connect();
 try{
  await c.query('BEGIN');connection.query=(...args)=>c.query(...args);connection.connect=async()=>({query:(sql,args)=>c.query(sql.startsWith('BEGIN')?'SAVEPOINT return_api':sql==='COMMIT'?'RELEASE SAVEPOINT return_api':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT return_api':sql,args),release(){}});
  const suffix=`${Date.now()}${process.pid}`;
  const user={...(await c.query("INSERT INTO users(name,mobile,password_hash,user_type) VALUES('Return Test',$1,'test','Admin') RETURNING id",[suffix])).rows[0],userType:'Admin'};
  const staff={...user,userType:'Salesperson'};
  const stores=[];for(const code of ['RA','RB'])stores.push((await c.query("INSERT INTO stores(code,name,state,gstin,tax_id) VALUES($1,'Returns Test','Bihar','10JNEPD0678B1ZL','10JNEPD0678B1ZL') RETURNING id",[code+suffix])).rows[0]);
  await c.query("INSERT INTO user_store_assignments(user_id,store_id,role) VALUES($1,$2,'staff')",[user.id,stores[0].id]);
  const unit=(await c.query("INSERT INTO units_of_measure(code,name,decimal_places) VALUES($1,'Piece',0) RETURNING id",['RP'+suffix])).rows[0];
  const box=(await c.query("INSERT INTO units_of_measure(code,name,decimal_places) VALUES($1,'Box',2) RETURNING id",['RB'+suffix])).rows[0];
  const product=(await c.query("INSERT INTO products(sku,name,base_unit_id,tax_rate,hsn_code,gst_supply_classification) VALUES($1,'Return Tile',$2,18,'6907','TAXABLE') RETURNING id",['RT'+suffix,unit.id])).rows[0];
  await c.query('INSERT INTO product_unit_conversions(product_id,unit_id,factor_to_base) VALUES($1,$2,4)',[product.id,box.id]);
  for(const store of stores)await c.query("INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by) VALUES($1,$2,'adjustment',1000,'return_test',$1,1,$3,$4)",[store.id,product.id,`${suffix}-${store.id}`,user.id]);
  let attempt=0;
  const call=async(fn,{body={},id,type='sales',query={},actor=user,params={}}={})=>{const res=response();await fn({user:actor,body,params:{id,type,...params},query},res);return res;};
  const party=async(sales=true)=>(await c.query(`INSERT INTO ${sales?'customers':'suppliers'}(name) VALUES('Return Party') RETURNING id`)).rows[0];
  const salesInvoice=async({customer,paid='0',qty='10',rate='100',gst=false,store=stores[0],invoiceDate='2026-10-20'}={})=>{
   customer=customer||await party();await c.query(`INSERT INTO store_billing_config(store_id,invoice_type,invoice_layout,default_document_type,gst_registration_status,gst_registration_category) VALUES($1,$2,$3,$4,'REGISTERED','REGULAR') ON CONFLICT(store_id) DO UPDATE SET invoice_type=$2,invoice_layout=$3,default_document_type=$4`,[store.id,gst?'GST':'NON_GST',gst?'STANDARD_GST_LAYOUT':'SIMPLE_LAYOUT',gst?'GST_TAX_INVOICE':'NON_GST_COMMERCIAL']);
   const draft=await call(createSalesDraft,{body:{storeId:store.id,customerId:customer.id,invoiceDate,items:[{productId:product.id,unitId:box.id,quantity:qty,unitPrice:rate}]}});assert.equal(draft.statusCode,201,JSON.stringify(draft.body));
   const posted=await call(finalizeSales,{id:draft.body.id,body:{payment:{amount:paid,method:'cash',idempotencyKey:`return-paid-${suffix}-${++attempt}`}}});assert.equal(posted.statusCode,200,JSON.stringify(posted.body));return {...posted.body,party:customer};
  };
  const purchaseInvoice=async({paid='0',qty='10',received='10',rate='100',gst=false}={})=>{
   const supplier=await party(false);await c.query("INSERT INTO store_billing_config(store_id,invoice_type,invoice_layout,default_document_type) VALUES($1,'NON_GST','SIMPLE_LAYOUT','NON_GST_COMMERCIAL') ON CONFLICT(store_id) DO UPDATE SET invoice_type='NON_GST',invoice_layout='SIMPLE_LAYOUT',default_document_type='NON_GST_COMMERCIAL'",[stores[0].id]);
   const draft=await call(createPurchaseDraft,{body:{storeId:stores[0].id,supplierId:supplier.id,invoiceDate:'2026-10-20',supplierDocumentType:'NON_GST_COMMERCIAL',items:[{productId:product.id,unitId:box.id,quantity:qty,unitPrice:rate,taxRate:'0'}]}});assert.equal(draft.statusCode,201,JSON.stringify(draft.body));
   const posted=await call(postPurchaseInvoice,{id:draft.body.id});assert.equal(posted.statusCode,200,JSON.stringify(posted.body));
   if(Number(received)>0){const r=await call(receivePurchaseGoods,{id:draft.body.id,body:{idempotencyKey:`return-receipt-${suffix}-${++attempt}`,items:[{purchaseInvoiceItemId:draft.body.items[0].id,quantityReceived:received}]}});assert.equal(r.statusCode,201,JSON.stringify(r.body));}
   if(Number(paid)>0){const p=await call(createSupplierPayment,{body:{storeId:stores[0].id,partyId:supplier.id,amount:paid,paymentMethod:'cash',paymentDate:'2026-10-20',idempotencyKey:`return-supplier-${suffix}-${++attempt}`,allocations:[{invoiceId:draft.body.id,amount:paid}]}});assert.equal(p.statusCode,201,JSON.stringify(p.body));}
   return {...posted.body,items:draft.body.items,party:supplier};
  };
  const stock=async()=>(await c.query('SELECT quantity FROM inventory_balances WHERE store_id=$1 AND product_id=$2',[stores[0].id,product.id])).rows[0].quantity;
  const makeReturn=async(inv,{type='sales',qty='2',mode='ADJUST',condition='SELLABLE',extra={},actor=user}={})=>{
   const body={invoiceId:inv.id,storeId:inv.store_id,partyId:inv.party.id,returnDate:'2026-10-27',reason:'Returned goods',settlementMode:mode,idempotencyKey:`return-create-${suffix}-${++attempt}`,items:[{invoiceItemId:inv.items[0].id,quantity:qty,stockCondition:condition}],...extra};
   return {body,result:await call(createReturn,{type,body,actor})};
  };
  const post=async(id,type='sales',key=`return-final-${suffix}-${++attempt}`)=>call(finalizeReturn,{id,type,body:{idempotencyKey:key}});
  const balance=async(inv,sales=true)=>(await call(sales?getCustomerBalance:getSupplierBalance,{id:inv.party.id,query:{storeId:String(inv.store_id)}})).body.totalOutstanding;
  await t.test('partial unpaid invoice return adjusts outstanding and posts original conversion exactly once',async()=>{
   const inv=await salesInvoice({paid:'800'}),before=await stock(),original=JSON.stringify((await call(getSales,{id:inv.id})).body);
   const {body,result}=await makeReturn(inv);assert.equal(result.statusCode,201,JSON.stringify(result.body));assert.equal(result.body.total,'200.00');assert.equal(await stock(),before);
   const edited=await call(updateReturn,{id:result.body.id,body:{...body,notes:'Updated draft'}});assert.equal(edited.statusCode,200,JSON.stringify(edited.body));
   await c.query('UPDATE product_unit_conversions SET factor_to_base=10 WHERE product_id=$1 AND unit_id=$2',[product.id,box.id]);
   const key=`partial-final-${suffix}`,posted=await post(result.body.id,'sales',key);assert.equal(posted.statusCode,200,JSON.stringify(posted.body));assert.equal(posted.body.adjusted_amount,'200.00');assert.equal(posted.body.unapplied_credit,'0.00');
   assert.equal((await c.query('SELECT $1::numeric-$2::numeric AS value',[await stock(),before])).rows[0].value,'8.0000');assert.equal(await balance(inv),'0.00');
   const again=await post(result.body.id,'sales',key);assert.equal(again.statusCode,200);assert.equal(again.body.duplicate,true);assert.equal((await c.query("SELECT count(*)::int n FROM stock_movements WHERE source_type='sales_return' AND source_id=$1",[result.body.id])).rows[0].n,1);
   const current=(await call(getSales,{id:inv.id})).body;assert.equal(current.total,JSON.parse(original).total);assert.equal(current.invoice_number,inv.invoice_number);assert.equal(current.outstanding_balance,'0.00');
   assert.equal((await call(updateReturn,{id:result.body.id,body})).statusCode,409);
   await c.query('UPDATE product_unit_conversions SET factor_to_base=4 WHERE product_id=$1 AND unit_id=$2',[product.id,box.id]);
  });
  await t.test('retained credit on a paid invoice can settle a future invoice without changing net balance',async()=>{
   const inv=await salesInvoice({paid:'1000'}),{result}=await makeReturn(inv,{qty:'3',mode:'CREDIT'});assert.equal(result.statusCode,201);
   let posted=await post(result.body.id);assert.equal(posted.statusCode,200,JSON.stringify(posted.body));assert.equal(posted.body.unapplied_credit,'300.00');assert.equal(await balance(inv),'-300.00');
   const future=await salesInvoice({customer:inv.party,qty:'2'});assert.equal(await balance(inv),'-100.00');
   const key=`apply-credit-${suffix}`;const applied=await call(applyReturnCredit,{id:result.body.id,body:{idempotencyKey:key}});assert.equal(applied.statusCode,200,JSON.stringify(applied.body));assert.equal(applied.body.unapplied_credit,'100.00');assert.equal(await balance(inv),'-100.00');assert.equal((await call(getSales,{id:future.id})).body.outstanding_balance,'0.00');
   assert.equal((await call(applyReturnCredit,{id:result.body.id,body:{idempotencyKey:key}})).body.duplicate,true);
  });
  await t.test('cash refund is a separate payment and cannot exceed credit after outstanding adjustment',async()=>{
   const inv=await salesInvoice({paid:'600'});
   const invalid=await makeReturn(inv,{qty:'5',mode:'REFUND',extra:{refundAmount:'200',refundMethod:'cash',refundDate:'2026-10-27'}});assert.equal(invalid.result.statusCode,422);
   const {result}=await makeReturn(inv,{qty:'5',mode:'REFUND',extra:{refundAmount:'100',refundMethod:'cash',refundDate:'2026-10-27'}});assert.equal(result.statusCode,201,JSON.stringify(result.body));
   const posted=await post(result.body.id);assert.equal(posted.statusCode,200,JSON.stringify(posted.body));assert.equal(posted.body.adjusted_amount,'400.00');assert.equal(posted.body.unapplied_credit,'0.00');assert.equal(posted.body.refunds.length,1);assert.equal(await balance(inv),'0.00');
   const payment=await call(getPayment,{id:posted.body.refunds[0].id});assert.equal(payment.statusCode,200);assert.equal(payment.body.party_type,'customer');assert.equal(payment.body.is_refund,true);
   const ledger=await call(partyLedger,{id:inv.party.id,params:{partyType:'customer'},query:{storeId:String(inv.store_id),toDate:'2099-12-31'}});assert.equal(ledger.statusCode,200,JSON.stringify(ledger.body));assert.equal(ledger.body.closingBalance,'0.00');assert.ok(ledger.body.items.some(entry=>entry.entry_type==='customer_refund'&&entry.source_type==='payment'));
   const daily=await call(dailyCollections,{query:{storeId:String(inv.store_id),date:'2026-10-27'}});assert.equal(daily.statusCode,200,JSON.stringify(daily.body));assert.equal(daily.body.refunds.customer_refunds,'100.00');
   assert.equal((await call(changeReturnStatus,{id:result.body.id,params:{action:'reverse'},body:{reason:'Correction'}})).statusCode,422);
   const reversed=await call(reversePayment,{id:payment.body.id,body:{reason:'Refund transaction correction'}});assert.equal(reversed.statusCode,200,JSON.stringify(reversed.body));
   const undone=await call(changeReturnStatus,{id:result.body.id,params:{action:'reverse'},body:{reason:'Return correction'}});assert.equal(undone.statusCode,200,JSON.stringify(undone.body));assert.equal(await balance(inv),'400.00');
  });
  await t.test('damaged returns never enter sellable stock and pending stock requires an inspection',async()=>{
   const inv=await salesInvoice(),before=await stock();
   const damaged=await makeReturn(inv,{qty:'2',condition:'DAMAGED'});assert.equal(damaged.result.statusCode,201);assert.equal((await post(damaged.result.body.id)).statusCode,200);assert.equal(await stock(),before);
   const pending=await makeReturn(inv,{qty:'1',condition:'PENDING_INSPECTION'});assert.equal(pending.result.statusCode,201);let posted=await post(pending.result.body.id);assert.equal(posted.statusCode,200);assert.equal(await stock(),before);
   const payload={itemId:posted.body.items[0].id,quantity:'0.5',decision:'SELLABLE',reason:'Received and checked',idempotencyKey:`inspect-${suffix}`};
   let inspected=await call(inspectReturn,{id:pending.result.body.id,body:payload});assert.equal(inspected.statusCode,200,JSON.stringify(inspected.body));assert.equal((await c.query('SELECT $1::numeric-$2::numeric value',[await stock(),before])).rows[0].value,'2.0000');
   assert.equal((await call(inspectReturn,{id:pending.result.body.id,body:payload})).body.duplicate,true);
   inspected=await call(inspectReturn,{id:pending.result.body.id,body:{...payload,decision:'DAMAGED',idempotencyKey:`inspect-damaged-${suffix}`}});assert.equal(inspected.statusCode,200,JSON.stringify(inspected.body));
   assert.equal((await call(inspectReturn,{id:pending.result.body.id,body:{...payload,quantity:'1',idempotencyKey:`inspect-too-many-${suffix}`}})).statusCode,422);
  });
  await t.test('inspection reversal compensates sellable and bucket movements exactly once',async()=>{
   const inv=await salesInvoice(),before=await stock(),saved=await makeReturn(inv,{qty:'2',condition:'PENDING_INSPECTION'});
   const posted=await post(saved.result.body.id);assert.equal(posted.statusCode,200);
   for(const decision of ['SELLABLE','DAMAGED']){const result=await call(inspectReturn,{id:posted.body.id,body:{itemId:posted.body.items[0].id,quantity:'1',decision,reason:'Received and checked',idempotencyKey:decision+suffix}});assert.equal(result.statusCode,200,JSON.stringify(result.body));}
   const undone=await call(changeReturnStatus,{id:posted.body.id,params:{action:'reverse'},body:{reason:'Correct inspected return'}});assert.equal(undone.statusCode,200,JSON.stringify(undone.body));assert.equal(await stock(),before);
   const buckets=await c.query('SELECT bucket,sum(quantity_delta)::numeric(18,4) quantity FROM return_inventory_movements WHERE sales_return_item_id=$1 GROUP BY bucket',[posted.body.items[0].id]);assert.ok(buckets.rows.every(row=>row.quantity==='0.0000'));
   assert.equal((await call(changeReturnStatus,{id:posted.body.id,params:{action:'reverse'},body:{reason:'Duplicate reverse'}})).statusCode,409);
  });
  await t.test('return summary reports gross, returns and net independently within the store boundary',async()=>{
   const result=await call(returnSummary,{query:{storeId:String(stores[0].id),fromDate:'2026-10-01',toDate:'2026-10-31'}});assert.equal(result.statusCode,200,JSON.stringify(result.body));
   for(const type of ['sales','purchases'])assert.equal((await c.query('SELECT ($1::numeric-$2::numeric)::numeric(18,2) value',[result.body['gross_'+type],result.body[type==='sales'?'sales_returns':'purchase_returns']])).rows[0].value,result.body['net_'+type]);
   assert.equal((await call(returnSummary,{actor:staff,query:{storeId:String(stores[1].id)}})).statusCode,403);
  });
  await t.test('purchase return removes the selected bucket and records supplier refund receivable/cash separately',async()=>{
   const inv=await purchaseInvoice({paid:'900'}),before=await stock();
   const {result}=await makeReturn(inv,{type:'purchase',qty:'2',mode:'REFUND',extra:{refundAmount:'100',refundMethod:'cash',refundDate:'2026-10-27'}});assert.equal(result.statusCode,201,JSON.stringify(result.body));
   const posted=await post(result.body.id,'purchase');assert.equal(posted.statusCode,200,JSON.stringify(posted.body));assert.equal(posted.body.adjusted_amount,'100.00');assert.equal(posted.body.refunds.length,1);assert.equal(await balance(inv,false),'0.00');assert.equal((await c.query('SELECT $1::numeric-$2::numeric value',[await stock(),before])).rows[0].value,'-8.0000');
   const ledger=await call(partyLedger,{id:inv.party.id,params:{partyType:'supplier'},query:{storeId:String(inv.store_id),toDate:'2099-12-31'}});assert.equal(ledger.statusCode,200,JSON.stringify(ledger.body));assert.equal(ledger.body.closingBalance,'0.00');assert.ok(ledger.body.items.some(entry=>entry.entry_type==='supplier_refund'));
   const damaged=await purchaseInvoice();const saved=await makeReturn(damaged,{type:'purchase',qty:'1',extra:{items:[{invoiceItemId:damaged.items[0].id,quantity:'1',stockBucket:'DAMAGED'}]}});assert.equal(saved.result.statusCode,201);
   const beforeDamaged=await stock(),sent=await post(saved.result.body.id,'purchase');assert.equal(sent.statusCode,200,JSON.stringify(sent.body));assert.equal(await stock(),beforeDamaged);
  });
  await t.test('original GST snapshots survive new store defaults and catalog rate edits',async()=>{
   const inv=await salesInvoice({gst:true});await c.query('UPDATE products SET tax_rate=28 WHERE id=$1',[product.id]);
   await c.query("UPDATE store_billing_config SET invoice_type='NON_GST',invoice_layout='SIMPLE_LAYOUT',default_document_type='NON_GST_COMMERCIAL' WHERE store_id=$1",[stores[0].id]);
   const {result}=await makeReturn(inv,{qty:'5'});assert.equal(result.statusCode,201,JSON.stringify(result.body));assert.equal(result.body.total,'590.00');assert.equal(result.body.tax_adjustment,'90.00');assert.equal(result.body.items[0].tax_rate,'18.0000');assert.equal(result.body.amounts.cgst,'45.00');assert.equal(result.body.amounts.sgst,'45.00');
   assert.equal((await post(result.body.id)).statusCode,200);assert.equal((await call(getSales,{id:inv.id})).body.total,'1180.00');await c.query('UPDATE products SET tax_rate=18 WHERE id=$1',[product.id]);
  });
  await t.test('repeated small GST returns preserve total and component rounding',async()=>{
   const inv=await salesInvoice({gst:true,qty:'2',rate:'0.03'});assert.equal(inv.total,'0.07');
   const first=await makeReturn(inv,{qty:'1'});assert.equal(first.result.statusCode,201);assert.equal((await post(first.result.body.id)).statusCode,200);
   const second=await makeReturn(inv,{qty:'1'});assert.equal(second.result.statusCode,201);assert.equal((await post(second.result.body.id)).statusCode,200);
   const totals=(await c.query('SELECT sum(line_total)::numeric(18,2) total,sum(x.tax_adjustment)::numeric(18,2) tax,sum(cgst_adjustment+sgst_adjustment+igst_adjustment)::numeric(18,2) components FROM sales_return_items x JOIN sales_returns r ON r.id=x.sales_return_id WHERE r.sales_invoice_id=$1',[inv.id])).rows[0];assert.deepEqual(totals,{total:'0.07',tax:'0.01',components:'0.01'});
  });
  await t.test('stock failure rolls back the supplier refund, credit allocation and return posting together',async()=>{
   const inv=await purchaseInvoice({paid:'1000'}),saved=await makeReturn(inv,{type:'purchase',qty:'1',mode:'REFUND',extra:{refundAmount:'100',refundMethod:'cash',refundDate:'2026-10-27'}});assert.equal(saved.result.statusCode,201);
   const available=await stock();await c.query("INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by) VALUES($1,$2,'adjustment',-$3::numeric,'return_test_empty',$4,1,$5,$6)",[stores[0].id,product.id,available,saved.result.body.id,`drain-${suffix}`,user.id]);
   const rejected=await post(saved.result.body.id,'purchase');assert.equal(rejected.statusCode,422,JSON.stringify(rejected.body));assert.equal((await c.query('SELECT count(*)::int n FROM payments WHERE purchase_return_id=$1',[saved.result.body.id])).rows[0].n,0);assert.equal((await c.query('SELECT status FROM purchase_returns WHERE id=$1',[saved.result.body.id])).rows[0].status,'draft');
   await c.query("INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by) VALUES($1,$2,'adjustment',$3::numeric,'return_test_restore',$4,1,$5,$6)",[stores[0].id,product.id,available,saved.result.body.id,`restore-${suffix}`,user.id]);
  });
  await t.test('refund method failure leaves the return draft and creates no cash or stock posting',async()=>{
   const inv=await salesInvoice({paid:'1000'}),before=await stock(),method='rf'+suffix;
   await c.query('INSERT INTO payment_method_options(code,label,is_active) VALUES($1,$2,TRUE)',[method,'Refund test']);
   const saved=await makeReturn(inv,{qty:'1',mode:'REFUND',extra:{refundAmount:'100',refundMethod:method,refundDate:'2026-10-27'}});assert.equal(saved.result.statusCode,201,JSON.stringify(saved.result.body));
   await c.query('UPDATE payment_method_options SET is_active=FALSE WHERE code=$1',[method]);
   const denied=await post(saved.result.body.id);assert.equal(denied.statusCode,422,JSON.stringify(denied.body));assert.equal(await stock(),before);
   assert.equal((await c.query('SELECT count(*)::int n FROM payments WHERE sales_return_id=$1',[saved.result.body.id])).rows[0].n,0);
   assert.equal((await c.query('SELECT status FROM sales_returns WHERE id=$1',[saved.result.body.id])).rows[0].status,'draft');
  });
  await t.test('purchase receipts supporting posted returns cannot be reversed first',async()=>{
   const inv=await purchaseInvoice(),saved=await makeReturn(inv,{type:'purchase',qty:'1'});assert.equal((await post(saved.result.body.id,'purchase')).statusCode,200);
   const receipt=(await c.query('SELECT id FROM purchase_receipts WHERE purchase_invoice_id=$1',[inv.id])).rows[0];
   const blocked=await call(reverseGoodsReceipt,{id:inv.id,params:{receiptId:receipt.id}});assert.equal(blocked.statusCode,400,JSON.stringify(blocked.body));
   assert.equal((await c.query('SELECT status FROM purchase_receipts WHERE id=$1',[receipt.id])).rows[0].status,'posted');
   assert.equal((await call(changeReturnStatus,{id:saved.result.body.id,type:'purchase',params:{action:'reverse'},body:{reason:'Correct supplier return'}})).statusCode,200);
   assert.equal((await call(reverseGoodsReceipt,{id:inv.id,params:{receiptId:receipt.id}})).statusCode,200);
  });
  await t.test('inactive products retain eligibility from the original invoice and cancelled drafts post nothing',async()=>{
   const inv=await salesInvoice(),before=await stock();await c.query('UPDATE products SET is_active=FALSE WHERE id=$1',[product.id]);
   const saved=await makeReturn(inv,{qty:'1'});assert.equal(saved.result.statusCode,201);assert.equal((await post(saved.result.body.id)).statusCode,200);
   await c.query('UPDATE products SET is_active=TRUE WHERE id=$1',[product.id]);
   const cancelled=await makeReturn(inv,{qty:'1'});assert.equal((await call(changeReturnStatus,{id:cancelled.result.body.id,params:{action:'cancel'},body:{reason:'Customer kept remaining goods'}})).statusCode,200);
   assert.equal((await post(cancelled.result.body.id)).statusCode,409);assert.equal((await c.query('SELECT $1::numeric-$2::numeric value',[await stock(),before])).rows[0].value,'4.0000');
  });
  await t.test('one return combines five bills with independent original rates, tax and quantity budgets',async()=>{
   const customer=await party(),invoices=[];
   for(let i=0;i<5;i++)invoices.push(await salesInvoice({customer,qty:'2',rate:String((i+1)*100),gst:i%2===1}));
   const before=await stock(),items=invoices.map(inv=>({invoiceId:inv.id,invoiceItemId:inv.items[0].id,quantity:'1',stockCondition:'SELLABLE'}));
   const saved=await makeReturn(invoices[0],{extra:{items}});assert.equal(saved.result.statusCode,201,JSON.stringify(saved.result.body));
   assert.equal(saved.result.body.total,'1608.00');assert.equal(saved.result.body.tax_adjustment,'108.00');assert.equal(saved.result.body.original_invoices.length,5);assert.equal(saved.result.body.document_snapshot.invoices.length,5);
   assert.deepEqual(saved.result.body.items.map(line=>line.unit_price),['100.0000','200.0000','300.0000','400.0000','500.0000']);
   const key='multi-five-'+suffix,posted=await post(saved.result.body.id,'sales',key);assert.equal(posted.statusCode,200,JSON.stringify(posted.body));assert.equal(posted.body.adjusted_amount,'1608.00');assert.equal(posted.body.items.length,5);assert.equal(await balance(invoices[0]),'1608.00');
   assert.equal((await c.query('SELECT $1::numeric-$2::numeric value',[await stock(),before])).rows[0].value,'20.0000');
   const settledStock=await stock();assert.equal((await post(posted.body.id,'sales',key)).body.duplicate,true);assert.equal(await stock(),settledStock);
   const loaded=await call(getReturnById,{id:posted.body.id});assert.equal(loaded.body.original_invoices.length,5);
   const history=await call(listReturns,{query:{storeId:String(stores[0].id),q:invoices[4].invoice_number}});assert.equal(history.statusCode,200);assert.ok(history.body.some(row=>String(row.id)===String(posted.body.id)&&row.original_invoice_number.includes(invoices[4].invoice_number)));
   for(const inv of invoices){assert.equal((await call(getSales,{id:inv.id})).body.total,inv.total);const lookup=await call(returnInvoiceSource,{id:inv.id});assert.equal(lookup.body.items[0].remaining_quantity,'1.0000');}
  });
  await t.test('editing a combined draft can remove a bill, add another and keep the same customer',async()=>{
   const customer=await party(),a=await salesInvoice({customer,qty:'2'}),b=await salesInvoice({customer,qty:'2',rate:'150'}),d=await salesInvoice({customer,qty:'2',rate:'200'});
   const saved=await makeReturn(a,{extra:{items:[{invoiceItemId:a.items[0].id,quantity:'1'},{invoiceItemId:b.items[0].id,quantity:'1'}]}});assert.equal(saved.result.statusCode,201);
   const edited=await call(updateReturn,{id:saved.result.body.id,body:{...saved.body,invoiceId:b.id,items:[{invoiceItemId:b.items[0].id,quantity:'1'},{invoiceItemId:d.items[0].id,quantity:'1'}]}});assert.equal(edited.statusCode,200,JSON.stringify(edited.body));assert.equal(edited.body.total,'350.00');assert.equal(String(edited.body.sales_invoice_id),String(b.id));assert.equal(edited.body.original_invoices.length,2);assert.equal((await post(edited.body.id)).statusCode,200);
  });
  await t.test('combined returns reject foreign customers, stores, wrong source labels and over-returned secondary lines',async()=>{
   const a=await salesInvoice({qty:'2'}),b=await salesInvoice({customer:a.party,qty:'2'}),foreign=await salesInvoice({qty:'2'}),otherStore=await salesInvoice({customer:a.party,qty:'2',store:stores[1]});
   for(const inv of [foreign,otherStore]){const invalid=await makeReturn(a,{extra:{items:[{invoiceItemId:a.items[0].id,quantity:'1'},{invoiceItemId:inv.items[0].id,quantity:'1'}]}});assert.equal(invalid.result.statusCode,422,JSON.stringify(invalid.result.body));}
   const wrong=await makeReturn(a,{extra:{items:[{invoiceId:a.id,invoiceItemId:b.items[0].id,quantity:'1'}]}});assert.equal(wrong.result.statusCode,422);
   const prior=await makeReturn(b,{qty:'1'});assert.equal((await post(prior.result.body.id)).statusCode,200);
   const excess=await makeReturn(a,{extra:{items:[{invoiceItemId:a.items[0].id,quantity:'1'},{invoiceItemId:b.items[0].id,quantity:'2'}]}});assert.equal(excess.result.statusCode,422);
   const later=await salesInvoice({customer:a.party,qty:'1',invoiceDate:'2026-10-26'});
   const backdated=await makeReturn(a,{extra:{returnDate:'2026-10-25',items:[{invoiceItemId:a.items[0].id,quantity:'1'},{invoiceItemId:later.items[0].id,quantity:'1'}]}});assert.equal(backdated.result.statusCode,400);
  });
  await t.test('a secondary source reversed after drafting blocks the entire combined finalization',async()=>{
   const a=await salesInvoice({qty:'2'}),b=await salesInvoice({customer:a.party,qty:'2'}),before=await stock();
   const saved=await makeReturn(a,{extra:{items:[{invoiceItemId:a.items[0].id,quantity:'1'},{invoiceItemId:b.items[0].id,quantity:'1'}]}});assert.equal(saved.result.statusCode,201);
   const reversed=await call(reverseSales,{id:b.id});assert.equal(reversed.statusCode,200,JSON.stringify(reversed.body));const afterInvoiceReverse=await stock();
   const result=await post(saved.result.body.id);assert.equal(result.statusCode,422,JSON.stringify(result.body));assert.equal(await stock(),afterInvoiceReverse);assert.equal((await c.query('SELECT status FROM sales_returns WHERE id=$1',[saved.result.body.id])).rows[0].status,'draft');assert.equal((await c.query('SELECT count(*)::int n FROM return_credit_allocations WHERE sales_return_id=$1',[saved.result.body.id])).rows[0].n,0);
  });
  await t.test('retained multi-bill credit blocks secondary invoice reversal and return reversal restores every source',async()=>{
   const a=await salesInvoice({qty:'2'}),b=await salesInvoice({customer:a.party,qty:'2'}),before=await stock();
   const saved=await makeReturn(a,{mode:'CREDIT',extra:{items:[{invoiceItemId:a.items[0].id,quantity:'1',stockCondition:'SELLABLE'},{invoiceItemId:b.items[0].id,quantity:'1',stockCondition:'SELLABLE'}]}});assert.equal(saved.result.statusCode,201);assert.equal((await post(saved.result.body.id)).statusCode,200);
   assert.equal((await call(reverseSales,{id:b.id})).statusCode,409);
   const undone=await call(changeReturnStatus,{id:saved.result.body.id,params:{action:'reverse'},body:{reason:'Combined return correction'}});assert.equal(undone.statusCode,200,JSON.stringify(undone.body));assert.equal(await stock(),before);
   assert.equal((await call(returnInvoiceSource,{id:b.id})).body.items[0].remaining_quantity,'2.0000');assert.equal((await call(reverseSales,{id:b.id})).statusCode,200);
  });
  await t.test('combined paid invoices produce one refund payment and one remaining customer credit',async()=>{
   const a=await salesInvoice({qty:'2',paid:'200'}),b=await salesInvoice({customer:a.party,qty:'2',paid:'200'});
   const saved=await makeReturn(a,{mode:'REFUND',extra:{refundAmount:'100',refundMethod:'cash',refundDate:'2026-10-27',items:[{invoiceItemId:a.items[0].id,quantity:'1'},{invoiceItemId:b.items[0].id,quantity:'1'}]}});assert.equal(saved.result.statusCode,201);
   const posted=await post(saved.result.body.id);assert.equal(posted.statusCode,200,JSON.stringify(posted.body));assert.equal(posted.body.total,'200.00');assert.equal(posted.body.refunds.length,1);assert.equal(posted.body.unapplied_credit,'100.00');assert.equal(await balance(a),'-100.00');
  });
  await t.test('quantity races, store boundaries, rate authority and unlinked policy block invalid finalization',async()=>{
   const inv=await salesInvoice(),first=await makeReturn(inv,{qty:'6'}),second=await makeReturn(inv,{qty:'6'});assert.equal(first.result.statusCode,201);assert.equal(second.result.statusCode,201);assert.equal((await post(first.result.body.id)).statusCode,200);
   const blocked=await post(second.result.body.id);assert.equal(blocked.statusCode,409,JSON.stringify(blocked.body));assert.equal((await c.query('SELECT status FROM sales_returns WHERE id=$1',[second.result.body.id])).rows[0].status,'draft');
   const lookup=await call(eligibleReturnInvoices,{query:{type:'sales',storeId:String(stores[0].id),partyId:String(inv.party.id)}});assert.equal(lookup.statusCode,200);assert.equal(lookup.body[0].returnable_quantity,'4.0000');
   const source=await call(returnInvoiceSource,{id:inv.id});assert.equal(source.body.items[0].remaining_quantity,'4.0000');
   const forged=await makeReturn(inv,{qty:'1',actor:staff,extra:{items:[{invoiceItemId:inv.items[0].id,quantity:'1',returnRate:'90',rateChangeReason:'Authorized change'}]}});assert.equal(forged.result.statusCode,403);
   const override=await makeReturn(inv,{qty:'1',extra:{items:[{invoiceItemId:inv.items[0].id,quantity:'1',returnRate:'90',rateChangeReason:'Authorized change',stockCondition:'SELLABLE'}]}});assert.equal(override.result.statusCode,201);assert.equal(override.result.body.total,'90.00');
   const unlinked=await call(createReturn,{body:{reason:'Unlinked return',items:[{productId:product.id,quantity:'1'}]}});assert.equal(unlinked.statusCode,422);
   const outside=await salesInvoice({store:stores[1]});const unauthorized=await makeReturn(outside,{actor:staff});assert.equal(unauthorized.result.statusCode,403);
  });
 }finally{connection.query=query;connection.connect=connect;await c.query('ROLLBACK');c.release();await connection.end();}
});

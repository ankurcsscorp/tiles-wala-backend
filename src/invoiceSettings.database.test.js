import 'dotenv/config';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {connection} from '../connection.js';
import {getInvoiceSettings,putInvoiceSettings} from './controllers/invoiceSettings.js';
import {createSalesDraft,updateSalesDraft,finalizeSales,getSales,cancelSales,reverseSales,recordSalesPayment} from './controllers/sales.js';
import {createReturn,approveSalesReturn,postReturn} from './controllers/returns.js';
const configured=['DB_HOST','DB_USER','DB_PASSWORD','DB_NAME'].every(k=>process.env[k]);
const response=()=>({statusCode:200,status(c){this.statusCode=c;return this;},json(b){this.body=b;return this;}});
test('store invoice types persist independently and preserve sales stock, payments, snapshots, and permissions',{skip:!configured},async()=>{
 const originalQuery=connection.query,originalConnect=connection.connect,client=await connection.connect();
 try{
  await client.query('BEGIN');
  connection.query=(...args)=>client.query(...args);
  connection.connect=async()=>({query:(sql,args)=>client.query(sql==='BEGIN'?'SAVEPOINT invoice_api':sql==='COMMIT'?'RELEASE SAVEPOINT invoice_api':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT invoice_api':sql,args),release(){}});
  const suffix=`${Date.now()}${process.pid}`;
  const user=(await client.query("INSERT INTO users(name,mobile,password_hash,user_type) VALUES('Invoice Test',$1,'test','Salesperson') RETURNING id",[suffix])).rows[0];user.userType='Salesperson';
  const stores=[];
  for(const code of ['A','B']){
   const store=(await client.query("INSERT INTO stores(code,name) VALUES($1,'Invoice Test') RETURNING id",[code+suffix])).rows[0];stores.push(store);
   await client.query("INSERT INTO user_store_assignments(user_id,store_id,role) VALUES($1,$2,'manager')",[user.id,store.id]);
  }
  const invoke=async(fn,store,body)=>{const r=response();await fn({user,params:{id:String(store.id)},body},r);return r;};
  let result=await invoke(getInvoiceSettings,stores[0]);assert.equal(result.body.data.invoiceType,'GST');
  result=await invoke(putInvoiceSettings,stores[0],{invoiceType:'NON_GST'});assert.equal(result.statusCode,422);
  result=await invoke(putInvoiceSettings,stores[0],{invoiceType:'bogus'});assert.equal(result.statusCode,400);
  result=await invoke(putInvoiceSettings,stores[0],{invoiceType:'NON_GST',registrationStatus:'UNREGISTERED'});assert.equal(result.statusCode,200,JSON.stringify(result.body));
  assert.equal((await invoke(getInvoiceSettings,stores[0])).body.data.invoiceType,'NON_GST');
  assert.equal((await invoke(getInvoiceSettings,stores[1])).body.data.invoiceType,'GST');
  await client.query("UPDATE user_store_assignments SET role='staff' WHERE user_id=$1",[user.id]);
  assert.equal((await invoke(putInvoiceSettings,stores[0],{invoiceType:'GST'})).statusCode,403);
  await client.query("UPDATE user_store_assignments SET role='manager' WHERE user_id=$1",[user.id]);
  const unit=(await client.query("INSERT INTO units_of_measure(code,name) VALUES($1,'Box') RETURNING id",['U'+suffix])).rows[0];
  const products=[];
  for(let i=0;i<3;i++){
   const p=(await client.query("INSERT INTO products(sku,name,base_unit_id,tax_rate) VALUES($1,'Invoice Test Tile',$2,18) RETURNING id",[`P${i}${suffix}`,unit.id])).rows[0];products.push(p);
   await client.query("INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by) VALUES($1,$2,'adjustment',100,'invoice_test',1,$2,$3,$4)",[stores[0].id,p.id,`${suffix}-${i}`,user.id]);
  }
  const customer=(await client.query("INSERT INTO customers(name) VALUES('Invoice Test Customer') RETURNING id")).rows[0];
  const body={storeId:String(stores[0].id),customerId:String(customer.id),invoiceType:'NON_GST',items:products.map((p,i)=>({productId:String(p.id),unitId:String(unit.id),quantity:['10','5','2'][i],unitPrice:['850','600','450'][i]}))};
  const draft=response();await createSalesDraft({user,body},draft);assert.equal(draft.statusCode,201,JSON.stringify(draft.body));
  assert.equal(draft.body.invoice_type,'NON_GST');assert.equal(draft.body.total,'12400.00');assert.equal(draft.body.tax_total,'0.00');assert.equal(draft.body.items[0].tax_rate,'0.0000');
  // Server rejects injected tax/adjustments rather than trusting client totals.
  const invalid=response();await createSalesDraft({user,body:{...body,items:[{...body.items[0],taxRate:'18'}]}},invalid);assert.equal(invalid.statusCode,400);
  await invoke(putInvoiceSettings,stores[0],{invoiceLayout:'SIMPLE_LAYOUT'});
  const stale=response();await createSalesDraft({user,body:{...body,invoiceLayout:'STANDARD_GST_LAYOUT'}},stale);assert.equal(stale.statusCode,409);
  const edited=response();await updateSalesDraft({user,params:{id:draft.body.id},body},edited);assert.equal(edited.statusCode,200,JSON.stringify(edited.body));assert.equal(edited.body.invoice_type,'NON_GST');
  const converted=response();await updateSalesDraft({user,params:{id:draft.body.id},body:{...body,invoiceType:'GST'}},converted);assert.equal(converted.statusCode,409);
  // Current registration is rechecked even after a draft was saved.
  await client.query("UPDATE stores SET gstin='10JNEPD0678B1ZL' WHERE id=$1",[stores[0].id]);
  await invoke(putInvoiceSettings,stores[0],{invoiceType:'GST',registrationStatus:'REGISTERED',registrationCategory:'REGULAR'});
  let posted=response();await finalizeSales({user,params:{id:draft.body.id},body:{}},posted);assert.equal(posted.statusCode,422);
  await client.query('UPDATE stores SET gstin=NULL,tax_id=NULL WHERE id=$1',[stores[0].id]);
  await invoke(putInvoiceSettings,stores[0],{invoiceType:'NON_GST',registrationStatus:'UNREGISTERED'});
  posted=response();await finalizeSales({user,params:{id:draft.body.id},body:{payment:{amount:'400',method:'cash',idempotencyKey:suffix}}},posted);assert.equal(posted.statusCode,200,JSON.stringify(posted.body));
  assert.equal(posted.body.invoice_type,'NON_GST');assert.equal(posted.body.total,'12400.00');assert.equal(posted.body.outstanding_balance,'12000.00');assert.equal(posted.body.amount_received,'400.00');
  assert.equal((await client.query('SELECT quantity FROM inventory_balances WHERE store_id=$1 AND product_id=$2',[stores[0].id,products[0].id])).rows[0].quantity,'90.0000');
  const retry=response();await finalizeSales({user,params:{id:draft.body.id},body:{}},retry);assert.equal(retry.statusCode,409);
  assert.equal((await client.query("SELECT count(*)::int n FROM stock_movements WHERE source_type='sales_invoice' AND source_id=$1",[draft.body.id])).rows[0].n,3);
  assert.equal((await client.query('SELECT count(*)::int n FROM payment_allocations WHERE sales_invoice_id=$1',[draft.body.id])).rows[0].n,1);
  const unchanged=response();await getSales({user,params:{id:draft.body.id}},unchanged);assert.equal(unchanged.body.invoice_type,'NON_GST');assert.equal(unchanged.body.total,'12400.00');
  const immutable=response();await updateSalesDraft({user,params:{id:draft.body.id},body},immutable);assert.equal(immutable.statusCode,409);
  await client.query("UPDATE stores SET gstin='10JNEPD0678B1ZL' WHERE id=$1",[stores[1].id]);
  await invoke(putInvoiceSettings,stores[1],{invoiceType:'GST',registrationStatus:'REGISTERED',registrationCategory:'REGULAR'});
  const gst=response();await createSalesDraft({user,body:{...body,storeId:String(stores[1].id),invoiceType:'GST',items:[{...body.items[0],quantity:'1',unitPrice:'100'}]}},gst);assert.equal(gst.statusCode,201);assert.equal(gst.body.total,'118.00');
  const cancelled=response();await cancelSales({user,params:{id:gst.body.id}},cancelled);assert.equal(cancelled.statusCode,200);assert.equal(cancelled.body.status,'cancelled');
  // Returns inherit the saved zero tax and preserve the customer credit/stock workflow.
  const returned=response();await createReturn({user,params:{type:'sales'},body:{invoiceId:draft.body.id,reason:'Test return',items:[{invoiceItemId:posted.body.items[0].id,quantity:'1',disposition:'restock'}]}},returned);
  assert.equal(returned.statusCode,201,JSON.stringify(returned.body));assert.equal(returned.body.tax_adjustment,'0.00');assert.equal(returned.body.customer_credit,'850.00');
  const approved=response();await approveSalesReturn({user,params:{id:returned.body.id}},approved);assert.equal(approved.statusCode,200);
  const postedReturn=response();await postReturn({user,params:{type:'sales',id:returned.body.id}},postedReturn);assert.equal(postedReturn.statusCode,200,JSON.stringify(postedReturn.body));
  assert.equal((await client.query('SELECT quantity FROM inventory_balances WHERE store_id=$1 AND product_id=$2',[stores[0].id,products[0].id])).rows[0].quantity,'91.0000');
  const paid=response();await recordSalesPayment({user,params:{id:draft.body.id},body:{amount:'11150',method:'cash',idempotencyKey:suffix+'-full'}},paid);assert.equal(paid.statusCode,200,JSON.stringify(paid.body));assert.equal(paid.body.outstanding_balance,'0.00');assert.equal(paid.body.payment_status,'paid');
  const paidRetry=response();await recordSalesPayment({user,params:{id:draft.body.id},body:{amount:'11150',method:'cash',idempotencyKey:suffix+'-full'}},paidRetry);assert.equal(paidRetry.statusCode,200);
  assert.equal((await client.query('SELECT count(*)::int n FROM payment_allocations WHERE sales_invoice_id=$1',[draft.body.id])).rows[0].n,2);
  // An unpaid Non-GST invoice follows the original reversal workflow.
  await invoke(putInvoiceSettings,stores[0],{invoiceType:'NON_GST'});
  const reversible=response();await createSalesDraft({user,body:{...body,items:[{...body.items[0],quantity:'1'}]}},reversible);assert.equal(reversible.statusCode,201);
  const reversePosted=response();await finalizeSales({user,params:{id:reversible.body.id},body:{}},reversePosted);assert.equal(reversePosted.statusCode,200);
  const reversed=response();await reverseSales({user,params:{id:reversible.body.id}},reversed);assert.equal(reversed.statusCode,200,JSON.stringify(reversed.body));assert.equal(reversed.body.status,'reversed');assert.equal(reversed.body.invoice_type,'NON_GST');
  assert.equal((await client.query('SELECT quantity FROM inventory_balances WHERE store_id=$1 AND product_id=$2',[stores[0].id,products[0].id])).rows[0].quantity,'91.0000');
  // GSTIN prevents an unregistered declaration from enabling Non-GST billing.
  await client.query("UPDATE stores SET gstin='10JNEPD0678B1ZL' WHERE id=$1",[stores[1].id]);
  assert.equal((await invoke(putInvoiceSettings,stores[1],{invoiceType:'NON_GST',registrationStatus:'UNREGISTERED'})).statusCode,422);
  await client.query('UPDATE user_store_assignments SET is_active=FALSE WHERE user_id=$1 AND store_id=$2',[user.id,stores[1].id]);
  assert.equal((await invoke(getInvoiceSettings,stores[1])).statusCode,403);
  assert.ok((await client.query('SELECT count(*)::int n FROM invoice_settings_audit WHERE store_id=$1',[stores[0].id])).rows[0].n>=4);
 }finally{connection.query=originalQuery;connection.connect=originalConnect;await client.query('ROLLBACK');client.release();await connection.end();}
});

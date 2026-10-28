import 'dotenv/config';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {connection} from '../connection.js';
import {createSalesDraft,finalizeSales,getSales} from './controllers/sales.js';
import {createCustomerReceipt,reversePayment} from './controllers/payments.js';
import {getCustomerBalance} from './controllers/customers.js';
import {createReturn,approveSalesReturn,postReturn} from './controllers/returns.js';

const configured=['DB_HOST','DB_USER','DB_PASSWORD','DB_NAME'].every(key=>process.env[key]);
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});

test('customer receipts allocate oldest invoices automatically and deduct excess advances exactly once',{skip:!configured},async t=>{
 const originalQuery=connection.query,originalConnect=connection.connect,c=await connection.connect();
 try{
  await c.query('BEGIN');connection.query=(...args)=>c.query(...args);
  connection.connect=async()=>({query:(sql,args)=>c.query(sql==='BEGIN'?'SAVEPOINT receipt_api':sql==='COMMIT'?'RELEASE SAVEPOINT receipt_api':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT receipt_api':sql,args),release(){}});
  const suffix=`${Date.now()}${process.pid}`;
  const user={...(await c.query("INSERT INTO users(name,mobile,password_hash,user_type) VALUES('Receipt Test',$1,'test','Admin') RETURNING id",[suffix])).rows[0],userType:'Admin'};
  const stores=[];
  for(const prefix of ['RA','RB'])stores.push((await c.query("INSERT INTO stores(code,name) VALUES($1,'Receipt Test') RETURNING id",[prefix+suffix])).rows[0]);
  await c.query("INSERT INTO user_store_assignments(user_id,store_id,role) VALUES($1,$2,'staff')",[user.id,stores[0].id]);
  const customers=[];for(let i=0;i<4;i++)customers.push((await c.query("INSERT INTO customers(name) VALUES('Receipt Customer') RETURNING id")).rows[0]);
  const unit=(await c.query("INSERT INTO units_of_measure(code,name) VALUES($1,'Box') RETURNING id",['R'+suffix])).rows[0];
  const product=(await c.query("INSERT INTO products(sku,name,base_unit_id) VALUES($1,'Receipt Tile',$2) RETURNING id",['R'+suffix,unit.id])).rows[0];
  for(const store of stores)await c.query("INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by) VALUES($1,$2,'adjustment',100,'receipt_test',$1,1,$3,$4)",[store.id,product.id,`${suffix}-${store.id}`,user.id]);
  const invoke=async(handler,body={},id,query={},actor=user)=>{const res=response();await handler({user:actor,body,params:{id},query},res);return res;};
  const invoice=async(customer,date,total,{store=stores[0],posted=true,paid='0'}={})=>{
   const draft=await invoke(createSalesDraft,{storeId:store.id,customerId:customer.id,invoiceDate:date,items:[{productId:product.id,unitId:unit.id,quantity:'1',unitPrice:total}]});
   assert.equal(draft.statusCode,201,JSON.stringify(draft.body));
   if(!posted)return draft.body;
   const result=await invoke(finalizeSales,{payment:{amount:paid,method:'cash',idempotencyKey:`initial-${draft.body.id}-${suffix}`}},draft.body.id);
   assert.equal(result.statusCode,200,JSON.stringify(result.body));return result.body;
  };
  let attempt=0;
  const receipt=(customer,amount,extra={},actor=user)=>invoke(createCustomerReceipt,{storeId:stores[0].id,partyId:customer.id,amount,paymentMethod:'cash',paymentDate:'2026-10-27',idempotencyKey:`receipt-${suffix}-${++attempt}`,allocations:[],...extra},undefined,{},actor);
  const balance=async customer=>{const result=await invoke(getCustomerBalance,{},customer.id,{storeId:String(stores[0].id)});assert.equal(result.statusCode,200,JSON.stringify(result.body));return result.body.totalOutstanding;};
  await t.test('partial receipt covers oldest invoice then the next, skipping paid/draft/other-store/other-customer invoices',async()=>{
   const newer=await invoice(customers[0],'2026-10-20','1000.25');
   const oldest=await invoice(customers[0],'2026-10-01','1000.10');
   const tied=await invoice(customers[0],'2026-10-01','500.05');
   await invoice(customers[0],'2026-09-01','100',{paid:'100'});
   await invoice(customers[0],'2026-09-01','100',{posted:false});
   const elsewhere=await invoice(customers[0],'2026-09-01','100',{store:stores[1]});
   const otherCustomer=await invoice(customers[1],'2026-09-01','100');
   const manual=await receipt(customers[0],'100.10',{allocations:[{invoiceId:oldest.id,amount:'100.10'}]});assert.equal(manual.statusCode,201,JSON.stringify(manual.body));
   const key=`automatic-${suffix}`;
   const automatic=await receipt(customers[0],'1000',{idempotencyKey:key});assert.equal(automatic.statusCode,201,JSON.stringify(automatic.body));
   assert.equal((await c.query("SELECT after_data->>'allocationMode' AS mode FROM audit_logs WHERE entity_type='payment' AND entity_id=$1 AND action='customer.receipt.posted'",[automatic.body.id])).rows[0].mode,'OLDEST_FIRST');
   assert.deepEqual(automatic.body.allocations.map(line=>[String(line.invoice_id),line.amount]),[[String(oldest.id),'900.00'],[String(tied.id),'100.00']]);
   assert.equal((await invoke(getSales,{},oldest.id)).body.payment_status,'paid');
   assert.equal((await invoke(getSales,{},tied.id)).body.outstanding_balance,'400.05');
   assert.equal((await invoke(getSales,{},elsewhere.id)).body.outstanding_balance,'100.00');
   assert.equal((await invoke(getSales,{},otherCustomer.id)).body.outstanding_balance,'100.00');
   assert.equal(await balance(customers[0]),'1400.30');
   const retry=await receipt(customers[0],'1000',{idempotencyKey:key});assert.equal(retry.statusCode,200);assert.equal(retry.body.duplicate,true);assert.deepEqual(retry.body.allocations,automatic.body.allocations);
   assert.equal((await receipt(customers[0],'1001',{idempotencyKey:key})).statusCode,409);
   // A manual selection is honored even when another invoice is older.
   const chosen=await receipt(customers[0],'20',{allocations:[{invoiceId:newer.id,amount:'20'}]});assert.equal(chosen.statusCode,201);assert.equal(String(chosen.body.allocations[0].invoice_id),String(newer.id));
   const excess=await receipt(customers[0],'2000');assert.equal(excess.statusCode,201,JSON.stringify(excess.body));
   assert.deepEqual(excess.body.allocations.map(line=>line.amount),['400.05','980.25']);
   assert.equal(await balance(customers[0]),'-619.70');
   for(const inv of [oldest,tied,newer])assert.equal((await invoke(getSales,{},inv.id)).body.outstanding_balance,'0.00');
   const denied=await receipt(customers[0],'1',{storeId:stores[1].id},{id:user.id,userType:'Salesperson'});assert.equal(denied.statusCode,403);
  });
  await t.test('no posted invoices leaves an advance, including omitted selections; retries do not retroactively allocate it',async()=>{
   const key=`advance-${suffix}`;
   const advance=await receipt(customers[2],'50.25',{allocations:undefined,idempotencyKey:key});assert.equal(advance.statusCode,201,JSON.stringify(advance.body));assert.deepEqual(advance.body.allocations,[]);
   assert.equal(await balance(customers[2]),'-50.25');
   await invoice(customers[2],'2026-10-27','100');
   const retry=await receipt(customers[2],'50.25',{allocations:undefined,idempotencyKey:key});assert.equal(retry.statusCode,200);assert.deepEqual(retry.body.allocations,[]);assert.equal(await balance(customers[2]),'49.75');
   const next=await receipt(customers[2],'10.01');assert.equal(next.statusCode,201);assert.equal(next.body.allocations[0].amount,'10.01');assert.equal(await balance(customers[2]),'39.74');
  });
  await t.test('posted return credits reduce the amount that can be automatically allocated',async()=>{
   const source=(await c.query("SELECT id FROM sales_invoices WHERE customer_id=$1 AND store_id=$2 AND status='posted'",[customers[1].id,stores[0].id])).rows[0];
   const inv=(await invoke(getSales,{},source.id)).body;
   const returned=response();await createReturn({user,params:{type:'sales'},body:{invoiceId:inv.id,reason:'Return credit test',items:[{invoiceItemId:inv.items[0].id,quantity:'0.25',disposition:'restock'}]}},returned);
   assert.equal(returned.statusCode,201,JSON.stringify(returned.body));assert.equal(returned.body.customer_credit,'25.00');
   assert.equal((await invoke(approveSalesReturn,{},returned.body.id)).statusCode,200);
   const posted=response();await postReturn({user,params:{type:'sales',id:returned.body.id}},posted);assert.equal(posted.statusCode,200,JSON.stringify(posted.body));
   const paid=await receipt(customers[1],'100');assert.equal(paid.statusCode,201,JSON.stringify(paid.body));assert.equal(paid.body.allocations[0].amount,'75.00');assert.equal(await balance(customers[1]),'-25.00');
  });
  await t.test('reversed receipts reopen invoice capacity for automatic allocation',async()=>{
   const inv=await invoice(customers[3],'2026-10-01','100');
   const first=await receipt(customers[3],'100');assert.equal(first.statusCode,201);
   const reversed=await invoke(reversePayment,{reason:'Receipt correction'},first.body.id);assert.equal(reversed.statusCode,200,JSON.stringify(reversed.body));
   assert.equal(await balance(customers[3]),'100.00');
   const replacement=await receipt(customers[3],'100');assert.equal(replacement.statusCode,201,JSON.stringify(replacement.body));assert.equal(String(replacement.body.allocations[0].invoice_id),String(inv.id));assert.equal(await balance(customers[3]),'0.00');
  });
 }finally{connection.query=originalQuery;connection.connect=originalConnect;await c.query('ROLLBACK');c.release();await connection.end();}
});

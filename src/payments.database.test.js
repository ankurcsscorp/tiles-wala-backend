import 'dotenv/config';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {connection} from '../connection.js';
import {dailyCollections,partyPaymentHistory} from './controllers/payments.js';

const configured=['DB_HOST','DB_USER','DB_PASSWORD','DB_NAME'].every(key=>process.env[key]);
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});

test('daily collections and party history execute with optional store filters and preserve authorized totals',{skip:!configured},async()=>{
 const originalQuery=connection.query,client=await connection.connect();
 try{
  await client.query('BEGIN');connection.query=(...args)=>client.query(...args);
  const suffix=`${Date.now()}${process.pid}`;
  const person=(await client.query("INSERT INTO users(name,mobile,password_hash,user_type) VALUES('Collections Test',$1,'test','Salesperson') RETURNING id",[suffix])).rows[0];
  const staff={id:person.id,userType:'Salesperson'},admin={userType:'Admin'};
  const stores=[];
  for(const prefix of ['CA','CB','CC'])stores.push((await client.query("INSERT INTO stores(code,name) VALUES($1,'Collections Test') RETURNING id",[prefix+suffix])).rows[0]);
  for(const store of stores.slice(0,2))await client.query('INSERT INTO user_store_assignments(user_id,store_id) VALUES($1,$2)',[person.id,store.id]);
  const customer=(await client.query("INSERT INTO customers(name) VALUES('Collections Customer') RETURNING id")).rows[0];
  const supplier=(await client.query("INSERT INTO suppliers(name) VALUES('Collections Supplier') RETURNING id")).rows[0];
  const fixtures=[
   [0,'in','posted','cash','100.25'],[0,'in','posted','upi','50.75'],[0,'out','posted','cash','40'],
   [0,'in','reversed','cash','20'],[0,'out','reversed','bank_transfer','10'],
   [0,'in','draft','cash','5'],[0,'in','voided','cash','7'],[0,'in','posted','cash','999','2026-10-26'],
   [1,'in','posted','upi','300'],[1,'out','posted','bank_transfer','60'],[2,'in','posted','cash','9999']
  ];
  for(const [index,[store,direction,status,method,amount,date='2026-10-27']] of fixtures.entries())await client.query(`INSERT INTO payments(store_id,payment_number,direction,status,payment_method,amount,payment_date,customer_id,supplier_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[stores[store].id,`COL-${suffix}-${index}`,direction,status,method,amount,date,direction==='in'?customer.id:null,direction==='out'?supplier.id:null]);
  const invoke=async(handler,user,query={},params={})=>{const res=response();await handler({user,query:{date:'2026-10-27',...query},params},res);return res;};
  const expected={receipt_count:2,supplier_payment_count:1,receipts:'151.00',supplier_payments:'40.00',reversed_receipts:'20.00',reversed_supplier_payments:'10.00'};
  for(const user of [admin,staff]){
   const result=await invoke(dailyCollections,user,{storeId:String(stores[0].id)});
   assert.equal(result.statusCode,200,JSON.stringify(result.body));assert.deepEqual(result.body.summary,expected);
   assert.deepEqual(result.body.byMethod,[
    {direction:'in',payment_method:'cash',payment_count:1,amount:'100.25'},
    {direction:'in',payment_method:'upi',payment_count:1,amount:'50.75'},
    {direction:'out',payment_method:'cash',payment_count:1,amount:'40.00'}
   ]);
  }
  const all=await invoke(dailyCollections,staff);assert.equal(all.statusCode,200,JSON.stringify(all.body));
  assert.deepEqual(all.body.summary,{...expected,receipt_count:3,supplier_payment_count:2,receipts:'451.00',supplier_payments:'100.00'});
  const second=await invoke(dailyCollections,staff,{storeId:String(stores[1].id)});assert.equal(second.body.summary.receipts,'300.00');
  for(const user of [staff,{userType:'Salesperson',id:'0'}]){
   const empty=await invoke(dailyCollections,user,{date:'2026-10-29'});assert.equal(empty.statusCode,200);
   assert.deepEqual(empty.body.summary,{receipt_count:0,supplier_payment_count:0,receipts:'0.00',supplier_payments:'0.00',reversed_receipts:'0.00',reversed_supplier_payments:'0.00'});assert.deepEqual(empty.body.byMethod,[]);
  }
  for(const storeId of [String(stores[2].id),'invalid'])assert.equal((await invoke(dailyCollections,staff,{storeId})).statusCode,403);
  assert.equal((await invoke(dailyCollections,staff,{date:'27/10/2026'})).statusCode,400);
  for(const [partyType,partyId,direction] of [['customer',customer.id,'in'],['supplier',supplier.id,'out']]){
   const params={partyType,partyId:String(partyId)};
   const history=await invoke(partyPaymentHistory,staff,{storeId:String(stores[1].id)},params);
   assert.equal(history.statusCode,200,JSON.stringify(history.body));assert.equal(history.body.length,1);assert.equal(history.body[0].direction,direction);assert.equal(String(history.body[0].store_id),String(stores[1].id));
   const combined=await invoke(partyPaymentHistory,staff,{},params);assert.equal(combined.statusCode,200);assert.ok(combined.body.length>1);assert.ok(combined.body.every(row=>stores.slice(0,2).some(store=>String(store.id)===String(row.store_id))));
   assert.equal((await invoke(partyPaymentHistory,staff,{storeId:String(stores[2].id)},params)).statusCode,403);
  }
 }finally{connection.query=originalQuery;await client.query('ROLLBACK');client.release();await connection.end();}
});

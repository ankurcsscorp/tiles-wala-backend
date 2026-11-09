import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { connection } from '../../connection.js';
import { createOrder, listCatalog } from './dealerPortal.js';

let queryOriginal;let connectOriginal;
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});
afterEach(()=>{if(queryOriginal){connection.query=queryOriginal;queryOriginal=null;}if(connectOriginal){connection.connect=connectOriginal;connectOriginal=null;}});

test('dealer catalog returns explicit unit dealer prices and a store availability indicator without purchase cost',async()=>{
 const calls=[];queryOriginal=connection.query;
 connection.query=async(sql,values)=>{calls.push({sql,values});if(sql.includes('FROM dealer_profiles d'))return {rows:[{id:'7',user_id:'9',store_id:'3',account_status:'active',store_active:true,dealer_transport_charge:'1000.00'}]};return {rows:[{id:'4',name:'GVT Tile',base_unit_id:'1',sales_unit_id:'2',available_units:[{unitId:'2',unitName:'Box',dealerPrice:'850.0000',mrp:'1200.00',discountPercentage:29.17}],stock_status:'IN_STOCK'}]};};
 const res=response();await listCatalog({user:{id:'9',userType:'Dealer'}},res);
 assert.equal(res.body.storeId,'3');assert.equal(res.body.transportCharge,'1000.00');assert.equal(res.body.items[0].base_unit_id,'1');assert.equal(res.body.items[0].sales_unit_id,'2');assert.equal(res.body.items[0].available_units[0].dealerPrice,'850.0000');assert.equal(res.body.items[0].available_units[0].mrp,'1200.00');assert.equal(res.body.items[0].available_units[0].discountPercentage,29.17);assert.equal(res.body.items[0].stock_status,'IN_STOCK');
 assert.match(calls[1].sql,/p\.base_unit_id/);assert.match(calls[1].sql,/p\.sales_unit_id/);assert.match(calls[1].sql,/dealer_product_unit_prices/);assert.match(calls[1].sql,/discountPercentage/);assert.match(calls[1].sql,/d\.mrp/);assert.match(calls[1].sql,/stock_status/);assert.doesNotMatch(calls[1].sql,/default_purchase_price|supplier/i);assert.deepEqual(calls[1].values,['3']);
});

test('dealer order multiplies quantity by the configured unit price and snapshots that price',async()=>{
 const calls=[];connectOriginal=connection.connect;
 connection.connect=async()=>({query:async(sql,values=[])=>{calls.push({sql,values});
  if(sql.includes('FROM dealer_profiles d JOIN stores s'))return {rows:[{id:'7',store_id:'3',account_status:'active',store_active:true,dealer_transport_charge:'1000.00',delivery_address:{},billing_address:{},contact_name:'Asha',mobile:'9876543210',business_name:'Dealer House'}]};
  if(sql.includes('SELECT * FROM dealer_orders WHERE dealer_id=$1 AND idempotency_key=$2'))return {rows:[],rowCount:0};
  if(sql.includes('FROM products p JOIN dealer_product_unit_prices'))return {rowCount:1,rows:[{id:'4',name:'GVT Tile',tax_rate:'18',tax_inclusive:false,unit_name:'Box',dealer_price:'850.0000',mrp:'1200.00',gross_amount:'1700.00',tax_amount:'306.00',factor_to_base:'4.00000000'}]};
  if(sql.includes('SELECT quantity FROM inventory_balances'))return {rowCount:1,rows:[{quantity:'100.0000'}]};
  if(sql.includes('nextval'))return {rows:[{n:'1'}]};
  if(sql.includes('INSERT INTO dealer_orders'))return {rows:[{id:'21',order_number:'DO-2026-0000001',quotation_number:'Q-DO-2026-0000001-1',store_id:'3',subtotal:'1700.00',transport_charge:'1000.00',tax_amount:'306.00',grand_total:'3006.00'}]};
  return {rows:[],rowCount:1};
 },release(){}});
 const res=response();await createOrder({user:{id:'9',userType:'Dealer'},headers:{'idempotency-key':'dealer-test-order-key-001'},body:{items:[{productId:'4',unitId:'2',quantity:2}],paymentMethod:'CASH_ON_DELIVERY',transportMode:'PICKUP',deliveryAddress:{line1:'Main Road',city:'Patna'}}},res);
 assert.equal(res.statusCode,201);assert.equal(res.body.subtotal,'1700.00');assert.equal(res.body.transport_charge,'1000.00');assert.equal(res.body.grand_total,'3006.00');
 const item=calls.find(x=>x.sql.includes('INSERT INTO dealer_order_items'));
 assert.equal(item.values[4],'850.0000');assert.equal(item.values[5],'1200.00');assert.equal(item.values[8],'1700.00');assert.equal(item.values[10],'2006.00');
 const quoteInsert=calls.find(x=>x.sql.includes('INSERT INTO dealer_order_quotations'));const quoteItems=JSON.parse(quoteInsert.values[6]);assert.equal(quoteItems[0].mrp,'1200.00');assert.equal(quoteItems[0].dealerPrice,'850.0000');assert.equal(quoteItems[0].lineTotal,'2006.00');
 const header=calls.find(x=>x.sql.includes('INSERT INTO dealer_orders'));assert.equal(header.values[4],'1700.00');assert.equal(header.values[5],'1000.00');assert.equal(header.values[7],'3006.00');assert.equal(header.values[8],'CASH_ON_DELIVERY');assert.equal(header.values[16],'dealer-test-order-key-001');assert.equal(header.values[18],'PICKUP');assert.equal(header.sql.includes("'UNPAID'"),true);
 assert.equal(calls.some(x=>x.sql.includes('INSERT INTO dealer_order_quotations')),true);assert.equal(calls.some(x=>x.sql.includes('INSERT INTO dealer_order_admin_notifications')),true);
 assert.equal(calls.at(-1).sql,'COMMIT');
});

test('Self Pickup snapshots configured zero transport and ignores a browser-supplied charge',async()=>{
 const calls=[];connectOriginal=connection.connect;
 connection.connect=async()=>({query:async(sql,values=[])=>{calls.push({sql,values});
  if(sql.includes('FROM dealer_profiles d JOIN stores s'))return {rows:[{id:'7',store_id:'3',account_status:'active',store_active:true,dealer_transport_options:[{code:'SELF',label:'Self Pickup',charge:0},{code:'PICKUP',label:'Pickup',charge:1000}],delivery_address:{},billing_address:{},contact_name:'Asha',mobile:'9876543210',business_name:'Dealer House'}]};
  if(sql.includes('SELECT * FROM dealer_orders WHERE dealer_id=$1 AND idempotency_key=$2'))return {rows:[],rowCount:0};
  if(sql.includes('FROM products p JOIN dealer_product_unit_prices'))return {rowCount:1,rows:[{id:'4',name:'GVT Tile',tax_rate:'18',tax_inclusive:false,unit_name:'Box',dealer_price:'850.0000',mrp:'1200.00',gross_amount:'1700.00',tax_amount:'306.00',factor_to_base:'4.00000000'}]};
  if(sql.includes('SELECT quantity FROM inventory_balances'))return {rowCount:1,rows:[{quantity:'100.0000'}]};
  if(sql.includes('nextval'))return {rows:[{n:'1'}]};
  if(sql.includes('INSERT INTO dealer_orders'))return {rows:[{id:'22',order_number:'DO-2026-0000002',transport_mode:values[18],subtotal:values[4],transport_charge:'0.00',tax_amount:values[6],grand_total:values[7]}]};
  return {rows:[],rowCount:1};
 },release(){}});
 const res=response();await createOrder({user:{id:'9',userType:'Dealer'},headers:{'idempotency-key':'dealer-self-pickup-key-004'},body:{items:[{productId:'4',unitId:'2',quantity:2}],paymentMethod:'UPI',transportMode:'SELF',transportCharge:'9999.00',deliveryAddress:{line1:'Main Road',city:'Patna'}}},res);
 assert.equal(res.statusCode,201);assert.equal(res.body.transport_charge,'0.00');assert.equal(res.body.grand_total,'2006.00');
 const header=calls.find(x=>x.sql.includes('INSERT INTO dealer_orders'));assert.equal(header.values[5],'0');assert.equal(header.values[18],'SELF');assert.equal(header.sql.includes('transport_mode'),true);
});

test('dealer order requires an idempotency key and supported payment method before connecting',async()=>{
 connectOriginal=connection.connect;connection.connect=async()=>{throw new Error('invalid request must not open a transaction');};
 const badKey=response();await createOrder({user:{id:'9',userType:'Dealer'},headers:{},body:{items:[{productId:'4',unitId:'2',quantity:1}],paymentMethod:'UPI'}},badKey);assert.equal(badKey.statusCode,400);assert.match(badKey.body.message,/Idempotency-Key/);
 const badMethod=response();await createOrder({user:{id:'9',userType:'Dealer'},headers:{'idempotency-key':'dealer-test-order-key-002'},body:{items:[{productId:'4',unitId:'2',quantity:1}],paymentMethod:'BANK_TRANSFER'}},badMethod);assert.equal(badMethod.statusCode,400);assert.match(badMethod.body.message,/UPI or Cash on Delivery/);
});

test('reusing an idempotency key for a different payload is rejected instead of replaying another order',async()=>{
 connectOriginal=connection.connect;connection.connect=async()=>({query:async(sql)=>{
  if(sql==='BEGIN')return {rows:[]};
  if(sql.includes('FROM dealer_profiles d JOIN stores s'))return {rows:[{id:'7',store_id:'3',account_status:'active',store_active:true,dealer_transport_charge:'1000.00'}]};
  if(sql.includes('SELECT * FROM dealer_orders WHERE dealer_id=$1 AND idempotency_key=$2'))return {rowCount:1,rows:[{id:'21',request_hash:'a'.repeat(64)}]};
  if(sql==='ROLLBACK')return {rows:[]};
  throw new Error('A duplicate request must not continue to order creation');
 },release(){}});
 const res=response();await createOrder({user:{id:'9',userType:'Dealer'},headers:{'idempotency-key':'dealer-test-order-key-003'},body:{items:[{productId:'4',unitId:'2',quantity:1}],paymentMethod:'UPI',transportMode:'PICKUP'}},res);assert.equal(res.statusCode,409);assert.match(res.body.message,/different order request/);
});

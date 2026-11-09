import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { connection } from '../../connection.js';
import { adminDealerOrderSummary, adminDealerReports, adminTransitionDealerOrder, confirmDealerOrderAndCreateInvoice, confirmDealerOrderStock, listAdminDealerOrders, publishDealerQuotation, recordDealerPartialDelivery, saveDealerShipment } from './adminDealerOrders.js';

let originalQuery,originalConnect;
afterEach(()=>{if(originalQuery){connection.query=originalQuery;originalQuery=null;}if(originalConnect){connection.connect=originalConnect;originalConnect=null;}});
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});

test('Admin-only dealer order endpoints reject dealer users before database access',async()=>{
 originalQuery=connection.query;connection.query=async()=>{throw new Error('database should not be queried');};
 const summary=response(),list=response();await adminDealerOrderSummary({user:{userType:'Dealer'}},summary);await listAdminDealerOrders({user:{userType:'Dealer'},query:{}},list);
 const reports=response();await adminDealerReports({user:{userType:'Dealer'},query:{}},reports);assert.equal(summary.statusCode,403);assert.equal(list.statusCode,403);assert.equal(reports.statusCode,403);
});

test('Admin order list rejects unknown status filters before connecting',async()=>{
 originalConnect=connection.connect;connection.connect=async()=>{throw new Error('database should not be connected');};
 const res=response();await listAdminDealerOrders({user:{userType:'Admin'},query:{status:'SOMETHING_ELSE'}},res);assert.equal(res.statusCode,400);
});

test('Admin publishes the current quotation without generating a sales invoice',async()=>{
 const calls=[];originalConnect=connection.connect;connection.connect=async()=>({query:async(sql)=>{calls.push(sql);if(sql.includes('SELECT o.*,d.user_id'))return {rowCount:1,rows:[{id:'41',dealer_id:'8',dealer_user_id:'19',store_id:'3',status:'PENDING_REVIEW',quotation_version:1}]};if(sql.includes('SELECT 1 FROM dealer_order_quotations'))return {rowCount:1,rows:[{}]};return {rowCount:1,rows:[]};},release(){}});
 const res=response();await publishDealerQuotation({params:{id:'41'},user:{id:'1',userType:'Admin'}},res);assert.equal(res.statusCode,200);assert.equal(res.body.status,'QUOTATION_SENT');assert.equal(res.body.quotationVersion,1);assert.ok(calls.some(sql=>sql.includes("SET status='QUOTATION_SENT'")));assert.ok(!calls.some(sql=>sql.includes('sales_invoices')));
});

test('processing confirmation does not automatically create a sales invoice',async()=>{
 let queryText='';originalConnect=connection.connect;connection.connect=async()=>({query:async(sql)=>{queryText=sql;if(sql.includes('SELECT o.*,d.user_id'))return {rowCount:1,rows:[{id:'41',status:'PROCESSING',store_id:'3'}]};return {rowCount:1,rows:[]};},release(){}});originalQuery=connection.query;connection.query=async(sql)=>{queryText=sql;return {rowCount:1,rows:[{id:'41',status:'PROCESSING',store_id:'3'}]};};
 const res=response();await confirmDealerOrderAndCreateInvoice({params:{id:'41'},body:{},user:{id:'1',userType:'Admin'}},res);assert.equal(res.statusCode,200);assert.equal(res.body.invoiceCreated,false);assert.equal(res.body.status,'PROCESSING');assert.doesNotMatch(queryText,/sales_invoice_id/);
});

test('Admin cannot skip stock and payment-term confirmation before processing',async()=>{
 const calls=[];originalConnect=connection.connect;connection.connect=async()=>({query:async(sql)=>{calls.push(sql);if(sql.includes('SELECT o.*,d.user_id'))return {rowCount:1,rows:[{id:'41',store_id:'3',dealer_user_id:'19',status:'CONFIRMED',stock_confirmed_at:null,payment_terms_confirmed_at:null}]};return {rowCount:0,rows:[]};},release(){}});
 const res=response();await adminTransitionDealerOrder({params:{id:'41'},body:{status:'PROCESSING'},user:{id:'1',userType:'Admin'}},res);assert.equal(res.statusCode,409);assert.match(res.body.message,/Confirm stock and payment terms/);assert.equal(calls.includes('ROLLBACK'),true);
});

test('processing status update casts repeated status parameters consistently',async()=>{
 const updates=[];originalConnect=connection.connect;connection.connect=async()=>({query:async(sql)=>{if(sql.includes('SELECT o.*,d.user_id'))return {rowCount:1,rows:[{id:'41',store_id:'3',dealer_user_id:'19',status:'CONFIRMED',stock_confirmed_at:new Date(),payment_terms_confirmed_at:new Date()}]};if(sql.startsWith('UPDATE dealer_orders SET status='))updates.push(sql);return {rowCount:1,rows:[]};},release(){}});
 const res=response();await adminTransitionDealerOrder({params:{id:'41'},body:{status:'PROCESSING'},user:{id:'1',userType:'Admin'}},res);assert.equal(res.statusCode,200);assert.equal(updates.length,1);assert.match(updates[0],/status=\$2::varchar/);assert.match(updates[0],/CASE WHEN \$2::varchar='DELIVERED'/);
});

test('Stock confirmation reports shortages without reserving or changing stock',async()=>{
 const calls=[];originalConnect=connection.connect;connection.connect=async()=>({query:async(sql)=>{calls.push(sql);if(sql.includes('SELECT o.*,d.user_id'))return {rowCount:1,rows:[{id:'41',store_id:'3',dealer_user_id:'19',status:'CONFIRMED'}]};if(sql.includes('jsonb_to_recordset'))return {rowCount:1,rows:[{product_id:'5',product_name:'Tile A',base_unit:'Piece',available_base:'10.0000',required_base:'18.0000'}]};return {rowCount:1,rows:[]};},release(){}});
 const res=response();await confirmDealerOrderStock({params:{id:'41'},user:{id:'1',userType:'Admin'}},res);assert.equal(res.statusCode,200);assert.equal(res.body.confirmed,false);assert.equal(res.body.shortages[0].required,'18.0000');assert.equal(res.body.shortages[0].available,'10.0000');assert.equal(res.body.physicalStockChanged,false);assert.equal(calls.some(sql=>sql.includes('stock_movements')||sql.includes('inventory_balances SET')),false);
});

test('Admin cannot mark an order shipped until invoice posting and dispatch details exist',async()=>{
 const calls=[];originalConnect=connection.connect;connection.connect=async()=>({query:async(sql)=>{calls.push(sql);if(sql.includes('SELECT o.*,d.user_id'))return {rowCount:1,rows:[{id:'41',store_id:'3',dealer_user_id:'19',status:'READY_TO_DISPATCH',sales_invoice_id:'77'}]};if(sql.includes('SELECT EXISTS(SELECT 1 FROM sales_invoices'))return {rowCount:1,rows:[{invoice_posted:false,shipment_ready:false}]};return {rowCount:0,rows:[]};},release(){}});
 const res=response();await adminTransitionDealerOrder({params:{id:'41'},body:{status:'SHIPPED'},user:{id:'1',userType:'Admin'}},res);assert.equal(res.statusCode,409);assert.match(res.body.message,/Finalize the linked sales invoice/);assert.equal(calls.some(sql=>sql.includes('UPDATE dealer_orders SET status')),false);
});

test('Shipment details cannot be saved before Ready to Dispatch',async()=>{
 originalConnect=connection.connect;connection.connect=async()=>({query:async(sql)=>sql.includes('SELECT o.*,d.user_id')?{rowCount:1,rows:[{id:'41',store_id:'3',dealer_user_id:'19',status:'PROCESSING'}]}:{rowCount:0,rows:[]},release(){}});
 const res=response();await saveDealerShipment({params:{id:'41'},body:{transporterName:'North Transport'},user:{id:'1',userType:'Admin'}},res);assert.equal(res.statusCode,409);assert.match(res.body.message,/ready to dispatch/);
});

test('Self Pickup collection confirms an explicit handover without shipment details',async()=>{
 const calls=[];originalConnect=connection.connect;connection.connect=async()=>({query:async(sql,values=[])=>{calls.push({sql,values});if(sql.includes('SELECT o.*,d.user_id'))return {rowCount:1,rows:[{id:'41',store_id:'3',dealer_user_id:'19',status:'READY_TO_DISPATCH',transport_mode:'SELF',sales_invoice_id:'77',payment_status:'UNPAID'}]};if(sql.includes('SELECT 1 FROM sales_invoices'))return {rowCount:1,rows:[{}]};return {rowCount:1,rows:[]};},release(){}});
 const res=response();await adminTransitionDealerOrder({params:{id:'41'},body:{status:'DELIVERED',receivedBy:'Ravi',actualDeliveryDate:'2026-11-04'},user:{id:'1',userType:'Admin'}},res);assert.equal(res.statusCode,200);assert.equal(res.body.collectionConfirmed,true);assert.ok(calls.some(x=>x.sql.includes('UPDATE dealer_orders SET status')));const event=calls.find(x=>x.sql.includes('INSERT INTO dealer_order_delivery_events'));assert.equal(event.values[1],'DELIVERED');assert.equal(event.values[2].collectionMethod,'DEALER_SELF_COLLECTION');
});

test('Self Pickup orders cannot be completed until full payment is recorded',async()=>{
 const calls=[];originalConnect=connection.connect;connection.connect=async()=>({query:async(sql)=>{calls.push(sql);if(sql.includes('SELECT o.*,d.user_id'))return {rowCount:1,rows:[{id:'41',store_id:'3',dealer_user_id:'19',status:'DELIVERED',transport_mode:'SELF',payment_status:'PARTIALLY_PAID'}]};return {rowCount:1,rows:[]};},release(){}});
 const res=response();await adminTransitionDealerOrder({params:{id:'41'},body:{status:'COMPLETED'},user:{id:'1',userType:'Admin'}},res);assert.equal(res.statusCode,409);assert.match(res.body.message,/full payment/);assert.equal(calls.some(sql=>sql.includes('UPDATE dealer_orders SET status')),false);
});

test('Partial delivery cannot exceed the remaining posted invoice quantity',async()=>{
 const calls=[];originalConnect=connection.connect;connection.connect=async()=>({query:async(sql)=>{calls.push(sql);if(sql.includes('SELECT o.*,d.user_id'))return {rowCount:1,rows:[{id:'41',store_id:'3',dealer_user_id:'19',status:'SHIPPED',sales_invoice_id:'77'}]};if(sql.includes('FROM sales_invoice_items li WHERE li.id=$1'))return {rowCount:1,rows:[{id:'88',ordered_quantity:'10.0000',delivered_quantity:'7.0000',product_name_snapshot:'Tile A',unit_name_snapshot:'Box'}]};if(sql.includes('AS valid'))return {rowCount:1,rows:[{valid:false}]};return {rowCount:0,rows:[]};},release(){}});
 const res=response();await recordDealerPartialDelivery({params:{id:'41'},body:{items:[{invoiceItemId:'88',quantity:'4'}]},user:{id:'1',userType:'Admin'}},res);assert.equal(res.statusCode,409);assert.match(res.body.message,/exceeds the remaining quantity/);assert.equal(calls.some(sql=>sql.includes('INSERT INTO dealer_order_delivery_events')),false);
});

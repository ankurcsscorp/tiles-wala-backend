import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { connection } from '../../connection.js';
import { acceptQuotation, createManualUpiAttempt, getDealerDashboardAnalytics, getDealerLedger, getDealerQuotation, listOrders, sendQuotation } from './dealerPortal.js';

let originalQuery, originalConnect;
afterEach(()=>{if(originalQuery){connection.query=originalQuery;originalQuery=null;}if(originalConnect){connection.connect=originalConnect;originalConnect=null;}});
const response=()=>({statusCode:200,headers:{},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});

test('dealer dashboard analytics validates filters and scopes aggregation to the authenticated dealer',async()=>{
 const calls=[];originalQuery=connection.query;connection.query=async(sql,values=[])=>{calls.push({sql,values});
  if(sql.includes('FROM dealer_profiles d'))return {rowCount:1,rows:[{id:'7',customer_id:'12',store_id:'3',account_status:'active',store_active:true}]};
  if(sql.includes('WITH cfg AS'))return {rowCount:1,rows:[{start_date:'2026-01-01',end_date:'2027-01-01',tz:'Asia/Kolkata',total_orders:1,purchase_value:'100.00',confirmed_value:'100.00',confirmed_count:1,outstanding:'20.00',available_credit:'5.00',verified_payments:'75.00',pending_verification:'0.00',paid:1,partially_paid:0,unpaid:0,chart_data:[{periodKey:'2026-01',label:'Jan',orderCount:1,purchaseValue:'100.00'}]}]};
  return {rowCount:1,rows:[{orders:0}]};
 };
 const bad=response();await getDealerDashboardAnalytics({query:{period:'hourly'},user:{id:'99',userType:'Dealer'}},bad);assert.equal(bad.statusCode,400);assert.equal(calls.length,0);
 const res=response();await getDealerDashboardAnalytics({query:{period:'monthly',dealerId:'999'},user:{id:'99',userType:'Dealer'}},res);assert.equal(res.statusCode,200);assert.equal(res.body.summary.outstandingAmount,'20.00');assert.equal(res.body.chartData.length,1);
 const aggregate=calls.find(x=>x.sql.includes('WITH cfg AS'));assert.deepEqual(aggregate.values,['7','3','12','monthly','Asia/Kolkata']);assert.match(aggregate.sql,/generate_series/);assert.match(aggregate.sql,/status='posted'/);assert.match(aggregate.sql,/dealer_manual_payment_claims/);
});

test('dealer order list includes method and posted-payment balance for confirmed orders',async()=>{
 let sql='';originalQuery=connection.query;connection.query=async(statement)=>{sql=statement;return {rowCount:1,rows:[{id:'21',status:'CONFIRMED',payment_method:'UPI',grand_total:'21500.00',paid_amount:'0.00',remaining_amount:'21500.00'}]};};
 const res=response();await listOrders({user:{id:'9',userType:'Dealer'}},res);assert.equal(res.statusCode,200);assert.equal(res.body[0].payment_method,'UPI');assert.equal(res.body[0].remaining_amount,'21500.00');assert.match(sql,/payment_method/);assert.match(sql,/status='posted' AND direction='in'/);
});

test('dealer ledger derives party and store scope from authenticated dealer profile',async()=>{
 const calls=[];originalQuery=connection.query;connection.query=async(sql,values=[])=>{calls.push({sql,values});return {rowCount:1,rows:[{id:'7',customer_id:'12',store_id:'3',account_status:'active',store_active:true}]};};originalConnect=connection.connect;connection.connect=async()=>({query:async(sql,values=[])=>{calls.push({sql,values});if(sql.includes('SELECT id,code,name,phone,email,tax_id,address'))return {rowCount:1,rows:[{id:'12',name:'Dealer Account'}]};if(sql.includes('SELECT id,code,name,address,city'))return {rowCount:1,rows:[{id:'3',name:'Main Store'}]};if(sql.includes('CURRENT_TIMESTAMP AT TIME ZONE'))return {rowCount:1,rows:[{date:'2026-10-31'}]};if(sql.includes('opening_balance'))return {rowCount:1,rows:[{opening_balance:'0.00',closing_balance:'250.00',total_debit:'250.00',total_credit:'0.00',invoice_amount:'250.00',payment_amount:'0.00',total:1}]};if(sql.includes('store_running_balance'))return {rowCount:1,rows:[{entry_date:'2026-01-01',store_id:'3',entry_type:'sales_invoice',reference:'INV-1',debit:'250.00',credit:'0.00',running_balance:'250.00'}]};return {rowCount:1,rows:[]};},release(){}});
 const res=response();await getDealerLedger({user:{id:'99',userType:'Dealer'},query:{}},res);assert.equal(res.statusCode,200);assert.equal(res.body.customerId,'12');assert.equal(res.body.outstandingBalance,'250.00');const partyQuery=calls.find(x=>x.sql.includes('SELECT id,code,name,phone,email,tax_id,address'));assert.deepEqual(partyQuery.values,['12']);const ledgerEntries=calls.filter(x=>x.values?.[0]==='12'&&Array.isArray(x.values?.[1]));assert.ok(ledgerEntries.length>=3);assert.ok(ledgerEntries.every(x=>x.values[1].length===1&&x.values[1][0]==='3'));
});

test('Admin quotation revision snapshots edited lines and creates a new version',async()=>{
 const calls=[];originalConnect=connection.connect;connection.connect=async()=>({query:async(sql,values=[])=>{calls.push({sql,values});
  if(sql.includes('SELECT o.*,d.user_id AS dealer_user_id'))return {rows:[{id:'21',dealer_id:'7',order_number:'DO-2026-0000001',status:'PENDING_REVIEW',quotation_version:1,subtotal:'1700.00',transport_charge:'1000.00',discount_amount:'0.00',tax_amount:'306.00',billing_address_snapshot:{city:'Patna'},delivery_address_snapshot:{city:'Mahua'},payment_method:'UPI',business_name:'Dealer House',store_name:'Tiles Wala'}]};
  if(sql.includes('FROM products p JOIN dealer_product_unit_prices'))return {rowCount:1,rows:[{id:'4',name:'GVT Tile',tax_rate:'18',tax_inclusive:false,unit_name:'Box',decimal_places:0,dealer_price:'900.0000',mrp:'1200.00',gross_amount:'1800.00',tax_amount:'324.00'}]};
  return {rowCount:1,rows:[]};
 },release(){}});
 const res=response();await sendQuotation({params:{id:'21'},body:{items:[{productId:'4',unitId:'2',quantity:2}],transportCharge:'1200.00',remarks:'Revised transport'},user:{id:'1',userType:'Admin'}},res);
 assert.equal(res.statusCode,201);assert.equal(res.body.version,2);assert.equal(res.body.subtotal,'1800.00');assert.equal(res.body.taxAmount,'324.00');assert.equal(res.body.grandTotal,'3324.00');
 const insert=calls.find(x=>x.sql.includes('INSERT INTO dealer_order_quotations'));assert.equal(insert.values[1],2);const snapshot=JSON.parse(insert.values[8]);assert.equal(snapshot[0].dealerPrice,'900.0000');assert.equal(snapshot[0].mrp,'1200.00');assert.equal(snapshot[0].discountPercentage,'25.00');assert.equal(snapshot[0].quantity,'2');assert.equal(calls.some(x=>x.sql.includes("'QUOTATION_REVISED'")),true);assert.equal(calls.at(-1).sql,'COMMIT');
});

test('dealer acceptance is bound to the current quotation version and unpaid status stays separate',async()=>{
 originalConnect=connection.connect;connection.connect=async()=>({query:async(sql)=>{
  if(sql.includes('SELECT d.id FROM dealer_profiles'))return {rowCount:1,rows:[{id:'7'}]};
  if(sql.includes('SELECT * FROM dealer_orders'))return {rowCount:1,rows:[{id:'21',quotation_version:3,status:'QUOTATION_SENT',payment_status:'UNPAID'}]};
  if(sql.includes('SELECT valid_until'))return {rowCount:1,rows:[{valid_until:'2999-01-01'}]};
  return {rowCount:1,rows:[]};
 },release(){}});
 const stale=response();await acceptQuotation({params:{id:'21'},body:{quotationVersion:2},user:{id:'9',userType:'Dealer'}},stale);assert.equal(stale.statusCode,409);
 const accepted=response();await acceptQuotation({params:{id:'21'},body:{quotationVersion:3},user:{id:'9',userType:'Dealer'}},accepted);assert.equal(accepted.statusCode,200);assert.equal(accepted.body.paymentStatus,'UNPAID');
});

test('direct UPI attempt returns store payee, exact outstanding amount, and order reference',async()=>{
 const calls=[];originalConnect=connection.connect;connection.connect=async()=>({query:async(sql,values=[])=>{calls.push({sql,values});if(sql.includes('FROM dealer_orders o JOIN dealer_profiles d'))return {rowCount:1,rows:[{id:'21',order_number:'DO-21',status:'CONFIRMED',payment_method:'UPI',quotation_version:1,accepted_total:'2003.00',customer_id:'12',account_status:'active',store_active:true,store_name:'Tiles Wala',invoice_payment_details:{upiId:'8109961022@indianbk'},dealer_partial_payments_enabled:false}]};if(sql.includes('SELECT COALESCE(sum(amount)'))return {rowCount:1,rows:[{amount:'503.00'}]};if(sql.includes('GREATEST($1::numeric-$2::numeric'))return {rowCount:1,rows:[{amount:'1500.00'}]};if(sql.includes('SELECT attempt_reference'))return {rowCount:0,rows:[]};return {rowCount:1,rows:[]};},release(){}});
 const res=response();await createManualUpiAttempt({params:{id:'21'},body:{},user:{id:'9',userType:'Dealer'}},res);assert.equal(res.statusCode,201);assert.equal(res.body.amount,'1500.00');assert.equal(res.body.upiId,'8109961022@indianbk');assert.equal(res.body.payeeName,'Tiles Wala');const uri=new URL(res.body.upiUri);assert.equal(uri.searchParams.get('pa'),'8109961022@indianbk');assert.equal(uri.searchParams.get('am'),'1500.00');assert.match(uri.searchParams.get('tn'),/^DO-DO-21-[a-f0-9]{8}$/);assert.ok(calls.some(call=>call.sql.includes('dealer_manual_payment_claims')));
});

test('dealer quotation endpoint returns a downloadable PDF quotation snapshot',async()=>{
 originalQuery=connection.query;connection.query=async()=>({rowCount:1,rows:[{id:'21',order_number:'DO-21',payment_method:'UPI',delivery_contact_name:'Asha',delivery_contact_mobile:'9876543210',delivery_instructions:'Call ahead',store_name:'Tiles Wala',store_address:{line1:'Main Road',city:'Patna'},quote_number:'Q-DO-21-1',quote_subtotal:'850.00',quote_transport:'1000.00',quote_discount:'0.00',quote_tax:'153.00',quote_total:'2003.00',items_snapshot:[{productName:'GVT Tile',quantity:'1',unit:'Box',dealerPrice:'850.00',lineTotal:'1003.00'}],quote_document:{store:{name:'Tiles Wala'},dealer:{businessName:'Dealer House',contactName:'Asha'}},quote_billing:{city:'Patna'},quote_delivery:{city:'Mahua'},quote_created_at:new Date(),valid_until:'2999-01-01'}]});
 const res={headers:{},setHeader(name,value){this.headers[name]=value;},send(value){this.body=value;}};await getDealerQuotation({params:{id:'21'},query:{},user:{id:'1',userType:'Admin'}},res);assert.equal(res.headers['Content-Type'],'application/pdf');assert.match(res.headers['Content-Disposition'],/Q-DO-21-1\.pdf/);assert.equal(res.body.subarray(0,4).toString(),'%PDF');
});

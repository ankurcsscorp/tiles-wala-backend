import 'dotenv/config';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {connection} from '../connection.js';
import {createSalesDraft,finalizeSales} from './controllers/sales.js';
import {createCustomerReceipt} from './controllers/payments.js';
import {partyLedger,printLedger,downloadLedgerPdf,exportLedger} from './controllers/financialReports.js';
const configured=['DB_HOST','DB_USER','DB_PASSWORD','DB_NAME'].every(key=>process.env[key]);
const response=()=>({statusCode:200,headers:{},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;},send(body){this.body=body;return this;},set(key,value){this.headers[key]=value;return this;},type(value){this.contentType=value;return this;}});
test('ledger statements reconcile opening, period movements and closing across filters, all pages and exports',{skip:!configured},async t=>{
 const c=await connection.connect(),query=connection.query,connect=connection.connect;
 try{
  // Confirm the real report snapshot mode without writing business data.
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');assert.equal((await c.query('SHOW transaction_isolation')).rows[0].transaction_isolation,'repeatable read');assert.equal((await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');await c.query('ROLLBACK');
  await c.query('BEGIN');connection.query=(...args)=>c.query(...args);connection.connect=async()=>({query:(sql,args)=>c.query(sql.startsWith('BEGIN')?'SAVEPOINT ledger_api':sql==='COMMIT'?'RELEASE SAVEPOINT ledger_api':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT ledger_api':sql,args),release(){}});
  const suffix=Date.now()+String(process.pid),user={...(await c.query("INSERT INTO users(name,mobile,password_hash,user_type) VALUES('Ledger Tester',$1,'test','Admin') RETURNING id",[suffix])).rows[0],userType:'Admin'};
  const stores=[];for(const code of ['LA','LB'])stores.push((await c.query("INSERT INTO stores(code,name,address) VALUES($1,$2,$3) RETURNING id",[code+suffix,code+' Ledger Store',{line1:'Test address'}])).rows[0]);
  await c.query("INSERT INTO user_store_assignments(user_id,store_id,role) VALUES($1,$2,'staff')",[user.id,stores[0].id]);
  const customer=(await c.query("INSERT INTO customers(name,phone) VALUES('Ledger Customer','9999999999') RETURNING id")).rows[0],supplier=(await c.query("INSERT INTO suppliers(name) VALUES('Ledger Supplier') RETURNING id")).rows[0];
  const unit=(await c.query("INSERT INTO units_of_measure(code,name) VALUES($1,'Piece') RETURNING id",['LU'+suffix])).rows[0];
  const product=(await c.query("INSERT INTO products(sku,name,base_unit_id) VALUES($1,'Ledger Tile',$2) RETURNING id",['LP'+suffix,unit.id])).rows[0];
  for(const store of stores)await c.query("INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by) VALUES($1,$2,'adjustment',1000,'ledger_test',$1,1,$3,$4)",[store.id,product.id,codeKey(store.id),user.id]);
  function codeKey(id){return 'ledger-'+suffix+'-'+id;}
  const call=async(fn,{body={},id=customer.id,type='customer',actor=user,params={},query={}}={})=>{const res=response();await fn({user:actor,params:{id,partyType:type,...params},body,query},res);return res;};
  const sale=async(rate,date,store=stores[0])=>{const draft=await call(createSalesDraft,{body:{storeId:store.id,customerId:customer.id,invoiceDate:date,items:[{productId:product.id,unitId:unit.id,quantity:'1',unitPrice:rate}]}});assert.equal(draft.statusCode,201,JSON.stringify(draft.body));const posted=await call(finalizeSales,{id:draft.body.id});assert.equal(posted.statusCode,200,JSON.stringify(posted.body));return posted.body;};
  await c.query("INSERT INTO customer_balance_adjustments(customer_id,store_id,adjustment_type,direction,amount,status,adjustment_date,created_by) VALUES($1,$2,'opening_balance','debit',30,'posted','2025-09-29',$3)",[customer.id,stores[0].id,user.id]);
  await sale('100','2025-10-01');const invoice=await sale('200','2026-02-01');await sale('50','2026-03-01');await sale('20','2026-06-01',stores[1]);await sale('999','2027-01-01');
  const received=await call(createCustomerReceipt,{body:{storeId:stores[0].id,partyId:customer.id,amount:'75',paymentMethod:'cash',paymentDate:'2026-04-01',idempotencyKey:'ledger-paid-'+suffix,allocations:[{invoiceId:invoice.id,amount:'30'}]}});assert.equal(received.statusCode,201,JSON.stringify(received.body));
  for(let i=0;i<120;i++)await c.query("INSERT INTO customer_balance_adjustments(customer_id,store_id,adjustment_type,direction,amount,status,adjustment_date,note,created_by) VALUES($1,$2,'adjustment','debit',1,'posted','2026-05-01','Ledger page coverage',$3)",[customer.id,stores[0].id,user.id]);
  const filter={storeId:String(stores[0].id),fromDate:'2026-01-01',toDate:'2026-10-28'};
  await t.test('opening excludes period rows and closing includes allocated and unapplied receipts once',async()=>{
   const res=await call(partyLedger,{query:{...filter,limit:2}});assert.equal(res.statusCode,200,JSON.stringify(res.body));assert.equal(res.body.openingBalance,'130.00');assert.equal(res.body.closingBalance,'425.00');assert.equal(res.body.totalDebit,'370.00');assert.equal(res.body.totalCredit,'75.00');assert.equal(res.body.summary.invoiceAmount,'250.00');assert.equal(res.body.summary.paymentAmount,'75.00');assert.equal(res.body.items.length,2);assert.equal(res.body.pagination.total,124);assert.equal(res.body.items[0].running_balance,'330.00');assert.equal(res.body.items[1].running_balance,'380.00');assert.equal(res.body.items[0].due_date,'2026-02-01');
  });
  await t.test('all-store running balances follow one combined displayed sequence',async()=>{
   const res=await call(partyLedger,{query:{fromDate:filter.fromDate,toDate:filter.toDate,limit:200}});assert.equal(res.statusCode,200,JSON.stringify(res.body));assert.equal(res.body.closingBalance,'445.00');assert.equal(res.body.items.at(-1).running_balance,'445.00');assert.equal(res.body.items.at(-1).store_running_balance,'20.00');assert.equal(res.body.business.length>=2,true);
  });
  await t.test('HTML and PDF include the complete filtered period beyond the screen page',async()=>{
   const html=await call(printLedger,{query:{...filter,limit:1,offset:100}});assert.equal(html.statusCode,200);assert.match(html.body,/Opening Balance/);assert.match(html.body,/Closing Balance/);assert.match(html.body,/Transactions: 124/);assert.match(html.body,/₹425 Dr/);assert.equal((html.body.match(/>Balance Adjustment<\/td>/g)||[]).length,120);assert.equal(html.headers['Cache-Control'],'private, no-store');
   const csv=await call(exportLedger,{query:{...filter,limit:1,offset:100}});assert.equal(csv.statusCode,200);assert.match(csv.body,/Opening Balance/);assert.match(csv.body,/Closing Balance/);assert.match(csv.body,/Period totals/);assert.equal(csv.body.split('\r\n').length,128);
   const pdf=await call(downloadLedgerPdf,{query:{...filter,limit:1,offset:100}});assert.equal(pdf.statusCode,200,JSON.stringify(pdf.body));assert.equal(pdf.contentType,'application/pdf');assert.equal(pdf.body.subarray(0,5).toString(),'%PDF-');assert.match(pdf.headers['Content-Disposition'],/Ledger-Ledger-Customer-2026-01-01-2026-10-28\.pdf/);assert.ok(pdf.body.length>10000);
  });
  await t.test('a period without movements carries opening into closing',async()=>{
   const res=await call(partyLedger,{query:{...filter,fromDate:'2026-07-01'}});assert.equal(res.statusCode,200);assert.equal(res.body.openingBalance,'425.00');assert.equal(res.body.closingBalance,'425.00');assert.equal(res.body.items.length,0);assert.equal(res.body.totalDebit,'0.00');assert.equal(res.body.totalCredit,'0.00');
  });
  await t.test('supplier credit and debit retain their payable convention',async()=>{
   await c.query("INSERT INTO supplier_balance_adjustments(supplier_id,store_id,adjustment_type,direction,amount,status,adjustment_date,created_by) VALUES($1,$2,'opening_balance','credit',400,'posted','2025-09-29',$3),($1,$2,'adjustment','debit',120,'posted','2026-02-01',$3),($1,$2,'adjustment','credit',40,'posted','2026-03-01',$3)",[supplier.id,stores[0].id,user.id]);
   const res=await call(partyLedger,{id:supplier.id,type:'supplier',query:filter});assert.equal(res.statusCode,200,JSON.stringify(res.body));assert.equal(res.body.openingBalance,'400.00');assert.equal(res.body.closingBalance,'320.00');assert.equal(res.body.totalDebit,'120.00');assert.equal(res.body.totalCredit,'40.00');
   const html=await call(printLedger,{id:supplier.id,type:'supplier',query:filter});assert.match(html.body,/₹320 Cr/);
  });
  await t.test('date validation, missing parties and store authorization apply equally to exports',async()=>{
   for(const fn of [partyLedger,printLedger,downloadLedgerPdf]){
    assert.equal((await call(fn,{actor:{...user,userType:'Salesperson'},query:{...filter,storeId:String(stores[1].id)}})).statusCode,403);
    assert.equal((await call(fn,{query:{...filter,fromDate:'2026-02-30'}})).statusCode,400);
    assert.equal((await call(fn,{query:{...filter,fromDate:'2026-11-01'}})).statusCode,400);
    assert.equal((await call(fn,{id:'9223372036854775807',query:filter})).statusCode,404);
   }
  });
 }finally{connection.query=query;connection.connect=connect;await c.query('ROLLBACK');c.release();await connection.end();}
});

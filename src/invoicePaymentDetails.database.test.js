import 'dotenv/config';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {connection} from '../connection.js';
import {getInvoiceSettings,putInvoiceSettings} from './controllers/invoiceSettings.js';
import {createSalesDraft,finalizeSales,getSales} from './controllers/sales.js';
const configured=['DB_HOST','DB_USER','DB_PASSWORD','DB_NAME'].every(key=>process.env[key]);
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});

test('store payment instructions are authorized, audited and frozen with terms when sales finalize',{skip:!configured},async()=>{
  const originalQuery=connection.query,originalConnect=connection.connect,c=await connection.connect();
  try {
    await c.query('BEGIN');connection.query=(...args)=>c.query(...args);
    connection.connect=async()=>({query:(sql,args)=>c.query(sql==='BEGIN'?'SAVEPOINT payment_details_api':sql==='COMMIT'?'RELEASE SAVEPOINT payment_details_api':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT payment_details_api':sql,args),release(){}});
    const suffix=`${Date.now()}${process.pid}`;
    const user=(await c.query("INSERT INTO users(name,mobile,password_hash,user_type) VALUES('Payment Details Test',$1,'test','Salesperson') RETURNING id",[suffix])).rows[0];user.userType='Salesperson';
    const stores=[];
    for(const n of [0,1]){const store=(await c.query("INSERT INTO stores(code,name,terms_and_conditions) VALUES($1,'Demo Store','Original terms') RETURNING id",[`PD${n}${suffix}`])).rows[0];stores.push(store);await c.query("INSERT INTO user_store_assignments(user_id,store_id,role) VALUES($1,$2,'manager')",[user.id,store.id]);}
    const call=async(fn,id,body)=>{const r=response();await fn({user,params:{id:String(id)},body},r);return r;};
    const bank={accountName:'Demo Store',accountNumber:'001234567890',bankName:'Demo Bank',branch:'Main Branch',ifscCode:'ABCD0123456',upiId:'demo@bank'};
    // Footer changes never require converting an incomplete GST configuration.
    await c.query("INSERT INTO store_billing_config(store_id,invoice_type,invoice_layout,default_document_type) VALUES($1,'GST','STANDARD_GST_LAYOUT','GST_TAX_INVOICE')",[stores[0].id]);
    let result=await call(putInvoiceSettings,stores[0].id,{termsAndConditions:'Saved terms\nSecond line',paymentDetails:bank});
    assert.equal(result.statusCode,200,JSON.stringify(result.body));assert.equal(result.body.data.billingMode,'GST');assert.deepEqual(result.body.data.paymentDetails,bank);
    assert.equal((await call(getInvoiceSettings,stores[0].id)).body.data.termsAndConditions,'Saved terms\nSecond line');
    assert.equal((await c.query('SELECT terms_and_conditions FROM store_billing_config WHERE store_id=$1',[stores[0].id])).rows[0].terms_and_conditions,'Saved terms\nSecond line');
    result=await call(getInvoiceSettings,stores[1].id);assert.deepEqual(result.body.data.paymentDetails,{});assert.equal(result.body.data.termsAndConditions,'Original terms');
    for(const body of [{paymentDetails:{accountNumber:'123456'}},{paymentDetails:{upiId:'invalid'}},{termsAndConditions:45},{termsAndConditions:'x'.repeat(10001)}])assert.equal((await call(putInvoiceSettings,stores[0].id,body)).statusCode,400);
    await c.query("UPDATE user_store_assignments SET role='staff' WHERE user_id=$1 AND store_id=$2",[user.id,stores[0].id]);
    assert.equal((await call(putInvoiceSettings,stores[0].id,{paymentDetails:{}})).statusCode,403);
    await c.query("UPDATE user_store_assignments SET role='manager' WHERE user_id=$1 AND store_id=$2",[user.id,stores[0].id]);
    await call(putInvoiceSettings,stores[0].id,{billingMode:'NON_GST'});
    const unit=(await c.query("INSERT INTO units_of_measure(code,name) VALUES($1,'Box') RETURNING id",['PD'+suffix])).rows[0];
    const product=(await c.query("INSERT INTO products(sku,name,base_unit_id,tax_rate) VALUES($1,'Payment Tile',$2,0) RETURNING id",['PD'+suffix,unit.id])).rows[0];
    await c.query("INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by) VALUES($1,$2,'adjustment',100,'payment_details_test',1,1,$3,$4)",[stores[0].id,product.id,suffix,user.id]);
    result=response();await createSalesDraft({user,body:{storeId:String(stores[0].id),items:[{productId:String(product.id),unitId:String(unit.id),quantity:'1',unitPrice:'100'}]}},result);
    assert.equal(result.statusCode,201,JSON.stringify(result.body));const id=result.body.id;
    const posted=response();await finalizeSales({user,params:{id},body:{}},posted);assert.equal(posted.statusCode,200,JSON.stringify(posted.body));
    assert.deepEqual(posted.body.payment_details_snapshot,bank);assert.equal(posted.body.terms_snapshot,'Saved terms\nSecond line');
    const audit=(await c.query('SELECT new_settings FROM invoice_settings_audit WHERE store_id=$1 ORDER BY id DESC',[stores[0].id])).rows;
    assert(audit.some(row=>row.new_settings.invoice_payment_details?.accountNumber===bank.accountNumber));
    await call(putInvoiceSettings,stores[0].id,{paymentDetails:{},termsAndConditions:''});
    result=await call(getInvoiceSettings,stores[0].id);assert.deepEqual(result.body.data.paymentDetails,{});assert.equal(result.body.data.termsAndConditions,'');
    const saved=response();await getSales({user,params:{id}},saved);assert.deepEqual(saved.body.payment_details_snapshot,bank);assert.equal(saved.body.terms_snapshot,'Saved terms\nSecond line');
    await c.query('SAVEPOINT immutable_check');
    await assert.rejects(c.query("UPDATE sales_invoices SET payment_details_snapshot='{}'::jsonb WHERE id=$1",[id]),/immutable/);
    await c.query('ROLLBACK TO SAVEPOINT immutable_check');
  } finally {connection.query=originalQuery;connection.connect=originalConnect;await c.query('ROLLBACK');c.release();await connection.end();}
});

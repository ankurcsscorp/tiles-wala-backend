import 'dotenv/config';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {connection} from '../connection.js';
import {createProduct,updateProduct} from './controllers/products.js';

const configured=['DB_HOST','DB_USER','DB_PASSWORD','DB_NAME'].every(key=>process.env[key]);
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});

test('product edits persist tax metadata, preserve omitted classification, and roll back rejected updates',{skip:!configured},async()=>{
 const query=connection.query,connect=connection.connect,client=await connection.connect();
 try{
  await client.query('BEGIN');
  connection.query=(...args)=>client.query(...args);
  connection.connect=async()=>({query:(sql,args)=>client.query(sql==='BEGIN'?'SAVEPOINT product_api':sql==='COMMIT'?'RELEASE SAVEPOINT product_api':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT product_api':sql,args),release(){}});
  const suffix=`${Date.now()}${process.pid}`;
  const base=(await client.query("INSERT INTO units_of_measure(code,name) VALUES($1,'Product test base') RETURNING id",['PB'+suffix])).rows[0];
  const sales=(await client.query("INSERT INTO units_of_measure(code,name) VALUES($1,'Product test sales') RETURNING id",['PS'+suffix])).rows[0];
  const body={sku:'P'+suffix,name:'Product update fixture',baseUnitId:base.id,salesUnitId:sales.id,conversions:[{unitId:sales.id,factorToBase:'4'}],hsnCode:'6907',taxRate:null,supplyClassification:'UNKNOWN'};
  const call=async(fn,body,id)=>{const res=response();await fn({body,params:{id},query:{},user:{userType:'Admin'}},res);return res;};
  const created=await call(createProduct,body);assert.equal(created.statusCode,200,JSON.stringify(created.body));
  const id=created.body.id;
  let updated=await call(updateProduct,{...body,taxRate:'18',supplyClassification:'TAXABLE'},id);
  assert.equal(updated.statusCode,200,JSON.stringify(updated.body));assert.equal(updated.body.gst_supply_classification,'TAXABLE');assert.equal(updated.body.tax_rate,'18.0000');
  updated=await call(updateProduct,{...body,taxRate:'0',supplyClassification:'EXEMPT',classificationReference:'Reviewed exemption fixture'},id);
  assert.equal(updated.statusCode,200,JSON.stringify(updated.body));assert.equal(updated.body.gst_classification_reference,'Reviewed exemption fixture');
  const legacy={...body,name:'Updated name',taxRate:'0'};delete legacy.supplyClassification;
  updated=await call(updateProduct,legacy,id);
  assert.equal(updated.statusCode,200,JSON.stringify(updated.body));assert.equal(updated.body.name,'Updated name');
  assert.equal(updated.body.gst_supply_classification,'EXEMPT');assert.equal(updated.body.gst_classification_reference,'Reviewed exemption fixture');
  let rejected=await call(updateProduct,{...body,supplyClassification:'EXEMPT',classificationReference:''},id);
  assert.equal(rejected.statusCode,400);assert.match(rejected.body.message,/reference/);
  const duplicate=await call(createProduct,{...body,sku:'D'+suffix});assert.equal(duplicate.statusCode,200);
  rejected=await call(updateProduct,{...body,sku:'D'+suffix,name:'Must not persist'},id);
  assert.equal(rejected.statusCode,409);
  const stored=(await client.query('SELECT name,gst_supply_classification,gst_classification_reference FROM products WHERE id=$1',[id])).rows[0];
  assert.equal(stored.name,'Updated name');assert.equal(stored.gst_supply_classification,'EXEMPT');assert.equal(stored.gst_classification_reference,'Reviewed exemption fixture');
  assert.equal((await client.query('SELECT factor_to_base FROM product_unit_conversions WHERE product_id=$1',[id])).rows[0].factor_to_base,'4.00000000');
  // A later successful explicit review can change the classification and clear an obsolete reference.
  updated=await call(updateProduct,{...body,taxRate:'18',supplyClassification:'TAXABLE'},id);
  assert.equal(updated.statusCode,200);assert.equal(updated.body.gst_classification_reference,null);
 }finally{connection.query=query;connection.connect=connect;await client.query('ROLLBACK');client.release();await connection.end();}
});

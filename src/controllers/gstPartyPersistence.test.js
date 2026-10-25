import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import jwt from 'jsonwebtoken';
import { connection } from '../../connection.js';
import { createCustomer, updateCustomer } from './customers.js';
import { createSupplier, updateSupplier } from './suppliers.js';
const originalQuery=connection.query,originalConnect=connection.connect;
afterEach(()=>{connection.query=originalQuery;connection.connect=originalConnect;});
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});
const gstin='27AAPFU0939F1ZV';
process.env.JWT_SECRET='test-only-party-gst-secret-000000000000';
const token=()=>jwt.sign({gstin,source:'finagg',fetchedAt:new Date().toISOString()},process.env.JWT_SECRET,{audience:'gst-lookup',issuer:'tiles-wala',expiresIn:'30m'});
for(const [name,create,update] of [['customer',createCustomer,updateCustomer],['supplier',createSupplier,updateSupplier]]) {
 test(`${name} duplicate GSTIN returns conflict independently of its code`,async()=>{
  connection.connect=async()=>({query:async sql=>{if(sql.includes(`INSERT INTO ${name}s`))throw Object.assign(new Error('duplicate'),{code:'23505',constraint:`${name}s_gstin_unique`});return {rows:[]};},release(){}});
  const res=response();await create({user:{id:'1',userType:'Admin'},body:{name:'Business',gstin}},res);
  assert.equal(res.statusCode,409);assert.match(res.body.message,/GSTIN already exists/);
 });
 test(`${name} update binds all new columns, preserving verification only for an unchanged GSTIN`,async()=>{
  let recorded;connection.query=async(sql,values)=>{recorded={sql,values};return {rowCount:1,rows:[{id:'1'}]};};
  const res=response();await update({user:{id:'1',userType:'Admin'},params:{id:'1'},body:{name:'Business',gstin,gstDetails:{legalName:'Reviewed Legal'},gstLookupToken:token()}},res);
  assert.equal(res.statusCode,200);assert.equal(Math.max(...[...recorded.sql.matchAll(/\$(\d+)/g)].map(x=>Number(x[1]))),recorded.values.length);
  assert.ok(recorded.values.includes('finagg'));assert.ok(recorded.values.some(v=>v?.legalName==='Reviewed Legal'));
  assert.match(recorded.sql,/tax_id IS NOT DISTINCT FROM \$7/);
 });
 test(`${name} manual update clears verification when requested and ignores client timestamps`,async()=>{
  let values;connection.query=async(sql,params)=>{values=params;return {rowCount:1,rows:[{id:'1'}]};};
  const res=response();await update({user:{id:'1',userType:'Admin'},params:{id:'1'},body:{name:'Manual',gstin,clearGstVerification:true,gstVerifiedAt:'2026-01-01',gstDataSource:'forged'}},res);
  assert.equal(res.statusCode,200);assert.equal(values.at(-1),true);assert.equal(values.at(-2),null);assert.equal(values.at(-3),null);
 });
}

import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import jwt from 'jsonwebtoken';
import express from 'express';
import gstRouter from '../routes/gst.js';
import { connection } from '../../connection.js';
import { JWT_AUDIENCE, JWT_ISSUER } from './auth.js';
import { createLookupController } from './gst.js';
import { GSTError } from '../services/gstErrors.js';
const originalQuery = connection.query;
afterEach(() => {connection.query=originalQuery;});
const res = () => ({statusCode:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});
test('lookup returns a consistent sanitized error response', async () => {
  const response=res(); await createLookupController(async()=>{throw new Error('secret diagnostic');})({params:{gstin:'27AAPFU0939F1ZV'}},response);
  assert.equal(response.statusCode,503); assert.equal(response.body.success,false); assert.ok(!JSON.stringify(response.body).includes('secret'));
  assert.equal(response.headers['Cache-Control'],'no-store');
  const limited=res(); await createLookupController(async()=>{throw new GSTError('GST_RATE_LIMITED',429,'Try later',120);})({params:{gstin:'27AAPFU0939F1ZV'}},limited);
  assert.equal(limited.headers['Retry-After'],'120'); assert.equal(limited.statusCode,429);
});
test('lookup route authenticates, checks roles/store assignment, and limits requests', async () => {
  process.env.JWT_SECRET='test-only-route-gst-secret-000000000000';process.env.GST_PROVIDER='';
  let type='Admin';
  connection.query=async(sql)=>sql.includes('FROM users')?{rows:[{id:'91',name:'Tester',user_type:type}]}:{rows:[]};
  const app=express();app.use('/api/gst',gstRouter);
  const server=await new Promise(resolve=>{const handle=app.listen(0,'127.0.0.1',()=>resolve(handle));});
  try {
    const endpoint=`http://127.0.0.1:${server.address().port}/api/gst/lookup/27AAPFU0939F1ZV`;
    assert.equal((await fetch(endpoint)).status,401);
    const token=jwt.sign({},process.env.JWT_SECRET,{subject:'91',audience:JWT_AUDIENCE,issuer:JWT_ISSUER,expiresIn:'5m'});
    const headers={Authorization:`Bearer ${token}`};
    type='Customer';assert.equal((await fetch(endpoint,{headers})).status,403);
    type='Salesperson';assert.equal((await fetch(endpoint,{headers})).status,403);
    type='Admin';const configured=await fetch(endpoint,{headers});assert.equal(configured.status,503);assert.equal((await configured.json()).code,'GST_CONFIGURATION_REQUIRED');
    let response;for(let i=0;i<10;i++)response=await fetch(endpoint,{headers});
    assert.equal(response.status,429);assert.equal((await response.json()).code,'GST_RATE_LIMITED');
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

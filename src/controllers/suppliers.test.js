import assert from "node:assert/strict";
import {afterEach,test} from "node:test";
import {connection} from "../../connection.js";
import {createSupplier,getSupplierBalance,listSuppliers} from "./suppliers.js";

let originalQuery;let originalConnect;
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});
afterEach(()=>{if(originalQuery){connection.query=originalQuery;originalQuery=null;}if(originalConnect){connection.connect=originalConnect;originalConnect=null;}});

test("supplier creation permits duplicate mobile contacts",async()=>{
  const calls=[];originalQuery=connection.query;originalConnect=connection.connect;
  connection.query=async(sql,values)=>{calls.push({sql,values});return {rows:[{id:"23",name:"Shared Supplier"}]};};
  connection.connect=async()=>({query:async(sql,values)=>{calls.push({sql,values});return sql.includes("INSERT INTO suppliers")?{rows:[{id:"23"}],rowCount:1}:{rows:[]};},release(){}});
  const res=response();await createSupplier({user:{id:"1",userType:"Admin"},body:{name:"Shared Supplier",mobile:"+91 98765 43210"}},res);
  assert.equal(res.statusCode,201);assert.equal(calls.find((x)=>x.sql.includes("INSERT INTO suppliers")).values[3],"+91 98765 43210");
  assert.ok(!calls.some((x)=>/UNIQUE|ON CONFLICT/i.test(x.sql)));
});

test("supplier creation rejects invalid mobile values",async()=>{
  originalConnect=connection.connect;connection.connect=async()=>{throw new Error("Database should not be used");};
  const res=response();await createSupplier({user:{id:"3",userType:"Salesperson"},body:{name:"Supplier",mobile:"bad-number"}},res);
  assert.equal(res.statusCode,400);assert.match(res.body.message,/Mobile number/);
});

test("supplier creation requires a salesperson to have an active store assignment",async()=>{
  originalQuery=connection.query;originalConnect=connection.connect;
  connection.query=async()=>({rows:[]});connection.connect=async()=>{throw new Error("Must deny before creating supplier");};
  const res=response();await createSupplier({user:{id:"3",userType:"Salesperson"},body:{name:"Supplier"}},res);
  assert.equal(res.statusCode,403);assert.match(res.body.message,/store assignment/);
});

test("supplier balances are calculated only from the salesperson's assigned stores",async()=>{
  const calls=[];originalQuery=connection.query;
  connection.query=async(sql,values)=>{calls.push({sql,values});if(sql.includes("user_store_assignments"))return {rows:[{id:"15"}]};if(sql.includes("count(*)"))return {rows:[{total:1}]};return {rows:[{id:"23",outstanding_balance:"75.00"}]};};
  const res=response();await listSuppliers({user:{id:"8",userType:"Salesperson"},query:{q:"abc",page:"1",limit:"20"}},res);
  assert.equal(res.body.items[0].outstanding_balance,"75.00");
  assert.match(calls[2].sql,/purchase_invoices/);assert.ok(calls[2].values.some((value)=>Array.isArray(value)&&value.includes("15")));
});

test("supplier balance endpoint rejects an unassigned store",async()=>{
  originalQuery=connection.query;connection.query=async(sql)=>sql.includes("user_store_assignments")?{rows:[{id:"15"}]}:(()=>{throw new Error("Must deny before calculating balance");})();
  const res=response();await getSupplierBalance({user:{id:"8",userType:"Salesperson"},params:{id:"23"},query:{storeId:"16"}},res);
  assert.equal(res.statusCode,403);assert.match(res.body.message,/access to this store/);
});

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { connection } from "../../connection.js";
import { createCustomer, getCustomerBalance, listCustomers } from "./customers.js";

let originalQuery; let originalConnect;
const response = () => ({ statusCode:200, status(code){this.statusCode=code;return this;}, json(body){this.body=body;return this;} });
afterEach(() => { if (originalQuery) { connection.query=originalQuery; originalQuery=null; } if (originalConnect) { connection.connect=originalConnect; originalConnect=null; } });

test("customer creation permits duplicate mobile contact values", async () => {
  const calls=[]; originalQuery=connection.query; originalConnect=connection.connect;
  connection.query=async(sql,values)=>{calls.push({sql,values});return {rows:[{id:"19",name:"Shared Customer"}]};};
  connection.connect=async()=>({query:async(sql,values)=>{calls.push({sql,values});if(sql.includes("INSERT INTO customers"))return {rows:[{id:"19"}],rowCount:1};return {rows:[]};},release(){}});
  const res=response();
  await createCustomer({user:{id:"4",userType:"Admin"},body:{name:"Shared Customer",mobile:"+91 98765 43210"}},res);
  assert.equal(res.statusCode,201);
  assert.equal(calls.find(x=>x.sql.includes("INSERT INTO customers")).values[2],"+91 98765 43210");
  assert.ok(!calls.some(x=>/UNIQUE|ON CONFLICT/i.test(x.sql)));
});

test("customer creation rejects malformed phone numbers before database access", async () => {
  originalConnect=connection.connect; connection.connect=async()=>{throw new Error("Database should not be used");};
  const res=response();
  await createCustomer({user:{id:"2",userType:"Salesperson"},body:{name:"Person",mobile:"abc"}},res);
  assert.equal(res.statusCode,400);
  assert.match(res.body.message,/Mobile numbers/);
});

test("customer creation accepts a credit limit and returns the inserted party without a second connection", async () => {
  const calls=[];
  const customer={id:"20",name:"Credit Customer",credit_limit:"12500.50",gst_details:{}};
  originalQuery=connection.query; originalConnect=connection.connect;
  connection.query=async()=>{throw new Error("No follow-up pool query should be needed");};
  connection.connect=async()=>({query:async(sql,values)=>{
    calls.push({sql,values});
    return {rows:sql.includes("INSERT INTO customers")?[customer]:[]};
  },release(){}});
  const res=response();
  await createCustomer({user:{id:"4",userType:"Admin"},body:{name:customer.name,creditLimit:"12500.50"}},res);
  assert.equal(res.statusCode,201);
  assert.deepEqual(res.body,customer);
  assert.equal(calls.find(x=>x.sql.includes("INSERT INTO customers")).values[12],"12500.50");
  assert.equal(calls.at(-1).sql,"COMMIT");
});

test("customer creation rejects an invalid credit limit before database access", async () => {
  originalConnect=connection.connect;
  connection.connect=async()=>{throw new Error("Database should not be used");};
  for (const creditLimit of ["-1","12.345","abc"]) {
    const res=response();
    await createCustomer({body:{name:"Person",creditLimit}},res);
    assert.equal(res.statusCode,400);
    assert.match(res.body.message,/Credit limit must be/);
  }
});

test("customer creation rolls back both the customer and opening balance on a ledger failure", async () => {
  const calls=[]; let released=false;
  originalQuery=connection.query; originalConnect=connection.connect;
  connection.query=async()=>({rows:[{id:"1"}]});
  connection.connect=async()=>({query:async(sql)=>{
    calls.push(sql);
    if(sql.includes("INSERT INTO customer_balance_adjustments")) throw Object.assign(new Error("Unknown store"),{code:"23503"});
    return {rows:[{id:"20"}]};
  },release(){released=true;}});
  const res=response();
  await createCustomer({user:{id:"4",userType:"Admin"},body:{name:"Person",openingBalance:"100",openingStoreId:"1"}},res);
  assert.equal(res.statusCode,400);
  assert.equal(calls.at(-1),"ROLLBACK");
  assert.ok(!calls.includes("COMMIT"));
  assert.ok(released);
});

test("customer list scopes calculated balances to stores assigned to the user", async () => {
  const calls=[]; originalQuery=connection.query;
  connection.query=async(sql,values)=>{calls.push({sql,values});if(sql.includes("user_store_assignments"))return {rows:[{id:"12"}]};if(sql.includes("count(*)"))return {rows:[{total:1}]};return {rows:[{id:"3",outstanding_balance:"80.00"}]};};
  const res=response();
  await listCustomers({user:{id:"9",userType:"Salesperson"},query:{q:"Sam",page:"1",limit:"10"}},res);
  assert.equal(res.body.items[0].outstanding_balance,"80.00");
  const resultSql=calls[2];
  assert.match(resultSql.sql,/sales_invoices/);
  assert.ok(resultSql.values.some((value)=>Array.isArray(value)&&value.includes("12")));
  assert.ok(resultSql.values.includes("sam%"));
});

test("customer balance query rejects a store outside assigned stores", async () => {
  originalQuery=connection.query;
  connection.query=async(sql)=>sql.includes("user_store_assignments")?{rows:[{id:"12"}]}:(()=>{throw new Error("Should reject before balance query");})();
  const res=response();
  await getCustomerBalance({user:{id:"9",userType:"Salesperson"},params:{id:"3"},query:{storeId:"13"}},res);
  assert.equal(res.statusCode,403);
  assert.match(res.body.message,/access to this store/);
});

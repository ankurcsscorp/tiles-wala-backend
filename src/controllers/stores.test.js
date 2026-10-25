import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { connection } from "../../connection.js";
import { canManageStore, createStore, listStores } from "./stores.js";

let originalQuery; let originalConnect;
const response = () => ({ statusCode:200, status(code){this.statusCode=code;return this;}, json(body){this.body=body;return this;} });
afterEach(()=>{if(originalQuery){connection.query=originalQuery;originalQuery=null;}if(originalConnect){connection.connect=originalConnect;originalConnect=null;}});

test("non-admin store listing is scoped to assigned stores", async()=>{
  let queryText, values;
  originalQuery=connection.query;
  connection.query=async(text,params)=>{queryText=text;values=params;return {rows:[{id:"7",name:"North"}]};};
  const res=response();
  await listStores({user:{id:"12",userType:"Salesperson"}},res);
  assert.deepEqual(values,["12"]);
  assert.match(queryText,/user_store_assignments/);
  assert.match(queryText,/FROM stores WHERE is_active=TRUE AND EXISTS/);
  assert.deepEqual(res.body,[{id:"7",name:"North"}]);
});

test("admin store listing includes all stores",async()=>{
  let queryText;
  originalQuery=connection.query;
  connection.query=async(text)=>{queryText=text;return {rows:[]};};
  await listStores({user:{id:"1",userType:"Admin"}},response());
  assert.match(queryText,/FROM stores ORDER BY/);
  assert.doesNotMatch(queryText,/user_store_assignments/);
});

test("only administrators or manager assignments can manage a store",async()=>{
  originalQuery=connection.query;
  connection.query=async(text)=>text.includes("SELECT 1 FROM user_store_assignments usa JOIN stores")
    ? {rowCount:1,rows:[{}]}
    : {rowCount:1,rows:[{role:"staff"}]};
  assert.equal(await canManageStore({id:"2",userType:"Salesperson"},"7"),false);
  connection.query=async()=>({rowCount:1,rows:[{role:"manager"}]});
  assert.equal(await canManageStore({id:"2",userType:"Salesperson"},"7"),true);
  connection.query=async()=>{throw new Error("Admin must not need an assignment lookup");};
  assert.equal(await canManageStore({id:"1",userType:"Admin"},"7"),true);
});

test("store creation rejects invalid and duplicate codes",async()=>{
  originalQuery=connection.query;
  originalConnect=connection.connect;
  connection.connect=async()=>{throw new Error("Should not connect for invalid body");};
  const bad=response();
  await createStore({body:{name:"North",code:"bad code"}},bad);
  assert.equal(bad.statusCode,400);
  const error=new Error("duplicate");error.code="23505";
  connection.connect=async()=>({query:async(sql)=>{if(sql==="BEGIN"||sql==="ROLLBACK")return {};throw error;},release(){}});
  const duplicate=response();
  await createStore({body:{name:"North",code:"NORTH"}},duplicate);
  assert.equal(duplicate.statusCode,409);
  assert.match(duplicate.body.message,/already exists/);
});

test("store creation atomically saves profile and billing defaults",async()=>{
  const calls=[];
  originalConnect=connection.connect;
  connection.connect=async()=>({
    query:async(sql,values)=>{
      calls.push({sql,values});
      if(sql.includes("INSERT INTO stores")) return {rows:[{id:"22",code:"EAST",name:"East"}],rowCount:1};
      return {rows:[],rowCount:1};
    },release(){}
  });
  const res=response();
  await createStore({body:{name:" East ",code:" east ",city:"Pune",email:"sales@example.test",invoiceNumberingPeriod:"monthly",invoicePrefix:"E"}},res);
  assert.equal(res.statusCode,201);
  assert.equal(res.body.code,"EAST");
  assert.equal(res.body.invoice_prefix,"E");
  assert.equal(calls[0].sql,"BEGIN");
  assert.match(calls[1].sql,/INSERT INTO stores/);
  assert.equal(calls[1].values[0],"EAST");
  assert.match(calls[2].sql,/INSERT INTO store_billing_config/);
  assert.equal(calls[3].sql,"COMMIT");
});

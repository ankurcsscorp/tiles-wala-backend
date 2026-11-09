import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { connection } from "../../connection.js";
import { createProduct, getProductPrice, listProducts } from "./products.js";

let originalQuery; let originalConnect;
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});
afterEach(()=>{if(originalQuery){connection.query=originalQuery;originalQuery=null;}if(originalConnect){connection.connect=originalConnect;originalConnect=null;}});

test("product validation rejects missing base units and invalid conversions before connecting",async()=>{
  originalConnect=connection.connect;
  connection.connect=async()=>{throw new Error("Invalid product must not connect");};
  const noUnit=response();
  await createProduct({body:{sku:"A-1",name:"Tile"}},noUnit);
  assert.equal(noUnit.statusCode,400);
  assert.match(noUnit.body.message,/base unit/);
  const invalidFactor=response();
  await createProduct({body:{sku:"A-1",name:"Tile",baseUnitId:"1",purchaseUnitId:"2",conversions:[{unitId:"2",factorToBase:"0"}]}},invalidFactor);
  assert.equal(invalidFactor.statusCode,400);
  assert.match(invalidFactor.body.message,/positive decimals/);
});

test("dealer price validation rejects invalid precision and duplicate unit entries before connecting",async()=>{
  originalConnect=connection.connect;
  connection.connect=async()=>{throw new Error("Invalid dealer price must not connect");};
  const invalid=response();
  await createProduct({user:{userType:"Admin"},body:{sku:"D-1",name:"Dealer tile",baseUnitId:"1",dealerPrices:[{unitId:"1",price:"8.12345"}]}},invalid);
  assert.equal(invalid.statusCode,400);
  assert.match(invalid.body.message,/4 decimal places/);
  const duplicate=response();
  await createProduct({user:{userType:"Admin"},body:{sku:"D-1",name:"Dealer tile",baseUnitId:"1",dealerPrices:[{unitId:"1",price:"8"},{unitId:"1",price:"9"}]}},duplicate);
  assert.equal(duplicate.statusCode,400);
  assert.match(duplicate.body.message,/once per unit/);
});

test("MRP is optional but must be nonnegative, use two decimal places, and accompany a unit dealer price",async()=>{
  originalConnect=connection.connect;connection.connect=async()=>{throw new Error("Invalid MRP must not connect");};
  const tooPrecise=response();await createProduct({user:{userType:"Admin"},body:{sku:"MRP-1",name:"Tile",baseUnitId:"1",dealerPrices:[{unitId:"1",price:"850",mrp:"1200.001"}]}},tooPrecise);
  assert.equal(tooPrecise.statusCode,400);assert.match(tooPrecise.body.message,/MRP.*2 decimal places/);
  const withoutDealerPrice=response();await createProduct({user:{userType:"Admin"},body:{sku:"MRP-2",name:"Tile",baseUnitId:"1",dealerPrices:[{unitId:"1",price:"",mrp:"1200"}]}},withoutDealerPrice);
  assert.equal(withoutDealerPrice.statusCode,400);assert.match(withoutDealerPrice.body.message,/dealer price/);
  const negative=response();await createProduct({user:{userType:"Admin"},body:{sku:"MRP-3",name:"Tile",baseUnitId:"1",dealerPrices:[{unitId:"1",price:"850",mrp:"-1"}]}},negative);
  assert.equal(negative.statusCode,400);
});

test("only admins can submit dealer price or ordering availability changes",async()=>{
  originalConnect=connection.connect;
  connection.connect=async()=>{throw new Error("Unauthorized product mutation must not connect");};
  const res=response();
  await createProduct({user:{userType:"Salesperson"},body:{sku:"D-2",name:"Dealer tile",baseUnitId:"1",dealerPrices:[{unitId:"1",price:"850"}]}},res);
  assert.equal(res.statusCode,403);
});

test("product listing binds filters, caps pagination, and returns pagination metadata",async()=>{
  const calls=[];originalQuery=connection.query;
  connection.query=async(sql,values)=>{calls.push({sql,values});return calls.length===1?{rows:[{total:1}]}:{rows:[{id:"4",sku:"T-4",store_stock:"2.5"}]};};
  const res=response();
  await listProducts({user:{id:"1",userType:"Admin"},params:{},query:{q:"ant",brand:"North",page:"2",limit:"10",sort:"sku",direction:"desc",storeId:"8"}},res);
  assert.equal(calls.length,2);
  assert.match(calls[0].sql,/lower\(p\.sku\) LIKE \$1/);
  assert.ok(calls[0].values.includes("ant%"));
  assert.ok(calls[1].sql.includes("ORDER BY p.sku DESC"));
  assert.deepEqual(res.body.pagination,{page:2,limit:10,total:1,totalPages:1});
});

test("non-admin cannot request business-wide stock",async()=>{
  originalQuery=connection.query;
  connection.query=async()=>{throw new Error("Must deny before querying");};
  const res=response();
  await listProducts({user:{id:"2",userType:"Salesperson"},params:{},query:{includeBusinessStock:"true"}},res);
  assert.equal(res.statusCode,403);
});

test("price conversion uses PostgreSQL NUMERIC arithmetic",async()=>{
  const queries=[];originalQuery=connection.query;
  connection.query=async(sql)=>{
    queries.push(sql);
    if(sql.includes("FROM products p JOIN units_of_measure base"))return {rowCount:1,rows:[{id:"5",base_unit_id:"1",purchase_unit_id:"2",sales_unit_id:"2",price:"300.0000",target_unit_id:"1",base_unit_code:"SQFT",base_unit_name:"Square foot",target_unit_code:"SQFT",target_unit_name:"Square foot",target_factor:"1",default_factor:"15"}]};
    if(sql.includes("SELECT ("))return {rows:[{price:"20.0000"}]};
    return {rows:[{id:"1"}]};
  };
  const res=response();
  await getProductPrice({params:{id:"5"},query:{direction:"sales",unitId:"1"}},res);
  assert.equal(res.body.price,"20.0000");
  assert.ok(queries.some(sql=>sql.includes("::numeric * $2::numeric / $3::numeric")));
});

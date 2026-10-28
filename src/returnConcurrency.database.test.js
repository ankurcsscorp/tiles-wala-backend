import 'dotenv/config';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import pg from 'pg';
import {connection} from '../connection.js';
import {createSalesDraft,finalizeSales} from './controllers/sales.js';
import {createReturn,finalizeReturn} from './controllers/returns.js';
const configured=['DB_HOST','DB_USER','DB_PASSWORD','DB_NAME'].every(key=>process.env[key]);
const q=value=>'"'+String(value).replaceAll('"','""')+'"';
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});

test('simultaneous return finalizations cannot credit or restock the same eligible quantity twice',{skip:!configured,timeout:30000},async()=>{
 const schema=`return_race_${process.pid}_${Date.now()}`;
 const settings={host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,port:Number(process.env.DB_PORT||5432)};
 const control=new pg.Client(settings);await control.connect();let pool;
 const originalQuery=connection.query,originalConnect=connection.connect;
 try{
  // Clone schema and guards, not business rows. Real independent transactions
  // share these committed fixtures, and the entire isolated schema is removed.
  await control.query('SET search_path=pg_catalog');
  await control.query(`CREATE SCHEMA ${q(schema)}`);
  const tables=(await control.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  for(const row of tables)await control.query(`CREATE TABLE ${q(schema)}.${q(row.tablename)} (LIKE public.${q(row.tablename)} INCLUDING ALL)`);
  const sequences=(await control.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public'")).rows;
  for(const row of sequences)await control.query(`CREATE SEQUENCE IF NOT EXISTS ${q(schema)}.${q(row.sequencename)}`);
  const defaults=(await control.query("SELECT table_name,column_name,column_default FROM information_schema.columns WHERE table_schema='public' AND column_default LIKE 'nextval(%'")).rows;
  for(const row of defaults){const match=row.column_default.match(/nextval\('(?:public\.)?([^']+)'::regclass\)/);if(!match)throw Error('Unexpected sequence default');const sequence=match[1].replaceAll('"','');await control.query(`ALTER TABLE ${q(schema)}.${q(row.table_name)} ALTER COLUMN ${q(row.column_name)} SET DEFAULT nextval('${q(schema)}.${q(sequence)}'::regclass)`);}
  const constraints=(await control.query("SELECT c.conname,t.relname AS table_name,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND c.contype='f'")).rows;
  for(const row of constraints)await control.query(`ALTER TABLE ${q(schema)}.${q(row.table_name)} ADD CONSTRAINT ${q(row.conname)} ${row.definition.replaceAll('public.',q(schema)+'.')}`);
  const views=(await control.query("SELECT c.relname,pg_get_viewdef(c.oid) AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])",[['sales_return_accounting','purchase_return_accounting','sales_invoice_return_credits','purchase_invoice_return_credits']])).rows;
  for(const row of views)await control.query(`CREATE VIEW ${q(schema)}.${q(row.relname)} AS ${row.definition.replaceAll('public.',q(schema)+'.')}`);
  const triggers=(await control.query("SELECT c.relname AS table_name,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal")).rows;
  for(const row of triggers){const marker=row.definition.indexOf(' ON ');if(marker<0)throw Error('Unexpected trigger definition');const tail=row.definition.slice(marker+4),name=tail.split(' ')[0];if(!name.startsWith('public.'))throw Error('Trigger source was not schema qualified');const definition=row.definition.slice(0,marker+4)+q(schema)+'.'+q(row.table_name)+tail.slice(name.length);await control.query(definition);}
  pool=new pg.Pool({...settings,max:6,options:`-c search_path=${schema},public`});connection.query=(...args)=>pool.query(...args);connection.connect=()=>pool.connect();
  await pool.query('INSERT INTO payment_method_options SELECT * FROM public.payment_method_options WHERE is_system=TRUE');
  const users=[];for(const mobile of ['1111111111','2222222222'])users.push({...((await pool.query("INSERT INTO users(name,mobile,password_hash,user_type) VALUES('Race Test',$1,'test','Admin') RETURNING id",[mobile])).rows[0]),userType:'Admin'});
  const store=(await pool.query("INSERT INTO stores(code,name) VALUES('RACE','Race Store') RETURNING id")).rows[0];
  const customer=(await pool.query("INSERT INTO customers(name) VALUES('Race Customer') RETURNING id")).rows[0];
  const unit=(await pool.query("INSERT INTO units_of_measure(code,name) VALUES('BOX','Box') RETURNING id")).rows[0];
  const product=(await pool.query("INSERT INTO products(sku,name,base_unit_id) VALUES('RACE-TILE','Race Tile',$1) RETURNING id",[unit.id])).rows[0];
  await pool.query("INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by) VALUES($1,$2,'adjustment',100,'race_test',1,1,'race_opening',$3)",[store.id,product.id,users[0].id]);
  const call=async(fn,user,body={},id)=>{const res=response();await fn({user,body,params:{type:'sales',id},query:{}},res);return res;};
  const invoice=await call(createSalesDraft,users[0],{storeId:store.id,customerId:customer.id,invoiceDate:'2026-10-20',items:[{productId:product.id,unitId:unit.id,quantity:'10',unitPrice:'100'}]});assert.equal(invoice.statusCode,201,JSON.stringify(invoice.body));
  const posted=await call(finalizeSales,users[0],{},invoice.body.id);assert.equal(posted.statusCode,200,JSON.stringify(posted.body));
  const drafts=[];for(const user of users){const draft=await call(createReturn,user,{invoiceId:invoice.body.id,returnDate:'2026-10-27',reason:'Concurrent return',items:[{invoiceItemId:posted.body.items[0].id,quantity:'6',stockCondition:'SELLABLE'}]});assert.equal(draft.statusCode,201,JSON.stringify(draft.body));drafts.push(draft.body);}
  const attempts=await Promise.all(drafts.map((draft,index)=>call(finalizeReturn,users[index],{idempotencyKey:`race-finalize-${index}`},draft.id)));
  assert.deepEqual(attempts.map(row=>row.statusCode).sort(),[200,409],JSON.stringify(attempts.map(row=>row.body)));
  const quantity=(await pool.query("SELECT quantity FROM inventory_balances WHERE store_id=$1 AND product_id=$2",[store.id,product.id])).rows[0].quantity;assert.equal(quantity,'96.0000');
  assert.equal((await pool.query("SELECT count(*)::int n FROM sales_returns WHERE status='posted'")).rows[0].n,1);
  assert.equal((await pool.query('SELECT sum(amount)::numeric(18,2) amount FROM return_credit_allocations')).rows[0].amount,'600.00');
  const winner=attempts.findIndex(row=>row.statusCode===200),retry=await call(finalizeReturn,users[winner],{idempotencyKey:`race-finalize-${winner}`},drafts[winner].id);assert.equal(retry.statusCode,200);assert.equal(retry.body.duplicate,true);
  // Overlap is on the second bill of one return, so locking only its header
  // invoice would allow a double credit/restock.
  const sources=[];
  for(let i=0;i<2;i++){
   const draft=await call(createSalesDraft,users[0],{storeId:store.id,customerId:customer.id,invoiceDate:'2026-10-20',items:[{productId:product.id,unitId:unit.id,quantity:'10',unitPrice:'100'}]});assert.equal(draft.statusCode,201);
   const sale=await call(finalizeSales,users[0],{},draft.body.id);assert.equal(sale.statusCode,200);sources.push(sale.body);
  }
  const before=Number((await pool.query('SELECT quantity FROM inventory_balances WHERE store_id=$1 AND product_id=$2',[store.id,product.id])).rows[0].quantity);
  const combined=await call(createReturn,users[0],{invoiceId:sources[0].id,returnDate:'2026-10-27',reason:'Two-bill concurrent return',items:[{invoiceItemId:sources[0].items[0].id,quantity:'1',stockCondition:'SELLABLE'},{invoiceItemId:sources[1].items[0].id,quantity:'6',stockCondition:'SELLABLE'}]});assert.equal(combined.statusCode,201,JSON.stringify(combined.body));
  const overlapping=await call(createReturn,users[1],{invoiceId:sources[1].id,returnDate:'2026-10-27',reason:'Overlapping secondary bill',items:[{invoiceItemId:sources[1].items[0].id,quantity:'6',stockCondition:'SELLABLE'}]});assert.equal(overlapping.statusCode,201);
  const concurrent=await Promise.all([combined,overlapping].map((draft,index)=>call(finalizeReturn,users[index],{idempotencyKey:'multi-race-'+index},draft.body.id)));
  assert.deepEqual(concurrent.map(row=>row.statusCode).sort(),[200,409],JSON.stringify(concurrent.map(row=>row.body)));
  const postedQuantity=(await pool.query("SELECT sum(ri.quantity)::numeric(18,4) qty FROM sales_return_items ri JOIN sales_returns r ON r.id=ri.sales_return_id WHERE ri.sales_invoice_item_id=$1 AND r.status='posted'",[sources[1].items[0].id])).rows[0].qty;assert.equal(postedQuantity,'6.0000');
  const after=Number((await pool.query('SELECT quantity FROM inventory_balances WHERE store_id=$1 AND product_id=$2',[store.id,product.id])).rows[0].quantity);assert.equal(after-before,concurrent[0].statusCode===200?7:6);
 }finally{connection.query=originalQuery;connection.connect=originalConnect;if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);await control.end();await connection.end();}
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {quoteSalesInvoiceBonus,refreshInvoiceBonusPayability} from './salesBonusIntegration.js';

const line={productId:'10',unitId:'2',quantity:'10',unitPrice:'850',discountAmount:'0',costPrice:'0'};
function clientFor(userType='Salesperson'){
 return {async query(sql){
   if(sql.includes('FROM users'))return {rows:[{id:'7',name:'Referred User',user_type:userType}]};
   if(sql.includes('FROM products'))return {rows:[{name:'Tile A',category_id:'3',unit_name:'Box',default_cost_price:'650',default_bonus_percentage:'10',unit_label:'Box'}],rowCount:1};
   throw new Error(`Unexpected query: ${sql}`);
 }};
}

test('invoice bonus preview uses configured cost and rate, excludes invoice discounts from eligible sales, and applies salesperson split',async()=>{
 const quote=await quoteSalesInvoiceBonus(clientFor(),{referredByUserId:'7',items:[line],invoiceDiscount:500});
 assert.equal(quote.totals.cost,6500);
 assert.equal(quote.totals.sales,8000);
 assert.equal(quote.totals.profit,1500);
 assert.equal(quote.totals.grossBonus,150);
 assert.equal(quote.totals.userBonus,75);
 assert.equal(quote.items[0].costPrice,650);
});

test('invoice bonus preview retains full configured allocation for a Tile Mistire',async()=>{
 const quote=await quoteSalesInvoiceBonus(clientFor('Tile Mistire'),{referredByUserId:'7',items:[line]});
 assert.equal(quote.totals.grossBonus,200);
 assert.equal(quote.totals.userBonus,200);
});

test('invoice without an eligible referral has no bonus preview',async()=>{
 const quote=await quoteSalesInvoiceBonus({query:async()=>({rows:[]})},{items:[line]});
 assert.equal(quote.reason,'no_eligible_recipient');
 assert.equal(quote.totals,null);
});

test('approved invoice bonus becomes payable in proportion to posted customer collections',async()=>{
 let update;
 const client={async query(sql,values){
   if(sql.includes('SELECT id,total,status FROM sales_invoices'))return {rows:[{id:'40',total:'20000',status:'posted'}]};
   if(sql.includes('SELECT COALESCE(sum(pa.amount)'))return {rows:[{amount:'10000'}]};
   if(sql.includes('FROM sales_bonus_records br LEFT JOIN LATERAL'))return {rows:[{id:'70',status:'approved',approved_by:'1',approved_bonus:'400',total_amount_paid:'0',adjustments:'0'}]};
   if(sql.includes('UPDATE sales_bonus_records SET payable_amount')){update={values};return {rows:[]};}
   throw new Error(`Unexpected query: ${sql}`);
 }};
 await refreshInvoiceBonusPayability(client,'40');
 assert.deepEqual(update.values,[200,'partially_payable','70']);
});

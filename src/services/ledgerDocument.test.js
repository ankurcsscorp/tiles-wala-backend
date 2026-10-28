import assert from 'node:assert/strict';
import {test} from 'node:test';
import PDFDocument from 'pdfkit';
import {ledgerHtml,ledgerPdf,amount,balance,ledgerFilename} from './ledgerDocument.js';
const report={partyType:'customer',partyId:'12',party:{name:'Demo Customer',phone:'9999999999',address:'Patepur'},business:[{id:'1',name:'Demo Store',address:{line1:'Market Road'},gstin:'10JNEPD0678B1ZL'}],fromDate:'2026-01-01',toDate:'2026-10-28',openingBalance:'100.00',closingBalance:'250.00',totalDebit:'200.00',totalCredit:'50.00',summary:{invoiceAmount:'200.00',paymentAmount:'50.00'},pagination:{total:2},items:[{entry_date:'2026-02-01',entry_type:'sales_invoice',reference:'INV-1',debit:'200.00',credit:'0.00',running_balance:'300.00',due_date:'2026-03-01'},{entry_date:'2026-02-05',entry_type:'customer_receipt',reference:'RCPT-1',payment_method:'cash',debit:'0.00',credit:'50.00',running_balance:'250.00'}]};
test('statements show carried balances and movement totals without counting balance rows twice',()=>{
 const html=ledgerHtml(report);assert.match(html,/Opening Balance/);assert.match(html,/Closing Balance/);assert.match(html,/₹100 Dr/);assert.match(html,/₹250 Dr/);assert.match(html,/Period totals/);assert.match(html,/₹200/);assert.match(html,/Payment Received/);assert.match(html,/01 Mar 2026/);assert.match(html,/Currency: INR/);
});
test('party details and references are escaped and file names contain no path characters',()=>{
 const html=ledgerHtml({...report,party:{...report.party,name:'<script>alert(1)</script>'},items:[{...report.items[0],reference:'<img src=x onerror=alert(1)>'}]});assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;img/);assert.doesNotMatch(ledgerFilename({...report,party:{name:'../bad/name'}}),/[\\/]/);
});
test('large decimal amounts and opposite customer/supplier balance directions stay exact',()=>{
 assert.equal(amount('9999999999999999.99'),'₹9,99,99,99,99,99,99,999.99');assert.equal(balance('100.00','customer'),'₹100 Dr');assert.equal(balance('-100.00','customer'),'₹100 Cr');assert.equal(balance('100.00','supplier'),'₹100 Cr');assert.equal(balance('-100.00','supplier'),'₹100 Dr');assert.equal(balance('0.00','supplier'),'₹0');
});
test('empty supplier periods retain opening/closing credit and produce a valid PDF',async()=>{
 const empty={...report,partyType:'supplier',openingBalance:'-25.00',closingBalance:'-25.00',totalDebit:'0.00',totalCredit:'0.00',items:[],pagination:{total:0}};
 assert.match(ledgerHtml(empty),/No transactions in this period/);assert.match(ledgerHtml(empty),/₹25 Dr/);
 const pdf=await ledgerPdf(empty);assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.match(pdf.subarray(-80).toString(),/%%EOF/);
});
test('a long Unicode statement produces multiple numbered pages and preserves a complete document',async()=>{
 const large={...report,party:{...report.party,name:'अजय कुमार'},items:Array.from({length:125},(_,i)=>({...report.items[i%2],reference:'REFERENCE-'+i+'-LONG-SETTLEMENT-REFERENCE'})),pagination:{total:125}};
 const pdf=await ledgerPdf(large),pages=(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length;assert.ok(pages>1);assert.ok(pages<50);assert.match(pdf.subarray(-80).toString(),/%%EOF/);
});
test('a ten-transaction statement fits its notes on the same page as closing totals',async t=>{
 const calls=[],draw=PDFDocument.prototype.text;
 t.mock.method(PDFDocument.prototype,'text',function(value,...args){calls.push({value,page:this.page.dictionary.id});return draw.call(this,value,...args);});
 const ten={...report,fromDate:null,party:{...report.party,name:'Test'},business:[{...report.business[0],name:'Home Decor'}],items:Array.from({length:10},(_,i)=>({...report.items[0],reference:'SALE-2026-00001'})),pagination:{total:10}};
 const pdf=await ledgerPdf(ten);
 assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length,1,'Ten short transactions and their ending should fit on one A4 page');
 const closing=calls.find(call=>call.value==='Closing Balance'),notes=calls.find(call=>String(call.value).startsWith('Period totals exclude'));
 assert.equal(notes.page,closing.page);
});
test('overflow keeps closing balance, totals and explanations together on a genuine continuation page',async t=>{
 const draw=PDFDocument.prototype.text;
 let calls=[];
 t.mock.method(PDFDocument.prototype,'text',function(value,...args){calls.push({value,page:this.page.dictionary.id});return draw.call(this,value,...args);});
 for(const count of [11,12,13,14,22,40]){
  calls=[];
  await ledgerPdf({...report,items:Array.from({length:count},()=>({...report.items[0],reference:'SALE-2026-00001'})),pagination:{total:count}});
  const closing=calls.find(call=>call.value==='Closing Balance'),totals=calls.find(call=>call.value==='Period totals'),notes=calls.find(call=>String(call.value).startsWith('Period totals exclude'));
  assert.equal(totals.page,closing.page,`${count} transactions: closing balance and totals must share a page`);
  assert.equal(notes.page,closing.page,`${count} transactions: notes must not create a page of their own`);
 }
});

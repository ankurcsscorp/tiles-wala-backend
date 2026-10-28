import PDFDocument from 'pdfkit';
import {readFileSync} from 'node:fs';
const fontPath=new URL('../../assets/fonts/NotoSansDevanagari.ttf',import.meta.url);
const font=readFileSync(fontPath);
const labels={sales_invoice:'Sales Invoice',purchase_invoice:'Purchase Invoice',customer_receipt:'Payment Received',customer_receipt_advance:'Unallocated Receipt',supplier_payment:'Payment Made',supplier_payment_advance:'Unallocated Supplier Payment',sales_credit_note:'Sales Return',purchase_debit_note:'Purchase Return',customer_refund:'Customer Refund',supplier_refund:'Supplier Refund',opening_balance:'Opening Balance Adjustment',manual_adjustment:'Balance Adjustment',adjustment:'Balance Adjustment'};
const titleCase=value=>String(value||'').replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());
export const voucherLabel=value=>labels[value]||titleCase(value);
export const dateLabel=value=>{if(!value)return 'Beginning';const [y,m,d]=String(value).slice(0,10).split('-');return `${d} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m)-1]} ${y}`;};
export const addressText=value=>{
 if(!value)return '';if(typeof value==='string')return value;
 const a=value.billing||value.billingAddress||value;
 return [...new Set([typeof a==='string'?a:a.line1||a.street,a.line2,a.city||value.city,a.state||value.state,a.pinCode||a.pin_code||value.pin_code||value.pinCode].filter(Boolean))].join(', ');
};
export function amount(value,{currency=true}={}){
 const raw=String(value??'0'),negative=raw.startsWith('-'),[whole,decimal='']=raw.replace(/^[-+]/,'').split('.');
 const fraction=decimal.slice(0,2).replace(/0+$/,'');
 return `${negative?'-':''}${currency?'₹':''}${new Intl.NumberFormat('en-IN').format(BigInt(whole||'0'))}${fraction?`.${fraction}`:''}`;
}
export function balance(value,type){const negative=String(value).startsWith('-'),absolute=String(value).replace(/^-/,'');return `${amount(absolute)}${Number(value)===0?'':negative===(type==='supplier')?' Dr':' Cr'}`;}
function fullAddress(entity){return addressText({...(typeof entity.address==='object'?entity.address:{line1:entity.address}),city:entity.city||entity.address?.city,state:entity.state||entity.address?.state,pin_code:entity.pin_code||entity.address?.pin_code||entity.address?.pinCode});}
export function ledgerFilename(report){const slug=report.party.name.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60)||report.partyId;return `Ledger-${slug}-${report.fromDate||'beginning'}-${report.toDate}`;}
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function columns(report){
 const multiple=report.business.length>1;
 return [{label:'Date',width:49,value:r=>dateLabel(r.entry_date)},...(multiple?[{label:'Store',width:65,value:r=>r.store_name}]:[]),
  {label:'Voucher',width:75,value:r=>voucherLabel(r.entry_type)},{label:'Reference',width:73,value:r=>r.reference},
  {label:'Payment mode',width:55,value:r=>titleCase(r.payment_method)||'—'},
  {label:'Credit',width:65,numeric:true,value:r=>Number(r.credit)?amount(r.credit):'—'},
  {label:'Debit',width:65,numeric:true,value:r=>Number(r.debit)?amount(r.debit):'—'},
  {label:'Balance',width:90,numeric:true,value:r=>balance(r.running_balance,report.partyType)},
  {label:'Due date',width:62,value:r=>r.due_date?dateLabel(r.due_date):'—'}];
}
function summary(report){return [
 [report.partyType==='customer'?'Total sales in period':'Total purchases in period',amount(report.summary.invoiceAmount)],
 [report.partyType==='customer'?'Total received in period':'Total paid in period',amount(report.summary.paymentAmount)],
 ['Opening balance',balance(report.openingBalance,report.partyType)],['Closing balance',balance(report.closingBalance,report.partyType)]
];}
function balanceCells(report,value,cols){
 const isDebit=(String(value).startsWith('-'))===(report.partyType==='supplier'),zero=Number(value)===0;
 return cols.map(c=>c.label==='Balance'?balance(value,report.partyType):c.label==='Debit'&&isDebit&&!zero?amount(String(value).replace(/^-/,'')):c.label==='Credit'&&!isDebit&&!zero?amount(String(value).replace(/^-/,'')):'');
}
export function ledgerHtml(report){
 const store=report.business.length===1?report.business[0]:{name:'Tiles Wala',address:report.business.map(s=>s.name).join(' · ')},cols=columns(report);
 const band=(label,value)=>{const cells=balanceCells(report,value,cols);return `<tr class="balance-row">${cells.map((cell,i)=>`<td class="${cols[i].numeric?'num':''}">${cols[i].label==='Voucher'?esc(label):esc(cell)}</td>`).join('')}</tr>`;};
 return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(ledgerFilename(report))}</title><style>
 @font-face{font-family:Ledger;src:url(data:font/ttf;base64,${font.toString('base64')}) format('truetype');font-weight:100 900}
 @page{size:A4 portrait;margin:12mm}*{box-sizing:border-box}body{font-family:Ledger,Arial,sans-serif;color:#202b27;margin:0;font-size:11px}header{display:flex;justify-content:space-between;gap:20px;border-top:2px solid #276953;padding-top:14px}h1{font-size:21px;margin:0 0 5px}h2{font-size:15px;margin:2px 0;white-space:nowrap}p{margin:4px 0}.brand{max-width:68%}.party-summary{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin:24px 0}.summary{border:1px solid #bfcfc7;padding:10px}.summary p{display:flex;justify-content:space-between;gap:15px}.muted{color:#65766e}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:9px}th,td{border:1px solid #d0dad5;padding:7px 5px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#edf4f0;font-weight:700}.num{text-align:right}.balance-row{background:#f2f6f3;font-weight:700}.total-row{font-weight:700}tr{break-inside:avoid}thead{display:table-header-group}footer{margin-top:18px;font-size:9px;color:#586a61}.scope{margin-top:12px}@media screen{body{max-width:1020px;margin:24px auto;padding:20px}}@media print{body{padding:0}header,.party-summary{break-inside:avoid}}
 </style></head><body><header><div class="brand"><h1>${esc(store.name)}</h1><p>${esc(fullAddress(store))}</p><p>${esc([store.phone&&'Phone: '+store.phone,store.email,store.gstin&&'GSTIN: '+store.gstin].filter(Boolean).join(' · '))}</p></div><h2>Party Ledger Report</h2></header>
 <section class="party-summary"><div><p class="muted">To · ${report.partyType==='customer'?'Customer':'Supplier'}</p><h2>${esc(report.party.name)}</h2><p>${esc(fullAddress(report.party))}</p><p>${esc(report.party.phone?'Phone: '+report.party.phone:'')}</p><p>${esc(report.party.tax_id?'GSTIN / Tax ID: '+report.party.tax_id:'')}</p></div>
 <div class="summary"><p><strong>Period</strong><span>${esc(dateLabel(report.fromDate))} – ${esc(dateLabel(report.toDate))}</span></p>${summary(report).map(([label,value])=>`<p><span>${esc(label)}</span><strong>${esc(value)}</strong></p>`).join('')}</div></section>
 <table><colgroup>${cols.map(c=>`<col style="width:${c.width/cols.reduce((n,c)=>n+c.width,0)*100}%">`).join('')}</colgroup><thead><tr>${cols.map(c=>`<th class="${c.numeric?'num':''}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>
 ${band('Opening Balance',report.openingBalance)}${report.items.map(row=>`<tr>${cols.map(c=>`<td class="${c.numeric?'num':''}">${esc(c.value(row))}</td>`).join('')}</tr>`).join('')}${!report.items.length?`<tr><td colspan="${cols.length}">No transactions in this period.</td></tr>`:''}${band('Closing Balance',report.closingBalance)}
 <tr class="total-row">${cols.map((c,i)=>`<td class="${c.numeric?'num':''}">${c.label==='Voucher'?'Period totals':c.label==='Credit'?esc(amount(report.totalCredit)):c.label==='Debit'?esc(amount(report.totalDebit)):''}</td>`).join('')}</tr></tbody></table>
 <footer><p>Opening balance includes posted entries before the period. Period totals exclude the opening and closing balance rows.</p><p>${report.partyType==='customer'?'Dr: customer owes us · Cr: customer credit / advance':'Cr: payable to supplier · Dr: supplier owes us'}. Transactions: ${report.pagination.total}. Currency: INR.</p><p class="scope">Store scope: ${esc(report.business.map(store=>store.name).join(' · ')||'No authorized stores')}</p><p>Generated by Tiles Wala</p></footer></body></html>`;
}

export function ledgerPdf(report){return new Promise((resolve,reject)=>{
 const doc=new PDFDocument({size:'A4',margins:{top:34,left:34,right:34,bottom:48},bufferPages:true,info:{Title:ledgerFilename(report),Author:'Tiles Wala',Subject:'Party ledger with opening and closing balances'}}),chunks=[];
 doc.on('data',chunk=>chunks.push(chunk));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
 try{
  doc.registerFont('Ledger',font).font('Ledger');
  const left=34,width=doc.page.width-68,cols=columns(report),scale=width/cols.reduce((sum,col)=>sum+col.width,0);
  cols.forEach(col=>col.actualWidth=col.width*scale);
  let y=34;
  const text=(value,x,top,w,size=9)=>{doc.fontSize(size).fillColor('#263b30').text(String(value||''),x,top,{width:w,lineGap:2});};
  const header=(continued=false)=>{
   const store=report.business.length===1?report.business[0]:{name:'Tiles Wala',address:report.business.map(s=>s.name).join(' · ')};
   doc.moveTo(left,34).lineTo(left+width,34).strokeColor('#276953').lineWidth(1.5).stroke();
   y=45;text(store.name,left,y,width-160,continued?12:18);const nameBottom=doc.y;text('Party Ledger Report',left+width-145,y,145,12);y=Math.max(nameBottom,doc.y)+4;
   if(continued){text(report.party.name+' · '+dateLabel(report.fromDate)+' – '+dateLabel(report.toDate)+' (continued)',left,y,width,9);y=doc.y+12;return;}
   text(fullAddress(store),left,y,width,9);y=doc.y+4;
   text([store.phone&&'Phone: '+store.phone,store.email,store.gstin&&'GSTIN: '+store.gstin].filter(Boolean).join(' · '),left,y,width,9);y=doc.y+16;
   const summaryY=y;
   text('To · '+(report.partyType==='customer'?'Customer':'Supplier'),left,y,240,9);y=doc.y+2;text(report.party.name,left,y,240,12);y=doc.y+3;
   const partyAddress=fullAddress(report.party);text(partyAddress,left,y,240,9);y=doc.y+4;
   text([report.party.phone&&'Phone: '+report.party.phone,report.party.tax_id&&'GSTIN / Tax ID: '+report.party.tax_id].filter(Boolean).join('\n'),left,y,240,9);const partyBottom=doc.y;
   let sy=summaryY;const x=left+width-260;
   for(const [label,value] of [['Period',dateLabel(report.fromDate)+' – '+dateLabel(report.toDate)],...summary(report)]){text(label,x,sy,125,8);text(value,x+128,sy,132,8);sy=Math.max(doc.y,sy+13)+5;}
   y=Math.max(partyBottom,sy)+18;
  };
  const tableHeader=()=>{let x=left;const height=32;for(const col of cols){doc.rect(x,y,col.actualWidth,height).fillAndStroke('#edf4f0','#d0dad5');text(col.label,x+4,y+6,col.actualWidth-8,8);x+=col.actualWidth;}y+=height;};
  const newPage=()=>{doc.addPage();header(true);tableHeader();};
  const rowHeight=cells=>{
   doc.fontSize(8);
   return Math.max(28,...cells.map((cell,index)=>doc.heightOfString(String(cell||''),{width:cols[index].actualWidth-8,lineGap:2})+12));
  };
  const row=(cells,{band=false}={})=>{
   const height=rowHeight(cells);
   if(y+height>doc.page.height-66)newPage();let x=left;
   cells.forEach((cell,index)=>{const col=cols[index];doc.rect(x,y,col.actualWidth,height).fillAndStroke(band?'#f2f6f3':'#ffffff','#d0dad5');doc.fontSize(8).fillColor('#263b30').text(String(cell||''),x+4,y+6,{width:col.actualWidth-8,lineGap:2,align:col.numeric?'right':'left'});x+=col.actualWidth;});y+=height;
  };
  const band=(label,value)=>{const cells=balanceCells(report,value,cols);cells[cols.findIndex(col=>col.label==='Voucher')]=label;row(cells,{band:true});};
  header();tableHeader();band('Opening Balance',report.openingBalance);
  for(const item of report.items)row(cols.map(col=>col.value(item)));
  if(!report.items.length){const cells=cols.map(()=> '');cells[cols.findIndex(col=>col.label==='Voucher')]='No transactions in this period';row(cells);}
  const closing=balanceCells(report,report.closingBalance,cols);
  closing[cols.findIndex(col=>col.label==='Voucher')]='Closing Balance';
  const totals=cols.map(c=>c.label==='Voucher'?'Period totals':c.label==='Debit'?amount(report.totalDebit):c.label==='Credit'?amount(report.totalCredit):'');
  const notes=[
   'Period totals exclude opening and closing balance rows. '+(report.partyType==='customer'?'Dr: customer owes us · Cr: customer credit / advance.':'Cr: payable to supplier · Dr: supplier owes us.'),
   'Store scope: '+(report.business.map(store=>store.name).join(' · ')||'No authorized stores')+' · Transactions: '+report.pagination.total
  ];
  // Reserve the actual ending height before drawing either financial summary
  // row. Notes must never force an otherwise empty continuation page.
  const financialHeight=rowHeight(closing)+rowHeight(totals);
  doc.fontSize(8);
  const notesHeight=14+notes.reduce((height,note)=>height+doc.heightOfString(note,{width,lineGap:2}),0)+4;
  if(y+financialHeight+notesHeight>doc.page.height-66)newPage();
  row(closing,{band:true});row(totals,{band:true});
  y+=14;text(notes[0],left,y,width,8);
  y=doc.y+4;text(notes[1],left,y,width,8);
  const pages=doc.bufferedPageRange();
  for(let i=pages.start;i<pages.start+pages.count;i++){doc.switchToPage(i);const bottom=doc.page.margins.bottom;doc.page.margins.bottom=0;doc.fontSize(8).fillColor('#68786e').text(`Tiles Wala · INR · Page ${i+1} of ${pages.count}`,left,doc.page.height-30,{width,align:'right',lineBreak:false});doc.page.margins.bottom=bottom;}
  doc.end();
 }catch(error){reject(error);doc.destroy();}
});}

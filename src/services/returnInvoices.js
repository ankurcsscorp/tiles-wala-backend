import {createHash,randomUUID} from 'node:crypto';
import {canAccessStore,canManageStore} from '../controllers/stores.js';
import {hasPermission} from './permissions.js';
export const fail=(message,status=422)=>{throw Object.assign(new Error(message),{status});};
export const idOk=x=>/^\d+$/.test(String(x??''));
const decimal=(v,scale=4)=>new RegExp(`^\\d{1,14}(\\.\\d{1,${scale}})?$`).test(String(v??''));
export const validDate=v=>/^\d{4}-\d{2}-\d{2}$/.test(String(v))&&!Number.isNaN(new Date(`${v}T00:00:00Z`).valueOf())&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v;
export const fingerprint=body=>{const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;return createHash('sha256').update(JSON.stringify(sorted(body))).digest('hex');};
export const spec=kind=>{
 if(!['sales','purchase'].includes(kind))fail('Return type must be sales or purchase',400);
 const sales=kind==='sales';return {kind,sales,returns:sales?'sales_returns':'purchase_returns',items:sales?'sales_return_items':'purchase_return_items',invoice:sales?'sales_invoices':'purchase_invoices',invoiceItems:sales?'sales_invoice_items':'purchase_invoice_items',invoiceKey:sales?'sales_invoice_id':'purchase_invoice_id',itemKey:sales?'sales_invoice_item_id':'purchase_invoice_item_id',returnKey:sales?'sales_return_id':'purchase_return_id',partyKey:sales?'customer_id':'supplier_id',party:sales?'customers':'suppliers',credits:sales?'sales_invoice_return_credits':'purchase_invoice_return_credits',accounting:sales?'sales_return_accounting':'purchase_return_accounting',direction:sales?'in':'out'};
};
export async function authorize(db,user,storeId,manage=false){
 if(!await canAccessStore(user,storeId))fail('You do not have access to this store',403);
 if(manage&&!await canManageStore(user,storeId,['owner','manager'],db))fail('Store owner or manager authorization is required',403);
}
export async function permissions(db,user,storeId){const manager=await canManageStore(user,storeId,['owner','manager'],db);return {canEdit:hasPermission(user,'returns.manage'),canFinalize:hasPermission(user,'returns.manage')&&manager,canOverrideRate:manager,canRefund:manager&&hasPermission(user,'payments.manage'),canInspect:manager&&hasPermission(user,'inventory.manage'),allowUnlinked:false};}
export async function sourceInvoice(db,s,invoiceId){
 if(!idOk(invoiceId))fail('Store policy requires a posted original invoice. Unlinked returns are not authorized.',422);
 const r=await db.query(`SELECT i.*,i.invoice_date::text AS invoice_date,s.code AS store_code,p.name AS party_name,p.phone AS party_phone,p.tax_id AS party_tax_id,p.address AS party_address,p.is_active AS party_active
 FROM ${s.invoice} i JOIN stores s ON s.id=i.store_id LEFT JOIN ${s.party} p ON p.id=i.${s.partyKey} WHERE i.id=$1`,[invoiceId]);
 if(!r.rowCount)fail('Original invoice not found',404);if(r.rows[0].status!=='posted')fail('Returns require a posted original invoice');return r.rows[0];
}
// Item references, rather than a client-supplied invoice list, establish sources.
// The header retains an anchor invoice for existing party/accounting projections.
export async function returnSources(db,s,body,user,{lock=false}={}){
 if(!idOk(body.invoiceId))fail('Select an original posted invoice for the return');
 const ids=new Set([String(body.invoiceId)]);
 if(s.sales&&Array.isArray(body.items)){
  const itemIds=body.items.map(line=>line.invoiceItemId);
  if(itemIds.length>100||itemIds.some(id=>!idOk(id)))fail('Choose up to 100 original invoice products');
  const rows=await db.query('SELECT DISTINCT sales_invoice_id FROM sales_invoice_items WHERE id=ANY($1::bigint[])',[itemIds]);
  for(const row of rows.rows)ids.add(String(row.sales_invoice_id));
 }
 const ordered=[...ids].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
 if(lock)await db.query(`SELECT id FROM ${s.invoice} WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`,[ordered]);
 const anchor=await sourceInvoice(db,s,body.invoiceId);await authorize(db,user,anchor.store_id);
 const invoices=[anchor];
 for(const id of ordered){
  if(id===String(anchor.id))continue;
  const inv=await sourceInvoice(db,s,id);await authorize(db,user,inv.store_id);
  if(String(inv.store_id)!==String(anchor.store_id)||!anchor[s.partyKey]||String(inv[s.partyKey])!==String(anchor[s.partyKey]))fail('All return items must belong to the same customer and store');
  invoices.push(inv);
 }
 return invoices;
}
export async function sourceItems(db,s,invoiceId,excludeReturnId=null){
 const r=await db.query(`SELECT i.*,i.product_sku_snapshot AS sku,i.product_name_snapshot AS product_name,i.unit_name_snapshot AS unit_name,u.decimal_places,
 COALESCE(b.quantity,0)::numeric(18,4) AS store_stock,(SELECT COALESCE(sum(quantity_delta),0)::numeric(18,4) FROM return_inventory_movements m WHERE m.store_id=inv.store_id AND m.product_id=i.product_id AND bucket='DAMAGED') AS damaged_stock,p.is_active AS product_active,
 COALESCE(pr.qty,0)::numeric(18,4) AS previously_returned_quantity,
 GREATEST(${s.sales?'i.quantity':"LEAST(i.quantity,COALESCE(received.qty,0))"}-COALESCE(pr.qty,0),0)::numeric(18,4) AS remaining_quantity,
 COALESCE(pr.total,0)::numeric(18,2) AS previously_returned_amount,
 COALESCE(pr.taxable,0)::numeric(18,2) AS previously_returned_taxable,
 COALESCE(pr.tax,0)::numeric(18,2) AS previously_returned_tax
 FROM ${s.invoiceItems} i JOIN ${s.invoice} inv ON inv.id=i.${s.invoiceKey} JOIN products p ON p.id=i.product_id JOIN units_of_measure u ON u.id=i.unit_id
 LEFT JOIN inventory_balances b ON b.store_id=inv.store_id AND b.product_id=i.product_id
 LEFT JOIN LATERAL(SELECT sum(x.quantity) qty,sum(x.line_total) total,sum(COALESCE(x.taxable_adjustment,x.line_total-x.tax_adjustment)) taxable,sum(x.tax_adjustment) tax
 FROM ${s.items} x JOIN ${s.returns} r ON r.id=x.${s.returnKey} WHERE x.${s.itemKey}=i.id AND r.status='posted' AND r.id<>COALESCE($2::bigint,0)) pr ON TRUE
 ${s.sales?'':`LEFT JOIN LATERAL(SELECT sum(x.quantity_received) FILTER(WHERE r.status='posted') qty FROM purchase_receipt_items x JOIN purchase_receipts r ON r.id=x.receipt_id WHERE x.purchase_invoice_item_id=i.id) received ON TRUE`}
 WHERE i.${s.invoiceKey}=$1 ORDER BY i.line_number,i.id`,[invoiceId,excludeReturnId]);return r.rows;
}
export async function invoiceBalances(db,s,storeId,partyId,lock=false){
 if(!partyId)return [];
 if(lock)await db.query(`SELECT id FROM ${s.invoice} WHERE store_id=$1 AND ${s.partyKey}=$2 AND status='posted' ORDER BY id FOR UPDATE`,[storeId,partyId]);
 return (await db.query(`SELECT i.id,i.invoice_number,i.invoice_date,GREATEST(i.total-
 COALESCE((SELECT sum(a.amount) FROM payment_allocations a JOIN payments p ON p.id=a.payment_id WHERE a.${s.invoiceKey}=i.id AND p.status='posted'),0)-
 COALESCE((SELECT sum(c.total) FROM ${s.credits} c WHERE c.${s.invoiceKey}=i.id AND c.status='posted'),0),0)::numeric(18,2) AS due
 FROM ${s.invoice} i WHERE i.store_id=$1 AND i.${s.partyKey}=$2 AND i.status='posted' ORDER BY i.invoice_date,i.id`,[storeId,partyId])).rows;
}
export async function partyBalance(db,s,storeId,partyId){
 if(!partyId)return '0.00';
 return (await db.query(`SELECT (COALESCE((SELECT sum(total) FROM ${s.invoice} WHERE store_id=$1 AND ${s.partyKey}=$2 AND status='posted'),0)
 -COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.store_id=$1 AND p.${s.partyKey}=$2 AND p.status='posted' AND p.direction=$3),0)
 -COALESCE((SELECT sum(a.amount) FROM payment_allocations a JOIN payments p ON p.id=a.payment_id JOIN ${s.invoice} i ON i.id=a.${s.invoiceKey} WHERE p.store_id=$1 AND a.store_id=$1 AND p.${s.partyKey} IS NULL AND i.${s.partyKey}=$2 AND i.status='posted' AND p.direction=$3 AND p.status='posted'),0)
 -COALESCE((SELECT sum(r.${s.sales?'customer_credit':'supplier_credit'}) FROM ${s.accounting} r JOIN ${s.invoice} i ON i.id=r.${s.invoiceKey} WHERE r.store_id=$1 AND i.${s.partyKey}=$2 AND r.status='posted'),0)
 +COALESCE((SELECT sum(CASE WHEN direction=$4 THEN amount ELSE -amount END) FROM ${s.sales?'customer_balance_adjustments':'supplier_balance_adjustments'} WHERE store_id=$1 AND ${s.partyKey}=$2 AND status='posted'),0))::numeric(18,2) AS amount`,[storeId,partyId,s.direction,s.sales?'debit':'credit'])).rows[0].amount;
}
export async function calculate(db,s,b,user,{excludeReturnId=null}={}){
 const invoices=await returnSources(db,s,b,user),inv=invoices[0];
 if(b.storeId&&String(b.storeId)!==String(inv.store_id))fail('Return store must match the original invoice');
 if(b.partyId&&String(b.partyId)!==String(inv[s.partyKey]))fail('The original invoice belongs to another party');
 const date=b.returnDate||new Date().toISOString().slice(0,10);if(!validDate(date)||invoices.some(source=>date<source.invoice_date))fail('Return date must be valid and cannot precede any original invoice',400);
 if(!Array.isArray(b.items)||!b.items.length||b.items.length>100)fail('Add between 1 and 100 original invoice products',400);
 const reason=String(b.reason||'').trim(),notes=String(b.notes||'').trim();if(reason.length>1000||notes.length>4000)fail('Return reason or remarks are too long',400);
 const source=[],seen=new Set(),lines=[];
 for(const original of invoices)for(const item of await sourceItems(db,s,original.id,excludeReturnId))source.push({...item,original_invoice:original});
 const access=await permissions(db,user,inv.store_id);
 for(const [index,line] of b.items.entries()){
  const src=source.find(x=>String(x.id)===String(line.invoiceItemId));if(!src||seen.has(String(src.id)))fail(`Line ${index+1}: choose a distinct product from the original invoice`);seen.add(String(src.id));
  if(line.invoiceId&&String(line.invoiceId)!==String(src.original_invoice.id))fail(`Line ${index+1}: the product does not belong to the selected original invoice`);
  if(!decimal(line.quantity)||Number(line.quantity)<=0)fail(`Line ${index+1}: enter a positive return quantity`);
  const precision=Math.min(4,src.decimal_places);if((String(line.quantity).split('.')[1]||'').replace(/0+$/,'').length>precision)fail(`Line ${index+1}: ${src.unit_name} permits ${precision} decimal places`);
  if(!(await db.query('SELECT $1::numeric<=$2::numeric AS ok',[line.quantity,src.remaining_quantity])).rows[0].ok)fail(`Line ${index+1}: quantity exceeds the remaining eligible quantity (${src.remaining_quantity} ${src.unit_name})`);
  const rate=String(line.returnRate??(s.sales?line.unitPrice:line.unitCost)??src.unit_price),rateReason=String(line.rateChangeReason||'').trim();
  if(!decimal(rate)||rateReason.length>1000)fail(`Line ${index+1}: invalid return rate or rate-change reason`);
  const price=await db.query('SELECT $1::numeric=$2::numeric AS same,$1::numeric<=$2::numeric AS within',[rate,src.unit_price]);
  if(!price.rows[0].same&&(!access.canOverrideRate||!rateReason))fail(`Line ${index+1}: a manager and a rate-change reason are required for a different return rate`,403);
  if(!price.rows[0].within)fail(`Line ${index+1}: return rate cannot exceed the original invoice rate`);
  const calculated=(await db.query(`SELECT round($1::numeric*$2::numeric/$3::numeric*CASE WHEN $4::numeric=0 THEN 1 ELSE $5::numeric/$4::numeric END,2)::numeric(18,2) AS taxable,
   round($6::numeric*$2::numeric/$3::numeric*CASE WHEN $4::numeric=0 THEN 1 ELSE $5::numeric/$4::numeric END,2)::numeric(18,2) AS tax,
   round($7::numeric*$2::numeric/$3::numeric*CASE WHEN $4::numeric=0 THEN 1 ELSE $5::numeric/$4::numeric END,2)::numeric(18,2) AS cgst,
   round($8::numeric*$2::numeric/$3::numeric*CASE WHEN $4::numeric=0 THEN 1 ELSE $5::numeric/$4::numeric END,2)::numeric(18,2) AS igst`,[src.taxable_value,line.quantity,src.quantity,src.unit_price,rate,src.tax_amount,src.cgst_amount||'0',src.igst_amount||'0'])).rows[0];
  // Last original-rate return absorbs the remaining paise, but never recovers an authorized lower-rate concession.
  const priorOverrides=await db.query(`SELECT EXISTS(SELECT 1 FROM ${s.items} x JOIN ${s.returns} r ON r.id=x.${s.returnKey} WHERE x.${s.itemKey}=$1 AND r.status='posted' AND x.rate_change_reason IS NOT NULL) yes`,[src.id]);
  const finalPart=(await db.query('SELECT $1::numeric=$2::numeric AS yes',[line.quantity,src.remaining_quantity])).rows[0].yes;
  if(finalPart&&price.rows[0].same&&!priorOverrides.rows[0].yes){
   const remainder=(await db.query('SELECT ($1::numeric-$2::numeric)::numeric(18,2) AS taxable,($3::numeric-$4::numeric)::numeric(18,2) AS tax',[src.taxable_value,src.previously_returned_taxable,src.tax_amount,src.previously_returned_tax])).rows[0];Object.assign(calculated,remainder);
  }
  const taxKnown=Number(src.cgst_amount||0)+Number(src.sgst_amount||0)+Number(src.igst_amount||0)>0||Number(src.tax_amount)===0;
  if(taxKnown&&Number(src.tax_amount)>0){
   const previous=(await db.query(`SELECT COALESCE(sum(cgst_adjustment),0) c,COALESCE(sum(sgst_adjustment),0) s,COALESCE(sum(igst_adjustment),0) i FROM ${s.items} x JOIN ${s.returns} r ON r.id=x.${s.returnKey} WHERE x.${s.itemKey}=$1 AND r.status='posted'`,[src.id])).rows[0];
   const budgets=(await db.query('SELECT GREATEST($1::numeric-$2::numeric,0)::numeric(18,2) c,GREATEST($3::numeric-$4::numeric,0)::numeric(18,2) s,GREATEST($5::numeric-$6::numeric,0)::numeric(18,2) i',[src.cgst_amount||0,previous.c,src.sgst_amount||0,previous.s,src.igst_amount||0,previous.i])).rows[0];
   const parts=(await db.query(`WITH budget AS (SELECT $1::numeric c,$2::numeric s,$3::numeric i,$4::numeric tax),preferred AS (
    SELECT *,LEAST(c,$5::numeric,tax) pc FROM budget),first AS (SELECT *,LEAST(i,$6::numeric,tax-pc) pi FROM preferred),second AS (
    SELECT *,LEAST(s,tax-pc-pi) ps FROM first),remaining AS (SELECT *,tax-pc-pi-ps missing FROM second)
    SELECT (pc+LEAST(missing,c-pc))::numeric(18,2) cgst,(pi+GREATEST(missing-(c-pc),0))::numeric(18,2) igst FROM remaining`,[budgets.c,budgets.s,budgets.i,calculated.tax,finalPart&&price.rows[0].same&&!priorOverrides.rows[0].yes?budgets.c:calculated.cgst,finalPart&&price.rows[0].same&&!priorOverrides.rows[0].yes?budgets.i:calculated.igst])).rows[0];Object.assign(calculated,parts);
  }
  const sum=(await db.query('SELECT ($1::numeric+$2::numeric)::numeric(18,2) AS total,GREATEST($2::numeric-$3::numeric-$4::numeric,0)::numeric(18,2) AS sgst',[calculated.taxable,calculated.tax,calculated.cgst,calculated.igst])).rows[0];
  if(!(await db.query('SELECT $1::numeric+$2::numeric<=$3::numeric AND $4::numeric+$5::numeric<=$6::numeric AS ok',[sum.total,src.previously_returned_amount,src.line_total,calculated.tax,src.previously_returned_tax,src.tax_amount])).rows[0].ok)fail(`Line ${index+1}: return exceeds the original remaining eligible value; refresh the invoice`);
  let condition=line.productCondition||'resalable',disposition=line.disposition||'restock';
  if(line.stockCondition){condition=line.stockCondition==='DAMAGED'?'damaged':'resalable';disposition=line.stockCondition==='SELLABLE'?'restock':line.stockCondition==='DAMAGED'?'damaged':'supplier_return_pending';}
  const restock=String(line.restockQuantity??(disposition==='restock'?line.quantity:0)),quarantine=String(line.quarantinedQuantity??(['damaged','quarantined'].includes(disposition)?line.quantity:0)),pending=String(line.supplierReturnPendingQuantity??(disposition==='supplier_return_pending'?line.quantity:0));
  if(s.sales&&(!['resalable','damaged','unsuitable'].includes(condition)||![restock,quarantine,pending].every(v=>decimal(v))||!(await db.query('SELECT $1::numeric+$2::numeric+$3::numeric=$4::numeric AND ($5 OR $1::numeric=0) AS ok',[restock,quarantine,pending,line.quantity,condition==='resalable'])).rows[0].ok))fail(`Line ${index+1}: sellable, damaged and pending quantities/condition must match the return quantity`);
  if(s.sales&&Number(restock)>0&&line.physicallyReceived===false)fail('Only physically received and accepted goods may increase sellable inventory');
  const bucket=line.stockBucket||'SELLABLE';if(!['SELLABLE','DAMAGED'].includes(bucket))fail('Choose a valid purchase return stock bucket');
  const factor=src.conversion_factor_to_base??(await db.query('SELECT product_quantity_in_base($1,$2,1) AS value',[src.product_id,src.unit_id])).rows[0].value;
  lines.push({source:src,quantity:String(line.quantity),rate,rateReason:price.rows[0].same?null:rateReason,reason:String(line.reason||reason).trim(),condition,restock,quarantine,pending,bucket,factor,...calculated,sgst:taxKnown?sum.sgst:'0.00',total:sum.total,snapshot:{invoice:documentSnapshot(src.original_invoice,s).invoice,productName:src.product_name,sku:src.sku,unitId:src.unit_id,unitName:src.unit_name,product:src.product_snapshot,originalQuantity:src.quantity,originalRate:src.unit_price,originalTaxRate:src.tax_rate,taxBreakupKnown:taxKnown,unitDecimalPlaces:src.decimal_places}});
  if(!lines.at(-1).reason||lines.at(-1).reason.length>1000)fail(`Line ${index+1}: a return reason is required`);
 }
 if(!s.sales){
  const requested=(await db.query('SELECT x.product_id,x.bucket,sum(round(x.quantity*x.factor,4)) quantity FROM jsonb_to_recordset($1::jsonb) AS x(product_id bigint,bucket text,quantity numeric,factor numeric) GROUP BY x.product_id,x.bucket',[JSON.stringify(lines.map(line=>({product_id:line.source.product_id,bucket:line.bucket,quantity:line.quantity,factor:line.factor})))])).rows;
  for(const group of requested){const available=group.bucket==='SELLABLE'?(await db.query('SELECT COALESCE((SELECT quantity FROM inventory_balances WHERE store_id=$1 AND product_id=$2),0) quantity',[inv.store_id,group.product_id])).rows[0].quantity:(await db.query("SELECT COALESCE(sum(quantity_delta),0) quantity FROM return_inventory_movements WHERE store_id=$1 AND product_id=$2 AND bucket='DAMAGED'",[inv.store_id,group.product_id])).rows[0].quantity;
   if(!(await db.query('SELECT $1::numeric<=$2::numeric AS ok',[group.quantity,available])).rows[0].ok)fail('Insufficient '+group.bucket.toLowerCase()+' stock for the purchase return');
  }
 }
 const amounts=(await db.query('SELECT sum(x.total)::numeric(18,2) total,sum(x.tax)::numeric(18,2) tax,sum(x.taxable)::numeric(18,2) subtotal,sum(x.quantity)::numeric(18,4) quantity FROM jsonb_to_recordset($1::jsonb) AS x(total numeric,tax numeric,taxable numeric,quantity numeric)',[JSON.stringify(lines)])).rows[0];
 const mode=b.settlementMode||(Number(b.refundAmount||0)>0?'REFUND':'ADJUST');if(!['ADJUST','CREDIT','REFUND'].includes(mode))fail('Choose an appropriate return settlement');
 const refund=String(b.refundAmount??'0');if(!decimal(refund,2)||!(await db.query('SELECT $1::numeric<=$2::numeric AND ($3 OR $1::numeric=0) AS ok',[refund,amounts.total,mode==='REFUND'])).rows[0].ok)fail('Refund must be within the return value and requires Refund settlement');
 if(Number(refund)>0&&!access.canRefund)fail('Store manager and payment-management permission are required to record a refund',403);
 if(Number(refund)>0&&(!b.refundMethod||!(await db.query('SELECT 1 FROM payment_method_options WHERE code=$1 AND is_active=TRUE',[b.refundMethod])).rowCount))fail('Select an active refund payment method');
 const refundDate=Number(refund)>0?(b.refundDate||date):date;if(!validDate(refundDate)||refundDate<date)fail('Refund date must be on or after the return date');
 if(b.supplierCreditNoteDate&&!validDate(b.supplierCreditNoteDate))fail('Supplier credit note date must be valid');
 if(b.supplierCreditNoteReference&&!b.supplierCreditNoteDate)fail('Enter the date shown on the supplier credit note');
 const outstanding=await partyBalance(db,s,inv.store_id,inv[s.partyKey]);
 const settlement=(await db.query('SELECT LEAST($1::numeric, GREATEST($2::numeric,0))::numeric(18,2) AS adjusted,($1::numeric-$3::numeric)::numeric(18,2) AS net',[amounts.total,outstanding,refund])).rows[0];
 const adjusted=mode==='CREDIT'?'0.00':settlement.adjusted;
 if(!(await db.query('SELECT $1::numeric+$2::numeric<=$3::numeric AS ok',[adjusted,refund,amounts.total])).rows[0].ok)fail('Refund exceeds the credit available after adjusting outstanding invoices');
 const credit=(await db.query('SELECT ($1::numeric-$2::numeric)::numeric(18,2) AS value',[settlement.net,adjusted])).rows[0].value;
 return {inv,invoices,lines,date,reason,notes,amounts,mode,refund,refundMethod:Number(refund)>0?b.refundMethod:null,refundReference:String(b.refundReference||'').slice(0,120),refundDate,outstanding,adjusted,credit,netCredit:settlement.net,access,supplierNote:String(b.supplierCreditNoteReference||'').slice(0,120),supplierNoteDate:b.supplierCreditNoteDate||null};
}
export async function distributeCredit(db,s,row,amount,user){
 const balances=await invoiceBalances(db,s,row.store_id,row.party_id,true);let remaining=amount;const allocations=[];
 for(const inv of balances){const values=(await db.query('SELECT LEAST($1::numeric,$2::numeric)::numeric(18,2) amount,GREATEST($1::numeric-$2::numeric,0)::numeric(18,2) remaining',[remaining,inv.due])).rows[0];if(Number(values.amount)>0){await db.query(`INSERT INTO return_credit_allocations(store_id,${s.returnKey},${s.invoiceKey},amount,created_by) VALUES($1,$2,$3,$4,$5)`,[row.store_id,row.id,inv.id,values.amount,user.id]);allocations.push({invoiceId:inv.id,amount:values.amount});}remaining=values.remaining;if(Number(remaining)===0)break;}
 return allocations;
}
export async function nextNumber(db,storeId,kind,series,date){const period=String(date).slice(0,4);await db.query('INSERT INTO invoice_number_sequences(store_id,document_type,series,period_key,next_number) VALUES($1,$2,$3,$4,1) ON CONFLICT DO NOTHING',[storeId,kind,series,period]);const r=await db.query('UPDATE invoice_number_sequences SET next_number=next_number+1 WHERE store_id=$1 AND document_type=$2 AND series=$3 AND period_key=$4 RETURNING next_number-1 AS number',[storeId,kind,series,period]);return `${series}-${period}-${String(r.rows[0].number).padStart(5,'0')}`;}
export function documentSnapshot(inv,s){return {store:{name:inv.store_name_snapshot,address:inv.store_address_snapshot,phone:inv.store_phone_snapshot,email:inv.store_email_snapshot,gstin:inv.store_tax_id_snapshot,logo:inv.store_logo_snapshot},party:s.sales?{name:inv.customer_name_snapshot||inv.party_name,phone:inv.customer_mobile_snapshot||inv.party_phone,address:inv.customer_address_snapshot,gstin:inv.customer_tax_id_snapshot}:{...inv.supplier_details_snapshot,name:inv.supplier_details_snapshot?.name||inv.party_name},invoice:{id:inv.id,number:inv.invoice_number,date:inv.invoice_date,documentType:s.sales?inv.document_type:inv.supplier_document_type,invoiceType:inv.invoice_type,layout:inv.invoice_layout,total:inv.total},issuer:s.sales?'STORE':'INTERNAL_PURCHASE_RETURN'};}
export async function writeDraft(db,s,data,user,id=null,key=null,hash=null){
 let rowId=id;
 if(!rowId){const series=`${s.sales?'SR':'PR'}${data.inv.store_code}`.slice(0,32);const number=await nextNumber(db,data.inv.store_id,`${s.kind}_return`,series,data.date);rowId=(await db.query(`INSERT INTO ${s.returns}(store_id,${s.invoiceKey},series,return_number,return_date,created_by,workflow_version,idempotency_key,request_fingerprint) VALUES($1,$2,$3,$4,$5,$6,2,$7,$8) RETURNING id`,[data.inv.store_id,data.inv.id,series,number,data.date,user.id,key,hash])).rows[0].id;}
 await db.query(`DELETE FROM ${s.items} WHERE ${s.returnKey}=$1`,[rowId]);
 for(const line of data.lines){
  const columns=s.sales?',product_condition,restock_quantity,quarantined_quantity,supplier_return_pending_quantity':',stock_bucket';
  const extra=s.sales?[line.condition,line.restock,line.quarantine,line.pending]:[line.bucket];
  const values=[rowId,line.source.id,line.source.product_id,line.quantity,line.rate,line.total,line.reason,line.source.tax_rate,line.tax,line.taxable,line.cgst,line.sgst,line.igst,line.snapshot,line.factor,line.rateReason,...extra];
  await db.query(`INSERT INTO ${s.items}(${s.returnKey},${s.itemKey},product_id,quantity,${s.sales?'unit_price':'unit_cost'},line_total,reason,tax_rate,tax_adjustment,taxable_adjustment,cgst_adjustment,sgst_adjustment,igst_adjustment,return_snapshot,conversion_factor_to_base,rate_change_reason${columns}) VALUES(${values.map((_,index)=>'$'+(index+1)).join(',')})`,values);
 }
 const values=[rowId,data.date,data.reason,data.notes,data.amounts.total,data.amounts.tax,data.refund,data.netCredit,data.refundMethod,data.refundReference,data.refundDate,data.mode,{...documentSnapshot(data.inv,s),...(s.sales?{invoices:data.invoices.map(inv=>documentSnapshot(inv,s))}:{})}];
 await db.query(`UPDATE ${s.returns} SET return_date=$2,reason=$3,notes=$4,total=$5,tax_adjustment=$6,refund_amount=$7,${s.sales?'customer_credit':'supplier_credit'}=$8,refund_method=$9,refund_reference=$10,refund_date=$11,settlement_mode=$12,document_snapshot=$13${s.sales?',sales_invoice_id=$14':''} WHERE id=$1`,s.sales?[...values,data.inv.id]:values);
 if(!s.sales)await db.query('UPDATE purchase_returns SET supplier_credit_note_reference=$2,supplier_credit_note_date=$3 WHERE id=$1',[rowId,data.supplierNote,data.supplierNoteDate]);
 return rowId;
}
export async function recordRefund(db,s,row,user){
 if(Number(row.refund_amount)<=0)return null;
 const result=await db.query(`INSERT INTO payments(store_id,payment_number,direction,status,payment_method,amount,payment_date,reference,notes,created_by,${s.returnKey}) VALUES($1,$2,$3,'posted',$4,$5,$6,$7,$8,$9,$10) RETURNING id`,[row.store_id,`REF-${randomUUID()}`,s.sales?'out':'in',row.refund_method,row.refund_amount,row.refund_date||row.return_date,row.refund_reference,`${s.sales?'Customer refund paid':'Supplier refund received'} for ${row.return_number}`,user.id,row.id]);const id=result.rows[0].id;await db.query("INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'return.refund.posted','payment',$3,$4)",[row.store_id,user.id,id,{returnType:s.kind,returnId:row.id,amount:row.refund_amount,method:row.refund_method}]);return id;
}

export async function lockReturnInventory(db,storeId,lines){
 const products=[...new Set(lines.map(line=>String(line.product_id)))].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
 for(const productId of products)for(const bucket of ['DAMAGED','PENDING_INSPECTION'])await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['return_bucket:'+storeId+':'+productId+':'+bucket]);
 await db.query('SELECT product_id FROM inventory_balances WHERE store_id=$1 AND product_id=ANY($2::bigint[]) ORDER BY product_id FOR UPDATE',[storeId,products]);
}

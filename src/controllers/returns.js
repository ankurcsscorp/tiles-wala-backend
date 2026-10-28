import {businessCustomerEntries,businessSupplierEntries} from './financialReports.js';
import {connection} from '../../connection.js';
import {canAccessStore,canManageStore} from './stores.js';
import {hasPermission} from '../services/permissions.js';
import * as workflow from '../services/returnInvoices.js';
import {adjustInvoiceBonusForReturn} from './salesBonusIntegration.js';
const {spec,fail,idOk,validDate,authorize,sourceInvoice,sourceItems,calculate,partyBalance,invoiceBalances,permissions}=workflow;
const error=(res,e,label)=>{if(e.status)return res.status(e.status).json({message:e.message});if(['23503','23514','22007','22003','22P02','TW001'].includes(e.code))return res.status(422).json({message:e.message});if(e.code==='23505')return res.status(409).json({message:'Duplicate return or settlement request'});console.error(label,e.message);return res.status(500).json({message:label});};
const kindOf=req=>req.params.type||req.query.type||'sales';
async function audit(db,user,s,id,storeId,action,data){await db.query('INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,$3,$4,$5,$6)',[storeId,user.id,`${s.kind}_return.${action}`,`${s.kind}_return`,id,data]);}
async function transaction(req,res,label,operation){const c=await connection.connect();try{await c.query('BEGIN');const result=await operation(c);await c.query('COMMIT');return res.status(result.status||200).json(result.body);}catch(e){await c.query('ROLLBACK').catch(()=>{});return error(res,e,label);}finally{c.release();}}
async function loadRecord(db,s,id,user){
 const result=await db.query(`SELECT r.*,to_jsonb(i) AS original_snapshot,r.return_date::text AS return_date,i.${s.partyKey} AS party_id,i.invoice_number AS original_invoice_number,i.invoice_date::text AS original_invoice_date,
 COALESCE(r.document_snapshot->'party'->>'name',p.name,'Walk-in customer') AS party_name,p.phone AS party_phone,st.name AS store_name,st.code AS store_code,a.name AS approved_by_name,c.name AS created_by_name,
 acc.refund_amount AS effective_refund_amount,acc.${s.sales?'customer_credit':'supplier_credit'} AS effective_credit
 FROM ${s.returns} r JOIN ${s.invoice} i ON i.id=r.${s.invoiceKey} LEFT JOIN ${s.party} p ON p.id=i.${s.partyKey} JOIN stores st ON st.id=r.store_id
 LEFT JOIN users a ON a.id=${s.sales?'r.approved_by':'NULL::bigint'} LEFT JOIN users c ON c.id=r.created_by JOIN ${s.accounting} acc ON acc.id=r.id WHERE r.id=$1`,[id]);
 if(!result.rowCount)fail('Return not found',404);const row=result.rows[0];await authorize(db,user,row.store_id);
 if(!row.document_snapshot)row.document_snapshot=workflow.documentSnapshot({...row.original_snapshot,party_name:row.party_name,party_phone:row.party_phone},s);delete row.original_snapshot;
 const lines=await db.query(`SELECT r.*,src.${s.invoiceKey} AS original_invoice_id,original.invoice_number AS source_invoice_number,original.invoice_date::text AS source_invoice_date,src.product_sku_snapshot AS sku,src.product_name_snapshot AS product_name,src.unit_id,src.unit_name_snapshot AS unit_name,src.unit_code_snapshot AS unit_code,src.product_snapshot,src.quantity AS original_quantity,
 COALESCE((SELECT sum(x.quantity) FROM ${s.items} x JOIN ${s.returns} xr ON xr.id=x.${s.returnKey} WHERE x.${s.itemKey}=src.id AND xr.status='posted' AND xr.id<>$1),0)::numeric(18,4) AS previously_returned_quantity
 FROM ${s.items} r JOIN ${s.invoiceItems} src ON src.id=r.${s.itemKey} JOIN ${s.invoice} original ON original.id=src.${s.invoiceKey} WHERE r.${s.returnKey}=$1 ORDER BY r.id`,[id]);
 const originals=[...new Map(lines.rows.map(line=>[String(line.original_invoice_id),{id:line.original_invoice_id,invoice_number:line.source_invoice_number,invoice_date:line.source_invoice_date}])).values()];
 if(s.sales&&originals.length)row.original_invoice_number=originals.map(inv=>inv.invoice_number).join(', ');
 for(const line of lines.rows)if(!line.return_snapshot&&Number(line.tax_adjustment)>0)line.return_snapshot={taxBreakupKnown:false};
 const allocations=(await db.query(`SELECT a.id,a.amount,a.${s.invoiceKey} AS invoice_id,i.invoice_number FROM return_credit_allocations a JOIN ${s.invoice} i ON i.id=a.${s.invoiceKey} WHERE a.${s.returnKey}=$1 ORDER BY a.id`,[id])).rows;
 const refunds=(await db.query(`SELECT id,payment_number,status,payment_method,amount,payment_date,reference FROM payments WHERE ${s.returnKey}=$1`,[id])).rows;
 const sums=(await db.query(`SELECT COALESCE(sum(taxable_adjustment),sum(line_total-tax_adjustment),0)::numeric(18,2) subtotal,COALESCE(sum(cgst_adjustment),0)::numeric(18,2) cgst,COALESCE(sum(sgst_adjustment),0)::numeric(18,2) sgst,COALESCE(sum(igst_adjustment),0)::numeric(18,2) igst,COALESCE(sum(quantity),0)::numeric(18,4) quantity FROM ${s.items} WHERE ${s.returnKey}=$1`,[id])).rows[0];
 const applied=(await db.query(`SELECT COALESCE(sum(amount),0)::numeric(18,2) amount FROM return_credit_allocations WHERE ${s.returnKey}=$1`,[id])).rows[0].amount;
 const credit=(await db.query('SELECT GREATEST($1::numeric-$2::numeric,0)::numeric(18,2) value',[row.effective_credit,applied])).rows[0].value;
 const buckets=s.sales?(await db.query(`SELECT m.sales_return_item_id,bucket,sum(quantity_delta)::numeric(18,4) quantity FROM return_inventory_movements m JOIN sales_return_items r ON r.id=m.sales_return_item_id WHERE r.sales_return_id=$1 GROUP BY m.sales_return_item_id,bucket`,[id])).rows:[];
 return {...row,original_invoices:originals,items:lines.rows,allocations,refunds,buckets,amounts:sums,adjusted_amount:row.workflow_version===2?applied:row.adjusted_amount,unapplied_credit:row.workflow_version===2?credit:row.unapplied_credit,current_party_balance:await partyBalance(db,s,row.store_id,row.party_id),permissions:await permissions(db,user,row.store_id),kind:s.kind};
}
export async function getReturnById(req,res){try{if(!idOk(req.params.id))fail('Invalid return ID',400);return res.json(await loadRecord(connection,spec(req.query.type||req.params.type||'sales'),req.params.id,req.user));}catch(e){return error(res,e,'Unable to load return');}}
export async function listReturns(req,res){try{
 const s=spec(req.query.type||'sales');let ids;
 if(req.user.userType?.toLowerCase()==='admin')ids=(await connection.query('SELECT id FROM stores WHERE is_active=TRUE')).rows.map(r=>String(r.id));
 else ids=(await connection.query('SELECT store_id AS id FROM user_store_assignments WHERE user_id=$1 AND is_active=TRUE',[req.user.id])).rows.map(r=>String(r.id));
 if(req.query.storeId){if(!ids.includes(String(req.query.storeId)))fail('You do not have access to this store',403);ids=[String(req.query.storeId)];}
 if(!ids.length)return res.json([]);
 const values=[ids],where=['r.store_id=ANY($1::bigint[])'];const add=(sql,value)=>{values.push(value);where.push(sql.replace('?',`$${values.length}`));};
 if(req.query.status)add('r.status=?',req.query.status);if(req.query.partyId){if(!idOk(req.query.partyId))fail('Invalid party ID',400);add(`i.${s.partyKey}=?`,req.query.partyId);}
 for(const [key,operator] of [['fromDate','>='],['toDate','<=']])if(req.query[key]){if(!validDate(req.query[key]))fail('Use valid date filters',400);add(`r.return_date${operator}?::date`,req.query[key]);}
 if(req.query.q){
  values.push(`%${String(req.query.q).slice(0,100)}%`);const match='$'+values.length;
  where.push(`(r.return_number ILIKE ${match} OR i.invoice_number ILIKE ${match} OR p.name ILIKE ${match}${s.sales?` OR EXISTS(SELECT 1 FROM sales_return_items ri JOIN sales_invoice_items si ON si.id=ri.sales_invoice_item_id JOIN sales_invoices original ON original.id=si.sales_invoice_id WHERE ri.sales_return_id=r.id AND original.invoice_number ILIKE ${match})`:''})`);
 }
 const rows=(await connection.query(`SELECT r.*,${s.sales?`COALESCE((SELECT string_agg(DISTINCT original.invoice_number, ', ' ORDER BY original.invoice_number) FROM sales_return_items ri JOIN sales_invoice_items si ON si.id=ri.sales_invoice_item_id JOIN sales_invoices original ON original.id=si.sales_invoice_id WHERE ri.sales_return_id=r.id),i.invoice_number)`:'i.invoice_number'} AS original_invoice_number,i.${s.partyKey} AS party_id,COALESCE(p.name,'Walk-in customer') AS party_name,st.name AS store_name,
 ${s.sales?'r.approved_at IS NOT NULL':'TRUE'} AS approved,acc.refund_amount AS effective_refund_amount,
 COALESCE(a.amount,0)::numeric(18,2) AS applied_credit,GREATEST(acc.${s.sales?'customer_credit':'supplier_credit'}-COALESCE(a.amount,0),0)::numeric(18,2) AS credit_balance
 FROM ${s.returns} r JOIN ${s.invoice} i ON i.id=r.${s.invoiceKey} LEFT JOIN ${s.party} p ON p.id=i.${s.partyKey} JOIN stores st ON st.id=r.store_id JOIN ${s.accounting} acc ON acc.id=r.id
 LEFT JOIN LATERAL(SELECT sum(amount) amount FROM return_credit_allocations x WHERE x.${s.returnKey}=r.id) a ON TRUE
 WHERE ${where.join(' AND ')} ORDER BY r.return_date DESC,r.id DESC LIMIT 200`,values)).rows;return res.json(rows);
 }catch(e){return error(res,e,'Unable to list returns');}}
export async function eligibleReturnInvoices(req,res){try{
 const s=spec(req.query.type||'sales'),storeId=req.query.storeId,partyId=req.query.partyId;if(!idOk(storeId)||!idOk(partyId))fail('Select a store and party',400);await authorize(connection,req.user,storeId);
 const rows=(await connection.query(`SELECT i.id,i.invoice_number,i.invoice_date,i.total,i.${s.partyKey} AS party_id FROM ${s.invoice} i WHERE i.store_id=$1 AND i.${s.partyKey}=$2 AND i.status='posted' AND ($3::text='' OR i.invoice_number ILIKE '%'||$3||'%') ORDER BY i.invoice_date DESC,i.id DESC LIMIT 200`,[storeId,partyId,String(req.query.q||'').slice(0,100)])).rows;
 for(const row of rows){const lines=await sourceItems(connection,s,row.id);const available=(await connection.query('SELECT COALESCE(sum(round(x.line_total*x.remaining_quantity/NULLIF(x.quantity,0),2)),0)::numeric(18,2) amount,COALESCE(sum(x.remaining_quantity),0)::numeric(18,4) quantity FROM jsonb_to_recordset($1::jsonb) AS x(line_total numeric,remaining_quantity numeric,quantity numeric)',[JSON.stringify(lines)])).rows[0];row.returnable_amount=available.amount;row.returnable_quantity=available.quantity;}
 return res.json(rows);
 }catch(e){return error(res,e,'Unable to load returnable invoices');}}
export async function returnInvoiceSource(req,res){try{
 const s=spec(req.params.type),inv=await sourceInvoice(connection,s,req.params.id);await authorize(connection,req.user,inv.store_id);
 return res.json({invoice:inv,items:await sourceItems(connection,s,inv.id),permissions:await permissions(connection,req.user,inv.store_id),partyBalance:await partyBalance(connection,s,inv.store_id,inv[s.partyKey])});
 }catch(e){return error(res,e,'Unable to load original invoice products');}}
export async function previewReturn(req,res){return transaction(req,res,'Unable to calculate return preview',async c=>{const s=spec(req.params.type),data=await calculate(c,s,req.body,req.user,{excludeReturnId:req.body.returnId||null});return {body:{amounts:data.amounts,outstandingBefore:data.outstanding,adjustedAmount:data.adjusted,creditAmount:data.credit,refundAmount:data.refund,items:data.lines.map(x=>({invoiceItemId:x.source.id,invoiceId:x.source.original_invoice.id,invoiceNumber:x.source.original_invoice.invoice_number,total:x.total,tax:x.tax,taxable:x.taxable,rate:x.rate,cgst:x.cgst,sgst:x.sgst,igst:x.igst}))}};});}
export async function createReturn(req,res){return transaction(req,res,'Unable to create return draft',async c=>{
 const s=spec(req.params.type),b=req.body||{},key=String(b.idempotencyKey||'').slice(0,120)||null,hash=workflow.fingerprint(b);
 if(key){await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`return:${s.kind}:${key}`]);const prior=await c.query(`SELECT id,store_id,request_fingerprint FROM ${s.returns} WHERE idempotency_key=$1`,[key]);if(prior.rowCount){await authorize(c,req.user,prior.rows[0].store_id);if(prior.rows[0].request_fingerprint!==hash)fail('Return request key was reused with different details',409);return {body:{...await loadRecord(c,s,prior.rows[0].id,req.user),duplicate:true}};}}
 const sources=await workflow.returnSources(c,s,b,req.user,{lock:true}),inv=sources[0];
 const data=await calculate(c,s,b,req.user),id=await workflow.writeDraft(c,s,data,req.user,null,key,hash);await audit(c,req.user,s,id,inv.store_id,'created',{invoiceId:inv.id,invoiceIds:data.invoices.map(source=>source.id),total:data.amounts.total,mode:data.mode,rateChanges:data.lines.filter(x=>x.rateReason).map(x=>({originalRate:x.source.unit_price,returnRate:x.rate,reason:x.rateReason}))});
 return {status:201,body:await loadRecord(c,s,id,req.user)};
 });}
export async function updateReturn(req,res){return transaction(req,res,'Unable to update return draft',async c=>{
 const s=spec(req.params.type);if(!idOk(req.params.id))fail('Invalid return ID',400);const r=await c.query(`SELECT * FROM ${s.returns} WHERE id=$1 FOR UPDATE`,[req.params.id]);if(!r.rowCount)fail('Return not found',404);const row=r.rows[0];await authorize(c,req.user,row.store_id);
 if(row.workflow_version!==2)fail('Legacy returns keep their original workflow; cancel this draft and create a replacement to use new settlement options',409);
 if(row.status!=='draft'||row.approved_at)fail('Only an unapproved draft can be edited; cancel an approved draft and create a replacement',409);if(!s.sales&&String(req.body.invoiceId)!==String(row[s.invoiceKey]))fail('The original invoice cannot be changed on an existing return',409);
 const previous=await sourceInvoice(c,s,row[s.invoiceKey]),sources=await workflow.returnSources(c,s,req.body,req.user,{lock:true});
 if(String(sources[0].store_id)!==String(row.store_id)||String(sources[0][s.partyKey])!==String(previous[s.partyKey]))fail('An existing return must keep the same party and store');
 const data=await calculate(c,s,req.body,req.user,{excludeReturnId:row.id});await workflow.writeDraft(c,s,data,req.user,row.id);await audit(c,req.user,s,row.id,row.store_id,'updated',{total:data.amounts.total,invoiceIds:data.invoices.map(source=>source.id)});return {body:await loadRecord(c,s,row.id,req.user)};
 });}
export async function approveSalesReturn(req,res){return transaction(req,res,'Unable to approve sales return',async c=>{
 const s=spec('sales'),r=await c.query('SELECT * FROM sales_returns WHERE id=$1 FOR UPDATE',[req.params.id]);if(!r.rowCount)fail('Return not found',404);const row=r.rows[0];await authorize(c,req.user,row.store_id,true);if(row.status!=='draft'||row.approved_at)fail('Only an unapproved draft can be approved',409);
 await c.query('UPDATE sales_returns SET approved_by=$2,approved_at=now() WHERE id=$1',[row.id,req.user.id]);await audit(c,req.user,s,row.id,row.store_id,'approved',{});return {body:await loadRecord(c,s,row.id,req.user)};
 });}
async function finalize(req,res,modern){return transaction(req,res,'Unable to finalize return',async c=>{
 const s=spec(req.params.type);if(!idOk(req.params.id))fail('Invalid return ID',400);const r=await c.query(`SELECT r.*,r.return_date::text AS return_date,i.${s.partyKey} AS party_id FROM ${s.returns} r JOIN ${s.invoice} i ON i.id=r.${s.invoiceKey} WHERE r.id=$1 FOR UPDATE OF r`,[req.params.id]);if(!r.rowCount)fail('Return not found',404);const row=r.rows[0];await authorize(c,req.user,row.store_id);
 const key=String(req.body?.idempotencyKey||'').slice(0,120);if(row.status==='posted'&&modern&&key&&key===row.finalization_key)return {body:{...await loadRecord(c,s,row.id,req.user),duplicate:true}};
 if(row.status!=='draft')fail('Only a draft return can be finalized',409);if(modern&&!key)fail('A finalization request key is required',400);
 if(modern||!s.sales)await authorize(c,req.user,row.store_id,true);if(!modern&&s.sales&&!row.approved_at)fail('Sales return requires manager approval',409);
 await invoiceBalances(c,s,row.store_id,row.party_id,true);
 await c.query(`SELECT id FROM ${s.invoice} WHERE id=$1 FOR UPDATE`,[row[s.invoiceKey]]);const inv=await sourceInvoice(c,s,row[s.invoiceKey]);
 const lines=(await c.query(`SELECT * FROM ${s.items} WHERE ${s.returnKey}=$1 ORDER BY id`,[row.id])).rows;if(!lines.length)fail('Add a return product');
 const sources=await workflow.returnSources(c,s,{invoiceId:inv.id,items:lines.map(line=>({invoiceItemId:line[s.itemKey]}))},req.user,{lock:true});
 const returnDate=row.return_date instanceof Date?row.return_date.toISOString().slice(0,10):String(row.return_date).slice(0,10);if(sources.some(source=>returnDate<source.invoice_date))fail('Return date cannot precede an original invoice');
 const originals=[];for(const source of sources)originals.push(...await sourceItems(c,s,source.id,row.id));
 for(const line of lines){const src=originals.find(x=>String(x.id)===String(line[s.itemKey]));if(!src||!(await c.query('SELECT $1::numeric<=$2::numeric AND $3::numeric+$4::numeric<=$5::numeric AS ok',[line.quantity,src.remaining_quantity,line.line_total,src.previously_returned_amount,src.line_total])).rows[0].ok)fail('A product quantity or value is no longer returnable. Refresh or replace this draft.',409);}
 for(const line of lines){const src=originals.find(x=>String(x.id)===String(line[s.itemKey]));if(row.workflow_version===2&&!(await c.query('SELECT $1::numeric+$2::numeric<=$3::numeric AND $4::numeric+$5::numeric<=$6::numeric AS ok',[line.tax_adjustment,src.previously_returned_tax,src.tax_amount,line.taxable_adjustment,src.previously_returned_taxable,src.taxable_value])).rows[0].ok)fail('Original tax eligibility changed after this draft was saved. Edit and review the draft again.',409);}
 await workflow.lockReturnInventory(c,row.store_id,lines);
 const before=await partyBalance(c,s,row.store_id,row.party_id);
 const expected=(await c.query('SELECT LEAST($1::numeric,GREATEST($2::numeric,0))::numeric(18,2) adjusted,($1::numeric-$3::numeric)::numeric(18,2) credit',[row.total,before,row.refund_amount])).rows[0];
 const adjusted=row.settlement_mode==='CREDIT'?'0.00':expected.adjusted;
 if(!(await c.query('SELECT $1::numeric+$2::numeric<=$3::numeric AS ok',[adjusted,row.refund_amount,row.total])).rows[0].ok)fail('Refund exceeds credit available after outstanding adjustment; edit the unapproved draft',409);
 if(Number(row.refund_amount)>0){if(!hasPermission(req.user,'payments.manage'))fail('Payment-management permission is required for refunds',403);if(!(await c.query('SELECT 1 FROM payment_method_options WHERE code=$1 AND is_active=TRUE',[row.refund_method])).rowCount)fail('The selected refund payment method is no longer active');}
 let allocations=[];
 if(row.workflow_version===2&&Number(adjusted)>0)allocations=await workflow.distributeCredit(c,s,row,adjusted,req.user);
 const applied=(await c.query('SELECT COALESCE(sum(x.amount),0)::numeric(18,2) amount FROM jsonb_to_recordset($1::jsonb) AS x(amount numeric)',[JSON.stringify(allocations)])).rows[0].amount;
 const remaining=(await c.query('SELECT ($1::numeric-$2::numeric)::numeric(18,2) amount',[expected.credit,applied])).rows[0].amount;
 const refundPaymentId=row.workflow_version===2?await workflow.recordRefund(c,s,row,req.user):null;
 await c.query(`UPDATE ${s.returns} SET status='posted',posted_at=now(),outstanding_before=$2,adjusted_amount=$3,unapplied_credit=$4,finalization_key=$5${s.sales?',approved_at=COALESCE(approved_at,now()),approved_by=COALESCE(approved_by,$6)':''} WHERE id=$1`,s.sales?[row.id,before,applied,remaining,key||null,req.user.id]:[row.id,before,applied,remaining,key||null]);
 if(s.sales)await adjustInvoiceBonusForReturn(c,row.id,req.user.id);
 await audit(c,req.user,s,row.id,row.store_id,'posted',{invoiceIds:sources.map(source=>source.id),total:row.total,adjusted:applied,credit:remaining,refundPaymentId,requestKey:key||null});return {body:await loadRecord(c,s,row.id,req.user)};
 });}
export const postReturn=(req,res)=>finalize(req,res,false);
export const finalizeReturn=(req,res)=>finalize(req,res,true);
export async function changeReturnStatus(req,res){return transaction(req,res,'Unable to change return status',async c=>{
 const s=spec(req.params.type),r=await c.query(`SELECT * FROM ${s.returns} WHERE id=$1 FOR UPDATE`,[req.params.id]);if(!r.rowCount)fail('Return not found',404);const row=r.rows[0];await authorize(c,req.user,row.store_id,true);
 const next=req.params.action==='cancel'?'cancelled':'reversed';if(next==='cancelled'&&row.status!=='draft'||next==='reversed'&&row.status!=='posted')fail('The return cannot make this status transition',409);
 const reason=String(req.body?.reason||'').trim();if(reason.length<3||reason.length>1000)fail('Provide a correction reason of 3 to 1000 characters',400);
 const originalLines=(await c.query(`SELECT product_id FROM ${s.items} WHERE ${s.returnKey}=$1`,[row.id])).rows;await workflow.lockReturnInventory(c,row.store_id,originalLines);
 await c.query(`UPDATE ${s.returns} SET status=$2 WHERE id=$1`,[row.id,next]);
 if(s.sales&&next==='reversed')await c.query("INSERT INTO sales_bonus_adjustments(sales_bonus_record_id,store_id,source_type,source_id,source_item_id,amount,reason,created_by) SELECT sales_bonus_record_id,store_id,'sales_return_reversal',source_id,source_item_id,-amount,'Sales return reversed',$2 FROM sales_bonus_adjustments WHERE source_type='sales_return_item' AND source_id=$1 ON CONFLICT DO NOTHING",[row.id,req.user.id]);
 await audit(c,req.user,s,row.id,row.store_id,next,{reason});return {body:await loadRecord(c,s,row.id,req.user)};
 });}
export async function inspectReturn(req,res){return transaction(req,res,'Unable to record return inspection',async c=>{
 const s=spec('sales'),r=await c.query('SELECT * FROM sales_returns WHERE id=$1 FOR UPDATE',[req.params.id]);if(!r.rowCount)fail('Return not found',404);const row=r.rows[0];await authorize(c,req.user,row.store_id,true);if(!hasPermission(req.user,'inventory.manage'))fail('Inventory-management permission is required',403);if(row.status!=='posted')fail('Only a posted return can be inspected');
 const b=req.body||{},key=String(b.idempotencyKey||'');if(key.length<8||key.length>100||!idOk(b.itemId)||!['SELLABLE','DAMAGED'].includes(b.decision)||!String(b.reason||'').trim())fail('Select a returned item, inspection decision, reason, and request key',400);
 const prior=await c.query("SELECT after_data FROM audit_logs WHERE action='sales_return.inspected' AND entity_id=$1 AND after_data->>'requestKey'=$2",[row.id,key]);if(prior.rowCount){if(prior.rows[0].after_data.fingerprint!==workflow.fingerprint(b))fail('Inspection key was reused with different details',409);return {body:{...await loadRecord(c,s,row.id,req.user),duplicate:true}};}
 const item=(await c.query('SELECT * FROM sales_return_items WHERE sales_return_id=$1 AND id=$2',[row.id,b.itemId])).rows[0];if(!item)fail('Returned product not found',404);
 await workflow.lockReturnInventory(c,row.store_id,[item]);
 if(!/^\d{1,14}(\.\d{1,4})?$/.test(String(b.quantity))||Number(b.quantity)<=0)fail('Enter a positive inspection quantity');
 const precision=Math.min(4,item.return_snapshot?.unitDecimalPlaces??4);if((String(b.quantity).split('.')[1]||'').replace(/0+$/,'').length>precision)fail('Inspection quantity uses more decimals than the original unit permits');
 const available=(await c.query("SELECT COALESCE(sum(quantity_delta),0)::numeric(18,4) quantity FROM return_inventory_movements WHERE sales_return_item_id=$1 AND bucket='PENDING_INSPECTION'",[item.id])).rows[0].quantity;
 const delta=(await c.query('SELECT round($1::numeric*$2::numeric,4)::numeric(18,4) amount',[b.quantity,item.conversion_factor_to_base||1])).rows[0].amount;
 if(!(await c.query('SELECT $1::numeric<=$2::numeric AS ok',[delta,available])).rows[0].ok)fail('Inspection quantity exceeds pending stock');
 await c.query("INSERT INTO return_inventory_movements(store_id,product_id,sales_return_item_id,bucket,quantity_delta,source_type,source_id,idempotency_key,reason,created_by) VALUES($1,$2,$3,'PENDING_INSPECTION',-$4::numeric,'return_inspection',$5,$6,$7,$8)",[row.store_id,item.product_id,item.id,delta,row.id,`inspection:${row.id}:${key}:out`,String(b.reason).slice(0,1000),req.user.id]);
 if(b.decision==='DAMAGED')await c.query("INSERT INTO return_inventory_movements(store_id,product_id,sales_return_item_id,bucket,quantity_delta,source_type,source_id,idempotency_key,reason,created_by) VALUES($1,$2,$3,'DAMAGED',$4,'return_inspection',$5,$6,$7,$8)",[row.store_id,item.product_id,item.id,delta,row.id,`inspection:${row.id}:${key}:in`,String(b.reason).slice(0,1000),req.user.id]);
 else await c.query("INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by) VALUES($1,$2,'sales_return',$3,'return_inspection',$4,$5,$6,$7)",[row.store_id,item.product_id,delta,row.id,item.id,`inspection:${row.id}:${key}`,req.user.id]);
 await audit(c,req.user,s,row.id,row.store_id,'inspected',{...b,requestKey:key,fingerprint:workflow.fingerprint(b)});return {body:await loadRecord(c,s,row.id,req.user)};
 });}
export async function applyReturnCredit(req,res){return transaction(req,res,'Unable to apply return credit',async c=>{
 const s=spec(req.params.type),r=await c.query(`SELECT r.*,r.return_date::text AS return_date,i.${s.partyKey} AS party_id FROM ${s.returns} r JOIN ${s.invoice} i ON i.id=r.${s.invoiceKey} WHERE r.id=$1 FOR UPDATE OF r`,[req.params.id]);if(!r.rowCount)fail('Return not found',404);const row=r.rows[0];await authorize(c,req.user,row.store_id,true);if(row.workflow_version!==2||row.status!=='posted')fail('Only new posted return credit can be applied');
 const key=String(req.body?.idempotencyKey||'');if(key.length<8||key.length>100)fail('An allocation request key is required',400);
 const previous=await c.query("SELECT 1 FROM audit_logs WHERE action=$1 AND entity_id=$2 AND after_data->>'requestKey'=$3",[`${s.kind}_return.credit_applied`,row.id,key]);if(previous.rowCount)return {body:{...await loadRecord(c,s,row.id,req.user),duplicate:true}};
 const current=await loadRecord(c,s,row.id,req.user);if(Number(current.unapplied_credit)<=0)fail('This return has no remaining credit',409);
 const allocations=await workflow.distributeCredit(c,s,row,current.unapplied_credit,req.user);if(!allocations.length)fail('No outstanding invoices are available for this party in this store',409);
 await audit(c,req.user,s,row.id,row.store_id,'credit_applied',{requestKey:key,allocations});return {body:await loadRecord(c,s,row.id,req.user)};
 });}
export async function returnPartyBalance(req,res){try{const s=spec(req.query.type||'sales');if(!idOk(req.query.storeId)||!idOk(req.query.partyId))fail('Select an authorized store and party',400);await authorize(connection,req.user,req.query.storeId);const amount=await partyBalance(connection,s,req.query.storeId,req.query.partyId);return res.json({totalOutstanding:amount,amountDue:Number(amount)>0?amount:'0.00',creditBalance:Number(amount)<0?String(amount).slice(1):'0.00'});}catch(e){return error(res,e,'Unable to load party balance');}}
export async function returnSummary(req,res){try{
 let stores=req.user.userType?.toLowerCase()==='admin'?(await connection.query('SELECT id FROM stores WHERE is_active=TRUE')).rows.map(row=>String(row.id)):(await connection.query('SELECT store_id AS id FROM user_store_assignments WHERE user_id=$1 AND is_active=TRUE',[req.user.id])).rows.map(row=>String(row.id));
 if(req.query.storeId){if(!stores.includes(String(req.query.storeId)))fail('You do not have access to this store',403);stores=[String(req.query.storeId)];}
 const from=req.query.fromDate||null,to=req.query.toDate||null;if(from&&!validDate(from)||to&&!validDate(to)||from&&to&&from>to)fail('Use a valid return-report date range',400);
 const result=await connection.query(`WITH documents AS (
 SELECT 'sales' kind,total,invoice_date date FROM sales_invoices WHERE store_id=ANY($1::bigint[]) AND status='posted'
 UNION ALL SELECT 'purchase',total,invoice_date FROM purchase_invoices WHERE store_id=ANY($1::bigint[]) AND status='posted'
 UNION ALL SELECT 'sales_return',total,return_date FROM sales_returns WHERE store_id=ANY($1::bigint[]) AND status='posted'
 UNION ALL SELECT 'purchase_return',total,return_date FROM purchase_returns WHERE store_id=ANY($1::bigint[]) AND status='posted'
 ),totals AS (SELECT COALESCE(sum(total) FILTER(WHERE kind='sales'),0)::numeric(18,2) gross_sales,COALESCE(sum(total) FILTER(WHERE kind='purchase'),0)::numeric(18,2) gross_purchases,
 COALESCE(sum(total) FILTER(WHERE kind='sales_return'),0)::numeric(18,2) sales_returns,COALESCE(sum(total) FILTER(WHERE kind='purchase_return'),0)::numeric(18,2) purchase_returns FROM documents WHERE date>=COALESCE($2::date,'1900-01-01') AND date<=COALESCE($3::date,CURRENT_DATE))
 SELECT *, (gross_sales-sales_returns)::numeric(18,2) net_sales,(gross_purchases-purchase_returns)::numeric(18,2) net_purchases,
 (SELECT COALESCE(sum(GREATEST(r.customer_credit-COALESCE((SELECT sum(a.amount) FROM return_credit_allocations a WHERE a.sales_return_id=r.id),0),0)),0)::numeric(18,2) FROM sales_return_accounting r JOIN sales_returns src ON src.id=r.id WHERE r.store_id=ANY($1::bigint[]) AND r.status='posted' AND src.workflow_version=2 AND r.return_date<=COALESCE($3::date,CURRENT_DATE)) customer_return_credits,
 (SELECT COALESCE(sum(GREATEST(r.supplier_credit-COALESCE((SELECT sum(a.amount) FROM return_credit_allocations a WHERE a.purchase_return_id=r.id),0),0)),0)::numeric(18,2) FROM purchase_return_accounting r JOIN purchase_returns src ON src.id=r.id WHERE r.store_id=ANY($1::bigint[]) AND r.status='posted' AND src.workflow_version=2 AND r.return_date<=COALESCE($3::date,CURRENT_DATE)) supplier_return_credits,
 (SELECT COALESCE(sum(GREATEST(-balance,0)),0)::numeric(18,2) FROM (SELECT party_id,sum(debit-credit) balance FROM (${businessCustomerEntries}) e WHERE store_id=ANY($1::bigint[]) AND entry_date<=COALESCE($3::date,CURRENT_DATE) AND party_id IS NOT NULL GROUP BY store_id,party_id) x) customer_net_credit,
 (SELECT COALESCE(sum(GREATEST(-balance,0)),0)::numeric(18,2) FROM (SELECT party_id,sum(credit-debit) balance FROM (${businessSupplierEntries}) e WHERE store_id=ANY($1::bigint[]) AND entry_date<=COALESCE($3::date,CURRENT_DATE) AND party_id IS NOT NULL GROUP BY store_id,party_id) x) supplier_net_credit
 FROM totals`,[stores,from,to]);return res.json(result.rows[0]);
 }catch(e){return error(res,e,'Unable to calculate return report');}}

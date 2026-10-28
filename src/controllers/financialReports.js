import {entriesSql,buildLedger} from '../services/partyLedger.js';
import {ledgerHtml,ledgerPdf,ledgerFilename} from '../services/ledgerDocument.js';
import { connection } from "../../connection.js";

const isAdmin=req=>req.user?.userType?.toLowerCase()==="admin";
const idOk=value=>/^\d+$/.test(String(value??""));
const dateOk=value=>{if(!value)return true;if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const d=new Date(`${value}T00:00:00Z`);return !Number.isNaN(d.valueOf())&&d.toISOString().slice(0,10)===value;};
const partyTypeOk=value=>["customer","supplier"].includes(value);

async function storesFor(req,res,requested){
  const result=isAdmin(req)?await connection.query("SELECT id FROM stores ORDER BY id"):
    await connection.query("SELECT usa.store_id AS id FROM user_store_assignments usa JOIN stores s ON s.id=usa.store_id WHERE usa.user_id=$1 AND usa.is_active=TRUE AND s.is_active=TRUE ORDER BY usa.store_id",[req.user.id]);
  const ids=result.rows.map(row=>String(row.id));
  if(requested){if(!idOk(requested)){res.status(400).json({message:"Invalid store ID"});return null;}if(!ids.includes(String(requested))){res.status(403).json({message:"You do not have access to this store"});return null;}return [String(requested)];}
  return ids;
}


const signExpr=type=>type==="customer"?"debit-credit":"credit-debit";
const pageLimit=req=>{const limit=Number.parseInt(req.query.limit,10)||50,offset=Number.parseInt(req.query.offset,10)||0;return Number.isInteger(limit)&&limit>0&&limit<=200&&Number.isInteger(offset)&&offset>=0?{limit,offset}:null;};
const error=(res,e,label)=>{if(["23503","23514","22007","22P02"].includes(e.code))return res.status(400).json({message:e.message});console.error(label,e.message);return res.status(500).json({message:label});};

async function ledgerRequest(req,res,{complete=false}={}){
 const {partyType,id}=req.params;
 if(!partyTypeOk(partyType)||!idOk(id)){res.status(400).json({message:'Choose a customer or supplier and a valid ID'});return null;}
 const from=req.query.fromDate||null,to=req.query.toDate||null;
 if(!dateOk(from)||!dateOk(to)||(from&&to&&from>to)){res.status(400).json({message:'Use a valid date range with fromDate before toDate'});return null;}
 const paging=pageLimit(req);if(!complete&&!paging){res.status(400).json({message:'Limit must be 1 to 200 and offset cannot be negative'});return null;}
 const stores=await storesFor(req,res,req.query.storeId);if(!stores)return null;
 const client=await connection.connect();
 try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const report=await buildLedger(client,{partyType,id,stores,from,to,complete,...paging});await client.query('COMMIT');return report;}
 catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
export async function partyLedger(req,res){try{const report=await ledgerRequest(req,res);if(report){res.set?.('Cache-Control','private, no-store');return res.json(report);}}catch(e){return ledgerError(res,e,'Unable to load financial ledger');}}
export async function printLedger(req,res){try{const report=await ledgerRequest(req,res,{complete:true});if(report){res.set('Cache-Control','private, no-store');return res.type('html').send(ledgerHtml(report));}}catch(e){return ledgerError(res,e,'Unable to prepare ledger printing');}}
export async function downloadLedgerPdf(req,res){try{const report=await ledgerRequest(req,res,{complete:true});if(!report)return;const pdf=await ledgerPdf(report);res.set('Cache-Control','private, no-store');res.set('Content-Disposition','attachment; filename="'+ledgerFilename(report)+'.pdf"');return res.type('application/pdf').send(pdf);}catch(e){return ledgerError(res,e,'Unable to generate ledger PDF');}}
function ledgerError(res,e,label){if(e.status)return res.status(e.status).json({message:e.message});return error(res,e,label);}

export async function outstandingReport(req,res){
 const type=req.query.partyType;if(!partyTypeOk(type))return res.status(400).json({message:"partyType must be customer or supplier"});const {limit,offset}=pageLimit(req)||{};if(!limit)return res.status(400).json({message:"Limit must be 1 to 200 and offset cannot be negative"});
 try{const stores=await storesFor(req,res,req.query.storeId);if(!stores)return;if(!stores.length)return res.json({items:[],pagination:{limit,offset,total:0}});
  const sign=signExpr(type),table=type==="customer"?"customers":"suppliers",q=String(req.query.q||"").trim();
  // Replace the id-scoped party ledger parameters with a business-wide transaction set.
  const businessEntries=type==="customer"?businessCustomerEntries:businessSupplierEntries;
  const c=await connection.query(`WITH e AS (${businessEntries}), account_balances AS (SELECT e.party_id,e.store_id,sum(${sign})::numeric(18,2) AS outstanding FROM e WHERE e.entry_date<=CURRENT_DATE GROUP BY e.party_id,e.store_id)
    SELECT a.*,p.code AS party_code,p.name AS party_name,s.name AS store_name,s.code AS store_code FROM account_balances a JOIN ${table} p ON p.id=a.party_id JOIN stores s ON s.id=a.store_id
    WHERE s.id=ANY($1::bigint[]) ${q?"AND (p.name ILIKE $2 OR COALESCE(p.code,'') ILIKE $2)":""} AND a.outstanding<>0 ORDER BY abs(a.outstanding) DESC,p.name,s.name LIMIT $${q?3:2} OFFSET $${q?4:3}`,
    q?[stores,`%${q}%`,limit,offset]:[stores,limit,offset]);
  const ct=await connection.query(`WITH e AS (${businessEntries}), account_balances AS (SELECT party_id,store_id,sum(${sign})::numeric(18,2) AS outstanding FROM e WHERE store_id=ANY($1::bigint[]) AND entry_date<=CURRENT_DATE GROUP BY party_id,store_id) SELECT count(*)::int total FROM account_balances a JOIN ${table} p ON p.id=a.party_id WHERE a.outstanding<>0 ${q?"AND (p.name ILIKE $2 OR COALESCE(p.code,'') ILIKE $2)":""}`,q?[stores,`%${q}%`]:[stores]);
  return res.json({partyType:type,items:c.rows,pagination:{limit,offset,total:ct.rows[0].total}});
 }catch(e){return error(res,e,"Unable to create outstanding report");}
}

export const businessCustomerEntries=`SELECT si.customer_id AS party_id,si.store_id,si.invoice_date AS entry_date,si.total AS debit,0::numeric AS credit FROM sales_invoices si WHERE si.status='posted'
 UNION ALL SELECT si.customer_id,si.store_id,p.payment_date,0::numeric,pa.amount FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.status='posted' AND p.direction='in' JOIN sales_invoices si ON si.id=pa.sales_invoice_id AND si.status='posted' WHERE pa.direction='in'
 UNION ALL SELECT p.customer_id,p.store_id,p.payment_date,0::numeric,GREATEST(p.amount-COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.payment_id=p.id AND pa.direction='in'),0),0) FROM payments p WHERE p.direction='in' AND p.status='posted' AND p.customer_id IS NOT NULL
 UNION ALL SELECT si.customer_id,r.store_id,r.return_date,r.refund_amount,r.total FROM sales_return_accounting r JOIN sales_invoices si ON si.id=r.sales_invoice_id WHERE r.status='posted'
 UNION ALL SELECT a.customer_id,a.store_id,a.adjustment_date,CASE WHEN a.direction='debit' THEN a.amount ELSE 0 END,CASE WHEN a.direction='credit' THEN a.amount ELSE 0 END FROM customer_balance_adjustments a WHERE a.status='posted'`;
export const businessSupplierEntries=`SELECT pi.supplier_id AS party_id,pi.store_id,pi.invoice_date AS entry_date,0::numeric AS debit,pi.total AS credit FROM purchase_invoices pi WHERE pi.status='posted'
 UNION ALL SELECT pi.supplier_id,pi.store_id,p.payment_date,pa.amount,0::numeric FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.status='posted' AND p.direction='out' JOIN purchase_invoices pi ON pi.id=pa.purchase_invoice_id AND pi.status='posted' WHERE pa.direction='out'
 UNION ALL SELECT p.supplier_id,p.store_id,p.payment_date,GREATEST(p.amount-COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.payment_id=p.id AND pa.direction='out'),0),0),0::numeric FROM payments p WHERE p.direction='out' AND p.status='posted' AND p.supplier_id IS NOT NULL
 UNION ALL SELECT pi.supplier_id,r.store_id,r.return_date,r.supplier_credit,0::numeric FROM purchase_return_accounting r JOIN purchase_invoices pi ON pi.id=r.purchase_invoice_id WHERE r.status='posted'
 UNION ALL SELECT a.supplier_id,a.store_id,a.adjustment_date,CASE WHEN a.direction='debit' THEN a.amount ELSE 0 END,CASE WHEN a.direction='credit' THEN a.amount ELSE 0 END FROM supplier_balance_adjustments a WHERE a.status='posted'`;

export async function outstandingSummary(req,res){
 try{const stores=await storesFor(req,res,req.query.storeId);if(!stores)return;if(!stores.length)return res.json({stores:[],business:{receivables:"0.00",payables:"0.00"}});
  const r=await connection.query(`WITH ce AS (${businessCustomerEntries}),se AS (${businessSupplierEntries}),cb AS (SELECT store_id,sum(debit-credit)::numeric(18,2) receivables FROM ce WHERE store_id=ANY($1::bigint[]) AND entry_date<=CURRENT_DATE GROUP BY store_id),sb AS (SELECT store_id,sum(credit-debit)::numeric(18,2) payables FROM se WHERE store_id=ANY($1::bigint[]) AND entry_date<=CURRENT_DATE GROUP BY store_id)
   SELECT st.id AS store_id,st.code AS store_code,st.name AS store_name,COALESCE(cb.receivables,0)::numeric(18,2) AS receivables,COALESCE(sb.payables,0)::numeric(18,2) AS payables FROM stores st LEFT JOIN cb ON cb.store_id=st.id LEFT JOIN sb ON sb.store_id=st.id WHERE st.id=ANY($1::bigint[]) ORDER BY st.name,st.id`,[stores]);
  const total=await connection.query("SELECT COALESCE(sum(receivables),0)::numeric(18,2) receivables,COALESCE(sum(payables),0)::numeric(18,2) payables FROM (SELECT store_id,sum(debit-credit)::numeric(18,2) receivables,0::numeric payables FROM ("+businessCustomerEntries+") x WHERE store_id=ANY($1::bigint[]) AND entry_date<=CURRENT_DATE GROUP BY store_id UNION ALL SELECT store_id,0::numeric,sum(credit-debit)::numeric(18,2) FROM ("+businessSupplierEntries+") y WHERE store_id=ANY($1::bigint[]) AND entry_date<=CURRENT_DATE GROUP BY store_id) sums",[stores]);
  return res.json({stores:r.rows,business:total.rows[0],basis:"Posted documents, posted allocations, posted returns and posted balance adjustments. Reversed payments are excluded."});
 }catch(e){return error(res,e,"Unable to calculate outstanding summary");}
}

export async function agingReport(req,res){
 const type=req.query.partyType;if(!partyTypeOk(type))return res.status(400).json({message:"partyType must be customer or supplier"});const {limit,offset}=pageLimit(req)||{};if(!limit)return res.status(400).json({message:"Limit must be 1 to 200 and offset cannot be negative"});const asOf=req.query.asOfDate||new Date().toISOString().slice(0,10);if(!dateOk(asOf))return res.status(400).json({message:"asOfDate must use YYYY-MM-DD"});
 try{const stores=await storesFor(req,res,req.query.storeId);if(!stores)return;if(!stores.length)return res.json({items:[],summary:{},pagination:{limit,offset,total:0},dateBasis:"due_date"});
  const customer=type==="customer",invoice=customer?"sales_invoices":"purchase_invoices",party=customer?"customers":"suppliers",partyId=customer?"customer_id":"supplier_id",returnTable=customer?"sales_invoice_return_credits":"purchase_invoice_return_credits",returnKey=customer?"sales_invoice_id":"purchase_invoice_id",returnAmount=customer?"customer_credit":"supplier_credit",direction=customer?"in":"out";
  const rowsSql=`SELECT i.id AS invoice_id,i.store_id,i.${partyId} AS party_id,i.series,i.invoice_number,i.invoice_date,COALESCE(i.due_date,i.invoice_date+p.payment_terms_days) AS due_date,i.total,
    GREATEST(i.total-COALESCE(a.amount,0)-COALESCE(r.amount,0),0)::numeric(18,2) AS outstanding,(($2::date-COALESCE(i.due_date,i.invoice_date+p.payment_terms_days))::int) AS overdue_days
    FROM ${invoice} i JOIN ${party} p ON p.id=i.${partyId}
    LEFT JOIN LATERAL(SELECT sum(pa.amount) amount FROM payment_allocations pa JOIN payments pm ON pm.id=pa.payment_id AND pm.status='posted' AND pm.direction='${direction}' WHERE pa.${customer?"sales_invoice_id":"purchase_invoice_id"}=i.id) a ON TRUE
    LEFT JOIN LATERAL(SELECT sum(x.${returnAmount}) amount FROM ${returnTable} x WHERE x.${returnKey}=i.id AND x.status='posted') r ON TRUE
    WHERE i.status='posted' AND i.store_id=ANY($1::bigint[]) AND COALESCE(i.due_date,i.invoice_date+p.payment_terms_days)<=$2::date`;
  const q=String(req.query.q||"").trim(),filter=q?" AND (p.name ILIKE $3 OR COALESCE(p.code,'') ILIKE $3)":"";
  const bounds=await connection.query(`WITH invoices AS (${rowsSql}) SELECT COALESCE(sum(outstanding) FILTER(WHERE overdue_days BETWEEN 0 AND 30),0)::numeric(18,2) AS days_0_30,COALESCE(sum(outstanding) FILTER(WHERE overdue_days BETWEEN 31 AND 60),0)::numeric(18,2) AS days_31_60,COALESCE(sum(outstanding) FILTER(WHERE overdue_days BETWEEN 61 AND 90),0)::numeric(18,2) AS days_61_90,COALESCE(sum(outstanding) FILTER(WHERE overdue_days>90),0)::numeric(18,2) AS days_over_90,COALESCE(sum(outstanding),0)::numeric(18,2) AS overdue_total FROM invoices WHERE outstanding>0`,[stores,asOf]);
  const count=await connection.query(`WITH invoices AS (${rowsSql}) SELECT count(*)::int total FROM invoices JOIN ${party} p ON p.id=invoices.party_id WHERE outstanding>0${filter}`,[stores,asOf,...(q?[`%${q}%`]:[])]);
  const data=await connection.query(`WITH invoices AS (${rowsSql}) SELECT invoices.*,p.name AS party_name,p.code AS party_code,s.name AS store_name,CASE WHEN overdue_days<=30 THEN '0-30' WHEN overdue_days<=60 THEN '31-60' WHEN overdue_days<=90 THEN '61-90' ELSE 'over-90' END AS aging_bucket
    FROM invoices JOIN ${party} p ON p.id=invoices.party_id JOIN stores s ON s.id=invoices.store_id WHERE outstanding>0${filter} ORDER BY due_date,store_id,invoice_id LIMIT $${q?4:3} OFFSET $${q?5:4}`,[stores,asOf,...(q?[`%${q}%`]:[]),limit,offset]);
  return res.json({partyType:type,asOfDate:asOf,dateBasis:"Invoice due date; when absent, invoice date plus the party's configured payment terms.",aging:bounds.rows[0],items:data.rows,pagination:{limit,offset,total:count.rows[0].total}});
 }catch(e){return error(res,e,"Unable to calculate invoice aging");}
}

export async function transactionDetails(req,res){
 const map={sales_invoice:{table:"sales_invoices",store:"store_id",items:"sales_invoice_items",fk:"sales_invoice_id",document:true},purchase_invoice:{table:"purchase_invoices",store:"store_id",items:"purchase_invoice_items",fk:"purchase_invoice_id",document:true},sales_return:{table:"sales_returns",store:"store_id",items:"sales_return_items",fk:"sales_return_id",document:true},purchase_return:{table:"purchase_returns",store:"store_id",items:"purchase_return_items",fk:"purchase_return_id",document:true},payment:{table:"payments",store:"store_id"},customer_adjustment:{table:"customer_balance_adjustments",store:"store_id"},supplier_adjustment:{table:"supplier_balance_adjustments",store:"store_id"}};
 const type=req.params.type,id=req.params.id,spec=map[type];if(!spec||!idOk(id))return res.status(400).json({message:"Choose a valid transaction type and ID"});
 try{const result=await connection.query(`SELECT * FROM ${spec.table} WHERE id=$1`,[id]);if(!result.rowCount)return res.status(404).json({message:"Transaction not found"});const row=result.rows[0];const stores=await storesFor(req,res,String(row[spec.store]));if(!stores)return;
  let items=[],allocations=[];if(spec.items){const itemRows=await connection.query(`SELECT * FROM ${spec.items} WHERE ${spec.fk}=$1 ORDER BY id`,[id]);items=itemRows.rows;}
  if(type==="payment")allocations=(await connection.query(`SELECT pa.*,COALESCE(si.invoice_number,pi.invoice_number) AS invoice_number,COALESCE(si.total,pi.total) AS invoice_total
    FROM payment_allocations pa LEFT JOIN sales_invoices si ON si.id=pa.sales_invoice_id LEFT JOIN purchase_invoices pi ON pi.id=pa.purchase_invoice_id WHERE pa.payment_id=$1 ORDER BY pa.id`,[id])).rows;
  return res.json({type,transaction:row,items,allocations});
 }catch(e){return error(res,e,"Unable to load transaction details");}
}

function csvCell(value){const text=value===null||value===undefined?"":String(value);return `"${text.replaceAll('"','""')}"`;}
export async function exportLedger(req,res){
 try{
  const report=await ledgerRequest(req,res,{complete:true});if(!report)return;
  const header=['Date','Store','Type','Reference','Debit','Credit','Running balance','Payment mode','Due date'];
  const carried=(label,value,date)=>{const debit=String(value).startsWith('-')===(report.partyType==='supplier'),absolute=String(value).replace(/^-/,'');return [date||'',report.scope,label,'',debit?absolute:'0.00',debit?'0.00':absolute,value,'',''];};
  const lines=[header,carried('Opening Balance',report.openingBalance,report.fromDate),...report.items.map(row=>[row.entry_date,row.store_name,row.entry_type,row.reference,row.debit,row.credit,row.running_balance,row.payment_method||'',row.due_date||'']),carried('Closing Balance',report.closingBalance,report.toDate),['','','Period totals','',report.totalDebit,report.totalCredit,'','','']];
  const csv=lines.map(line=>line.map(csvCell).join(',')).join('\r\n');res.type('text/csv; charset=utf-8');res.set('Cache-Control','private, no-store');res.set('Content-Disposition','attachment; filename="'+ledgerFilename(report)+'.csv"');return res.send(csv);
 }catch(e){return ledgerError(res,e,'Unable to export ledger');}
}

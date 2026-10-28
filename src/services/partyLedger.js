export function entriesSql(type){
 if(type==="customer")return `SELECT si.customer_id AS party_id,si.store_id,si.invoice_date AS entry_date,'sales_invoice'::text AS entry_type,si.invoice_number AS reference,si.id AS source_id,'sales_invoice'::text AS source_type,si.total AS debit,0::numeric AS credit
  FROM sales_invoices si WHERE si.customer_id=$1 AND si.status='posted' AND si.store_id=ANY($2::bigint[])
 UNION ALL SELECT si.customer_id,pa.store_id,p.payment_date,'customer_receipt',p.payment_number,p.id,'payment',0::numeric,sum(pa.amount)
  FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.direction='in' AND p.status='posted' AND p.store_id=pa.store_id
  JOIN sales_invoices si ON si.id=pa.sales_invoice_id AND si.customer_id=$1 AND si.status='posted' WHERE pa.direction='in' AND pa.store_id=ANY($2::bigint[]) GROUP BY si.customer_id,pa.store_id,p.payment_date,p.payment_number,p.id
 UNION ALL SELECT p.customer_id,p.store_id,p.payment_date,'customer_receipt_advance',p.payment_number,p.id,'payment',0::numeric,GREATEST(p.amount-COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.payment_id=p.id AND pa.direction='in'),0),0)
  FROM payments p WHERE p.customer_id=$1 AND p.direction='in' AND p.status='posted' AND p.store_id=ANY($2::bigint[]) AND p.amount>COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.payment_id=p.id AND pa.direction='in'),0)
 UNION ALL SELECT si.customer_id,r.store_id,r.return_date,'sales_credit_note',r.return_number,r.id,'sales_return',0::numeric,r.total
  FROM sales_return_accounting r JOIN sales_invoices si ON si.id=r.sales_invoice_id WHERE si.customer_id=$1 AND r.status='posted' AND r.store_id=ANY($2::bigint[])
 UNION ALL SELECT si.customer_id,r.store_id,COALESCE(r.refund_payment_date,r.return_date),'customer_refund',COALESCE(r.refund_payment_number,r.return_number),COALESCE(r.refund_payment_id,r.id),CASE WHEN r.refund_payment_id IS NULL THEN 'sales_return' ELSE 'payment' END,r.refund_amount,0::numeric
  FROM sales_return_accounting r JOIN sales_invoices si ON si.id=r.sales_invoice_id WHERE si.customer_id=$1 AND r.status='posted' AND r.refund_amount>0 AND r.store_id=ANY($2::bigint[])
 UNION ALL SELECT a.customer_id,a.store_id,a.adjustment_date,a.adjustment_type,'Adjustment #'||a.id,a.id,'customer_adjustment',CASE WHEN a.direction='debit' THEN a.amount ELSE 0 END,CASE WHEN a.direction='credit' THEN a.amount ELSE 0 END
  FROM customer_balance_adjustments a WHERE a.customer_id=$1 AND a.status='posted' AND a.store_id=ANY($2::bigint[])`;
 return `SELECT pi.supplier_id AS party_id,pi.store_id,pi.invoice_date AS entry_date,'purchase_invoice'::text AS entry_type,pi.invoice_number AS reference,pi.id AS source_id,'purchase_invoice'::text AS source_type,0::numeric AS debit,pi.total AS credit
  FROM purchase_invoices pi WHERE pi.supplier_id=$1 AND pi.status='posted' AND pi.store_id=ANY($2::bigint[])
 UNION ALL SELECT pi.supplier_id,pa.store_id,p.payment_date,'supplier_payment',p.payment_number,p.id,'payment',sum(pa.amount),0::numeric
  FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.direction='out' AND p.status='posted' AND p.store_id=pa.store_id
  JOIN purchase_invoices pi ON pi.id=pa.purchase_invoice_id AND pi.supplier_id=$1 AND pi.status='posted' WHERE pa.direction='out' AND pa.store_id=ANY($2::bigint[]) GROUP BY pi.supplier_id,pa.store_id,p.payment_date,p.payment_number,p.id
 UNION ALL SELECT p.supplier_id,p.store_id,p.payment_date,'supplier_payment_advance',p.payment_number,p.id,'payment',GREATEST(p.amount-COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.payment_id=p.id AND pa.direction='out'),0),0),0::numeric
  FROM payments p WHERE p.supplier_id=$1 AND p.direction='out' AND p.status='posted' AND p.store_id=ANY($2::bigint[]) AND p.amount>COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.payment_id=p.id AND pa.direction='out'),0)
 UNION ALL SELECT pi.supplier_id,r.store_id,r.return_date,'purchase_debit_note',r.return_number,r.id,'purchase_return',r.total,0::numeric
  FROM purchase_return_accounting r JOIN purchase_invoices pi ON pi.id=r.purchase_invoice_id WHERE pi.supplier_id=$1 AND r.status='posted' AND r.store_id=ANY($2::bigint[])
 UNION ALL SELECT pi.supplier_id,r.store_id,COALESCE(r.refund_payment_date,r.return_date),'supplier_refund',COALESCE(r.refund_payment_number,r.return_number),COALESCE(r.refund_payment_id,r.id),'payment',0::numeric,r.refund_amount
 FROM purchase_return_accounting r JOIN purchase_invoices pi ON pi.id=r.purchase_invoice_id WHERE pi.supplier_id=$1 AND r.status='posted' AND r.refund_amount>0 AND r.store_id=ANY($2::bigint[])
 UNION ALL SELECT a.supplier_id,a.store_id,a.adjustment_date,a.adjustment_type,'Adjustment #'||a.id,a.id,'supplier_adjustment',CASE WHEN a.direction='debit' THEN a.amount ELSE 0 END,CASE WHEN a.direction='credit' THEN a.amount ELSE 0 END
  FROM supplier_balance_adjustments a WHERE a.supplier_id=$1 AND a.status='posted' AND a.store_id=ANY($2::bigint[])`;
}

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export async function buildLedger(db,{partyType,id,stores,from,to,complete=false,limit=100,offset=0}){
 const table=partyType==='customer'?'customers':'suppliers';
 const party=(await db.query(`SELECT id,code,name,phone,email,tax_id,address,city,state,pin_code FROM ${table} WHERE id=$1`,[id])).rows[0];
 if(!party)fail('Party not found',404);
 const end=to||(await db.query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date::text date")).rows[0].date;
 if(from&&from>end)fail('From date cannot follow the closing date');
 const business=(await db.query('SELECT id,code,name,address,city,state,pin_code,phone,email,COALESCE(gstin,tax_id) AS gstin FROM stores WHERE id=ANY($1::bigint[]) ORDER BY id',[stores])).rows;
 const entries=entriesSql(partyType),sign=partyType==='customer'?'debit-credit':'credit-debit',params=[id,stores,from,end];
 const period="entry_date <= $4::date AND ($3::date IS NULL OR entry_date >= $3::date)";
 const totals=(await db.query(`WITH entries AS (${entries}) SELECT
  COALESCE(sum(${sign}) FILTER(WHERE $3::date IS NOT NULL AND entry_date<$3::date),0)::numeric(18,2) opening_balance,
  COALESCE(sum(${sign}) FILTER(WHERE entry_date<=$4::date),0)::numeric(18,2) closing_balance,
  COALESCE(sum(debit) FILTER(WHERE ${period}),0)::numeric(18,2) total_debit,
  COALESCE(sum(credit) FILTER(WHERE ${period}),0)::numeric(18,2) total_credit,
  COALESCE(sum(debit+credit) FILTER(WHERE ${period} AND entry_type IN ('sales_invoice','purchase_invoice')),0)::numeric(18,2) invoice_amount,
  COALESCE(sum(debit+credit) FILTER(WHERE ${period} AND entry_type IN ('customer_receipt','customer_receipt_advance','supplier_payment','supplier_payment_advance')),0)::numeric(18,2) payment_amount,
  count(*) FILTER(WHERE ${period})::int total FROM entries`,params)).rows[0];
 if(complete&&totals.total>20000)fail('This ledger contains more than 20,000 transactions. Choose a shorter date range to print or download.',422);
 const bounds=(await db.query(`WITH entries AS (${entries}) SELECT store_id,
  COALESCE(sum(${sign}) FILTER(WHERE $3::date IS NOT NULL AND entry_date<$3::date),0)::numeric(18,2) opening_balance,
  COALESCE(sum(${sign}) FILTER(WHERE entry_date<=$4::date),0)::numeric(18,2) closing_balance FROM entries GROUP BY store_id ORDER BY store_id`,params)).rows;
 // One combined running balance follows the exact displayed order. Per-store
 // balances remain available separately; exports never combine unrelated rows.
 const rows=(await db.query(`WITH entries AS (${entries}),running AS (
  SELECT e.*,sum(${sign}) OVER(ORDER BY entry_date,store_id,entry_type,source_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::numeric(18,2) running_balance,
  sum(${sign}) OVER(PARTITION BY store_id ORDER BY entry_date,entry_type,source_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::numeric(18,2) store_running_balance FROM entries e)
  SELECT r.*,r.entry_date::text AS entry_date,s.name store_name,s.code store_code,p.payment_method,
   COALESCE(si.due_date,si.invoice_date+c.payment_terms_days,pi.due_date,pi.invoice_date+su.payment_terms_days)::text due_date
  FROM running r JOIN stores s ON s.id=r.store_id
  LEFT JOIN payments p ON r.source_type='payment' AND p.id=r.source_id
  LEFT JOIN sales_invoices si ON r.source_type='sales_invoice' AND si.id=r.source_id LEFT JOIN customers c ON c.id=si.customer_id
  LEFT JOIN purchase_invoices pi ON r.source_type='purchase_invoice' AND pi.id=r.source_id LEFT JOIN suppliers su ON su.id=pi.supplier_id
  WHERE ${period} ORDER BY r.entry_date,r.store_id,r.entry_type,r.source_id ${complete?'':'LIMIT $5 OFFSET $6'}`,complete?params:[...params,limit,offset])).rows;
 return {partyType,partyId:String(id),party,business,scope:business.length===1?business[0].name:'All authorized stores',fromDate:from,toDate:end,
  openingBalance:totals.opening_balance,closingBalance:totals.closing_balance,totalDebit:totals.total_debit,totalCredit:totals.total_credit,
  summary:{invoiceAmount:totals.invoice_amount,paymentAmount:totals.payment_amount},items:rows,stores:bounds,pagination:{limit:complete?totals.total:limit,offset:complete?0:offset,total:totals.total},complete};
}

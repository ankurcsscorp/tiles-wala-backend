// Lock in ID order to match manual allocation/finalization, then distribute by
// invoice date and ID. NUMERIC keeps allocation and remainder exact to paise.
export async function oldestCustomerAllocations(db,storeId,customerId,amount){
 const locked=await db.query(`SELECT id FROM sales_invoices
  WHERE store_id=$1 AND customer_id=$2 AND status='posted' ORDER BY id FOR UPDATE`,[storeId,customerId]);
 if(!locked.rowCount)return [];
 const result=await db.query(`WITH balances AS (
  SELECT i.id,i.invoice_date,GREATEST(i.total-
   COALESCE((SELECT sum(a.amount) FROM payment_allocations a JOIN payments p ON p.id=a.payment_id
    WHERE a.sales_invoice_id=i.id AND p.status='posted' AND p.direction='in'),0)-
   COALESCE((SELECT sum(r.customer_credit) FROM sales_invoice_return_credits r WHERE r.sales_invoice_id=i.id AND r.status='posted'),0),0) AS due
  FROM sales_invoices i WHERE i.id=ANY($1::bigint[])
 ), ordered AS (
  SELECT *,COALESCE(sum(due) OVER(ORDER BY invoice_date,id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS covered
  FROM balances WHERE due>0
 ) SELECT id AS invoice_id,LEAST(due,$2::numeric-covered)::numeric(18,2) AS amount
 FROM ordered WHERE $2::numeric>covered ORDER BY invoice_date,id`,[locked.rows.map(row=>row.id),amount]);
 return result.rows.map(row=>({invoiceId:String(row.invoice_id),amount:row.amount}));
}

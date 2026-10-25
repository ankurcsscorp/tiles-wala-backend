import { connection } from "../../connection.js";
import { canAccessStore, canManageStore } from "./stores.js";

const admin = (req) => req.user?.userType?.toLowerCase() === "admin";
const validId = (x) => /^\d+$/.test(String(x ?? ""));
const validQty = (x) => /^\d{1,14}(\.\d{1,4})?$/.test(String(x ?? "")) && /[1-9]/.test(String(x ?? ""));
const validMoney = (x) => /^\d{1,14}(\.\d{1,2})?$/.test(String(x ?? ""));
const dateOk = (x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x ?? ""));
const replyError = (res,e,label) => {
  if (e.status) return res.status(e.status).json({ message: e.message });
  if (["23503","23514","22007","22003","22P02"].includes(e.code)) return res.status(400).json({ message: e.message });
  if (e.code === "23505") return res.status(409).json({ message: "Duplicate return number or request" });
  console.error(label,e.message); return res.status(500).json({ message: label });
};

async function getReturn(kind,id) {
  const sales=kind==="sales";
  const table=sales?"sales_returns":"purchase_returns", invoice=sales?"sales_invoices":"purchase_invoices";
  const party=sales?"customers":"suppliers", fk=sales?"customer_id":"supplier_id";
  const h=await connection.query(`SELECT r.*,i.${fk} AS party_id,i.invoice_number AS original_invoice_number,COALESCE(p.name,${sales?"'Walk-in customer'":"'Supplier'"}) AS party_name,s.name AS store_name,s.code AS store_code,
    a.name AS approved_by_name,c.name AS created_by_name FROM ${table} r JOIN ${invoice} i ON i.id=r.${sales?"sales_invoice_id":"purchase_invoice_id"}
    LEFT JOIN ${party} p ON p.id=i.${fk} JOIN stores s ON s.id=r.store_id LEFT JOIN users a ON a.id=${sales?"r.approved_by":"NULL::bigint"} LEFT JOIN users c ON c.id=r.created_by WHERE r.id=$1`,[id]);
  if(!h.rowCount)return null;
  const items=sales
    ? await connection.query(`SELECT ri.*,si.line_number,si.product_sku_snapshot AS sku,si.product_name_snapshot AS product_name,si.unit_id,si.unit_code_snapshot AS unit_code,si.unit_name_snapshot AS unit_name,si.quantity AS original_quantity,
      COALESCE((SELECT sum(x.quantity) FROM sales_return_items x JOIN sales_returns xr ON xr.id=x.sales_return_id WHERE x.sales_invoice_item_id=ri.sales_invoice_item_id AND xr.status='posted'),0) AS previously_returned_quantity
      FROM sales_return_items ri JOIN sales_invoice_items si ON si.id=ri.sales_invoice_item_id WHERE ri.sales_return_id=$1 ORDER BY ri.id`,[id])
    : await connection.query(`SELECT ri.*,pi.line_number,pi.product_sku_snapshot AS sku,pi.product_name_snapshot AS product_name,pi.unit_id,pi.unit_code_snapshot AS unit_code,pi.unit_name_snapshot AS unit_name,pi.quantity AS original_quantity
      FROM purchase_return_items ri JOIN purchase_invoice_items pi ON pi.id=ri.purchase_invoice_item_id WHERE ri.purchase_return_id=$1 ORDER BY ri.id`,[id]);
  return {...h.rows[0],items:items.rows};
}
async function storeAllowed(req,res,storeId) { if(!await canAccessStore(req.user,storeId)){res.status(403).json({message:"You do not have access to this store"});return false;}return true; }
async function nextNumber(client,storeId,kind,series,date) {
  const period=String(date).slice(0,4);
  await client.query(`INSERT INTO invoice_number_sequences(store_id,document_type,series,period_key,next_number) VALUES($1,$2,$3,$4,1) ON CONFLICT(store_id,document_type,series,period_key) DO NOTHING`,[storeId,kind,series,period]);
  const seq=await client.query("SELECT next_number FROM invoice_number_sequences WHERE store_id=$1 AND document_type=$2 AND series=$3 AND period_key=$4 FOR UPDATE",[storeId,kind,series,period]);
  await client.query("UPDATE invoice_number_sequences SET next_number=next_number+1 WHERE store_id=$1 AND document_type=$2 AND series=$3 AND period_key=$4",[storeId,kind,series,period]);
  return `${series}-${period}-${String(seq.rows[0].next_number).padStart(5,"0")}`;
}

export async function listReturns(req,res) {
  const kind=req.query.type==="purchase"?"purchase":"sales", sales=kind==="sales", table=sales?"sales_returns":"purchase_returns", invoice=sales?"sales_invoices":"purchase_invoices", fk=sales?"sales_invoice_id":"purchase_invoice_id", party=sales?"customers":"suppliers", pfk=sales?"customer_id":"supplier_id";
  try {
    let ids;
    if(admin(req)){const r=await connection.query("SELECT id FROM stores WHERE is_active=TRUE");ids=r.rows.map(x=>String(x.id));}
    else {const r=await connection.query("SELECT store_id AS id FROM user_store_assignments WHERE user_id=$1 AND is_active=TRUE",[req.user.id]);ids=r.rows.map(x=>String(x.id));}
    if(req.query.storeId){if(!validId(req.query.storeId)||!ids.includes(String(req.query.storeId)))return res.status(403).json({message:"You do not have access to this store"});ids=[String(req.query.storeId)];}
    if(!ids.length)return res.json([]);
    const params=[ids], where=[`r.store_id=ANY($1::bigint[])`];
    if(req.query.status){params.push(req.query.status);where.push(`r.status=$${params.length}`);}
    const result=await connection.query(`SELECT r.*,i.invoice_number AS original_invoice_number,COALESCE(p.name,${sales?"'Walk-in customer'":"'Supplier'"}) AS party_name,s.name AS store_name,
      ${sales?"r.approved_at IS NOT NULL AS approved":"TRUE AS approved"} FROM ${table} r JOIN ${invoice} i ON i.id=r.${fk} LEFT JOIN ${party} p ON p.id=i.${pfk} JOIN stores s ON s.id=r.store_id WHERE ${where.join(" AND ")} ORDER BY r.return_date DESC,r.id DESC LIMIT 200`,params);
    return res.json(result.rows);
  } catch(e){return replyError(res,e,"Unable to list returns");}
}

export async function getReturnById(req,res) {
  if(!validId(req.params.id))return res.status(400).json({message:"Invalid return ID"});
  const kind=req.query.type==="purchase"?"purchase":"sales";
  try{const row=await getReturn(kind,req.params.id);if(!row)return res.status(404).json({message:"Return not found"});if(!await storeAllowed(req,res,row.store_id))return;return res.json(row);}catch(e){return replyError(res,e,"Unable to load return");}
}

export async function createReturn(req,res) {
  if(!["sales","purchase"].includes(req.params.type))return res.status(400).json({message:"Return type must be sales or purchase"});
  const sales=req.params.type==="sales", b=req.body||{}, invoiceId=String(b.invoiceId||""), date=b.returnDate||new Date().toISOString().slice(0,10), items=b.items;
  if(!validId(invoiceId)||!dateOk(date)||!Array.isArray(items)||!items.length||items.length>100)return res.status(400).json({message:"Choose an invoice, valid return date, and 1 to 100 item lines"});
  if(items.some(x=>!x||!validId(x.invoiceItemId)||!validQty(x.quantity)||!String(x.reason||b.reason||"").trim()))return res.status(400).json({message:"Every line needs an original invoice line, positive quantity, and reason"});
  if(!sales && items.some(x=>x.disposition))return res.status(400).json({message:"Disposition is only used for sales returns"});
  const reason=String(b.reason||"").trim();
  if(reason.length>1000||String(b.notes||"").length>4000)return res.status(400).json({message:"Return reason or notes are too long"});
  const client=await connection.connect();
  try {
    await client.query("BEGIN");
    const table=sales?"sales_invoices":"purchase_invoices", select=sales?"si.*":"pi.*", alias=sales?"si":"pi";
    const source=await client.query(`SELECT ${select},s.code FROM ${table} ${alias} JOIN stores s ON s.id=${alias}.store_id WHERE ${alias}.id=$1 FOR UPDATE OF ${alias}`,[invoiceId]);
    if(!source.rowCount)throw Object.assign(new Error("Original invoice not found"),{status:404});
    const inv=source.rows[0];if(inv.status!=="posted")throw Object.assign(new Error("Returns require a posted original invoice"),{status:400});
    if(!await storeAllowed(req,res,inv.store_id)){await client.query("ROLLBACK");return;}
    if(b.storeId&&String(b.storeId)!==String(inv.store_id))throw Object.assign(new Error("Return store must match the original invoice"),{status:400});
    const series=`${sales?"SR":"PR"}${inv.code}`.slice(0,32), docType=sales?"sales_return":"purchase_return";
    const number=await nextNumber(client,inv.store_id,docType,series,date), idempotency=String(b.idempotencyKey||"").slice(0,120)||null;
    if(idempotency){const exists=await client.query(`SELECT id FROM ${sales?"sales_returns":"purchase_returns"} WHERE idempotency_key=$1`,[idempotency]);if(exists.rowCount)throw Object.assign(new Error("This return request was already submitted"),{status:409});}
    const header=sales
      ? await client.query(`INSERT INTO sales_returns(store_id,sales_invoice_id,series,return_number,return_date,reason,notes,created_by,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[inv.store_id,invoiceId,series,number,date,reason||null,String(b.notes||"").trim()||null,req.user.id,idempotency])
      : await client.query(`INSERT INTO purchase_returns(store_id,purchase_invoice_id,series,return_number,return_date,reason,notes,created_by,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[inv.store_id,invoiceId,series,number,date,reason||null,String(b.notes||"").trim()||null,req.user.id,idempotency]);
    const id=header.rows[0].id;
    for(const [i,line] of items.entries()){
      const original=await client.query(sales
        ? `SELECT id,product_id,quantity,unit_price,line_total,tax_rate,tax_amount,unit_id FROM sales_invoice_items WHERE id=$1 AND sales_invoice_id=$2 FOR SHARE`
        : `SELECT id,product_id,quantity,unit_price,line_total,tax_rate,tax_amount,unit_id FROM purchase_invoice_items WHERE id=$1 AND purchase_invoice_id=$2 FOR SHARE`,[line.invoiceItemId,invoiceId]);
      if(!original.rowCount)throw Object.assign(new Error(`Line ${i+1} does not belong to the original invoice`),{status:400});
      const src=original.rows[0];
      const prior=await client.query(sales
        ? "SELECT COALESCE(sum(ri.quantity),0) qty FROM sales_return_items ri JOIN sales_returns r ON r.id=ri.sales_return_id WHERE ri.sales_invoice_item_id=$1 AND r.status='posted'"
        : "SELECT COALESCE(sum(ri.quantity),0) qty FROM purchase_return_items ri JOIN purchase_returns r ON r.id=ri.purchase_return_id WHERE ri.purchase_invoice_item_id=$1 AND r.status='posted'",[src.id]);
      const eligible=sales?src.quantity:(await client.query(`SELECT COALESCE(sum(pri.quantity_received) FILTER(WHERE pr.status='posted'),0)::numeric received FROM purchase_receipt_items pri JOIN purchase_receipts pr ON pr.id=pri.receipt_id WHERE pri.purchase_invoice_item_id=$1`,[src.id])).rows[0].received;
      const within=await client.query("SELECT $1::numeric + $2::numeric <= $3::numeric AS valid",[prior.rows[0].qty,line.quantity,eligible]);
      if(!within.rows[0].valid)throw Object.assign(new Error(`Line ${i+1} exceeds the remaining ${sales?"invoiced":"received"} returnable quantity`),{status:400});
      const calculated=await client.query("SELECT round($1::numeric*$2::numeric/$3::numeric,2)::numeric(18,2) amount,round($4::numeric*$2::numeric/$3::numeric,2)::numeric(18,2) tax",[src.line_total,line.quantity,src.quantity,src.tax_amount]);
      const amount=calculated.rows[0].amount,tax=calculated.rows[0].tax;
      if(sales){
        const dispositions={restock:String(line.restockQuantity??(line.disposition==="restock"?line.quantity:0)),quarantine:String(line.quarantinedQuantity??(line.disposition==="damaged"||line.disposition==="quarantined"?line.quantity:0)),supplier:String(line.supplierReturnPendingQuantity??(line.disposition==="supplier_return_pending"?line.quantity:0))};
        if(Object.values(dispositions).some(x=>!/^\d{1,14}(\.\d{1,4})?$/.test(x))||!(await client.query("SELECT $1::numeric+$2::numeric+$3::numeric=$4::numeric AS valid",[dispositions.restock,dispositions.quarantine,dispositions.supplier,line.quantity])).rows[0].valid)throw Object.assign(new Error(`Line ${i+1} dispositions must add up to the return quantity`),{status:400});
        const condition=line.productCondition||"resalable";if(!["resalable","damaged","unsuitable"].includes(condition))throw Object.assign(new Error(`Line ${i+1} has an invalid product condition`),{status:400});
        if(condition!=="resalable"&&(await client.query("SELECT $1::numeric>0 AS value",[dispositions.restock])).rows[0].value)throw Object.assign(new Error(`Line ${i+1}: damaged or unsuitable goods cannot be restocked as sellable inventory`),{status:400});
        await client.query(`INSERT INTO sales_return_items(sales_return_id,sales_invoice_item_id,product_id,quantity,unit_price,line_total,reason,product_condition,restock_quantity,quarantined_quantity,supplier_return_pending_quantity,tax_rate,tax_adjustment)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,src.id,src.product_id,line.quantity,src.unit_price,amount,String(line.reason||reason).trim(),condition,dispositions.restock,dispositions.quarantine,dispositions.supplier,src.tax_rate,tax]);
      } else {
        await client.query(`INSERT INTO purchase_return_items(purchase_return_id,purchase_invoice_item_id,product_id,quantity,unit_cost,line_total,reason,tax_rate,tax_adjustment) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,src.id,src.product_id,line.quantity,src.unit_price,amount,String(line.reason||reason).trim(),src.tax_rate,tax]);
      }
    }
    const amounts=await client.query(sales?"SELECT COALESCE(sum(line_total),0)::numeric(18,2) AS total,COALESCE(sum(tax_adjustment),0)::numeric(18,2) AS tax FROM sales_return_items WHERE sales_return_id=$1":"SELECT COALESCE(sum(line_total),0)::numeric(18,2) AS total,COALESCE(sum(tax_adjustment),0)::numeric(18,2) AS tax FROM purchase_return_items WHERE purchase_return_id=$1",[id]);
    const taxAdjustment=String(amounts.rows[0].tax);
    const calculatedTotal=await client.query("SELECT ($1::numeric+$2::numeric-$3::numeric)::numeric(18,2) AS total",[amounts.rows[0].total,taxAdjustment,amounts.rows[0].tax]);
    const amountTotal=calculatedTotal.rows[0].total;
    if(sales){
      const refund=String(b.refundAmount??0);if(!validMoney(refund)||!(await client.query("SELECT $1::numeric <= $2::numeric AS valid",[refund,amountTotal])).rows[0].valid)throw Object.assign(new Error("Refund cannot exceed the return credit"),{status:400});
      const credit=(await client.query("SELECT ($1::numeric-$2::numeric)::numeric(18,2) AS amount",[amountTotal,refund])).rows[0].amount,method=b.refundMethod||null;
      if(refund!=="0"&&(!method||!['cash','upi','card','bank_transfer','cheque','other'].includes(method)))throw Object.assign(new Error("Choose a valid refund method"),{status:400});
      await client.query("UPDATE sales_returns SET total=$2,tax_adjustment=$3,refund_amount=$4,customer_credit=$5,refund_method=$6,refund_reference=$7 WHERE id=$1",[id,amountTotal,taxAdjustment,refund,credit,method,String(b.refundReference||"").slice(0,120)||null]);
    }else{
      await client.query("UPDATE purchase_returns SET total=$2,tax_adjustment=$3,supplier_credit=$2 WHERE id=$1",[id,amountTotal,taxAdjustment]);
    }
    await client.query("INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,$3,$4,$5,$6)",[inv.store_id,req.user.id,`${sales?"sales":"purchase"}_return.created`,`${sales?"sales":"purchase"}_return`,id,{returnNumber:number,invoiceId,items,total:amountTotal,refundAmount:sales?String(b.refundAmount??0):null,customerCredit:sales?String((await client.query("SELECT customer_credit FROM sales_returns WHERE id=$1",[id])).rows[0].customer_credit):null,supplierCredit:sales?null:amountTotal}]);
    await client.query("COMMIT");return res.status(201).json(await getReturn(sales?"sales":"purchase",id));
  }catch(e){await client.query("ROLLBACK").catch(()=>{});return replyError(res,e,"Unable to create return");}finally{client.release();}
}

export async function approveSalesReturn(req,res){
  if(!validId(req.params.id))return res.status(400).json({message:"Invalid return ID"});
  const client=await connection.connect();try{await client.query("BEGIN");const r=await client.query("SELECT * FROM sales_returns WHERE id=$1 FOR UPDATE",[req.params.id]);if(!r.rowCount)throw Object.assign(new Error("Sales return not found"),{status:404});if(!await storeAllowed(req,res,r.rows[0].store_id)){await client.query("ROLLBACK");return;}if(r.rows[0].status!=="draft"||r.rows[0].approved_at)throw Object.assign(new Error("Only an unapproved draft can be approved"),{status:409});if(!admin(req)){const a=await client.query("SELECT role FROM user_store_assignments WHERE user_id=$1 AND store_id=$2 AND is_active=TRUE",[req.user.id,r.rows[0].store_id]);if(!a.rowCount||!['owner','manager'].includes(a.rows[0].role))throw Object.assign(new Error("Manager approval is required"),{status:403});}
    const updated=await client.query("UPDATE sales_returns SET approved_by=$2,approved_at=now() WHERE id=$1 RETURNING id",[req.params.id,req.user.id]);await client.query("INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'sales_return.approved','sales_return',$3,$4)",[r.rows[0].store_id,req.user.id,req.params.id,{approvedAt:new Date().toISOString()}]);await client.query("COMMIT");return res.json(await getReturn("sales",updated.rows[0].id));
  }catch(e){await client.query("ROLLBACK").catch(()=>{});return replyError(res,e,"Unable to approve sales return");}finally{client.release();}}

export async function postReturn(req,res){
  if(!["sales","purchase"].includes(req.params.type))return res.status(400).json({message:"Return type must be sales or purchase"});
  const sales=req.params.type==="sales",table=sales?"sales_returns":"purchase_returns";if(!validId(req.params.id))return res.status(400).json({message:"Invalid return ID"});
  const client=await connection.connect();try{await client.query("BEGIN");const r=await client.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`,[req.params.id]);if(!r.rowCount)throw Object.assign(new Error("Return not found"),{status:404});const row=r.rows[0];if(!await storeAllowed(req,res,row.store_id)){await client.query("ROLLBACK");return;}if(row.status!=="draft")throw Object.assign(new Error("Only a draft return can be posted"),{status:409});if(sales&&(!row.approved_at||!row.approved_by))throw Object.assign(new Error("Sales return requires manager approval"),{status:409});if(!sales&&!await canManageStore(req.user,row.store_id,["owner","manager"],client)){await client.query("ROLLBACK");return res.status(403).json({message:"Manager authorization is required to post a purchase return"});}
    await client.query(`UPDATE ${table} SET status='posted',posted_at=now() WHERE id=$1`,[row.id]);await client.query("INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$7)",[row.store_id,req.user.id,`${sales?"sales":"purchase"}_return.posted`,`${sales?"sales":"purchase"}_return`,row.id,{status:"draft"},{status:"posted",total:row.total}]);await client.query("COMMIT");return res.json(await getReturn(sales?"sales":"purchase",row.id));
  }catch(e){await client.query("ROLLBACK").catch(()=>{});return replyError(res,e,"Unable to post return");}finally{client.release();}}

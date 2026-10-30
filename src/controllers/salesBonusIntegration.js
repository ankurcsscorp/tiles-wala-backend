import { calculateSalesBonusRow } from "../utils/salesBonusCalculator.js";

// Carries return-driven overpayments forward against the recipient's later
// approved bonus entitlement. This is computed from the immutable payment and
// adjustment ledgers, so it can be rebuilt without changing historical rows.
export function applyRecipientRecoveryLedger(records) {
  let recoveryBalance = 0;
  const recoveryDebts = [];
  const recoveryDueByRecord = new Map();
  const recoveredByRecord = new Map();
  const ordered = [...records].sort((a,b) =>
    new Date(a.created_at || 0) - new Date(b.created_at || 0) || Number(a.id) - Number(b.id)
  );
  const allocations = new Map();
  for (const record of ordered) {
    const adjustments = Number(record.adjustments || 0);
    const earned = Math.max(0, Number(record.source_sales_invoice_id
      ? record.approved_bonus
      : record.final_user_bonus) + adjustments);
    const paid = Number(record.total_amount_paid || 0);
    const recoverable = Math.max(earned - paid, 0);
    const recoveryOffset = Math.min(recoveryBalance, recoverable);
    let offsetRemaining = recoveryOffset;
    while (offsetRemaining > 0.001 && recoveryDebts.length) {
      const debt = recoveryDebts[0];
      const settled = Math.min(debt.amount, offsetRemaining);
      debt.amount = Number((debt.amount - settled).toFixed(2));
      offsetRemaining = Number((offsetRemaining - settled).toFixed(2));
      recoveredByRecord.set(debt.recordId, Number(((recoveredByRecord.get(debt.recordId) || 0) + settled).toFixed(2)));
      if (debt.amount <= 0.001) recoveryDebts.shift();
    }
    const newRecovery = Number(Math.max(paid - earned, 0).toFixed(2));
    if (newRecovery > 0) {
      recoveryDebts.push({ recordId: String(record.id), amount: newRecovery });
      recoveryDueByRecord.set(String(record.id), newRecovery);
    }
    recoveryBalance = Number(recoveryDebts.reduce((sum, debt) => sum + debt.amount, 0).toFixed(2));

    const payableLimit = record.source_sales_invoice_id
      ? Number(record.payable_amount || 0)
      : Number(record.final_user_bonus || 0);
    const unpaidPayable = Math.max(Math.min(earned, payableLimit) - paid, 0);
    const payableOffset = Math.min(recoveryOffset, unpaidPayable);
    const effectiveDue = Number(Math.max(unpaidPayable - payableOffset, 0).toFixed(2));
    allocations.set(String(record.id), {
      recovery_offset: Number(recoveryOffset.toFixed(2)),
      effective_due: effectiveDue,
      admin_effective_due: Number(Math.max(recoverable - recoveryOffset, 0).toFixed(2)),
      effective_awaiting_collection: Number(Math.max(recoverable - recoveryOffset - effectiveDue, 0).toFixed(2)),
      earned_after_adjustments: Number(earned.toFixed(2)),
    });
  }
  for (const [recordId, recoveryDue] of recoveryDueByRecord) {
    const settled = recoveredByRecord.get(recordId) || 0;
    const allocation = allocations.get(recordId);
    allocations.set(recordId, {
      ...allocation,
      recovery_settled: Number(settled.toFixed(2)),
      recovery_open: Number(Math.max(recoveryDue - settled, 0).toFixed(2)),
    });
  }
  return { allocations, recoveryBalance: Number(recoveryBalance.toFixed(2)) };
}

export async function refreshInvoiceBonusPayability(client, invoiceId) {
  const invoiceResult=await client.query(`SELECT id,total,status FROM sales_invoices WHERE id=$1`,[invoiceId]);
  const invoice=invoiceResult.rows[0];if(!invoice)return;
  const collected=await client.query(`SELECT COALESCE(sum(pa.amount),0)::numeric(18,2) amount FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.status='posted' WHERE pa.sales_invoice_id=$1 AND pa.direction='in'`,[invoiceId]);
  const ratio=Number(invoice.total)>0?Math.min(Number(collected.rows[0].amount)/Number(invoice.total),1):0;
  const records=await client.query(`SELECT br.id,br.status,br.approved_by,br.approved_bonus,br.total_amount_paid,br.admin_payment_override,COALESCE(a.adjustments,0)::numeric(12,2) adjustments FROM sales_bonus_records br LEFT JOIN LATERAL(SELECT sum(amount) adjustments FROM sales_bonus_adjustments WHERE sales_bonus_record_id=br.id) a ON TRUE WHERE br.source_sales_invoice_id=$1 FOR UPDATE OF br`,[invoiceId]);
  for(const record of records.rows){
    if(!record.approved_by||['reversed','on_hold'].includes(record.status))continue;
    const approved=Number(record.approved_bonus),earned=Math.max(0,approved+Number(record.adjustments));
    const payable=record.admin_payment_override?earned:Math.min(earned,Number((approved*ratio).toFixed(2)));
    const paid=Number(record.total_amount_paid);
    const status=paid>=earned&&earned>0?'paid':paid>0?'partially_paid':payable<earned?'partially_payable':'payable';
    await client.query(`UPDATE sales_bonus_records SET payable_amount=$1,status=$2,updated_at=now() WHERE id=$3`,[payable,status,record.id]);
  }
}

function allocateInvoiceDiscount(items,invoiceDiscount){
  const rows=items.map((line)=>{const gross=Math.round(Number(line.quantity)*Number(line.unitPrice)*100)/100;return {...line,gross,base:Math.max(0,Math.round((gross-Number(line.discountAmount||0))*100)/100)};});
  const total=rows.reduce((sum,line)=>sum+line.base,0),discount=Math.max(0,Number(invoiceDiscount)||0);let used=0;
  return rows.map((line,index)=>{const allocated=index===rows.length-1?Math.round((discount-used)*100)/100:total?Math.round(discount*line.base/total*100)/100:0;used+=allocated;return {...line,netSelling:Math.max(0,Math.round((line.base-allocated)*100)/100)};});
}

export function calculateBonusRows(lines,recipient){
  return lines.map(line=>{const sellingPrice=Number(line.taxable_value??line.netSelling)/Number(line.quantity);const result=calculateSalesBonusRow({costPrice:line.default_cost_price,sellingPrice,quantity:line.quantity,bonusRate:line.default_bonus_percentage,userType:recipient.user_type});return {line,sellingPrice,...result,bonusRate:Number(line.default_bonus_percentage),costPrice:Number(line.default_cost_price)};});
}

function sumBonusRows(rows){return rows.reduce((a,x)=>({quantity:a.quantity+Number(x.line.quantity),cost:a.cost+x.totalCost,sales:a.sales+x.totalSellingAmount,profit:a.profit+x.grossProfit,grossBonus:a.grossBonus+x.grossBonus,userBonus:a.userBonus+x.userBonus}),{quantity:0,cost:0,sales:0,profit:0,grossBonus:0,userBonus:0});}

export async function quoteSalesInvoiceBonus(client,{referredByUserId,items,invoiceDiscount=0}){
  const recipientResult=referredByUserId?await client.query(`SELECT id,name,user_type FROM users WHERE id=$1 AND is_active=TRUE AND user_type IN ('Salesperson','Tile Mistire')`,[referredByUserId]):{rows:[]};
  if(!recipientResult.rows.length)return {recipient:null,items:[],totals:null,reason:'no_eligible_recipient'};
  const allocated=allocateInvoiceDiscount(items,invoiceDiscount),configured=[];
  for(const line of allocated){
    const result=await client.query(`SELECT p.name,p.category_id,u.name unit_name,c.default_cost_price,c.default_bonus_percentage,c.unit_label
      FROM products p JOIN units_of_measure u ON u.id=$2
      JOIN sales_bonus_product_config c ON c.is_active=TRUE AND (c.product_id=p.id OR (c.product_id IS NULL AND c.product_name=p.name))
        AND (c.eligible_category_id IS NULL OR c.eligible_category_id=p.category_id) AND lower(trim(c.unit_label))=lower(trim(u.name))
      WHERE p.id=$1 AND p.is_active=TRUE ORDER BY (c.product_id=p.id) DESC,c.id LIMIT 1`,[line.productId,line.unitId]);
    if(result.rowCount)configured.push({...line,...result.rows[0],taxable_value:line.netSelling});
  }
  const rows=calculateBonusRows(configured,recipientResult.rows[0]);
  return {recipient:recipientResult.rows[0],items:rows.map(x=>({productName:x.line.name,quantity:x.line.quantity,costPrice:x.costPrice,sellingPrice:x.sellingPrice,grossProfit:x.grossProfit,bonusRate:x.bonusRate,bonus:x.userBonus})),totals:sumBonusRows(rows),reason:rows.length?'quoted':'no_configured_products'};
}

export async function processSalesInvoiceBonus(client, invoiceId, actorId) {
  const settings = await client.query("SELECT is_enabled,eligibility_basis FROM sales_bonus_integration_settings WHERE id=1");
  if (!settings.rows[0]?.is_enabled) return { processed: false, reason: "disabled" };
  const invoiceResult = await client.query(`SELECT id,store_id,total,status,referred_by_user_id,referred_by_name_snapshot,invoice_number
    FROM sales_invoices WHERE id=$1 FOR UPDATE`, [invoiceId]);
  const invoice = invoiceResult.rows[0];
  if (!invoice || invoice.status !== "posted") return { processed: false, reason: "invoice_not_posted" };
  const recipients = await client.query(`SELECT DISTINCT u.id,u.user_type,u.name FROM users u
    WHERE u.id=$2 AND u.user_type IN ('Salesperson','Tile Mistire')
    UNION SELECT u.id,u.user_type,u.name FROM sales_invoice_bonus_recipients r JOIN users u ON u.id=r.user_id
      WHERE r.sales_invoice_id=$1 AND u.user_type IN ('Salesperson','Tile Mistire')`,[invoiceId,invoice.referred_by_user_id]);
  if (!recipients.rows.length) return { processed: false, reason: "no_eligible_recipient" };

  const lineResult = await client.query(`SELECT li.id,li.product_name_snapshot,li.product_snapshot,li.unit_name_snapshot,
      li.quantity,li.unit_price,li.taxable_value,p.category_id,c.default_cost_price,c.default_bonus_percentage,c.unit_label
    FROM sales_invoice_items li JOIN products p ON p.id=li.product_id
    JOIN LATERAL(SELECT config.default_cost_price,config.default_bonus_percentage,config.unit_label FROM sales_bonus_product_config config
      WHERE config.is_active=TRUE AND (config.product_id=p.id OR (config.product_id IS NULL AND config.product_name=li.product_name_snapshot))
        AND (config.eligible_category_id IS NULL OR config.eligible_category_id=(li.product_snapshot->>'categoryId')::bigint)
        AND lower(trim(config.unit_label))=lower(trim(COALESCE(li.unit_name_snapshot,'')))
      ORDER BY (config.product_id=p.id) DESC,config.id LIMIT 1)c ON TRUE
    WHERE li.sales_invoice_id=$1 ORDER BY li.line_number`, [invoiceId]);
  if (!lineResult.rowCount) return { processed: false, reason: "no_configured_products" };

  let processed = 0;
  for (const recipient of recipients.rows) {
    const exists = await client.query("SELECT id FROM sales_bonus_records WHERE source_sales_invoice_id=$1 AND user_id=$2", [invoiceId, recipient.id]);
    if (exists.rowCount) continue;
    const rows = calculateBonusRows(lineResult.rows,recipient);
    const totals = sumBonusRows(rows);
    const record = await client.query(`INSERT INTO sales_bonus_records(user_id,selected_user_type,total_quantity,total_cost,total_selling_amount,
        total_gross_profit,total_gross_bonus,final_user_bonus,status,source_sales_invoice_id,store_id,recipient_name_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending_approval',$9,$10,$11) ON CONFLICT(source_sales_invoice_id,user_id)
      WHERE source_sales_invoice_id IS NOT NULL DO NOTHING RETURNING id`,
    [recipient.id,recipient.user_type,totals.quantity,totals.cost,totals.sales,totals.profit,totals.grossBonus,totals.userBonus,invoiceId,invoice.store_id,recipient.name||invoice.referred_by_name_snapshot]);
    if (!record.rowCount) continue;
    for (const x of rows) await client.query(`INSERT INTO sales_bonus_record_items(sales_bonus_record_id,product_name,cost_price,selling_price,quantity,
        total_cost,total_selling_amount,gross_profit,bonus_percentage,gross_bonus,user_bonus,source_sales_invoice_item_id,category_id_snapshot,unit_label_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [record.rows[0].id,x.line.product_name_snapshot,x.costPrice,x.sellingPrice,x.line.quantity,x.totalCost,x.totalSellingAmount,x.grossProfit,
      x.bonusRate,x.grossBonus,x.userBonus,x.line.id,x.line.category_id,x.line.unit_name_snapshot]);
    await client.query(`INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id,after_data)
      VALUES($1,$2,'sales_bonus.invoice.processed','sales_invoice',$3,$4)`,
    [invoice.store_id,actorId,invoiceId,{bonusRecordId:record.rows[0].id,recipientId:recipient.id,basis:settings.rows[0].eligibility_basis,amount:totals.userBonus}]);
    processed++;
  }
  await refreshInvoiceBonusPayability(client,invoiceId);
  return { processed: processed > 0, count: processed };
}

export async function adjustInvoiceBonusForReturn(client, returnId, actorId) {
  const result = await client.query(`SELECT r.store_id,li.sales_invoice_id,ri.id AS return_item_id,ri.sales_invoice_item_id,ri.quantity,
      li.quantity AS invoice_quantity,bi.sales_bonus_record_id,bi.user_bonus
    FROM sales_returns r JOIN sales_return_items ri ON ri.sales_return_id=r.id
    JOIN sales_invoice_items li ON li.id=ri.sales_invoice_item_id
    JOIN sales_bonus_record_items bi ON bi.source_sales_invoice_item_id=li.id
    JOIN sales_bonus_records br ON br.id=bi.sales_bonus_record_id AND br.source_sales_invoice_id=li.sales_invoice_id
    WHERE r.id=$1 AND r.status='posted'`, [returnId]);
  const invoiceIds=new Set();
  for (const row of result.rows) {
    invoiceIds.add(String(row.sales_invoice_id));
    const amount = await client.query("SELECT -round($1::numeric*$2::numeric/$3::numeric,2)::numeric(12,2) AS amount", [row.user_bonus,row.quantity,row.invoice_quantity]);
    if (amount.rows[0].amount === "0.00" || Number(amount.rows[0].amount) === 0) continue;
    const inserted = await client.query(`INSERT INTO sales_bonus_adjustments(sales_bonus_record_id,store_id,source_type,source_id,source_item_id,amount,reason,created_by)
      VALUES($1,$2,'sales_return_item',$3,$4,$5,'Posted sales return',$6) ON CONFLICT DO NOTHING RETURNING id`,
    [row.sales_bonus_record_id,row.store_id,returnId,row.return_item_id,amount.rows[0].amount,actorId]);
    if (inserted.rowCount) await client.query(`INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id,after_data)
      VALUES($1,$2,'sales_bonus.return.adjusted','sales_invoice',$3,$4)`,
    [row.store_id,actorId,row.sales_invoice_id,{returnId,returnItemId:row.return_item_id,adjustment:amount.rows[0].amount}]);
  }
  for(const invoiceId of invoiceIds)await refreshInvoiceBonusPayability(client,invoiceId);
}

export async function reverseInvoiceBonus(client, invoiceId, actorId, storeId) {
  const records = await client.query(`SELECT id,final_user_bonus,COALESCE((SELECT sum(amount) FROM sales_bonus_adjustments a WHERE a.sales_bonus_record_id=br.id),0) AS adjustments
    FROM sales_bonus_records br WHERE source_sales_invoice_id=$1 FOR UPDATE`, [invoiceId]);
  for (const record of records.rows) {
    const current = await client.query("SELECT ($1::numeric+$2::numeric)::numeric(12,2) AS amount", [record.final_user_bonus,record.adjustments]);
    if (Number(current.rows[0].amount) <= 0) {await client.query("UPDATE sales_bonus_records SET status='reversed',payable_amount=0,updated_at=now() WHERE id=$1",[record.id]);continue;}
    const adjustment = await client.query(`INSERT INTO sales_bonus_adjustments(sales_bonus_record_id,store_id,source_type,source_id,source_item_id,amount,reason,created_by)
      VALUES($1,$2,'invoice_reversal',$3,0,-$4::numeric,'Sales invoice reversed',$5) ON CONFLICT DO NOTHING RETURNING id`,
    [record.id,storeId,invoiceId,current.rows[0].amount,actorId]);
    if (adjustment.rowCount) await client.query(`INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id,after_data)
      VALUES($1,$2,'sales_bonus.invoice.reversed','sales_invoice',$3,$4)`, [storeId,actorId,invoiceId,{bonusRecordId:record.id,adjustment:`-${current.rows[0].amount}`}]);
    await client.query("UPDATE sales_bonus_records SET status='reversed',payable_amount=0,updated_at=now() WHERE id=$1",[record.id]);
  }
}

import { calculateSalesBonusRow } from "../utils/salesBonusCalculator.js";

export async function processSalesInvoiceBonus(client, invoiceId, actorId) {
  const settings = await client.query("SELECT is_enabled,eligibility_basis FROM sales_bonus_integration_settings WHERE id=1");
  if (!settings.rows[0]?.is_enabled) return { processed: false, reason: "disabled" };
  const invoiceResult = await client.query(`SELECT id,store_id,total,status,created_by,salesperson_user_id
    FROM sales_invoices WHERE id=$1 FOR UPDATE`, [invoiceId]);
  const invoice = invoiceResult.rows[0];
  if (!invoice || invoice.status !== "posted") return { processed: false, reason: "invoice_not_posted" };
  if (settings.rows[0].eligibility_basis === "fully_collected") {
    const paid = await client.query(`SELECT COALESCE(sum(pa.amount),0)::numeric(18,2) AS amount
      FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.status='posted'
      WHERE pa.sales_invoice_id=$1 AND pa.direction='in'`, [invoiceId]);
    const fullyPaid = await client.query("SELECT $1::numeric >= $2::numeric AS yes", [paid.rows[0].amount, invoice.total]);
    if (!fullyPaid.rows[0].yes) return { processed: false, reason: "not_fully_collected" };
  }
  const recipients = await client.query(`SELECT DISTINCT u.id,u.user_type FROM users u
    WHERE u.id=COALESCE($2,$3) AND u.user_type='Salesperson'
    UNION SELECT u.id,u.user_type FROM sales_invoice_bonus_recipients r JOIN users u ON u.id=r.user_id
      WHERE r.sales_invoice_id=$1 AND u.user_type IN ('Salesperson','Tile Mistire')`,
  [invoiceId, invoice.salesperson_user_id, invoice.created_by]);
  if (!recipients.rowCount) return { processed: false, reason: "no_eligible_recipient" };

  const lineResult = await client.query(`SELECT li.id,li.product_name_snapshot,li.product_snapshot,li.unit_name_snapshot,
      li.quantity,li.unit_price,li.taxable_value,p.category_id,c.default_cost_price,c.default_bonus_percentage,c.unit_label
    FROM sales_invoice_items li JOIN products p ON p.id=li.product_id
    JOIN sales_bonus_product_config c ON c.is_active=TRUE
      AND (c.product_id=p.id OR (c.product_id IS NULL AND c.product_name=li.product_name_snapshot))
      AND (c.eligible_category_id IS NULL OR c.eligible_category_id=(li.product_snapshot->>'categoryId')::bigint)
      AND lower(trim(c.unit_label))=lower(trim(COALESCE(li.unit_name_snapshot,'')))
    WHERE li.sales_invoice_id=$1 ORDER BY li.line_number`, [invoiceId]);
  if (!lineResult.rowCount) return { processed: false, reason: "no_configured_products" };

  let processed = 0;
  for (const recipient of recipients.rows) {
    const exists = await client.query("SELECT id FROM sales_bonus_records WHERE source_sales_invoice_id=$1 AND user_id=$2", [invoiceId, recipient.id]);
    if (exists.rowCount) continue;
    const rows = lineResult.rows.map((line) => {
      // Invoice discounts are already allocated into taxable_value; tax and charges never count as product sales.
      const sellingPrice = Number(line.taxable_value) / Number(line.quantity);
      const computed = calculateSalesBonusRow({ costPrice: line.default_cost_price, sellingPrice, quantity: line.quantity,
        bonusRate: line.default_bonus_percentage, userType: recipient.user_type });
      return { line, sellingPrice, ...computed, bonusRate: Number(line.default_bonus_percentage), costPrice: Number(line.default_cost_price) };
    });
    const totals = rows.reduce((a, x) => ({
      quantity: a.quantity + Number(x.line.quantity), cost: a.cost + x.totalCost,
      sales: a.sales + x.totalSellingAmount, profit: a.profit + x.grossProfit,
      grossBonus: a.grossBonus + x.grossBonus, userBonus: a.userBonus + x.userBonus,
    }), { quantity: 0, cost: 0, sales: 0, profit: 0, grossBonus: 0, userBonus: 0 });
    const record = await client.query(`INSERT INTO sales_bonus_records(user_id,selected_user_type,total_quantity,total_cost,total_selling_amount,
        total_gross_profit,total_gross_bonus,final_user_bonus,status,source_sales_invoice_id,store_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'posted',$9,$10) ON CONFLICT(source_sales_invoice_id,user_id)
      WHERE source_sales_invoice_id IS NOT NULL DO NOTHING RETURNING id`,
    [recipient.id,recipient.user_type,totals.quantity,totals.cost,totals.sales,totals.profit,totals.grossBonus,totals.userBonus,invoiceId,invoice.store_id]);
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
  return { processed: processed > 0, count: processed };
}

export async function adjustInvoiceBonusForReturn(client, returnId, actorId) {
  const result = await client.query(`SELECT r.store_id,r.sales_invoice_id,ri.id AS return_item_id,ri.sales_invoice_item_id,ri.quantity,
      li.quantity AS invoice_quantity,bi.sales_bonus_record_id,bi.user_bonus
    FROM sales_returns r JOIN sales_return_items ri ON ri.sales_return_id=r.id
    JOIN sales_invoice_items li ON li.id=ri.sales_invoice_item_id
    JOIN sales_bonus_record_items bi ON bi.source_sales_invoice_item_id=li.id
    JOIN sales_bonus_records br ON br.id=bi.sales_bonus_record_id AND br.source_sales_invoice_id=r.sales_invoice_id
    WHERE r.id=$1 AND r.status='posted'`, [returnId]);
  for (const row of result.rows) {
    const amount = await client.query("SELECT -round($1::numeric*$2::numeric/$3::numeric,2)::numeric(12,2) AS amount", [row.user_bonus,row.quantity,row.invoice_quantity]);
    if (amount.rows[0].amount === "0.00" || Number(amount.rows[0].amount) === 0) continue;
    const inserted = await client.query(`INSERT INTO sales_bonus_adjustments(sales_bonus_record_id,store_id,source_type,source_id,source_item_id,amount,reason,created_by)
      VALUES($1,$2,'sales_return_item',$3,$4,$5,'Posted sales return',$6) ON CONFLICT DO NOTHING RETURNING id`,
    [row.sales_bonus_record_id,row.store_id,returnId,row.return_item_id,amount.rows[0].amount,actorId]);
    if (inserted.rowCount) await client.query(`INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id,after_data)
      VALUES($1,$2,'sales_bonus.return.adjusted','sales_invoice',$3,$4)`,
    [row.store_id,actorId,row.sales_invoice_id,{returnId,returnItemId:row.return_item_id,adjustment:amount.rows[0].amount}]);
  }
}

export async function reverseInvoiceBonus(client, invoiceId, actorId, storeId) {
  const records = await client.query(`SELECT id,final_user_bonus,COALESCE((SELECT sum(amount) FROM sales_bonus_adjustments a WHERE a.sales_bonus_record_id=br.id),0) AS adjustments
    FROM sales_bonus_records br WHERE source_sales_invoice_id=$1 FOR UPDATE`, [invoiceId]);
  for (const record of records.rows) {
    const current = await client.query("SELECT ($1::numeric+$2::numeric)::numeric(12,2) AS amount", [record.final_user_bonus,record.adjustments]);
    if (Number(current.rows[0].amount) <= 0) continue;
    const adjustment = await client.query(`INSERT INTO sales_bonus_adjustments(sales_bonus_record_id,store_id,source_type,source_id,source_item_id,amount,reason,created_by)
      VALUES($1,$2,'invoice_reversal',$3,0,-$4::numeric,'Sales invoice reversed',$5) ON CONFLICT DO NOTHING RETURNING id`,
    [record.id,storeId,invoiceId,current.rows[0].amount,actorId]);
    if (adjustment.rowCount) await client.query(`INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id,after_data)
      VALUES($1,$2,'sales_bonus.invoice.reversed','sales_invoice',$3,$4)`, [storeId,actorId,invoiceId,{bonusRecordId:record.id,adjustment:`-${current.rows[0].amount}`}]);
  }
}

import { connection } from "../../connection.js";
import { randomUUID } from "node:crypto";
import { applyRecipientRecoveryLedger, refreshInvoiceBonusPayability } from "./salesBonusIntegration.js";
import { hasPermission } from "../services/permissions.js";
import {
  calculateSalesBonusSummary,
  SalesBonusValidationError,
  validateSalesBonusSummary,
  validateSalesBonusRows,
} from "../utils/salesBonusCalculator.js";

const VALID_USER_TYPES = new Set(["Salesperson", "Tile Mistire"]);
const PRODUCT_COLUMNS = `id, product_name, default_cost_price, default_bonus_percentage, unit_label, is_active`;
const INVOICE_PAYMENT_JOINS = `
  LEFT JOIN LATERAL (
    SELECT COALESCE(sum(pa.amount),0)::numeric(18,2) collected_amount
    FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.status='posted'
    WHERE pa.sales_invoice_id=si.id AND pa.direction='in'
  ) invoice_collections ON TRUE
  LEFT JOIN LATERAL (
    SELECT COALESCE(sum(r.customer_credit),0)::numeric(18,2) credit_amount
    FROM sales_invoice_return_credits r WHERE r.sales_invoice_id=si.id AND r.status='posted'
  ) invoice_credits ON TRUE`;
const INVOICE_PAYMENT_COLUMNS = `
  invoice_collections.collected_amount AS invoice_collected_amount,
  GREATEST(COALESCE(si.total,0)-invoice_collections.collected_amount,0)::numeric(18,2) invoice_unpaid_amount,
  GREATEST(COALESCE(si.total,0)-invoice_collections.collected_amount-invoice_credits.credit_amount,0)::numeric(18,2) invoice_due_amount,
  CASE WHEN si.id IS NULL THEN NULL
       WHEN invoice_collections.collected_amount>=si.total THEN 'paid'
       WHEN invoice_collections.collected_amount>0 THEN 'partially_paid'
       ELSE 'unpaid' END invoice_payment_status`;

const validateProductPayload = (body, requireActive = false) => {
  const productName = typeof body?.product_name === "string"
    ? body.product_name.trim()
    : "";
  const unitLabel = typeof body?.unit_label === "string"
    ? body.unit_label.trim()
    : "";
  const costPrice = body?.default_cost_price === "" ? Number.NaN : Number(body?.default_cost_price);
  const bonusPercentage = body?.default_bonus_percentage === ""
    ? Number.NaN
    : Number(body?.default_bonus_percentage);

  if (!productName || productName.length > 200) {
    return { error: "Product name is required and must be 200 characters or fewer." };
  }
  if (!Number.isFinite(costPrice) || costPrice < 0 || costPrice >= 10_000_000_000) {
    return { error: "Cost price must be a valid non-negative amount." };
  }
  if (!Number.isFinite(bonusPercentage) || bonusPercentage < 0 || bonusPercentage > 100) {
    return { error: "Bonus percentage must be between 0 and 100." };
  }
  if (!unitLabel || unitLabel.length > 40) {
    return { error: "Unit label is required and must be 40 characters or fewer." };
  }
  if (requireActive && typeof body?.is_active !== "boolean") {
    return { error: "Product active status must be true or false." };
  }

  return {
    value: {
      productName,
      costPrice,
      bonusPercentage,
      unitLabel,
      isActive: requireActive ? body.is_active : true,
    },
  };
};

export const getProductCatalog = async (_req, res) => {
  try {
    const productQuery = await connection.query(
      `SELECT id, product_name, default_cost_price, default_bonus_percentage, unit_label
       FROM sales_bonus_product_config
       WHERE is_active = TRUE
       ORDER BY product_name ASC;`
    );

    return res.status(200).json(productQuery.rows);
  } catch (error) {
    console.error("Error fetching sales bonus product catalog:", error.message);
    return res.status(500).json({ message: "Unable to load product catalog" });
  }
};

export const getManageableProductCatalog = async (_req, res) => {
  try {
    const productQuery = await connection.query(
      `SELECT p.id AS product_id,p.sku,p.name AS product_name,p.default_purchase_price,
              COALESCE(c.id IS NOT NULL,FALSE) AS has_bonus_rule,
              c.id AS bonus_rule_id,c.default_cost_price,c.default_bonus_percentage,
              COALESCE(c.unit_label,sales_unit.name) AS unit_label,
              COALESCE(c.is_active,FALSE) AS is_active
       FROM products p
       LEFT JOIN units_of_measure sales_unit ON sales_unit.id=COALESCE(p.sales_unit_id,p.base_unit_id)
       LEFT JOIN LATERAL (
         SELECT config.id,config.default_cost_price,config.default_bonus_percentage,config.unit_label,config.is_active
         FROM sales_bonus_product_config config
         WHERE config.product_id=p.id OR (config.product_id IS NULL AND lower(trim(config.product_name))=lower(trim(p.name)))
         ORDER BY (config.product_id=p.id) DESC,config.id DESC LIMIT 1
       ) c ON TRUE
       WHERE p.is_active=TRUE
       ORDER BY p.name,p.id;`
    );

    return res.status(200).json(productQuery.rows);
  } catch (error) {
    console.error("Error fetching manageable product catalog:", error.message);
    return res.status(500).json({ message: "Unable to load product catalog" });
  }
};

export const saveCatalogProductBonusRule = async (req,res) => {
  const productId=Number(req.params.productId);
  if(!Number.isSafeInteger(productId)||productId<=0)return res.status(400).json({message:"A valid catalog product is required."});
  const costPrice=req.body?.default_cost_price===""?Number.NaN:Number(req.body?.default_cost_price);
  const bonusPercentage=req.body?.default_bonus_percentage===""?Number.NaN:Number(req.body?.default_bonus_percentage);
  const unitLabel=typeof req.body?.unit_label==="string"?req.body.unit_label.trim():"";
  const isActive=typeof req.body?.is_active==="boolean"?req.body.is_active:true;
  if(!Number.isFinite(costPrice)||costPrice<0||costPrice>=10_000_000_000)return res.status(400).json({message:"Cost price must be a valid non-negative amount."});
  if(!Number.isFinite(bonusPercentage)||bonusPercentage<0||bonusPercentage>100)return res.status(400).json({message:"Bonus percentage must be between 0 and 100."});
  if(!unitLabel||unitLabel.length>40)return res.status(400).json({message:"Unit label is required and must be 40 characters or fewer."});
  try{
    const product=await connection.query("SELECT id,name FROM products WHERE id=$1 AND is_active=TRUE",[productId]);
    if(!product.rowCount)return res.status(404).json({message:"Active catalog product was not found."});
    const existing=await connection.query(`SELECT id FROM sales_bonus_product_config WHERE product_id=$1 OR (product_id IS NULL AND lower(trim(product_name))=lower(trim($2))) ORDER BY (product_id=$1) DESC,id DESC LIMIT 1`,[productId,product.rows[0].name]);
    const result=existing.rowCount
      ? await connection.query(`UPDATE sales_bonus_product_config SET product_id=$1,product_name=$2,default_cost_price=$3,default_bonus_percentage=$4,unit_label=$5,is_active=$6,updated_at=now() WHERE id=$7 RETURNING id,product_id,product_name,default_cost_price,default_bonus_percentage,unit_label,is_active`,[productId,product.rows[0].name,costPrice,bonusPercentage,unitLabel,isActive,existing.rows[0].id])
      : await connection.query(`INSERT INTO sales_bonus_product_config(product_id,product_name,default_cost_price,default_bonus_percentage,unit_label,is_active) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,product_id,product_name,default_cost_price,default_bonus_percentage,unit_label,is_active`,[productId,product.rows[0].name,costPrice,bonusPercentage,unitLabel,isActive]);
    return res.json(result.rows[0]);
  }catch(error){
    if(error.code==="23505")return res.status(409).json({message:"A bonus rule already exists for this product."});
    console.error("Unable to save catalog product bonus rule:",error.message);
    return res.status(500).json({message:"Unable to save product bonus rule."});
  }
};

export const getSalesBonusRecords = async (req, res) => {
  const isAdmin = req.user?.userType?.toLowerCase() === "admin";
  const requestedUserId = req.query.userId;

  if (requestedUserId !== undefined && !isAdmin) {
    return res.status(403).json({ message: "You do not have permission to view these records." });
  }

  const userId = isAdmin && requestedUserId !== undefined
    ? Number(requestedUserId)
    : Number(req.user?.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return res.status(400).json({ message: "A valid user ID is required." });
  }

  try {
    const userResult = await connection.query(
      `SELECT id, name, mobile, user_type
       FROM users
       WHERE id = $1;`,
      [userId]
    );
    const selectedUser = userResult.rows[0];
    if (!selectedUser) {
      return res.status(404).json({ message: "User was not found." });
    }

    const recordsResult = await connection.query(
      `SELECT br.id,br.user_id,br.selected_user_type,br.total_quantity,br.total_cost,
              br.total_selling_amount,br.total_gross_profit,br.total_gross_bonus,br.final_user_bonus,
              CASE WHEN br.source_sales_invoice_id IS NULL THEN br.final_user_bonus ELSE br.approved_bonus END approved_bonus,CASE WHEN br.source_sales_invoice_id IS NULL THEN br.final_user_bonus ELSE br.payable_amount END payable_amount,br.total_amount_paid,br.payment_method,
              br.is_fully_paid,br.status,br.created_at,br.source_sales_invoice_id,
              br.recipient_name_snapshot,si.invoice_number,si.invoice_date,si.total invoice_total,
              st.name store_name,c.name customer_name,
              COALESCE((SELECT sum(a.amount) FROM sales_bonus_adjustments a WHERE a.sales_bonus_record_id=br.id),0)::numeric(12,2) adjustments,
              CASE WHEN br.source_sales_invoice_id IS NULL THEN 0 ELSE GREATEST(br.total_amount_paid-GREATEST(br.approved_bonus+COALESCE((SELECT sum(a.amount) FROM sales_bonus_adjustments a WHERE a.sales_bonus_record_id=br.id),0),0),0) END::numeric(12,2) recovery_due
       FROM sales_bonus_records br LEFT JOIN sales_invoices si ON si.id=br.source_sales_invoice_id
       LEFT JOIN stores st ON st.id=br.store_id LEFT JOIN customers c ON c.id=si.customer_id
       WHERE br.user_id = $1
       ORDER BY br.created_at DESC, br.id DESC;`,
      [userId]
    );
    const records = recordsResult.rows;
    const recoveryLedger = applyRecipientRecoveryLedger(records);
    const recordIds = records.map((record) => record.id);
    let items = [],payments=[];
    if (recordIds.length) {
      const [itemsResult,paymentResult] = await Promise.all([connection.query(
        `SELECT id, sales_bonus_record_id, product_name, cost_price,
                selling_price, quantity, total_cost, total_selling_amount,
                gross_profit, bonus_percentage, gross_bonus, user_bonus
         FROM sales_bonus_record_items
         WHERE sales_bonus_record_id = ANY($1::bigint[])
         ORDER BY id ASC;`,
        [recordIds]
      ),connection.query(`SELECT id,sales_bonus_record_id,amount,payment_method,payment_date,reference,notes,created_at FROM sales_bonus_payments WHERE sales_bonus_record_id=ANY($1::bigint[]) ORDER BY payment_date,id`,[recordIds])]);
      items = itemsResult.rows;
      payments=paymentResult.rows;
    }

    const itemsByRecord = new Map();
    for (const item of items) {
      const recordItems = itemsByRecord.get(item.sales_bonus_record_id) ?? [];
      recordItems.push(item);
      itemsByRecord.set(item.sales_bonus_record_id, recordItems);
    }
    const paymentsByRecord=new Map();for(const payment of payments){const key=String(payment.sales_bonus_record_id);const list=paymentsByRecord.get(key)??[];list.push(payment);paymentsByRecord.set(key,list);}

    return res.status(200).json({
      user: {
        id: selectedUser.id,
        name: selectedUser.name,
        mobile: selectedUser.mobile,
        userType: selectedUser.user_type,
        recoveryBalance: recoveryLedger.recoveryBalance,
      },
      records: records.map((record) => {
        const {total_cost,total_gross_profit,...visible}=record;
        const safeItems=(itemsByRecord.get(record.id)??[]).map(item=>{if(hasPermission(req.user,'bonus_cost.view'))return item;const {cost_price,total_cost,gross_profit,...safe}=item;return safe;});
        return {...(hasPermission(req.user,'bonus_cost.view')?record:visible),...recoveryLedger.allocations.get(String(record.id)),items:safeItems,payments:paymentsByRecord.get(String(record.id))??[]};
      }),
    });
  } catch (error) {
    console.error("Error fetching sales bonus records:", error.message);
    return res.status(500).json({ message: "Unable to load sales bonus records." });
  }
};

export const getTopSeller = async (req, res) => {
  const isAdmin = req.user?.userType?.toLowerCase() === "admin";
  const userType = isAdmin ? req.query?.userType : req.user?.userType;
  const sellerType = {
    salesperson: "Salesperson",
    "tile mistire": "Tile Mistire",
  }[userType?.toLowerCase()];
  if (!sellerType) {
    const status = isAdmin ? 400 : 403;
    return res.status(status).json({
      message: isAdmin
        ? "Select a valid salesperson or tile mason group."
        : "You do not have permission to view the top seller.",
    });
  }

  try {
    const result = await connection.query(
      `SELECT u.id, u.name, u.user_type AS "userType",
              SUM(s.total_selling_amount) AS total_sales
       FROM users u
       JOIN sales_bonus_records s ON s.user_id = u.id
       WHERE u.user_type = $1
       GROUP BY u.id, u.name, u.user_type
       ORDER BY SUM(s.total_selling_amount) DESC, u.id ASC
       LIMIT 3;`,
      [sellerType]
    );

    return res.status(200).json({ topSellers: result.rows });
  } catch (error) {
    console.error("Error fetching top sales bonus seller:", error.message);
    return res.status(500).json({ message: "Unable to load top seller." });
  }
};

export const updateSalesBonusPayment = async (req, res) => {
  const recordId = Number(req.params.id);
  const amountInput =
    typeof req.body?.amount === "string" && req.body.amount.trim() === ""
      ? Number.NaN
      : Number(req.body?.amount);
  const paymentMethod = req.body?.paymentMethod;

  if (!Number.isSafeInteger(recordId) || recordId <= 0) {
    return res.status(400).json({ message: "A valid sales bonus record ID is required." });
  }
  if (!Number.isFinite(amountInput) || amountInput <= 0) {
    return res.status(400).json({ message: "Payment amount must be greater than zero." });
  }
  if (!["UPI", "CASH", "BANK_TRANSFER", "OTHER"].includes(paymentMethod)) {
    return res.status(400).json({ message: "Payment method must be Cash, UPI, bank transfer, or other." });
  }

  const paymentAmount = Math.round(amountInput * 100) / 100;
  if (paymentAmount <= 0) {
    return res.status(400).json({ message: "Payment amount must be at least 0.01." });
  }

  const client = await connection.connect();
  try {
    await client.query("BEGIN");
    const recordResult = await client.query(
      `SELECT id,user_id,created_at,final_user_bonus,approved_bonus,total_amount_paid,payment_method,is_fully_paid,source_sales_invoice_id,payable_amount,approved_by,status,store_id,admin_payment_override,
              COALESCE((SELECT sum(a.amount) FROM sales_bonus_adjustments a WHERE a.sales_bonus_record_id=sales_bonus_records.id),0)::numeric(12,2) adjustments
       FROM sales_bonus_records
       WHERE id = $1
       FOR UPDATE;`,
      [recordId]
    );
    const record = recordResult.rows[0];
    if (!record) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Sales bonus record was not found." });
    }

    // Serialize payments for this recipient, then apply any return recovery
    // against their later bonus entitlements before allowing another payout.
    await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [record.user_id]);
    const accountRecords = await client.query(
      `SELECT id,user_id,created_at,source_sales_invoice_id,final_user_bonus,approved_bonus,
              payable_amount,total_amount_paid,status,
              COALESCE((SELECT sum(a.amount) FROM sales_bonus_adjustments a WHERE a.sales_bonus_record_id=br.id),0)::numeric(12,2) adjustments
       FROM sales_bonus_records br WHERE user_id=$1 ORDER BY created_at,id FOR UPDATE`,
      [record.user_id]
    );
    const recoveryLedger = applyRecipientRecoveryLedger(accountRecords.rows);
    const effectiveRecord = recoveryLedger.allocations.get(String(recordId));

    const requestKey=String(req.body?.idempotencyKey||randomUUID());
    const duplicate=await client.query('SELECT * FROM sales_bonus_payments WHERE request_key=$1 FOR UPDATE',[requestKey]);
    if(duplicate.rowCount){const prior=duplicate.rows[0];if(String(prior.sales_bonus_record_id)!==String(recordId)||Number(prior.amount)!==paymentAmount||prior.payment_method!==paymentMethod)throw Object.assign(new Error('Payment request key was used for a different payment.'),{status:409});await client.query('COMMIT');return res.status(200).json({message:'Payment was already recorded.',record:{id:recordId,total_amount_paid:record.total_amount_paid,payment_method:record.payment_method,is_fully_paid:record.is_fully_paid}});}

    if(record.source_sales_invoice_id&&(!record.approved_by||['pending_approval','on_hold','reversed'].includes(record.status))){await client.query('ROLLBACK');return res.status(409).json({message:'This invoice bonus must be approved before payment.'});}

    const finalBonus = Number(record.final_user_bonus);
    const alreadyPaid = Number(record.total_amount_paid);
    const payoutLimit=record.source_sales_invoice_id
      ? Math.max(Number(record.approved_bonus)+Number(record.adjustments),0)
      : finalBonus;
    const payable=payoutLimit;
    const dueAmount = effectiveRecord?.admin_effective_due ?? Math.max(payable - alreadyPaid, 0);
    if (paymentAmount > dueAmount) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        message: "Payment amount cannot exceed the remaining bonus due.",
      });
    }

    const totalAmountPaid = Math.round((alreadyPaid + paymentAmount) * 100) / 100;
    const isFullyPaid = totalAmountPaid >= payoutLimit;
    const adminPaymentOverride=Boolean(record.source_sales_invoice_id&&(record.admin_payment_override||totalAmountPaid>Number(record.payable_amount)));
    const paymentDate=String(req.body?.paymentDate||new Date().toISOString().slice(0,10));
    if(!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate))throw Object.assign(new Error('Enter a valid payment date.'),{status:400});
    await client.query(`INSERT INTO sales_bonus_payments(sales_bonus_record_id,store_id,amount,payment_method,payment_date,reference,notes,request_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[recordId,record.store_id,paymentAmount,paymentMethod,paymentDate,String(req.body?.reference||'').slice(0,120)||null,String(req.body?.notes||'').slice(0,2000)||null,requestKey,req.user.id]);
    const updateResult = await client.query(
      `UPDATE sales_bonus_records
       SET total_amount_paid = $1,
           payment_method = CASE WHEN $2 IN ('CASH','UPI') THEN $2 ELSE payment_method END,
           is_fully_paid = $3,
           admin_payment_override=admin_payment_override OR $6,
           payable_amount=CASE WHEN $6 THEN $5 ELSE payable_amount END,
           status=CASE WHEN source_sales_invoice_id IS NOT NULL AND $3 THEN 'paid' WHEN source_sales_invoice_id IS NOT NULL THEN 'partially_paid' ELSE status END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING id,total_amount_paid,payment_method,is_fully_paid,payable_amount,status,admin_payment_override,updated_at;`,
      [totalAmountPaid, paymentMethod, isFullyPaid, recordId,payoutLimit,adminPaymentOverride]
    );
    await client.query(`INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'sales_bonus.payment.recorded','sales_bonus_record',$3,$4)`,[record.store_id,req.user.id,recordId,{amount:paymentAmount,paymentMethod,paymentDate,requestKey}]);
    await client.query("COMMIT");

    return res.status(200).json({
      message: "Sales bonus payment updated successfully.",
      record: updateResult.rows[0],
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Error rolling back sales bonus payment:", rollbackError.message);
    }
    if(error.status)return res.status(error.status).json({message:error.message});
    console.error("Error updating sales bonus payment:", error.message);
    return res.status(500).json({ message: "Unable to update sales bonus payment." });
  } finally {
    client.release();
  }
};

export const getBonusManagementRecords=async(req,res)=>{
  const filters=req.query||{},params=[],where=[];
  if(filters.status){params.push(String(filters.status));where.push(`br.status=$${params.length}`);}
  if(VALID_USER_TYPES.has(filters.recipientType)){params.push(filters.recipientType);where.push(`br.selected_user_type=$${params.length}`);}
  if(/^\d+$/.test(String(filters.storeId||''))){params.push(filters.storeId);where.push(`br.store_id=$${params.length}`);}
  if(filters.paymentStatus==='paid')where.push(`br.total_amount_paid>=CASE WHEN br.source_sales_invoice_id IS NULL THEN br.final_user_bonus ELSE GREATEST(br.approved_bonus+COALESCE((SELECT sum(a.amount) FROM sales_bonus_adjustments a WHERE a.sales_bonus_record_id=br.id),0),0) END AND br.total_amount_paid>0`);
  if(filters.paymentStatus==='unpaid')where.push(`br.total_amount_paid<CASE WHEN br.source_sales_invoice_id IS NULL THEN br.final_user_bonus ELSE GREATEST(br.approved_bonus+COALESCE((SELECT sum(a.amount) FROM sales_bonus_adjustments a WHERE a.sales_bonus_record_id=br.id),0),0) END`);
  if(filters.q){params.push(`%${String(filters.q).slice(0,100)}%`);where.push(`(u.name ILIKE $${params.length} OR si.invoice_number ILIKE $${params.length} OR c.name ILIKE $${params.length})`);}
  if(/^\d{4}-\d{2}-\d{2}$/.test(String(filters.fromDate||''))){params.push(filters.fromDate);where.push(`COALESCE(si.invoice_date,br.created_at::date)>=$${params.length}::date`);}
  if(/^\d{4}-\d{2}-\d{2}$/.test(String(filters.toDate||''))){params.push(filters.toDate);where.push(`COALESCE(si.invoice_date,br.created_at::date)<=$${params.length}::date`);}
  try{
    const rows=await connection.query(`SELECT br.id,br.user_id,br.selected_user_type,br.status,br.total_selling_amount,br.total_gross_profit,br.total_gross_bonus,br.final_user_bonus,CASE WHEN br.source_sales_invoice_id IS NULL THEN br.final_user_bonus ELSE br.approved_bonus END approved_bonus,CASE WHEN br.source_sales_invoice_id IS NULL THEN br.final_user_bonus ELSE br.payable_amount END payable_amount,br.total_amount_paid,br.created_at,br.approved_at,br.approval_note,br.approval_risk,br.unpaid_invoice_amount_at_approval,br.source_sales_invoice_id,br.store_id,br.recipient_name_snapshot,u.name recipient_name,si.invoice_number,si.invoice_date,si.total invoice_total,${INVOICE_PAYMENT_COLUMNS},c.name customer_name,st.name store_name,COALESCE((SELECT sum(a.amount) FROM sales_bonus_adjustments a WHERE a.sales_bonus_record_id=br.id),0)::numeric(12,2) adjustments,CASE WHEN br.source_sales_invoice_id IS NULL THEN 0 ELSE GREATEST(br.total_amount_paid-GREATEST(br.approved_bonus+COALESCE((SELECT sum(a.amount) FROM sales_bonus_adjustments a WHERE a.sales_bonus_record_id=br.id),0),0),0) END::numeric(12,2) recovery_due FROM sales_bonus_records br JOIN users u ON u.id=br.user_id LEFT JOIN sales_invoices si ON si.id=br.source_sales_invoice_id ${INVOICE_PAYMENT_JOINS} LEFT JOIN customers c ON c.id=si.customer_id LEFT JOIN stores st ON st.id=br.store_id ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY br.created_at DESC,br.id DESC LIMIT 500`,params);
    const userIds=[...new Set(rows.rows.map(row=>String(row.user_id)))];
    if(!userIds.length)return res.json({items:[]});
    const account=await connection.query(`SELECT id,user_id,created_at,source_sales_invoice_id,final_user_bonus,approved_bonus,payable_amount,total_amount_paid,status,COALESCE((SELECT sum(a.amount) FROM sales_bonus_adjustments a WHERE a.sales_bonus_record_id=br.id),0)::numeric(12,2) adjustments FROM sales_bonus_records br WHERE user_id=ANY($1::bigint[]) ORDER BY user_id,created_at,id`,[userIds]);
    const ledgerByUser=new Map();
    for(const userId of userIds){const ledger=applyRecipientRecoveryLedger(account.rows.filter(record=>String(record.user_id)===userId));ledgerByUser.set(userId,ledger);}
    return res.json({items:rows.rows.map(row=>({...row,...ledgerByUser.get(String(row.user_id))?.allocations.get(String(row.id)),account_recovery_balance:ledgerByUser.get(String(row.user_id))?.recoveryBalance||0}))});
  }
  catch(error){console.error('Unable to load bonus management records:',error.message);return res.status(500).json({message:'Unable to load bonus management records.'});}
};

export const approveSalesBonus=async(req,res)=>{
  const id=String(req.params.id||''),note=String(req.body?.note||'').trim(),riskReason=String(req.body?.riskReason||'').trim();
  if(!/^\d+$/.test(id)||note.length>1000||riskReason.length>1000)return res.status(400).json({message:'Provide a valid bonus record and approval note.'});
  const client=await connection.connect();
  try{
    await client.query('BEGIN');
    const initial=await client.query('SELECT id,store_id,source_sales_invoice_id FROM sales_bonus_records WHERE id=$1',[id]);
    const initialRecord=initial.rows[0];
    if(!initialRecord)throw Object.assign(new Error('Bonus record was not found.'),{status:404});
    if(!initialRecord.source_sales_invoice_id)throw Object.assign(new Error('Only invoice-linked bonuses use approval.'),{status:409});
    const invoiceResult=await client.query(`SELECT si.id,si.total,
      COALESCE(collected.amount,0)::numeric(18,2) collected_amount,
      GREATEST(si.total-COALESCE(collected.amount,0),0)::numeric(18,2) unpaid_amount,
      GREATEST(si.total-COALESCE(collected.amount,0)-COALESCE(credits.amount,0),0)::numeric(18,2) outstanding_amount
      FROM sales_invoices si
      LEFT JOIN LATERAL(SELECT sum(pa.amount) amount FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.status='posted' WHERE pa.sales_invoice_id=si.id AND pa.direction='in') collected ON TRUE
      LEFT JOIN LATERAL(SELECT sum(r.customer_credit) amount FROM sales_invoice_return_credits r WHERE r.sales_invoice_id=si.id AND r.status='posted') credits ON TRUE
      WHERE si.id=$1 FOR UPDATE OF si`,[initialRecord.source_sales_invoice_id]);
    const invoice=invoiceResult.rows[0];
    if(!invoice)throw Object.assign(new Error('The related sales invoice was not found.'),{status:404});
    const unpaidAmount=Number(invoice.unpaid_amount);
    if(unpaidAmount>0&&riskReason.length<3)throw Object.assign(new Error('This sales invoice is unpaid or partially paid. Enter a reason to approve its bonus as a risk.'),{status:400,code:'UNPAID_INVOICE_APPROVAL_REASON_REQUIRED',outstandingAmount:unpaidAmount});
    const result=await client.query('SELECT id,store_id,source_sales_invoice_id,final_user_bonus,status FROM sales_bonus_records WHERE id=$1 FOR UPDATE',[id]);
    const record=result.rows[0];
    if(!record)throw Object.assign(new Error('Bonus record was not found.'),{status:404});
    if(record.status==='reversed')throw Object.assign(new Error('A reversed bonus cannot be approved.'),{status:409});
    const approvalNote=unpaidAmount>0?riskReason||note||null:note||null;
    await client.query(`UPDATE sales_bonus_records SET approved_bonus=final_user_bonus,approved_by=$1,approved_at=now(),approval_note=$2,approval_risk=$3,unpaid_invoice_amount_at_approval=$4,status='approved',updated_at=now() WHERE id=$5`,[req.user.id,approvalNote,unpaidAmount>0,unpaidAmount,id]);
    await refreshInvoiceBonusPayability(client,record.source_sales_invoice_id);
    await client.query(`INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'sales_bonus.approved','sales_bonus_record',$3,$4)`,[record.store_id,req.user.id,id,{amount:record.final_user_bonus,note:approvalNote,approvalRisk:unpaidAmount>0,unpaidInvoiceAmount:unpaidAmount}]);
    const saved=await client.query('SELECT * FROM sales_bonus_records WHERE id=$1',[id]);
    await client.query('COMMIT');
    return res.json({record:saved.rows[0],invoice:{total:invoice.total,collectedAmount:invoice.collected_amount,unpaidAmount:invoice.unpaid_amount,outstandingAmount:invoice.outstanding_amount,paymentStatus:unpaidAmount<=0?'paid':Number(invoice.collected_amount)>0?'partially_paid':'unpaid'}});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});if(error.status)return res.status(error.status).json({message:error.message,...(error.code?{code:error.code}:{}),...(error.outstandingAmount!==undefined?{outstandingAmount:error.outstandingAmount}:{})});console.error('Unable to approve bonus:',error.message);return res.status(500).json({message:'Unable to approve bonus.'});}finally{client.release();}
};

export const holdSalesBonus=async(req,res)=>{
  const id=String(req.params.id||''),reason=String(req.body?.reason||'').trim();if(!/^\d+$/.test(id)||!reason||reason.length>1000)return res.status(400).json({message:'A valid bonus record and hold reason are required.'});
  const client=await connection.connect();try{await client.query('BEGIN');const result=await client.query('SELECT id,store_id,source_sales_invoice_id,total_amount_paid FROM sales_bonus_records WHERE id=$1 FOR UPDATE',[id]);const record=result.rows[0];if(!record)throw Object.assign(new Error('Bonus record was not found.'),{status:404});if(!record.source_sales_invoice_id)throw Object.assign(new Error('Only invoice-linked bonuses can be held.'),{status:409});if(Number(record.total_amount_paid)>0)throw Object.assign(new Error('A bonus with recorded payments cannot be held.'),{status:409});await client.query(`UPDATE sales_bonus_records SET approved_bonus=0,approved_by=NULL,approved_at=NULL,payable_amount=0,approval_note=$1,status='on_hold',updated_at=now() WHERE id=$2`,[reason,id]);await client.query(`INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'sales_bonus.held','sales_bonus_record',$3,$4)`,[record.store_id,req.user.id,id,{reason}]);await client.query('COMMIT');return res.json({message:'Bonus placed on hold.'});}catch(error){await client.query('ROLLBACK').catch(()=>{});if(error.status)return res.status(error.status).json({message:error.message});console.error('Unable to hold bonus:',error.message);return res.status(500).json({message:'Unable to hold bonus.'});}finally{client.release();}
};

export const getSalesBonusPaymentHistory=async(req,res)=>{try{const rows=await connection.query(`SELECT id,amount,payment_method,payment_date,reference,notes,created_by,created_at FROM sales_bonus_payments WHERE sales_bonus_record_id=$1 ORDER BY payment_date,id`,[req.params.id]);return res.json({items:rows.rows});}catch(error){console.error('Unable to load bonus payment history:',error.message);return res.status(500).json({message:'Unable to load payment history.'});}};

export const getSalesBonusManagementDetail=async(req,res)=>{try{const result=await connection.query(`SELECT br.*,${INVOICE_PAYMENT_COLUMNS},COALESCE((SELECT sum(a.amount) FROM sales_bonus_adjustments a WHERE a.sales_bonus_record_id=br.id),0)::numeric(12,2) adjustments,u.name recipient_name,si.invoice_number,si.invoice_date,si.total invoice_total,c.name customer_name,st.name store_name FROM sales_bonus_records br JOIN users u ON u.id=br.user_id LEFT JOIN sales_invoices si ON si.id=br.source_sales_invoice_id ${INVOICE_PAYMENT_JOINS} LEFT JOIN customers c ON c.id=si.customer_id LEFT JOIN stores st ON st.id=br.store_id WHERE br.id=$1`,[req.params.id]);if(!result.rowCount)return res.status(404).json({message:'Bonus record was not found.'});const target=result.rows[0];const account=await connection.query(`SELECT id,user_id,created_at,source_sales_invoice_id,final_user_bonus,approved_bonus,payable_amount,total_amount_paid,status,COALESCE((SELECT sum(a.amount) FROM sales_bonus_adjustments a WHERE a.sales_bonus_record_id=br.id),0)::numeric(12,2) adjustments FROM sales_bonus_records br WHERE user_id=$1 ORDER BY created_at,id`,[target.user_id]);const ledger=applyRecipientRecoveryLedger(account.rows);const items=await connection.query(`SELECT id,product_name,cost_price,selling_price,quantity,total_cost,total_selling_amount,gross_profit,bonus_percentage,gross_bonus,user_bonus FROM sales_bonus_record_items WHERE sales_bonus_record_id=$1 ORDER BY id`,[req.params.id]);return res.json({record:{...target,...ledger.allocations.get(String(target.id)),account_recovery_balance:ledger.recoveryBalance,items:items.rows}});}catch(error){console.error('Unable to load bonus detail:',error.message);return res.status(500).json({message:'Unable to load bonus detail.'});}};

export const createProductConfig = async (req, res) => {
  const validation = validateProductPayload(req.body);
  if (validation.error) {
    return res.status(400).json({ message: validation.error });
  }

  const { productName, costPrice, bonusPercentage, unitLabel, isActive } = validation.value;
  try {
    const result = await connection.query(
      `INSERT INTO sales_bonus_product_config (
         product_name, default_cost_price, default_bonus_percentage, unit_label, is_active
       )
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${PRODUCT_COLUMNS};`,
      [productName, costPrice, bonusPercentage, unitLabel, isActive]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ message: "A product with that name already exists." });
    }
    console.error("Error creating sales bonus product:", error.message);
    return res.status(500).json({ message: "Unable to create product" });
  }
};

export const updateProductConfig = async (req, res) => {
  const productId = Number(req.params.id);
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    return res.status(400).json({ message: "A valid product ID is required." });
  }

  const validation = validateProductPayload(req.body, true);
  if (validation.error) {
    return res.status(400).json({ message: validation.error });
  }

  const { productName, costPrice, bonusPercentage, unitLabel, isActive } = validation.value;
  try {
    const result = await connection.query(
      `UPDATE sales_bonus_product_config
       SET product_name = $1,
           default_cost_price = $2,
           default_bonus_percentage = $3,
           unit_label = $4,
           is_active = $5,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6
       RETURNING ${PRODUCT_COLUMNS};`,
      [productName, costPrice, bonusPercentage, unitLabel, isActive, productId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ message: "Product was not found." });
    }
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ message: "A product with that name already exists." });
    }
    console.error("Error updating sales bonus product:", error.message);
    return res.status(500).json({ message: "Unable to update product" });
  }
};

export const createSalesBonusRecord = async (req, res) => {
  const { selectedUserId, selectedUserType, rows } = req.body ?? {};
  const userId = Number(selectedUserId);

  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return res.status(400).json({ message: "A valid user ID is required" });
  }

  if (!VALID_USER_TYPES.has(selectedUserType)) {
    return res.status(400).json({ message: "Select a valid user type for bonus allocation" });
  }

  try {
    const userResult = await connection.query(
      `SELECT id, name, mobile, user_type
       FROM users
       WHERE id = $1;`,
      [userId]
    );
    const selectedUser = userResult.rows[0];

    if (!selectedUser) {
      return res.status(404).json({ message: "Selected user was not found" });
    }

    if (selectedUser.user_type !== selectedUserType) {
      return res.status(400).json({
        message: "The selected user does not match the selected user type",
      });
    }

    const catalogResult = await connection.query(
      `SELECT product_name, default_cost_price, default_bonus_percentage
       FROM sales_bonus_product_config
       WHERE is_active = TRUE
       ORDER BY product_name ASC;`
    );
    const preparedRows = validateSalesBonusRows(
      rows,
      selectedUserType,
      catalogResult.rows
    );
    const summary = validateSalesBonusSummary(
      calculateSalesBonusSummary(preparedRows, selectedUserType)
    );

    const rawPaidAmount = req.body?.totalAmountPaid ?? 0;
    const totalAmountPaidInput =
      typeof rawPaidAmount === "string" && rawPaidAmount.trim() === ""
        ? Number.NaN
        : Number(rawPaidAmount);
    const isFullyPaid = req.body?.isFullyPaid ?? false;
    const paymentMethod = req.body?.paymentMethod || null;

    if (typeof isFullyPaid !== "boolean") {
      return res.status(400).json({ message: "Full-paid status must be true or false." });
    }
    if (!Number.isFinite(totalAmountPaidInput) || totalAmountPaidInput < 0) {
      return res.status(400).json({ message: "Paid amount must be a valid non-negative amount." });
    }
    if (paymentMethod !== null && !["UPI", "CASH"].includes(paymentMethod)) {
      return res.status(400).json({ message: "Payment method must be UPI or CASH." });
    }

    const totalAmountPaid = isFullyPaid
      ? summary.finalUserBonus
      : Math.round(totalAmountPaidInput * 100) / 100;
    if (totalAmountPaid > summary.finalUserBonus) {
      return res.status(400).json({ message: "Paid amount cannot exceed the final user bonus payable." });
    }
    if (totalAmountPaid > 0 && !paymentMethod) {
      return res.status(400).json({ message: "Select a payment method for the paid amount." });
    }

    const client = await connection.connect();

    let record;
    try {
      await client.query("BEGIN");

      const recordResult = await client.query(
        `INSERT INTO sales_bonus_records (
          user_id,
          selected_user_type,
          total_quantity,
          total_cost,
          total_selling_amount,
          total_gross_profit,
          total_gross_bonus,
          final_user_bonus,
          total_amount_paid,
          payment_method,
          is_fully_paid,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'draft')
        RETURNING *;`,
        [
          userId,
          selectedUserType,
          summary.totalQuantity,
          summary.totalCost,
          summary.totalSellingAmount,
          summary.totalGrossProfit,
          summary.totalGrossBonus,
          summary.finalUserBonus,
          totalAmountPaid,
          totalAmountPaid > 0 ? paymentMethod : null,
          isFullyPaid,
        ]
      );

      record = recordResult.rows[0];

      for (const row of preparedRows) {
        await client.query(
          `INSERT INTO sales_bonus_record_items (
            sales_bonus_record_id,
            product_name,
            cost_price,
            selling_price,
            quantity,
            total_cost,
            total_selling_amount,
            gross_profit,
            bonus_percentage,
            gross_bonus,
            user_bonus
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);`,
          [
            record.id,
            row.productName,
            row.costPrice,
            row.sellingPrice,
            row.quantity,
            row.totalCost,
            row.totalSellingAmount,
            row.grossProfit,
            row.bonusRate,
            row.grossBonus,
            row.userBonus,
          ]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Error rolling back sales bonus record:", rollbackError.message);
      }
      throw error;
    } finally {
      client.release();
    }

    return res.status(201).json({
      message: "Sales bonus record created successfully",
      record: {
        ...record,
        selectedUser,
        items: preparedRows,
      },
    });
  } catch (error) {
    if (error instanceof SalesBonusValidationError) {
      return res.status(400).json({ message: error.message });
    }

    console.error("Error creating sales bonus record:", error.message);
    return res.status(500).json({ message: "Unable to create sales bonus record" });
  }
};

import { gstValidationError } from "../utils/gstValidator.js";
import { gstPartyFields } from "../utils/gstPartyFields.js";
import { connection } from "../../connection.js";

const isAdmin = (req) => req.user?.userType?.toLowerCase() === "admin";
const idOk = (value) => /^\d+$/.test(String(value ?? ""));
const clean = (value) => typeof value === "string" ? value.trim() : "";
const customerFields = `id,code,name,phone,alternate_mobile,email,tax_id AS gstin,address AS billing_address,
 shipping_address,city,state,pin_code,customer_type,credit_limit,payment_terms_days,notes,is_active,created_at,updated_at,gst_details,gst_verified_at,gst_data_source`;
const decimal = (value, label, nullable = true) => {
  if ((value === undefined || value === null || value === "") && nullable) return null;
  const raw = String(value);
  return /^\d{1,16}(\.\d{1,2})?$/.test(raw) ? raw : `${label} must be a non-negative amount with up to 2 decimal places`;
};

function validateCustomer(body = {}, creating = false) {
  const name = clean(body.name);
  const code = clean(body.code).toUpperCase();
  const phone = clean(body.mobile ?? body.phone);
  const alternateMobile = clean(body.alternateMobile);
  const email = clean(body.email).toLowerCase();
  const gstin = clean(body.gstin ?? body.taxId).toUpperCase();
  const billingAddress = body.billingAddress ?? body.address ?? {};
  const shippingAddress = body.shippingAddress ?? {};
  const type = clean(body.customerType) || "individual";
  const phoneValid = (value) => !value || (/^[+()\d\s.-]+$/.test(value) && value.replace(/\D/g, "").length >= 7 && value.replace(/\D/g, "").length <= 15);
  if (!name || name.length > 180) return { error: "Customer name is required and must be 180 characters or fewer" };
  if (code && (code.length > 50 || !/^[A-Z0-9][A-Z0-9._/-]*$/.test(code))) return { error: "Customer code must use letters, numbers, dots, underscores, slashes, or hyphens" };
  if (!phoneValid(phone) || !phoneValid(alternateMobile)) return { error: "Mobile numbers must contain 7 to 15 digits and may include +, spaces, parentheses, dots, or hyphens" };
  if (phone.length > 30 || alternateMobile.length > 30) return { error: "Mobile numbers must be 30 characters or fewer" };
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return { error: "Enter a valid email address" };
  if (gstin && gstValidationError(gstin)) return { error: gstValidationError(gstin) };
  if (!billingAddress || typeof billingAddress !== "object" || Array.isArray(billingAddress) || !shippingAddress || typeof shippingAddress !== "object" || Array.isArray(shippingAddress)) return { error: "Billing and shipping addresses must be objects" };
  if (!["individual", "business", "contractor", "other"].includes(type)) return { error: "Choose a valid customer type" };
  const creditLimit = decimal(body.creditLimit, "Credit limit");
  if (typeof creditLimit === "string" && creditLimit.includes("must be")) return { error: creditLimit };
  const paymentTermsDays = Number(body.paymentTermsDays ?? 0);
  if (!Number.isInteger(paymentTermsDays) || paymentTermsDays < 0 || paymentTermsDays > 365) return { error: "Payment terms must be between 0 and 365 days" };
  const strings = [clean(body.city), clean(body.state), clean(body.pinCode), clean(body.notes)];
  if (strings[0].length > 100 || strings[1].length > 100 || strings[2].length > 12 || strings[3].length > 10000) return { error: "One or more customer fields exceed the allowed length" };
  if (body.isActive !== undefined && typeof body.isActive !== "boolean") return { error: "isActive must be a boolean" };
  return { data: { code: code || null, name, phone: phone || null, alternateMobile: alternateMobile || null, email: email || null, gstin: gstin || null, billingAddress, shippingAddress, city: strings[0] || null, state: strings[1] || null, pinCode: strings[2] || null, customerType: type, creditLimit, paymentTermsDays, notes: strings[3] || null, isActive: body.isActive !== false, openingBalance: creating ? decimal(body.openingBalance, "Opening balance") : null, openingDirection: body.openingDirection === "credit" ? "credit" : "debit", openingStoreId: body.openingStoreId || body.storeId || null } };
}

async function authorizedStoreIds(req) {
  if (isAdmin(req)) {
    const result = await connection.query("SELECT id FROM stores ORDER BY id");
    return result.rows.map((row) => String(row.id));
  }
  const result = await connection.query(`SELECT usa.store_id AS id FROM user_store_assignments usa JOIN stores s ON s.id=usa.store_id WHERE usa.user_id=$1 AND usa.is_active=TRUE AND s.is_active=TRUE ORDER BY usa.store_id`, [req.user.id]);
  return result.rows.map((row) => String(row.id));
}

async function storeScope(req, res, requested) {
  const ids = await authorizedStoreIds(req);
  if (requested !== undefined && requested !== "") {
    if (!idOk(requested)) { res.status(400).json({ message: "Invalid store ID" }); return null; }
    if (!ids.includes(String(requested))) { res.status(403).json({ message: "You do not have access to this store" }); return null; }
    return [String(requested)];
  }
  return ids;
}

const balanceSql = `WITH entries AS (
 SELECT si.customer_id,si.store_id,si.invoice_date AS entry_date,'invoice'::text AS entry_type,si.invoice_number AS reference,si.total AS debit,0::numeric AS credit
 FROM sales_invoices si WHERE si.customer_id=$1 AND si.status='posted' AND si.store_id=ANY($2::bigint[])
 UNION ALL
 SELECT si.customer_id,si.store_id,p.payment_date,'payment',p.payment_number,0::numeric,pa.amount
 FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.store_id=pa.store_id AND p.direction='in' AND p.status='posted'
 JOIN sales_invoices si ON si.id=pa.sales_invoice_id AND si.customer_id=$1 AND si.status='posted'
 WHERE pa.direction='in' AND pa.store_id=ANY($2::bigint[])
 UNION ALL
 SELECT p.customer_id,p.store_id,p.payment_date,'payment_unallocated',p.payment_number,0::numeric,
   GREATEST(p.amount-COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.payment_id=p.id AND pa.direction='in'),0),0)
 FROM payments p WHERE p.customer_id=$1 AND p.direction='in' AND p.status='posted' AND p.store_id=ANY($2::bigint[])
   AND p.amount>COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.payment_id=p.id AND pa.direction='in'),0)
 UNION ALL
 SELECT si.customer_id,sr.store_id,sr.return_date,'sales_return',sr.return_number,0::numeric,sr.total
 FROM sales_returns sr JOIN sales_invoices si ON si.id=sr.sales_invoice_id
 WHERE si.customer_id=$1 AND sr.status='posted' AND sr.store_id=ANY($2::bigint[])
 UNION ALL
 SELECT si.customer_id,sr.store_id,sr.return_date,'sales_return_refund',sr.return_number,sr.refund_amount,0::numeric
 FROM sales_returns sr JOIN sales_invoices si ON si.id=sr.sales_invoice_id
 WHERE si.customer_id=$1 AND sr.status='posted' AND sr.refund_amount>0 AND sr.store_id=ANY($2::bigint[])
 UNION ALL
 SELECT a.customer_id,a.store_id,a.adjustment_date,a.adjustment_type,'Adjustment #'||a.id,
 CASE WHEN a.direction='debit' THEN a.amount ELSE 0 END,CASE WHEN a.direction='credit' THEN a.amount ELSE 0 END
 FROM customer_balance_adjustments a WHERE a.customer_id=$1 AND a.status='posted' AND a.store_id=ANY($2::bigint[])
)
SELECT customer_id,store_id,entry_date,entry_type,reference,debit,credit,(debit-credit) AS amount FROM entries`;

export async function listCustomers(req, res) {
  const page = Number(req.query.page ?? 1), limit = Number(req.query.limit ?? 25);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) return res.status(400).json({ message: "Page must be positive and limit must be between 1 and 100" });
  try {
    const stores = await authorizedStoreIds(req);
    if (!stores.length && !isAdmin(req)) return res.json({ items: [], pagination: { page, limit, total: 0, totalPages: 0 } });
    const params = [], where = [], bind = (value) => { params.push(value); return `$${params.length}`; };
    const q = clean(req.query.q).toLowerCase();
    if (q) { const p = bind(`${q}%`); where.push(`(lower(c.name) LIKE ${p} OR lower(COALESCE(c.code,'')) LIKE ${p} OR lower(COALESCE(c.phone,'')) LIKE ${p} OR lower(COALESCE(c.alternate_mobile,'')) LIKE ${p})`); }
    if (req.query.isActive !== undefined) where.push(`c.is_active=${bind(String(req.query.isActive) === "true")}`);
    if (req.query.customerType) where.push(`c.customer_type=${bind(req.query.customerType)}`);
    for (const key of ["city", "state"]) if (clean(req.query[key])) where.push(`lower(c.${key}) LIKE lower(${bind(`${clean(req.query[key])}%`)})`);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const count = await connection.query(`SELECT count(*)::int AS total FROM customers c ${whereSql}`, params);
    const customerProjection = customerFields.split(",").map((field) => `c.${field.trim()}`).join(",");
    const storeParam = `$${params.length + 1}`;
    const balanceParts = `
      COALESCE((SELECT sum(si.total) FROM sales_invoices si WHERE si.customer_id=c.id AND si.store_id=ANY(${storeParam}::bigint[]) AND si.status='posted'),0)
      - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id JOIN sales_invoices si ON si.id=pa.sales_invoice_id WHERE si.customer_id=c.id AND pa.store_id=ANY(${storeParam}::bigint[]) AND pa.direction='in' AND p.status='posted' AND si.status='posted'),0)
      - COALESCE((SELECT sum(GREATEST(p.amount-COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.payment_id=p.id AND pa.direction='in'),0),0)) FROM payments p WHERE p.customer_id=c.id AND p.store_id=ANY(${storeParam}::bigint[]) AND p.direction='in' AND p.status='posted'),0)
      - COALESCE((SELECT sum(sr.customer_credit) FROM sales_returns sr JOIN sales_invoices si ON si.id=sr.sales_invoice_id WHERE si.customer_id=c.id AND sr.store_id=ANY(${storeParam}::bigint[]) AND sr.status='posted'),0)
      + COALESCE((SELECT sum(CASE WHEN a.direction='debit' THEN a.amount ELSE -a.amount END) FROM customer_balance_adjustments a WHERE a.customer_id=c.id AND a.store_id=ANY(${storeParam}::bigint[]) AND a.status='posted'),0)`;
    const result = await connection.query(`SELECT ${customerProjection},(${balanceParts})::numeric(18,2) AS outstanding_balance
      FROM customers c ${whereSql} ORDER BY c.name,c.id LIMIT $${params.length + 2} OFFSET $${params.length + 3}`,
      [...params, stores, limit, (page - 1) * limit]);
    res.json({ items: result.rows, pagination: { page, limit, total: count.rows[0].total, totalPages: Math.ceil(count.rows[0].total / limit) } });
  } catch (error) { console.error("Unable to list customers:", error.message); res.status(500).json({ message: "Unable to load customers" }); }
}

export async function searchCustomers(req, res) {
  const q = clean(req.query.q);
  if (q.length < 2) return res.json([]);
  try {
    if (!(await authorizedStoreIds(req)).length && !isAdmin(req)) return res.json([]);
    const result = await connection.query(`SELECT ${customerFields} FROM customers WHERE is_active=TRUE AND
      (name ILIKE $1 OR COALESCE(code,'') ILIKE $1 OR COALESCE(phone,'') ILIKE $1 OR COALESCE(alternate_mobile,'') ILIKE $1)
      ORDER BY CASE WHEN phone ILIKE $2 OR alternate_mobile ILIKE $2 THEN 0 ELSE 1 END,name LIMIT 15`, [`%${q}%`, `${q}%`]);
    res.json(result.rows);
  } catch (error) { console.error("Unable to search customers:", error.message); res.status(500).json({ message: "Unable to search customers" }); }
}

export async function createCustomer(req, res) {
  const { data, error } = validateCustomer(req.body, true);
  if (error) return res.status(400).json({ message: error });
  if (typeof data.openingBalance === "string" && data.openingBalance.includes("must be")) return res.status(400).json({ message: data.openingBalance });
  const gst = gstPartyFields(req.body, data.gstin);
  if (gst.error) return res.status(400).json({ message: gst.error });
  const amount = data.openingBalance;
  if (amount && Number(amount) > 0 && !data.openingStoreId) return res.status(400).json({ message: "Choose a store for the opening balance" });
  let client;
  try {
    client = await connection.connect();
    await client.query("BEGIN");
    if (amount && Number(amount) > 0) {
      const scope = await storeScope(req, res, data.openingStoreId);
      if (!scope) { await client.query("ROLLBACK"); return; }
    }
    const result = await client.query(`INSERT INTO customers(code,name,phone,alternate_mobile,email,tax_id,address,shipping_address,city,state,pin_code,customer_type,credit_limit,payment_terms_days,notes,is_active,gst_details,gst_verified_at,gst_data_source)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING ${customerFields}`, [data.code,data.name,data.phone,data.alternateMobile,data.email,data.gstin,data.billingAddress,data.shippingAddress,data.city,data.state,data.pinCode,data.customerType,data.creditLimit,data.paymentTermsDays,data.notes,data.isActive,gst.details || {},gst.verifiedAt,gst.source]);
    const id = result.rows[0].id;
    if (amount && Number(amount) > 0) await client.query(`INSERT INTO customer_balance_adjustments(customer_id,store_id,adjustment_type,direction,amount,status,note,created_by)
      VALUES($1,$2,'opening_balance',$3,$4,'posted','Opening balance',$5)`, [id,data.openingStoreId,data.openingDirection,amount,req.user.id]);
    await client.query("COMMIT");
    res.status(201).json(result.rows[0]);
  } catch (error) { if (client) await client.query("ROLLBACK").catch(() => {}); if (error.code === "23505") return res.status(409).json({ message: error.constraint === "customers_gstin_unique" ? "A customer with this GSTIN already exists" : "A customer with this code already exists" }); if (error.code === "23503") return res.status(400).json({ message: "The selected store does not exist" }); console.error("Unable to create customer:", error.message); res.status(500).json({ message: "Unable to create customer" }); }
  finally { client?.release(); }
}

export async function getCustomer(req, res) {
  if (!idOk(req.params.id)) return res.status(400).json({ message: "Invalid customer ID" });
  try { if (!(await authorizedStoreIds(req)).length && !isAdmin(req)) return res.status(403).json({ message: "No active store access is assigned to this account" }); const result = await connection.query(`SELECT ${customerFields} FROM customers WHERE id=$1`, [req.params.id]); if (!result.rowCount) return res.status(404).json({ message: "Customer not found" }); res.json(result.rows[0]); }
  catch (error) { console.error("Unable to load customer:", error.message); res.status(500).json({ message: "Unable to load customer" }); }
}

export async function updateCustomer(req, res) {
  if (!idOk(req.params.id)) return res.status(400).json({ message: "Invalid customer ID" });
  const { data, error } = validateCustomer(req.body);
  if (error) return res.status(400).json({ message: error });
  const gst = gstPartyFields(req.body, data.gstin);
  if (gst.error) return res.status(400).json({ message: gst.error });
  try { const result = await connection.query(`UPDATE customers SET code=$2,name=$3,phone=$4,alternate_mobile=$5,email=$6,tax_id=$7,address=$8,shipping_address=$9,city=$10,state=$11,pin_code=$12,customer_type=$13,credit_limit=$14,payment_terms_days=$15,notes=$16,is_active=$17,gst_details=COALESCE($18::jsonb,CASE WHEN tax_id IS NOT DISTINCT FROM $7 THEN gst_details ELSE '{}'::jsonb END),gst_verified_at=CASE WHEN $19::timestamptz IS NOT NULL THEN $19 WHEN tax_id IS NOT DISTINCT FROM $7 AND NOT $21 THEN gst_verified_at ELSE NULL END,gst_data_source=CASE WHEN $20::varchar IS NOT NULL THEN $20 WHEN tax_id IS NOT DISTINCT FROM $7 AND NOT $21 THEN gst_data_source ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING ${customerFields}`,
    [req.params.id,data.code,data.name,data.phone,data.alternateMobile,data.email,data.gstin,data.billingAddress,data.shippingAddress,data.city,data.state,data.pinCode,data.customerType,data.creditLimit,data.paymentTermsDays,data.notes,data.isActive,gst.details,gst.verifiedAt,gst.source,req.body.clearGstVerification === true]); if (!result.rowCount) return res.status(404).json({ message: "Customer not found" }); res.json(result.rows[0]); }
  catch (error) { if (error.code === "23505") return res.status(409).json({ message: error.constraint === "customers_gstin_unique" ? "A customer with this GSTIN already exists" : "A customer with this code already exists" }); console.error("Unable to update customer:", error.message); res.status(500).json({ message: "Unable to update customer" }); }
}

export async function setCustomerActive(req, res) {
  if (!idOk(req.params.id) || typeof req.body?.isActive !== "boolean") return res.status(400).json({ message: "Valid customer ID and isActive boolean are required" });
  try { const result = await connection.query("UPDATE customers SET is_active=$2,updated_at=now() WHERE id=$1 RETURNING id,is_active", [req.params.id,req.body.isActive]); if (!result.rowCount) return res.status(404).json({ message: "Customer not found" }); res.json(result.rows[0]); }
  catch (error) { res.status(500).json({ message: "Unable to change customer status" }); }
}

async function customerAndScope(req, res) {
  if (!idOk(req.params.id)) { res.status(400).json({ message: "Invalid customer ID" }); return null; }
  const stores = await storeScope(req, res, req.query.storeId);
  if (!stores) return null;
  if (!stores.length && !isAdmin(req)) { res.status(403).json({ message: "No active store access is assigned to this account" }); return null; }
  const exists = await connection.query("SELECT 1 FROM customers WHERE id=$1", [req.params.id]);
  if (!exists.rowCount) { res.status(404).json({ message: "Customer not found" }); return null; }
  return stores;
}

export async function getCustomerInvoices(req, res) {
  try { const stores = await customerAndScope(req,res); if (!stores) return; const result = await connection.query(`SELECT si.id,si.store_id,s.name AS store_name,s.code AS store_code,si.series,si.invoice_number,si.invoice_date,si.due_date,si.subtotal,si.discount_total,si.tax_total,si.total,si.status,COALESCE(paid.amount,0)::numeric(18,2) AS allocated_payments,COALESCE(ret.amount,0)::numeric(18,2) AS returns,(si.total-COALESCE(paid.amount,0)-COALESCE(ret.amount,0)+COALESCE(refunds.amount,0))::numeric(18,2) AS outstanding_balance FROM sales_invoices si JOIN stores s ON s.id=si.store_id LEFT JOIN LATERAL(SELECT sum(pa.amount) amount FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id WHERE pa.sales_invoice_id=si.id AND p.status='posted') paid ON TRUE LEFT JOIN LATERAL(SELECT sum(total) amount FROM sales_returns WHERE sales_invoice_id=si.id AND status='posted') ret ON TRUE LEFT JOIN LATERAL(SELECT sum(refund_amount) amount FROM sales_returns WHERE sales_invoice_id=si.id AND status='posted') refunds ON TRUE WHERE si.customer_id=$1 AND si.store_id=ANY($2::bigint[]) AND si.status='posted' ORDER BY si.invoice_date DESC,si.id DESC`, [req.params.id,stores]); res.json(result.rows); }
  catch (error) { console.error("Unable to load customer invoices:", error.message); res.status(500).json({ message: "Unable to load customer invoices" }); }
}

export async function getCustomerPayments(req, res) {
  try { const stores = await customerAndScope(req,res); if (!stores) return; const result = await connection.query(`SELECT p.id,p.store_id,s.name AS store_name,s.code AS store_code,p.payment_number,p.payment_method,p.payment_date,p.amount,p.reference,p.notes,COALESCE(json_agg(json_build_object('invoiceId',si.id,'invoiceNumber',si.invoice_number,'amount',pa.amount) ORDER BY si.invoice_number) FILTER(WHERE si.id IS NOT NULL),'[]'::json) AS allocations FROM payments p LEFT JOIN payment_allocations pa ON pa.payment_id=p.id AND pa.store_id=p.store_id AND pa.direction='in' LEFT JOIN sales_invoices si ON si.id=pa.sales_invoice_id AND si.customer_id=$1 AND si.status='posted' JOIN stores s ON s.id=p.store_id WHERE p.direction='in' AND p.status='posted' AND p.store_id=ANY($2::bigint[]) AND (p.customer_id=$1 OR (p.customer_id IS NULL AND si.customer_id=$1)) GROUP BY p.id,s.name,s.code ORDER BY p.payment_date DESC,p.id DESC`, [req.params.id,stores]); res.json(result.rows); }
  catch (error) { console.error("Unable to load customer payments:", error.message); res.status(500).json({ message: "Unable to load customer payments" }); }
}

export async function getCustomerLedger(req, res) {
  try { const stores = await customerAndScope(req,res); if (!stores) return; const result = await connection.query(`SELECT e.*,s.name AS store_name,s.code AS store_code FROM (${balanceSql}) e JOIN stores s ON s.id=e.store_id ORDER BY e.entry_date,e.store_id,e.entry_type,e.reference`, [req.params.id,stores]); res.json(result.rows); }
  catch (error) { console.error("Unable to load customer ledger:", error.message); res.status(500).json({ message: "Unable to load customer ledger" }); }
}

export async function getCustomerBalance(req, res) {
  try { const stores = await customerAndScope(req,res); if (!stores) return; const result = await connection.query(`SELECT s.id AS store_id,s.code AS store_code,s.name AS store_name,COALESCE(sum(e.debit-e.credit),0)::numeric(18,2) AS outstanding_balance FROM stores s LEFT JOIN (${balanceSql}) e ON e.store_id=s.id WHERE s.id=ANY($2::bigint[]) GROUP BY s.id,s.code,s.name ORDER BY s.name,s.id`, [req.params.id,stores]); const total = result.rows.reduce((sum,row)=>sum+Number(row.outstanding_balance),0); res.json({ totalOutstanding: total.toFixed(2), stores: result.rows }); }
  catch (error) { console.error("Unable to calculate customer balance:", error.message); res.status(500).json({ message: "Unable to calculate customer balance" }); }
}

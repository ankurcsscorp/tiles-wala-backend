import { gstValidationError } from "../utils/gstValidator.js";
import { gstPartyFields } from "../utils/gstPartyFields.js";
import { connection } from "../../connection.js";

const isAdmin = (req) => req.user?.userType?.toLowerCase() === "admin";
const idOk = (value) => /^\d+$/.test(String(value ?? ""));
const clean = (value) => typeof value === "string" ? value.trim() : "";
const supplierFields = `id,code,name,contact_person,phone,email,tax_id AS gstin,address AS billing_address,city,state,pin_code,payment_terms_days,notes,is_active,created_at,updated_at,gst_details,gst_verified_at,gst_data_source`;
const decimal = (value, label, nullable=true) => {
  if ((value===undefined || value===null || value==="") && nullable) return null;
  const raw=String(value);
  return /^\d{1,16}(\.\d{1,2})?$/.test(raw) ? raw : `${label} must be a non-negative amount with up to 2 decimal places`;
};

function validateSupplier(body={}, creating=false) {
  const data={
    code:clean(body.code).toUpperCase(), name:clean(body.name), contactPerson:clean(body.contactPerson),
    phone:clean(body.mobile ?? body.phone), email:clean(body.email).toLowerCase(),
    gstin:clean(body.gstin ?? body.taxId).toUpperCase(), billingAddress:body.billingAddress ?? body.address ?? {},
    city:clean(body.city), state:clean(body.state), pinCode:clean(body.pinCode),
    paymentTermsDays:Number(body.paymentTermsDays ?? 0), notes:clean(body.notes),
    isActive:body.isActive!==false,
    openingBalance:creating?decimal(body.openingBalance,"Opening balance"):null,
    openingDirection:body.openingDirection==="debit"?"debit":"credit",
    openingStoreId:body.openingStoreId || body.storeId || null,
  };
  if (!data.name || data.name.length>180) return {error:"Supplier name is required and must be 180 characters or fewer"};
  if (data.code && (data.code.length>50 || !/^[A-Z0-9][A-Z0-9._/-]*$/.test(data.code))) return {error:"Supplier code must use letters, numbers, dots, underscores, slashes, or hyphens"};
  const phoneDigits=data.phone.replace(/\D/g,"").length;
  if (data.phone && (!/^[+()\d\s.-]+$/.test(data.phone) || phoneDigits<7 || phoneDigits>15)) return {error:"Mobile number must contain 7 to 15 digits"};
  if (data.phone.length>30 || data.contactPerson.length>150) return {error:"Contact fields exceed the allowed length"};
  if (data.email && (data.email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))) return {error:"Enter a valid email address"};
  if (data.gstin && gstValidationError(data.gstin)) return {error:gstValidationError(data.gstin)};
  if (!data.billingAddress || typeof data.billingAddress!=="object" || Array.isArray(data.billingAddress)) return {error:"Billing address must be an object"};
  if (data.city.length>100 || data.state.length>100 || data.pinCode.length>12 || data.notes.length>10000) return {error:"One or more supplier fields exceed the allowed length"};
  if (!Number.isInteger(data.paymentTermsDays) || data.paymentTermsDays<0 || data.paymentTermsDays>365) return {error:"Payment terms must be between 0 and 365 days"};
  if (body.isActive!==undefined && typeof body.isActive!=="boolean") return {error:"isActive must be a boolean"};
  return {data};
}

async function authorizedStoreIds(req) {
  if (isAdmin(req)) {
    const result=await connection.query("SELECT id FROM stores ORDER BY id");
    return result.rows.map((row)=>String(row.id));
  }
  const result=await connection.query(`SELECT usa.store_id AS id FROM user_store_assignments usa JOIN stores s ON s.id=usa.store_id WHERE usa.user_id=$1 AND usa.is_active=TRUE AND s.is_active=TRUE ORDER BY usa.store_id`,[req.user.id]);
  return result.rows.map((row)=>String(row.id));
}

async function storeScope(req,res,requested) {
  const ids=await authorizedStoreIds(req);
  if (requested!==undefined && requested!=="") {
    if (!idOk(requested)) {res.status(400).json({message:"Invalid store ID"});return null;}
    if (!ids.includes(String(requested))) {res.status(403).json({message:"You do not have access to this store"});return null;}
    return [String(requested)];
  }
  return ids;
}

async function requireSupplierManagementAccess(req,res) {
  if(isAdmin(req))return true;
  try{if((await authorizedStoreIds(req)).length)return true;res.status(403).json({message:"An active store assignment is required to manage suppliers"});return false;}
  catch(error){console.error("Unable to verify supplier permissions:",error.message);res.status(500).json({message:"Unable to verify supplier permissions"});return false;}
}

const ledgerSql=`WITH entries AS (
 SELECT pi.supplier_id,pi.store_id,pi.invoice_date AS entry_date,'purchase_invoice'::text AS entry_type,pi.invoice_number AS reference,0::numeric AS debit,pi.total AS credit
 FROM purchase_invoices pi WHERE pi.supplier_id=$1 AND pi.status='posted' AND pi.store_id=ANY($2::bigint[])
 UNION ALL
 SELECT pi.supplier_id,pi.store_id,p.payment_date,'payment',p.payment_number,pa.amount,0::numeric
 FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.store_id=pa.store_id AND p.direction='out' AND p.status='posted'
 JOIN purchase_invoices pi ON pi.id=pa.purchase_invoice_id AND pi.supplier_id=$1 AND pi.status='posted'
 WHERE pa.direction='out' AND pa.store_id=ANY($2::bigint[])
 UNION ALL
 SELECT p.supplier_id,p.store_id,p.payment_date,'payment_unallocated',p.payment_number,
   GREATEST(p.amount-COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.payment_id=p.id AND pa.direction='out'),0),0),0::numeric
 FROM payments p WHERE p.supplier_id=$1 AND p.direction='out' AND p.status='posted' AND p.store_id=ANY($2::bigint[])
   AND p.amount>COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.payment_id=p.id AND pa.direction='out'),0)
 UNION ALL
 SELECT pi.supplier_id,pr.store_id,pr.return_date,'purchase_return',pr.return_number,pr.total,0::numeric
 FROM purchase_returns pr JOIN purchase_invoices pi ON pi.id=pr.purchase_invoice_id
 WHERE pi.supplier_id=$1 AND pr.status='posted' AND pr.store_id=ANY($2::bigint[])
 UNION ALL
 SELECT a.supplier_id,a.store_id,a.adjustment_date,a.adjustment_type,'Adjustment #'||a.id,
 CASE WHEN a.direction='debit' THEN a.amount ELSE 0 END,CASE WHEN a.direction='credit' THEN a.amount ELSE 0 END
 FROM supplier_balance_adjustments a WHERE a.supplier_id=$1 AND a.status='posted' AND a.store_id=ANY($2::bigint[])
)
SELECT supplier_id,store_id,entry_date,entry_type,reference,debit,credit,(credit-debit) AS amount FROM entries`;

export async function listSuppliers(req,res) {
  const page=Number(req.query.page??1),limit=Number(req.query.limit??25);
  if (!Number.isInteger(page)||page<1||!Number.isInteger(limit)||limit<1||limit>100) return res.status(400).json({message:"Page must be positive and limit must be between 1 and 100"});
  try {
    const stores=await authorizedStoreIds(req);
    if (!stores.length&&!isAdmin(req)) return res.json({items:[],pagination:{page,limit,total:0,totalPages:0}});
    const params=[],where=[],bind=(value)=>{params.push(value);return `$${params.length}`;};
    const q=clean(req.query.q).toLowerCase();
    if(q){const p=bind(`${q}%`);where.push(`(lower(s.name) LIKE ${p} OR lower(COALESCE(s.code,'')) LIKE ${p} OR lower(COALESCE(s.phone,'')) LIKE ${p} OR lower(COALESCE(s.contact_person,'')) LIKE ${p})`);}
    if(req.query.isActive!==undefined)where.push(`s.is_active=${bind(String(req.query.isActive)==="true")}`);
    for(const key of ["city","state"])if(clean(req.query[key]))where.push(`lower(s.${key}) LIKE lower(${bind(`${clean(req.query[key])}%`)})`);
    const whereSql=where.length?`WHERE ${where.join(" AND ")}`:"";
    const count=await connection.query(`SELECT count(*)::int AS total FROM suppliers s ${whereSql}`,params);
    const projection=supplierFields.split(",").map((field)=>`s.${field.trim()}`).join(",");
    const storeParam=`$${params.length+1}`;
    const outstanding=`COALESCE((SELECT sum(pi.total) FROM purchase_invoices pi WHERE pi.supplier_id=s.id AND pi.store_id=ANY(${storeParam}::bigint[]) AND pi.status='posted'),0)
      -COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id JOIN purchase_invoices pi ON pi.id=pa.purchase_invoice_id WHERE pi.supplier_id=s.id AND pa.store_id=ANY(${storeParam}::bigint[]) AND pa.direction='out' AND p.status='posted' AND pi.status='posted'),0)
      -COALESCE((SELECT sum(GREATEST(p.amount-COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.payment_id=p.id AND pa.direction='out'),0),0)) FROM payments p WHERE p.supplier_id=s.id AND p.store_id=ANY(${storeParam}::bigint[]) AND p.direction='out' AND p.status='posted'),0)
      -COALESCE((SELECT sum(pr.total) FROM purchase_returns pr JOIN purchase_invoices pi ON pi.id=pr.purchase_invoice_id WHERE pi.supplier_id=s.id AND pr.store_id=ANY(${storeParam}::bigint[]) AND pr.status='posted'),0)
      +COALESCE((SELECT sum(CASE WHEN a.direction='credit' THEN a.amount ELSE -a.amount END) FROM supplier_balance_adjustments a WHERE a.supplier_id=s.id AND a.store_id=ANY(${storeParam}::bigint[]) AND a.status='posted'),0)`;
    const result=await connection.query(`SELECT ${projection},(${outstanding})::numeric(18,2) AS outstanding_balance FROM suppliers s ${whereSql} ORDER BY s.name,s.id LIMIT $${params.length+2} OFFSET $${params.length+3}`,[...params,stores,limit,(page-1)*limit]);
    res.json({items:result.rows,pagination:{page,limit,total:count.rows[0].total,totalPages:Math.ceil(count.rows[0].total/limit)}});
  } catch(error){console.error("Unable to list suppliers:",error.message);res.status(500).json({message:"Unable to load suppliers"});}
}

export async function searchSuppliers(req,res) {
  const q=clean(req.query.q);if(q.length<2)return res.json([]);
  try{if(!(await authorizedStoreIds(req)).length&&!isAdmin(req))return res.json([]);const result=await connection.query(`SELECT ${supplierFields} FROM suppliers WHERE is_active=TRUE AND (name ILIKE $1 OR COALESCE(code,'') ILIKE $1 OR COALESCE(phone,'') ILIKE $1 OR COALESCE(contact_person,'') ILIKE $1) ORDER BY CASE WHEN phone ILIKE $2 THEN 0 ELSE 1 END,name LIMIT 15`,[`%${q}%`,`${q}%`]);res.json(result.rows);}
  catch(error){console.error("Unable to search suppliers:",error.message);res.status(500).json({message:"Unable to search suppliers"});}
}

export async function createSupplier(req,res) {
  const {data,error}=validateSupplier(req.body,true);if(error)return res.status(400).json({message:error});
  if(!(await requireSupplierManagementAccess(req,res)))return;
  if(typeof data.openingBalance==="string"&&data.openingBalance.includes("must be"))return res.status(400).json({message:data.openingBalance});
  const gst=gstPartyFields(req.body,data.gstin);if(gst.error)return res.status(400).json({message:gst.error});
  const amount=data.openingBalance;if(amount&&Number(amount)>0&&!data.openingStoreId)return res.status(400).json({message:"Choose a store for the opening balance"});
  const client=await connection.connect();
  try{await client.query("BEGIN");if(amount&&Number(amount)>0){const scope=await storeScope(req,res,data.openingStoreId);if(!scope){await client.query("ROLLBACK");return;}}
    const inserted=await client.query(`INSERT INTO suppliers(code,name,contact_person,phone,email,tax_id,address,city,state,pin_code,payment_terms_days,notes,is_active,gst_details,gst_verified_at,gst_data_source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,[data.code||null,data.name,data.contactPerson||null,data.phone||null,data.email||null,data.gstin||null,data.billingAddress,data.city||null,data.state||null,data.pinCode||null,data.paymentTermsDays,data.notes||null,data.isActive,gst.details || {},gst.verifiedAt,gst.source]);
    const id=inserted.rows[0].id;
    if(amount&&Number(amount)>0)await client.query(`INSERT INTO supplier_balance_adjustments(supplier_id,store_id,adjustment_type,direction,amount,status,note,created_by) VALUES($1,$2,'opening_balance',$3,$4,'posted','Opening balance',$5)`,[id,data.openingStoreId,data.openingDirection,amount,req.user.id]);
    await client.query("COMMIT");const result=await connection.query(`SELECT ${supplierFields} FROM suppliers WHERE id=$1`,[id]);res.status(201).json(result.rows[0]);
  }catch(error){await client.query("ROLLBACK").catch(()=>{});if(error.code==="23505")return res.status(409).json({message:error.constraint==="suppliers_gstin_unique"?"A supplier with this GSTIN already exists":"A supplier with this code already exists"});if(error.code==="23503")return res.status(400).json({message:"The selected store does not exist"});console.error("Unable to create supplier:",error.message);res.status(500).json({message:"Unable to create supplier"});}finally{client.release();}
}

export async function getSupplier(req,res) {
  if(!idOk(req.params.id))return res.status(400).json({message:"Invalid supplier ID"});
  try{if(!(await authorizedStoreIds(req)).length&&!isAdmin(req))return res.status(403).json({message:"No active store access is assigned to this account"});const result=await connection.query(`SELECT ${supplierFields} FROM suppliers WHERE id=$1`,[req.params.id]);if(!result.rowCount)return res.status(404).json({message:"Supplier not found"});res.json(result.rows[0]);}
  catch(error){console.error("Unable to load supplier:",error.message);res.status(500).json({message:"Unable to load supplier"});}
}

export async function updateSupplier(req,res) {
  if(!idOk(req.params.id))return res.status(400).json({message:"Invalid supplier ID"});if(!(await requireSupplierManagementAccess(req,res)))return;const {data,error}=validateSupplier(req.body);if(error)return res.status(400).json({message:error});
  const gst=gstPartyFields(req.body,data.gstin);if(gst.error)return res.status(400).json({message:gst.error});
  try{const result=await connection.query(`UPDATE suppliers SET code=$2,name=$3,contact_person=$4,phone=$5,email=$6,tax_id=$7,address=$8,city=$9,state=$10,pin_code=$11,payment_terms_days=$12,notes=$13,is_active=$14,gst_details=COALESCE($15::jsonb,CASE WHEN tax_id IS NOT DISTINCT FROM $7 THEN gst_details ELSE '{}'::jsonb END),gst_verified_at=CASE WHEN $16::timestamptz IS NOT NULL THEN $16 WHEN tax_id IS NOT DISTINCT FROM $7 AND NOT $18 THEN gst_verified_at ELSE NULL END,gst_data_source=CASE WHEN $17::varchar IS NOT NULL THEN $17 WHEN tax_id IS NOT DISTINCT FROM $7 AND NOT $18 THEN gst_data_source ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING ${supplierFields}`,[req.params.id,data.code||null,data.name,data.contactPerson||null,data.phone||null,data.email||null,data.gstin||null,data.billingAddress,data.city||null,data.state||null,data.pinCode||null,data.paymentTermsDays,data.notes||null,data.isActive,gst.details,gst.verifiedAt,gst.source,req.body.clearGstVerification === true]);if(!result.rowCount)return res.status(404).json({message:"Supplier not found"});res.json(result.rows[0]);}
  catch(error){if(error.code==="23505")return res.status(409).json({message:error.constraint==="suppliers_gstin_unique"?"A supplier with this GSTIN already exists":"A supplier with this code already exists"});console.error("Unable to update supplier:",error.message);res.status(500).json({message:"Unable to update supplier"});}
}

export async function setSupplierActive(req,res) {
  if(!idOk(req.params.id)||typeof req.body?.isActive!=="boolean")return res.status(400).json({message:"Valid supplier ID and isActive boolean are required"});if(!(await requireSupplierManagementAccess(req,res)))return;
  try{const result=await connection.query("UPDATE suppliers SET is_active=$2,updated_at=now() WHERE id=$1 RETURNING id,is_active",[req.params.id,req.body.isActive]);if(!result.rowCount)return res.status(404).json({message:"Supplier not found"});res.json(result.rows[0]);}catch(error){res.status(500).json({message:"Unable to change supplier status"});}
}

async function supplierScope(req,res) {
  if(!idOk(req.params.id)){res.status(400).json({message:"Invalid supplier ID"});return null;}
  const stores=await storeScope(req,res,req.query.storeId);if(!stores)return null;
  if(!stores.length&&!isAdmin(req)){res.status(403).json({message:"No active store access is assigned to this account"});return null;}
  const exists=await connection.query("SELECT 1 FROM suppliers WHERE id=$1",[req.params.id]);if(!exists.rowCount){res.status(404).json({message:"Supplier not found"});return null;}return stores;
}

export async function getSupplierInvoices(req,res) {
  try{const stores=await supplierScope(req,res);if(!stores)return;const result=await connection.query(`SELECT pi.id,pi.store_id,s.name AS store_name,s.code AS store_code,pi.series,pi.invoice_number,pi.supplier_invoice_number,pi.invoice_date,pi.due_date,pi.subtotal,pi.discount_total,pi.tax_total,pi.total,pi.status,COALESCE(paid.amount,0)::numeric(18,2) AS allocated_payments,COALESCE(ret.amount,0)::numeric(18,2) AS returns,(pi.total-COALESCE(paid.amount,0)-COALESCE(ret.amount,0))::numeric(18,2) AS outstanding_balance FROM purchase_invoices pi JOIN stores s ON s.id=pi.store_id LEFT JOIN LATERAL(SELECT sum(pa.amount) amount FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id WHERE pa.purchase_invoice_id=pi.id AND p.status='posted') paid ON TRUE LEFT JOIN LATERAL(SELECT sum(total) amount FROM purchase_returns WHERE purchase_invoice_id=pi.id AND status='posted') ret ON TRUE WHERE pi.supplier_id=$1 AND pi.store_id=ANY($2::bigint[]) AND pi.status='posted' ORDER BY pi.invoice_date DESC,pi.id DESC`,[req.params.id,stores]);res.json(result.rows);}
  catch(error){console.error("Unable to load supplier invoices:",error.message);res.status(500).json({message:"Unable to load supplier invoices"});}
}

export async function getSupplierPayments(req,res) {
  try{const stores=await supplierScope(req,res);if(!stores)return;const result=await connection.query(`SELECT p.id,p.store_id,s.name AS store_name,s.code AS store_code,p.payment_number,p.payment_method,p.payment_date,p.amount,p.reference,p.notes,COALESCE(json_agg(json_build_object('invoiceId',pi.id,'invoiceNumber',pi.invoice_number,'amount',pa.amount) ORDER BY pi.invoice_number) FILTER(WHERE pi.id IS NOT NULL),'[]'::json) AS allocations FROM payments p LEFT JOIN payment_allocations pa ON pa.payment_id=p.id AND pa.store_id=p.store_id AND pa.direction='out' LEFT JOIN purchase_invoices pi ON pi.id=pa.purchase_invoice_id AND pi.supplier_id=$1 AND pi.status='posted' JOIN stores s ON s.id=p.store_id WHERE p.direction='out' AND p.status='posted' AND p.store_id=ANY($2::bigint[]) AND (p.supplier_id=$1 OR (p.supplier_id IS NULL AND pi.supplier_id=$1)) GROUP BY p.id,s.name,s.code ORDER BY p.payment_date DESC,p.id DESC`,[req.params.id,stores]);res.json(result.rows);}
  catch(error){console.error("Unable to load supplier payments:",error.message);res.status(500).json({message:"Unable to load supplier payments"});}
}

export async function getSupplierLedger(req,res) {
  try{const stores=await supplierScope(req,res);if(!stores)return;const result=await connection.query(`SELECT e.*,s.name AS store_name,s.code AS store_code FROM (${ledgerSql}) e JOIN stores s ON s.id=e.store_id ORDER BY e.entry_date,e.store_id,e.entry_type,e.reference`,[req.params.id,stores]);res.json(result.rows);}
  catch(error){console.error("Unable to load supplier ledger:",error.message);res.status(500).json({message:"Unable to load supplier ledger"});}
}

export async function getSupplierBalance(req,res) {
  try{const stores=await supplierScope(req,res);if(!stores)return;const result=await connection.query(`SELECT s.id AS store_id,s.code AS store_code,s.name AS store_name,COALESCE(sum(e.credit-e.debit),0)::numeric(18,2) AS outstanding_payable FROM stores s LEFT JOIN (${ledgerSql}) e ON e.store_id=s.id WHERE s.id=ANY($2::bigint[]) GROUP BY s.id,s.code,s.name ORDER BY s.name,s.id`,[req.params.id,stores]);const total=result.rows.reduce((sum,row)=>sum+Number(row.outstanding_payable),0);res.json({totalOutstanding:total.toFixed(2),stores:result.rows});}
  catch(error){console.error("Unable to calculate supplier balance:",error.message);res.status(500).json({message:"Unable to calculate supplier balance"});}
}

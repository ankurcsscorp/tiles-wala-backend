import { connection } from "../../connection.js";

const ADMIN = "admin";
const isAdmin = (req) => req.user?.userType?.toLowerCase() === ADMIN;
const idPattern = /^\d+$/;
const validEmail = (value) => !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const clean = (value) => typeof value === "string" ? value.trim() : "";

const storeProfileFields = `id, code, name, legal_name, address, city, state, pin_code, phone, email,
  COALESCE(gstin, tax_id) AS gstin, logo_url, invoice_footer,
  terms_and_conditions, invoice_numbering_period, invoice_number_padding, is_active,
  created_at, updated_at`;
const storeFields = `${storeProfileFields}, COALESCE((SELECT c.invoice_prefix FROM store_billing_config c WHERE c.store_id=stores.id),code) AS invoice_prefix`;

export async function canAccessStore(user, storeId) {
  if (user?.userType?.toLowerCase() === ADMIN) return true;
  const result = await connection.query(
    `SELECT 1 FROM user_store_assignments usa JOIN stores s ON s.id=usa.store_id
     WHERE usa.user_id=$1 AND usa.store_id=$2 AND usa.is_active=TRUE AND s.is_active=TRUE`,
    [user.id, storeId]
  );
  return result.rowCount > 0;
}

export async function canManageStore(user, storeId, roles = ["owner", "manager"], db = connection) {
  if (isAdmin({ user })) return true;
  const result = await db.query(
    `SELECT usa.role FROM user_store_assignments usa JOIN stores s ON s.id=usa.store_id
     WHERE usa.user_id=$1 AND usa.store_id=$2 AND usa.is_active=TRUE AND s.is_active=TRUE`,
    [user.id, storeId]
  );
  return result.rows.some((assignment) => roles.includes(assignment.role));
}

export async function listStores(req, res) {
  try {
    const result = isAdmin(req)
      ? await connection.query(`SELECT ${storeFields} FROM stores ORDER BY name, id`)
      : await connection.query(
        `SELECT ${storeFields} FROM stores WHERE is_active=TRUE AND EXISTS (
           SELECT 1 FROM user_store_assignments usa WHERE usa.store_id=stores.id AND usa.user_id=$1 AND usa.is_active=TRUE
         ) ORDER BY name, id`,
        [req.user.id]
      );
    res.json(result.rows);
  } catch (error) {
    console.error("Unable to list stores:", error.message);
    res.status(500).json({ message: "Unable to load stores" });
  }
}

export async function getStore(req, res) {
  const id = req.params.id;
  if (!idPattern.test(id)) return res.status(400).json({ message: "Invalid store ID" });
  try {
    if (!(await canAccessStore(req.user, id))) return res.status(403).json({ message: "You do not have access to this store" });
    const result = await connection.query(`SELECT ${storeFields} FROM stores WHERE id=$1`, [id]);
    if (!result.rowCount) return res.status(404).json({ message: "Store not found" });
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Unable to load store:", error.message);
    res.status(500).json({ message: "Unable to load store" });
  }
}

function validateStore(body = {}) {
  const data = {
    code: clean(body.code).toUpperCase(), name: clean(body.name), legalName: clean(body.legalName),
    address: body.address && typeof body.address === "object" && !Array.isArray(body.address) ? body.address : {},
    city: clean(body.city), state: clean(body.state), pinCode: clean(body.pinCode), phone: clean(body.phone),
    email: clean(body.email).toLowerCase(), gstin: clean(body.gstin).toUpperCase(), logoUrl: clean(body.logoUrl),
    invoicePrefix: clean(body.invoicePrefix).toUpperCase(), invoiceFooter: clean(body.invoiceFooter),
    terms: clean(body.termsAndConditions), period: clean(body.invoiceNumberingPeriod) || "yearly",
    padding: Number(body.invoiceNumberPadding ?? 5),
  };
  if (!data.code || data.code.length > 40 || !/^[A-Z0-9][A-Z0-9_-]*$/.test(data.code)) return { error: "Store code is required and may contain letters, numbers, hyphens, or underscores" };
  if (!data.name || data.name.length > 160) return { error: "Store name is required and must be 160 characters or fewer" };
  if (data.legalName.length > 200 || data.city.length > 100 || data.state.length > 100 || data.pinCode.length > 12 || data.phone.length > 30 || data.email.length > 254 || data.invoicePrefix.length > 24) return { error: "One or more store fields exceed the allowed length" };
  if (!validEmail(data.email)) return { error: "Enter a valid email address" };
  if (data.gstin && !/^[0-9A-Z]{15}$/.test(data.gstin)) return { error: "GSTIN must contain 15 letters or digits" };
  if (data.logoUrl && data.logoUrl.length > 2000) return { error: "Logo URL must be 2000 characters or fewer" };
  if (!data.invoicePrefix) data.invoicePrefix = data.code;
  if (!["yearly", "monthly", "never"].includes(data.period)) return { error: "Invoice numbering period must be yearly, monthly, or never" };
  if (!Number.isInteger(data.padding) || data.padding < 1 || data.padding > 12) return { error: "Invoice number padding must be between 1 and 12" };
  return { data };
}

export async function createStore(req, res) {
  const { data, error } = validateStore(req.body);
  if (error) return res.status(400).json({ message: error });
  const client = await connection.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO stores(code,name,legal_name,address,city,state,pin_code,phone,email,gstin,tax_id,logo_url,invoice_footer,terms_and_conditions,invoice_numbering_period,invoice_number_padding)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$15) RETURNING ${storeProfileFields}`,
      [data.code,data.name,data.legalName || null,data.address,data.city || null,data.state || null,data.pinCode || null,data.phone || null,data.email || null,data.gstin || null,data.logoUrl || null,data.invoiceFooter || null,data.terms || null,data.period,data.padding]
    );
    const store = { ...result.rows[0], invoice_prefix: data.invoicePrefix };
    await client.query("INSERT INTO store_billing_config(store_id, invoice_prefix, terms_and_conditions) VALUES($1,$2,$3)", [store.id, data.invoicePrefix, data.terms || null]);
    await client.query("COMMIT");
    res.status(201).json(store);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") return res.status(409).json({ message: "A store with this code already exists" });
    console.error("Unable to create store:", error.message);
    res.status(500).json({ message: "Unable to create store" });
  } finally { client.release(); }
}

export async function updateStore(req, res) {
  const id = req.params.id;
  if (!idPattern.test(id)) return res.status(400).json({ message: "Invalid store ID" });
  const { data, error } = validateStore(req.body);
  if (error) return res.status(400).json({ message: error });
  const client = await connection.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE stores SET code=$2,name=$3,legal_name=$4,address=$5,city=$6,state=$7,pin_code=$8,phone=$9,email=$10,gstin=$11,tax_id=$11,logo_url=$12,invoice_footer=$13,terms_and_conditions=$14,invoice_numbering_period=$15,invoice_number_padding=$16,updated_at=now()
       WHERE id=$1 RETURNING ${storeProfileFields}`,
      [id,data.code,data.name,data.legalName || null,data.address,data.city || null,data.state || null,data.pinCode || null,data.phone || null,data.email || null,data.gstin || null,data.logoUrl || null,data.invoiceFooter || null,data.terms || null,data.period,data.padding]
    );
    if (!result.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Store not found" }); }
    await client.query(`INSERT INTO store_billing_config(store_id,invoice_prefix,terms_and_conditions) VALUES($1,$2,$3)
      ON CONFLICT(store_id) DO UPDATE SET invoice_prefix=EXCLUDED.invoice_prefix,terms_and_conditions=EXCLUDED.terms_and_conditions,updated_at=now()`, [id,data.invoicePrefix,data.terms || null]);
    await client.query("COMMIT");
    res.json({ ...result.rows[0], invoice_prefix: data.invoicePrefix });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") return res.status(409).json({ message: "A store with this code already exists" });
    console.error("Unable to update store:", error.message);
    res.status(500).json({ message: "Unable to update store" });
  } finally { client.release(); }
}

export async function setStoreActive(req, res) {
  const id = req.params.id;
  const active = req.body?.isActive;
  if (!idPattern.test(id)) return res.status(400).json({ message: "Invalid store ID" });
  if (typeof active !== "boolean") return res.status(400).json({ message: "isActive must be a boolean" });
  try {
    const result = await connection.query(`UPDATE stores SET is_active=$2,updated_at=now() WHERE id=$1 RETURNING ${storeFields}`, [id,active]);
    if (!result.rowCount) return res.status(404).json({ message: "Store not found" });
    res.json(result.rows[0]);
  } catch (error) { console.error("Unable to change store status:", error.message); res.status(500).json({ message: "Unable to change store status" }); }
}

export async function getStoreSettings(req, res) {
  const id = req.params.id;
  if (!idPattern.test(id)) return res.status(400).json({ message: "Invalid store ID" });
  try {
    if (!(await canAccessStore(req.user, id))) return res.status(403).json({ message: "You do not have access to this store" });
    const result = await connection.query(
      `SELECT s.id AS store_id,s.legal_name,s.gstin,COALESCE(s.tax_id,s.gstin) AS tax_id,s.address,s.city,s.state,s.pin_code,s.phone,s.email,s.logo_url,s.invoice_footer,s.terms_and_conditions,s.invoice_numbering_period,s.invoice_number_padding,
       c.tax_inclusive,c.default_tax_rate,c.invoice_prefix,c.settings,c.terms_and_conditions AS billing_terms
       FROM stores s LEFT JOIN store_billing_config c ON c.store_id=s.id WHERE s.id=$1`, [id]
    );
    if (!result.rowCount) return res.status(404).json({ message: "Store not found" });
    res.json(result.rows[0]);
  } catch (error) { console.error("Unable to load store settings:", error.message); res.status(500).json({ message: "Unable to load store settings" }); }
}

export async function updateStoreSettings(req, res) {
  const id = req.params.id;
  const b = req.body ?? {};
  const taxRate = Number(b.defaultTaxRate);
  if (!idPattern.test(id)) return res.status(400).json({ message: "Invalid store ID" });
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100 || typeof b.taxInclusive !== "boolean") return res.status(400).json({ message: "Provide a valid tax rate and taxInclusive setting" });
  const validated = validateStore({ ...b, code: b.code || "STORE", name: b.name || "Store" });
  if (validated.error) return res.status(400).json({ message: validated.error });
  const config = validated.data;
  try {
    const client = await connection.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(`UPDATE stores SET legal_name=$2,gstin=$3,tax_id=$3,address=$4,city=$5,state=$6,pin_code=$7,phone=$8,email=$9,logo_url=$10,invoice_footer=$11,terms_and_conditions=$12,invoice_numbering_period=$13,invoice_number_padding=$14,updated_at=now() WHERE id=$1 RETURNING id`, [id,config.legalName||null,config.gstin||null,config.address,config.city||null,config.state||null,config.pinCode||null,config.phone||null,config.email||null,config.logoUrl||null,config.invoiceFooter||null,config.terms||null,config.period,config.padding]);
      if (!updated.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Store not found" }); }
      await client.query(`INSERT INTO store_billing_config(store_id,tax_inclusive,default_tax_rate,invoice_prefix,terms_and_conditions) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(store_id) DO UPDATE SET tax_inclusive=EXCLUDED.tax_inclusive,default_tax_rate=EXCLUDED.default_tax_rate,invoice_prefix=EXCLUDED.invoice_prefix,terms_and_conditions=EXCLUDED.terms_and_conditions,updated_at=now()`, [id,b.taxInclusive,taxRate,config.invoicePrefix,config.terms||null]);
      await client.query("COMMIT");
      return getStoreSettings(req,res);
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  } catch (error) { console.error("Unable to save store settings:", error.message); res.status(500).json({ message: "Unable to save store settings" }); }
}

export async function getNumberingConfig(req, res) {
  const id=req.params.id;
  if (!idPattern.test(id)) return res.status(400).json({ message: "Invalid store ID" });
  try {
    if (!(await canAccessStore(req.user,id))) return res.status(403).json({ message: "You do not have access to this store" });
    const result=await connection.query(`SELECT document_type,series,period_key,next_number FROM invoice_number_sequences WHERE store_id=$1 ORDER BY document_type,series,period_key`,[id]);
    res.json(result.rows);
  } catch(error) { console.error("Unable to load numbering configuration:",error.message); res.status(500).json({message:"Unable to load invoice numbering configuration"}); }
}

export async function listAssignments(req,res) {
  const id=req.params.id;
  if(!idPattern.test(id)) return res.status(400).json({message:"Invalid store ID"});
  try {
    const result=await connection.query(`SELECT usa.id,usa.user_id,usa.store_id,usa.role,usa.is_default,usa.is_active,u.name,u.mobile,u.user_type FROM user_store_assignments usa JOIN users u ON u.id=usa.user_id WHERE usa.store_id=$1 ORDER BY u.name,u.id`,[id]);
    res.json(result.rows);
  } catch(error) { console.error("Unable to list assignments:",error.message); res.status(500).json({message:"Unable to load store assignments"}); }
}

export async function searchAssignableUsers(req,res) {
  const q=clean(req.query.q);
  if(!q||q.length>100) return res.status(400).json({message:"Search text is required and must be 100 characters or fewer"});
  try { const result=await connection.query(`SELECT id,name,mobile,user_type FROM users WHERE LOWER(name) LIKE LOWER($1) OR mobile LIKE $1 ORDER BY name,id LIMIT 20`,[`%${q}%`]); res.json(result.rows); }
  catch(error) { console.error("Unable to search users for store assignment:",error.message); res.status(500).json({message:"Unable to search users"}); }
}

export async function saveAssignment(req,res) {
  const storeId=req.params.id; const userId=req.body?.userId; const role=clean(req.body?.role)||"staff";
  const active=req.body?.isActive!==false; const isDefault=req.body?.isDefault===true;
  if(!idPattern.test(storeId)||!/^\d+$/.test(String(userId??""))) return res.status(400).json({message:"Valid store and user IDs are required"});
  if(!["owner","manager","cashier","inventory","staff"].includes(role)) return res.status(400).json({message:"Invalid store role"});
  try {
    const result=await connection.query(`INSERT INTO user_store_assignments(user_id,store_id,role,is_default,is_active) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(user_id,store_id) DO UPDATE SET role=EXCLUDED.role,is_default=EXCLUDED.is_default,is_active=EXCLUDED.is_active
      RETURNING *`,[userId,storeId,role,isDefault,active]);
    res.status(200).json(result.rows[0]);
  } catch(error) { if(error.code==='23505') return res.status(409).json({message:"User already has a default store assignment"}); if(error.code==='23503') return res.status(404).json({message:"Store or user was not found"}); console.error("Unable to save assignment:",error.message); res.status(500).json({message:"Unable to save store assignment"}); }
}

export async function removeAssignment(req,res) {
  const id=req.params.assignmentId;
  if(!idPattern.test(id)) return res.status(400).json({message:"Invalid assignment ID"});
  try { const result=await connection.query("DELETE FROM user_store_assignments WHERE id=$1 RETURNING id",[id]); if(!result.rowCount) return res.status(404).json({message:"Assignment not found"}); res.status(204).end(); }
  catch(error) { console.error("Unable to remove assignment:",error.message); res.status(500).json({message:"Unable to remove assignment"}); }
}

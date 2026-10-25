import {INVOICE_LAYOUTS,DOCUMENT_TYPES,documentWarning,documentOptions} from "../services/invoicePolicy.js";
import { connection } from "../../connection.js";
import { canAccessStore, canManageStore } from "./stores.js";

const hasStoredTaxId = settings => [settings.gstin, settings.tax_id].some(value => String(value ?? '').trim().length > 0);

export function taxTreatmentWarning(settings) {
  if (settings.invoice_type !== "NON_GST") return null;
  if (hasStoredTaxId(settings))
    return "Non-GST billing is blocked because this store has a GSTIN or tax ID saved. Keep GST Invoice selected. If those details are inaccurate, an administrator must correct them in Stores. Choose an eligible tax document in Invoice Settings; appearance can still be Simple Layout.";
  if (settings.gst_registration_status === "REGISTERED")
    return "Non-GST billing is not supported for a store declared as GST registered. Choose an eligible tax document in Invoice Settings; appearance can still be Simple Layout.";
  if (settings.gst_registration_status !== "UNREGISTERED")
    return "Confirm the actual business GST registration status before saving Non-GST Invoice. Select Unregistered only if the business is unregistered; a format selection does not establish a tax exemption.";
  return null;
}
export async function readInvoiceSettings(db, id, lock = false) {
  const r = await db.query(`SELECT s.id AS store_id,s.gstin,s.tax_id,
    COALESCE(c.invoice_type,'GST') AS invoice_type, s.state,
    COALESCE(c.invoice_layout,'STANDARD_GST_LAYOUT') AS invoice_layout,
    COALESCE(c.default_document_type,'GST_TAX_INVOICE') AS default_document_type,
    COALESCE(c.gst_registration_category,'UNKNOWN') AS gst_registration_category,COALESCE(c.gst_registration_status,'UNKNOWN') AS gst_registration_status
    FROM stores s LEFT JOIN store_billing_config c ON c.store_id=s.id WHERE s.id=$1 AND s.is_active=TRUE ${lock ? "FOR SHARE OF s" : ""}`, [id]);
  return r.rows[0];
}
const output = (s, canEdit) => ({success:true,data:{storeId:s.store_id,invoiceType:s.invoice_type,
  billingMode:s.invoice_layout==='SIMPLE_LAYOUT'?'SIMPLE':'GST',invoiceLayout:s.invoice_layout,defaultDocumentType:s.default_document_type,
  registrationCategory:s.gst_registration_category,state:s.state,gstin:s.gstin||s.tax_id||'',documentOptions:documentOptions(s),
  registrationStatus:s.gst_registration_status,hasStoredTaxId:hasStoredTaxId(s),canEdit,warning:documentWarning(s,s.default_document_type)}});
export async function getInvoiceSettings(req,res) {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({message:"Invalid store ID"});
  try {
    if (!await canAccessStore(req.user,req.params.id)) return res.status(403).json({message:"You do not have access to this store"});
    const s = await readInvoiceSettings(connection,req.params.id);
    if (!s) return res.status(404).json({message:"Active store not found"});
    return res.json(output(s,await canManageStore(req.user,req.params.id)));
  } catch(e) { console.error("Invoice settings",e.message);return res.status(500).json({message:"Unable to load invoice settings"}); }
}
export async function putInvoiceSettings(req,res) {
  const {invoiceType,registrationStatus,invoiceLayout,defaultDocumentType,registrationCategory} = req.body || {};
  if (!/^\d+$/.test(req.params.id) || (invoiceType!==undefined && !["GST","NON_GST"].includes(invoiceType)) ||
    (registrationStatus !== undefined && !["UNKNOWN","REGISTERED","UNREGISTERED"].includes(registrationStatus)))
    return res.status(400).json({message:"Invalid invoice type or registration status"});
  if((invoiceLayout!==undefined&&!INVOICE_LAYOUTS.includes(invoiceLayout)) || (defaultDocumentType!==undefined&&!DOCUMENT_TYPES.includes(defaultDocumentType)) ||
    (registrationCategory!==undefined&&!['UNKNOWN','REGULAR','COMPOSITION'].includes(registrationCategory)))return res.status(400).json({message:'Invalid layout, document type, or registration category'});
  const c = await connection.connect();
  try {
    await c.query("BEGIN");
    if (!await canManageStore(req.user,req.params.id,undefined,c)) {await c.query("ROLLBACK");return res.status(403).json({message:"Only store owners, managers, or administrators can change invoice settings"});}
    // Serialize settings writes with draft creation and finalization through the store row.
    await c.query("SELECT id FROM stores WHERE id=$1 FOR UPDATE",[req.params.id]);
    const previous = await readInvoiceSettings(c,req.params.id);
    if (!previous) {await c.query("ROLLBACK");return res.status(404).json({message:"Active store not found"});}
    // Legacy invoiceType requests retain their tax meaning. Appearance-only requests never change it.
    const documentType=defaultDocumentType ?? (invoiceType===undefined?previous.default_document_type:invoiceType==='GST'?'GST_TAX_INVOICE':'NON_GST_COMMERCIAL');
    const next = {...previous,invoice_layout:invoiceLayout??previous.invoice_layout,
      default_document_type:documentType,invoice_type:documentType==='NON_GST_COMMERCIAL'?'NON_GST':'GST',
      gst_registration_status:registrationStatus??previous.gst_registration_status,
      gst_registration_category:registrationCategory??previous.gst_registration_category};
    const taxChanged=documentType!==previous.default_document_type || registrationStatus!==undefined || registrationCategory!==undefined || invoiceType!==undefined;
    const warning=taxChanged?documentWarning(next,documentType):null;
    if(warning){await c.query('ROLLBACK');return res.status(422).json({message:warning});}
    await c.query(`INSERT INTO store_billing_config(store_id,invoice_type,invoice_layout,default_document_type,gst_registration_status,gst_registration_category,invoice_settings_updated_at,invoice_settings_updated_by)
      VALUES($1,$2,$3,$4,$5,$6,now(),$7) ON CONFLICT(store_id) DO UPDATE SET invoice_type=$2,invoice_layout=$3,default_document_type=$4,gst_registration_status=$5,gst_registration_category=$6,invoice_settings_updated_at=now(),invoice_settings_updated_by=$7`,
      [req.params.id,next.invoice_type,next.invoice_layout,documentType,next.gst_registration_status,next.gst_registration_category,req.user.id]);
    await c.query("INSERT INTO invoice_settings_audit(store_id,changed_by,previous_settings,new_settings) VALUES($1,$2,$3,$4)",[req.params.id,req.user.id,previous,next]);
    await c.query("COMMIT");return res.json(output(next,true));
  } catch(e) {await c.query("ROLLBACK").catch(()=>{});console.error("Invoice settings",e.message);return res.status(500).json({message:"Unable to save invoice settings"});}
  finally {c.release();}
}

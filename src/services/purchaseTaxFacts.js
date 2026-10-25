import {gstValidationError} from '../utils/gstValidator.js';
export const SUPPLIER_DOCUMENT_TYPES=['GST_TAX_INVOICE','BILL_OF_SUPPLY','NON_GST_COMMERCIAL'];
const reject=message=>{throw Object.assign(new Error(message),{status:422});};
// Buyer registration and appearance deliberately do not participate in this decision.
export async function validateSupplierTaxFacts(db,data,{posting=false}={}) {
 if(!data.supplierDocumentType)return; // Existing drafts retain their original workflow.
 const r=await db.query('SELECT tax_id FROM suppliers WHERE id=$1 AND is_active=TRUE FOR SHARE',[data.supplierId]);
 if(!r.rowCount)reject('Active supplier not found');
 const gstin=String(r.rows[0].tax_id||'').trim();
 if(data.supplierDocumentType!=='GST_TAX_INVOICE'&&data.declaredTaxTotal!==null&&data.declaredTaxTotal!==undefined&&Number(data.declaredTaxTotal)!==0)reject('A nonzero supplier GST total cannot be discarded by selecting a document without GST. Review the supplier invoice.');
 if(data.supplierDocumentType==='NON_GST_COMMERCIAL') {
  if(gstin)reject('This supplier has a GSTIN. Record the actual GST Tax Invoice or Bill of Supply; Simple Billing does not change supplier tax treatment.');
 } else if(gstValidationError(gstin))reject('Record a valid supplier GSTIN before recording this supplier tax document.');
 if(data.supplierDocumentType==='BILL_OF_SUPPLY'&&!data.supplierTaxReason?.trim())reject('Record the exemption or composition basis shown on the supplier Bill of Supply.');
 if(data.supplierDocumentType==='GST_TAX_INVOICE'){
  if(!['INTRA_STATE','INTER_STATE'].includes(data.supplierTaxJurisdiction))reject('Select the GST breakup shown on the supplier invoice (CGST/SGST or IGST).');
  if(posting&&(!data.supplierInvoiceNumber||data.declaredTaxTotal===null||data.declaredTaxTotal===undefined))reject('Before posting, enter the supplier invoice number and the GST total shown on that invoice.');
 }
}

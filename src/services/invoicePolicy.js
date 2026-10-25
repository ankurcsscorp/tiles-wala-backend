import {gstValidationError} from '../utils/gstValidator.js';

export const INVOICE_LAYOUTS=['STANDARD_GST_LAYOUT','SIMPLE_LAYOUT'];
export const DOCUMENT_TYPES=['GST_TAX_INVOICE','BILL_OF_SUPPLY','NON_GST_COMMERCIAL'];
export const hasStoredTaxId=s=>[s.gstin,s.tax_id].some(v=>String(v??'').trim());
export const validStoreGstin=s=>[s.gstin,s.tax_id].some(v=>!gstValidationError(v));
export function documentWarning(s,type) {
  if(type==='NON_GST_COMMERCIAL') {
    if(hasStoredTaxId(s))return 'Non-GST Commercial Invoice requires an unregistered business without a saved GSTIN or tax ID. Appearance can still be Simple Layout.';
    if(s.gst_registration_status!=='UNREGISTERED')return 'Non-GST Commercial Invoice requires an explicit Unregistered declaration.';
    return null;
  }
  if(!validStoreGstin(s))return 'A valid store GSTIN is required for this tax document. Update the actual business details in Stores.';
  if(s.gst_registration_status==='UNREGISTERED')return 'This document is incompatible with an Unregistered declaration.';
  if(type==='GST_TAX_INVOICE') {
    if(s.gst_registration_status!=='REGISTERED')return 'Confirm the actual Registered declaration before issuing a GST Tax Invoice. Appearance changes can be saved independently.';
    if(s.gst_registration_category==='COMPOSITION')return 'Composition businesses must use Bill of Supply and cannot collect GST on these invoices.';
    if(s.gst_registration_category!=='REGULAR')return 'Select the actual Regular registration category before issuing a GST Tax Invoice.';
    return null;
  }
  if(type==='BILL_OF_SUPPLY') {
    if(s.gst_registration_status!=='REGISTERED')return 'Bill of Supply requires an explicit Registered declaration.';
    if(!['REGULAR','COMPOSITION'].includes(s.gst_registration_category))return 'Select the actual registration category before using Bill of Supply.';
    return null;
  }
  return 'Choose a valid tax document type.';
}
export const documentOptions=s=>DOCUMENT_TYPES.map(value=>({value,label:{GST_TAX_INVOICE:'GST Tax Invoice',BILL_OF_SUPPLY:'Bill of Supply',NON_GST_COMMERCIAL:'Non-GST Commercial Invoice'}[value],reason:documentWarning(s,value),description:value==='BILL_OF_SUPPLY'?'Composition: supported domestic supplies only. Regular: every product must be explicitly exempt or non-taxable with a reference.':null}));

export const documentInvoiceType=type=>type==='GST_TAX_INVOICE'?'GST':type==='NON_GST_COMMERCIAL'?'NON_GST':null;
export const billingModeForLayout=layout=>layout==='SIMPLE_LAYOUT'?'SIMPLE':'GST';
export const normalizeSalesStore=store=>({...store,
  gst_registration_status:store.gst_registration_status??store.registrationStatus,
  gst_registration_category:store.gst_registration_category??store.registrationCategory,
  default_document_type:store.default_document_type??store.defaultDocumentType,
  tax_id:store.tax_id??(store.hasStoredTaxId&&!store.gstin?'saved identifier':null)
});
const policyError=(code,message,details={})=>Object.assign(new Error(message),{status:422,code,...details});

// Appearance and invoice lifecycle deliberately do not participate in tax resolution.
// Explicit requests and saved draft documents are validated, never silently converted.
function validateSalesDocumentType({store,products=[],supplyDetails={},requestedDocumentType,requireTaxRate=true}) {
  const s=normalizeSalesStore(store);
  const type=requestedDocumentType??s.default_document_type;
  if(!DOCUMENT_TYPES.includes(type))throw policyError('INVALID_DOCUMENT_TYPE','Choose a valid tax document type.',{field:'documentType'});
  const warning=documentWarning(s,type);
  if(warning)throw policyError(s.gst_registration_status==='UNKNOWN'||s.gst_registration_category==='UNKNOWN'?'GST_REGISTRATION_INCOMPLETE':'DOCUMENT_NOT_ELIGIBLE',warning,{field:'documentType'});
  if(type==='BILL_OF_SUPPLY'&&s.gst_registration_category==='COMPOSITION'&&
    (!s.state||!supplyDetails.placeOfSupply||s.state.trim().toLowerCase()!==supplyDetails.placeOfSupply.trim().toLowerCase()))
    throw policyError('DOCUMENT_NOT_ELIGIBLE','Composition Bill of Supply requires a known domestic intra-state place of supply matching the store state.',{field:'placeOfSupply'});
  products.forEach((p,index)=>{
    const line=p.lineIndex??index,classification=p.gst_supply_classification||'UNKNOWN';
    const details={field:`items[${line}].productId`,productId:p.id??p.productId,lineNumber:line+1};
    const label=`Product ${p.name||p.product_name||p.id||line+1}`;
    if(type==='BILL_OF_SUPPLY'){
      if(!p.hsn_code?.trim()||classification==='UNKNOWN')throw policyError('PRODUCT_TAX_CLASSIFICATION_REQUIRED',`${label} requires HSN and GST supply classification for this Bill of Supply. Update the product details before finalizing.`,details);
      if(s.gst_registration_category==='REGULAR'&&!['EXEMPT','NON_TAXABLE'].includes(classification))throw policyError('DOCUMENT_NOT_ELIGIBLE',`${label}: taxable products require GST Tax Invoice for a regular registered business. Choose GST Tax Invoice for this new sale; Simple Billing can stay selected.`,details);
      if(['EXEMPT','NON_TAXABLE'].includes(classification)&&!p.gst_classification_reference?.trim())throw policyError('PRODUCT_TAX_CLASSIFICATION_REQUIRED',`${label} requires an exemption or non-taxable classification reference for this Bill of Supply. Update Products.`,details);
    }
    if(type==='GST_TAX_INVOICE'){
      if(['EXEMPT','NON_TAXABLE'].includes(classification))throw policyError('DOCUMENT_NOT_ELIGIBLE',`${label} is exempt or non-taxable and requires a separate Bill of Supply. Mixed-document supplies are not supported.`,details);
      if(requireTaxRate&&(p.tax_rate===null||p.tax_rate===undefined||p.tax_rate===''))throw policyError('PRODUCT_TAX_RATE_REQUIRED',`${label} needs its applicable GST rate configured in Products before issuing a GST Tax Invoice. Simple Billing does not establish a zero tax rate.`,details);
    }
  });
  return {documentType:type,invoiceType:documentInvoiceType(type)};
}

// For a NEW sale only, an incompatible default is a preference, not a document request.
// Resolve only when exactly one alternative passes the full transaction policy.
export function resolveSalesDocumentType(args){
  try{return validateSalesDocumentType(args);}
  catch(error){
    if(args.requestedDocumentType!==undefined||!args.products?.length)throw error;
    const eligible=DOCUMENT_TYPES.flatMap(type=>{
      // An unclassified zero rate is insufficient evidence to auto-select a tax treatment.
      if(type==='GST_TAX_INVOICE'&&args.products.some(p=>(!p.gst_supply_classification||p.gst_supply_classification==='UNKNOWN')&&!(Number(p.tax_rate)>0)))return [];
      try{return [validateSalesDocumentType({...args,requestedDocumentType:type})];}catch{return [];}
    });
    if(eligible.length!==1)throw error;
    return {...eligible[0],defaultDocumentType:normalizeSalesStore(args.store).default_document_type,
      reason:'The saved default is not eligible for these products. This new sale uses the only eligible tax document; billing appearance and store defaults stay unchanged.'};
  }
}

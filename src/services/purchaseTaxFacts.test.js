import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateSupplierTaxFacts} from './purchaseTaxFacts.js';
const db=gstin=>({query:async()=>({rowCount:1,rows:[{tax_id:gstin}]})});
test('supplier tax eligibility does not depend on buyer registration or billing mode',async()=>{
 await validateSupplierTaxFacts(db('10JNEPD0678B1ZL'),{supplierId:'1',supplierDocumentType:'GST_TAX_INVOICE',supplierTaxJurisdiction:'INTER_STATE',supplierInvoiceNumber:'SUP-1',declaredTaxTotal:'18.00',invoiceLayout:'SIMPLE_LAYOUT',registrationStatus:'UNREGISTERED'},{posting:true});
 await validateSupplierTaxFacts(db(null),{supplierId:'1',supplierDocumentType:'NON_GST_COMMERCIAL'});
});
test('posting requires supplier tax evidence and rejects contradictory no-GST records',async()=>{
 await assert.rejects(()=>validateSupplierTaxFacts(db(null),{supplierId:'1',supplierDocumentType:'GST_TAX_INVOICE'}),/valid supplier GSTIN/);
 await assert.rejects(()=>validateSupplierTaxFacts(db('10JNEPD0678B1ZL'),{supplierId:'1',supplierDocumentType:'BILL_OF_SUPPLY'}),/basis/);
 await assert.rejects(()=>validateSupplierTaxFacts(db(null),{supplierId:'1',supplierDocumentType:'NON_GST_COMMERCIAL',declaredTaxTotal:'18'}),/cannot be discarded/);
 await assert.rejects(()=>validateSupplierTaxFacts(db('10JNEPD0678B1ZL'),{supplierId:'1',supplierDocumentType:'GST_TAX_INVOICE',supplierTaxJurisdiction:'INTRA_STATE'},{posting:true}),/Before posting/);
});

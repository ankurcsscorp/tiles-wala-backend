import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {documentWarning,resolveSalesDocumentType} from './invoicePolicy.js';
const registered={gstin:'10JNEPD0678B1ZL',gst_registration_status:'REGISTERED',gst_registration_category:'REGULAR'};
test('regular, composition, and unregistered documents have distinct eligibility',()=>{
 assert.equal(documentWarning(registered,'GST_TAX_INVOICE'),null);
 assert.equal(documentWarning(registered,'BILL_OF_SUPPLY'),null);
 assert.equal(documentWarning(registered,'NON_GST_COMMERCIAL'),null);
 assert.match(documentWarning({...registered,gst_registration_category:'COMPOSITION'},'GST_TAX_INVOICE'),/Composition/);
 assert.equal(documentWarning({...registered,gst_registration_category:'COMPOSITION'},'BILL_OF_SUPPLY'),null);
 assert.equal(documentWarning({gst_registration_status:'UNREGISTERED'},'NON_GST_COMMERCIAL'),null);
 assert.equal(documentWarning({gst_registration_status:'UNKNOWN'},'NON_GST_COMMERCIAL'),null);
});
test('browser and server use the same document policy',async()=>{
 const backend=await readFile(new URL('./invoicePolicy.js',import.meta.url),'utf8');
 const actual=await readFile(new URL('../../../tiles-wala-frontend/src/utils/invoicePolicy.js',import.meta.url),'utf8');
 assert.equal(actual.replace("'./gstValidator'","'../utils/gstValidator.js'"),backend);
});

test('Simple appearance never selects Bill of Supply or overrides an explicit document',()=>{
 const taxable={id:43,name:'Costa Blue',hsn_code:'6907',tax_rate:'18',gst_supply_classification:'TAXABLE'};
 for(const invoice_layout of ['STANDARD_GST_LAYOUT','SIMPLE_LAYOUT']){
  assert.equal(resolveSalesDocumentType({store:{...registered,invoice_layout,default_document_type:'GST_TAX_INVOICE'},products:[taxable]}).documentType,'GST_TAX_INVOICE');
  assert.equal(resolveSalesDocumentType({store:{...registered,invoice_layout,default_document_type:'BILL_OF_SUPPLY'},products:[taxable],requestedDocumentType:'GST_TAX_INVOICE'}).documentType,'GST_TAX_INVOICE');
 }
});
test('reported Bill of Supply default identifies the actual product without inferring exemption or tax rate',()=>{
 const unknown={id:43,name:'Costa Blue',hsn_code:'657854',tax_rate:null,gst_supply_classification:'UNKNOWN'};
 assert.throws(()=>resolveSalesDocumentType({store:{...registered,invoice_layout:'SIMPLE_LAYOUT',default_document_type:'BILL_OF_SUPPLY'},products:[unknown]}),e=>e.code==='PRODUCT_TAX_CLASSIFICATION_REQUIRED'&&e.productId===43&&e.field==='items[0].productId'&&/Costa Blue.*Bill of Supply/.test(e.message));
 assert.throws(()=>resolveSalesDocumentType({store:registered,requestedDocumentType:'GST_TAX_INVOICE',products:[unknown]}),e=>e.code==='PRODUCT_TAX_RATE_REQUIRED');
 assert.equal(unknown.gst_supply_classification,'UNKNOWN');assert.equal(unknown.tax_rate,null);
});
test('genuine Bill of Supply classification, references, and composition jurisdiction remain enforced',()=>{
 const exempt={id:1,name:'Reviewed exemption',hsn_code:'6907',gst_supply_classification:'EXEMPT',gst_classification_reference:'Reviewed reference'};
 assert.equal(resolveSalesDocumentType({store:registered,requestedDocumentType:'BILL_OF_SUPPLY',products:[exempt]}).documentType,'BILL_OF_SUPPLY');
 assert.throws(()=>resolveSalesDocumentType({store:registered,requestedDocumentType:'BILL_OF_SUPPLY',products:[{...exempt,gst_classification_reference:''}]}),e=>e.code==='PRODUCT_TAX_CLASSIFICATION_REQUIRED');
 assert.throws(()=>resolveSalesDocumentType({store:registered,requestedDocumentType:'GST_TAX_INVOICE',products:[exempt]}),e=>e.code==='DOCUMENT_NOT_ELIGIBLE');
 const composition={...registered,state:'Bihar',gst_registration_category:'COMPOSITION'};
 assert.throws(()=>resolveSalesDocumentType({store:composition,requestedDocumentType:'BILL_OF_SUPPLY',products:[exempt],supplyDetails:{placeOfSupply:'Maharashtra'}}),e=>e.field==='placeOfSupply');
 assert.equal(resolveSalesDocumentType({store:composition,requestedDocumentType:'BILL_OF_SUPPLY',products:[exempt],supplyDetails:{placeOfSupply:'Bihar'}}).invoiceType,null);
 assert.equal(resolveSalesDocumentType({store:{gst_registration_status:'UNREGISTERED'},requestedDocumentType:'NON_GST_COMMERCIAL',products:[{gst_supply_classification:'UNKNOWN'}]}).invoiceType,'NON_GST');
});
test('Non-GST ignores product GST setup and GST never falls back to another document',()=>{
 const product={id:43,name:'Costa Blue',tax_rate:null,gst_supply_classification:'UNKNOWN'};
 const store={...registered,default_document_type:'NON_GST_COMMERCIAL'};
 assert.equal(resolveSalesDocumentType({store,products:[product]}).invoiceType,'NON_GST');
 assert.equal(resolveSalesDocumentType({store,products:[{...product,tax_rate:18,gst_supply_classification:'EXEMPT'}]}).invoiceType,'NON_GST');
 assert.throws(()=>resolveSalesDocumentType({store:{...store,default_document_type:'GST_TAX_INVOICE'},products:[product]}),e=>e.code==='PRODUCT_TAX_RATE_REQUIRED');
 assert.throws(()=>resolveSalesDocumentType({store:{default_document_type:'GST_TAX_INVOICE'},products:[product]}),e=>e.field==='documentType');
 assert.throws(()=>resolveSalesDocumentType({store:{...store,default_document_type:'BILL_OF_SUPPLY'},products:[{...product,tax_rate:18}]}),e=>e.code==='PRODUCT_TAX_CLASSIFICATION_REQUIRED');
});

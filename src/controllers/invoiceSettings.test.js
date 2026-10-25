import assert from 'node:assert/strict';
import {test} from 'node:test';
import {taxTreatmentWarning} from './invoiceSettings.js';

test('Non-GST validation explains a saved registration identifier even when the declaration is unregistered',()=>{
 for(const field of ['gstin','tax_id']){
  assert.match(taxTreatmentWarning({invoice_type:'NON_GST',gst_registration_status:'UNREGISTERED',[field]:'10JNEPD0678B1ZL'}),/GSTIN or tax ID saved/);
 }
});
test('Non-GST validation identifies unknown and registered declarations separately',()=>{
 assert.match(taxTreatmentWarning({invoice_type:'NON_GST',gst_registration_status:'UNKNOWN'}),/Confirm the actual business/);
 assert.match(taxTreatmentWarning({invoice_type:'NON_GST',gst_registration_status:'REGISTERED'}),/declared as GST registered/);
});
test('blank identifiers follow the same treatment as database posting checks',()=>{
 assert.equal(taxTreatmentWarning({invoice_type:'NON_GST',gst_registration_status:'UNREGISTERED',gstin:'  ',tax_id:null}),null);
});
test('GST settings do not invoke Non-GST restrictions',()=>{
 assert.equal(taxTreatmentWarning({invoice_type:'GST',gst_registration_status:'UNKNOWN',gstin:'10JNEPD0678B1ZL'}),null);
});

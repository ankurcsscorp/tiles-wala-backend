import assert from 'node:assert/strict';
import {test} from 'node:test';
import {documentWarning} from '../services/invoicePolicy.js';
test('Non-GST requires no declaration or identifiers to be cleared',()=>{
 for(const status of ['UNKNOWN','REGISTERED','UNREGISTERED'])for(const gstin of [null,'10JNEPD0678B1ZL','invalid']){
  const store={invoice_type:'NON_GST',gst_registration_status:status,gstin};
  assert.equal(documentWarning(store,'NON_GST_COMMERCIAL'),null);
 }
});
test('GST still requires valid identifiers, actual registration and regular category',()=>{
 assert.match(documentWarning({},'GST_TAX_INVOICE'),/valid store GSTIN/);
 const store={gstin:'10JNEPD0678B1ZL'};
 assert.match(documentWarning(store,'GST_TAX_INVOICE'),/Registered declaration/);
 assert.match(documentWarning({...store,gst_registration_status:'REGISTERED'},'GST_TAX_INVOICE'),/Regular registration category/);
 assert.equal(documentWarning({...store,gst_registration_status:'REGISTERED',gst_registration_category:'REGULAR'},'GST_TAX_INVOICE'),null);
});

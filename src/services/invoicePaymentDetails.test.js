import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalizeInvoicePaymentDetails as normalize} from './invoicePaymentDetails.js';

const bank={accountName:'Demo Store',accountNumber:'001234567890',bankName:'Demo Bank',branch:'Main Branch',ifscCode:'ABCD0123456',upiId:'demo@bank'};
test('invoice payment details preserve leading zeros and allow bank-only, UPI-only or empty configurations',()=>{
  assert.deepEqual(normalize({...bank,accountName:' Demo Store ',ifscCode:'abcd0123456'}),bank);
  assert.deepEqual(normalize({upiId:'demo@bank'}),{upiId:'demo@bank'});
  const {upiId,...bankOnly}=bank;assert.deepEqual(normalize(bankOnly),bankOnly);
  assert.deepEqual(normalize({accountName:' ',upiId:''}),{});
});
test('invalid or incomplete payment instructions cannot be saved',()=>{
  for(const value of [null,[],true,{unknown:'field'},{accountNumber:12345},{accountName:'Only a name'},{...bank,accountNumber:'12-3456'},{...bank,ifscCode:'invalid'},{upiId:'invalid'},{upiId:'name @bank'},{...bank,branch:'a'.repeat(161)}])assert.throws(()=>normalize(value));
});

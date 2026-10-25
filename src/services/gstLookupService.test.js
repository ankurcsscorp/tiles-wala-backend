import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGSTLookupService } from './gstLookupService.js';
import { gstPartyFields } from '../utils/gstPartyFields.js';
process.env.JWT_SECRET = 'test-only-gst-secret-000000000000000000';
const gstin = '27AAPFU0939F1ZV';
test('lookup coalesces concurrent requests and issues a bound proof', async () => {
  let calls = 0;
  const service = createGSTLookupService(() => ({ lookup: async () => { calls++; return { gstin, source: 'finagg', fetchedAt: new Date().toISOString() }; } }));
  const [a,b] = await Promise.all([service(gstin),service(gstin)]);
  assert.equal(calls,1); assert.equal(a.lookupToken,b.lookupToken);
  const fields = gstPartyFields({gstLookupToken:a.lookupToken,gstDetails:{legalName:'Manual edit'}},gstin);
  assert.equal(fields.source,'finagg'); assert.equal(fields.details.legalName,'Manual edit');
  assert.match(gstPartyFields({gstLookupToken:a.lookupToken},'29ABCDE1234F1ZW').error,/does not match/);
  await service(gstin); assert.equal(calls,2); // No retained cache.
});
test('invalid GSTIN never invokes the provider', async () => {
  await assert.rejects(createGSTLookupService(() => assert.fail())('invalid'), {code:'GST_INVALID'});
});
test('manual entry cannot set verification time/source or retain raw provider data', () => {
  const result = gstPartyFields({gstDetails:{legalName:'Manual',rawResponse:'secret'},gstVerifiedAt:new Date().toISOString(),gstDataSource:'invented'},gstin);
  assert.equal(result.verifiedAt,null); assert.equal(result.source,null); assert.equal(result.details.rawResponse,undefined);
  assert.equal(gstPartyFields({},null).error,undefined);
  assert.ok(gstPartyFields({gstLookupToken:'forged'},gstin).error);
  assert.ok(gstPartyFields({gstDetails:{natureOfBusiness:'not an array'}},gstin).error);
});

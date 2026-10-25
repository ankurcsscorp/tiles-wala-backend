import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGSTProvider, normalizeTaxpayer } from './gstProvider.js';
const gstin = '27AAPFU0939F1ZV';
const env = { GST_PROVIDER: 'finagg', GST_API_KEY: 'test-secret', GST_FINAGG_VERSION: 'v1', GST_GSP_VERSION: 'v1', GST_ENVIRONMENT: 'sandbox', GST_TIMEOUT_MS: 1000 };
const payload = (status = 'Active') => ({ status_cd: '1', data: { gstin, lgnm: 'Test Legal Name', tradeNam: 'Test Tiles', sts: status, dty: 'Regular', ctb: 'Partnership', rgdt: '22/10/2020', pradr: { addr: { bno: '12', bnm: 'Test Building', st: 'Main Road', loc: 'Pune', dst: 'Pune', stcd: 'Maharashtra', pncd: '411001' } }, nba: ['Retail Business'], privateData: 'must not escape' } });
const reply = (body, status = 200, headers) => new Response(JSON.stringify(body), { status, headers });

test('GSTN response is normalized and raw or contact fields are not leaked', () => {
  const data = normalizeTaxpayer(payload(), gstin);
  assert.equal(data.legalName, 'Test Legal Name'); assert.equal(data.registrationDate, '2020-10-22');
  assert.equal(data.address.stateCode, '27'); assert.equal(data.address.pincode, '411001');
  assert.deepEqual(data.natureOfBusiness, ['Retail Business']); assert.ok(!JSON.stringify(data).includes('privateData'));
  assert.equal(data.mobile, undefined); assert.equal(data.email, undefined);
});
test('missing provider fields remain blank and invalid dates stay null', () => {
  const data = normalizeTaxpayer({ data: { gstin, rgdt: '31/02/2020' } }, gstin);
  assert.equal(data.tradeName, ''); assert.equal(data.address.city, ''); assert.equal(data.registrationDate, null); assert.deepEqual(data.natureOfBusiness, []);
});
test('different GSTIN responses are rejected', () => assert.throws(() => normalizeTaxpayer({ data: { gstin: '29ABCDE1234F1ZW' } }, gstin), { code: 'GST_INVALID_RESPONSE' }));
for (const status of ['Cancelled', 'Suspended', 'Unknown provider status']) test(`${status} registration is returned without blocking manual saving`, () => assert.equal(normalizeTaxpayer(payload(status), gstin).registrationStatus, status));
test('unconfigured provider does not make a request', () => assert.throws(() => createGSTProvider({}, () => assert.fail()), { code: 'GST_CONFIGURATION_REQUIRED' }));
test('adapter sends only backend credentials to the configured HTTPS provider', async () => {
  const provider = createGSTProvider(env, async (url, options) => {
    assert.equal(url.hostname, 'sandbox-gsp.finagg.in'); assert.equal(url.searchParams.get('action'), 'SEARCHGSTIN');
    assert.equal(url.searchParams.get('gstin'), gstin); assert.equal(options.headers['x-api-key'], 'test-secret');
    assert.equal(options.redirect, 'error'); return reply(payload());
  });
  assert.equal((await provider.lookup(gstin)).source, 'finagg-sandbox');
});
for (const [status, code] of [[404,'GST_NOT_FOUND'],[401,'GST_PROVIDER_CREDENTIALS'],[403,'GST_PROVIDER_CREDENTIALS'],[429,'GST_RATE_LIMITED'],[500,'GST_UNAVAILABLE']]) {
  test(`provider HTTP ${status} maps to ${code} without leaking diagnostics`, async () => {
    const provider = createGSTProvider(env, async () => reply({ secret: 'must not escape' }, status, { 'Retry-After': '120' }));
    await assert.rejects(provider.lookup(gstin), (error) => error.code === code && !error.message.includes('must not escape') && (status !== 429 || error.retryAfter === 120));
  });
}
test('transient unavailable response retries once', async () => {
  let calls = 0; const provider = createGSTProvider(env, async () => ++calls === 1 ? reply({},503) : reply(payload()));
  await provider.lookup(gstin); assert.equal(calls, 2);
});
test('timeout cancels the provider request and does not retry', async () => {
  let calls = 0;
  const provider = createGSTProvider(env, (_, options) => { calls++; return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))); });
  await assert.rejects(provider.lookup(gstin), { code: 'GST_TIMEOUT' }); assert.equal(calls, 1);
});
test('invalid JSON and failed GSTN envelopes are treated as service errors', async () => {
  await assert.rejects(createGSTProvider(env, async () => new Response('broken JSON')).lookup(gstin), { code: 'GST_INVALID_RESPONSE' });
  await assert.rejects(createGSTProvider(env, async () => reply({status_cd:'0',error:{message:'Internal diagnostic'}})).lookup(gstin), {code:'GST_UNAVAILABLE'});
});

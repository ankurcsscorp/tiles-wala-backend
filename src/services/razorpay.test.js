import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createHmac } from 'node:crypto';
import { amountToPaise, verifyRazorpayCheckoutSignature, verifyRazorpayWebhook } from './razorpay.js';

const saved = { key: process.env.RAZORPAY_KEY_SECRET, webhook: process.env.RAZORPAY_WEBHOOK_SECRET };
afterEach(() => { if (saved.key === undefined) delete process.env.RAZORPAY_KEY_SECRET; else process.env.RAZORPAY_KEY_SECRET = saved.key; if (saved.webhook === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET; else process.env.RAZORPAY_WEBHOOK_SECRET = saved.webhook; });

test('Razorpay INR amount conversion requires positive two-decimal money', () => {
  assert.equal(amountToPaise('850.25'), 85025);
  assert.throws(() => amountToPaise('-1'));
  assert.throws(() => amountToPaise('1.999'));
  assert.throws(() => amountToPaise('0'));
});

test('Razorpay webhook signatures validate raw bytes with constant-time comparison', () => {
  process.env.RAZORPAY_WEBHOOK_SECRET = 'webhook-test-secret';
  const body = Buffer.from('{"event":"payment.captured"}');
  const signature = createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
  assert.equal(verifyRazorpayWebhook(body, signature), true);
  assert.equal(verifyRazorpayWebhook(body, 'bad-signature'), false);
  assert.equal(verifyRazorpayWebhook(Buffer.from('changed'), signature), false);
});

test('Razorpay checkout signature validates order and payment pair', () => {
  process.env.RAZORPAY_KEY_SECRET = 'api-secret';
  const signature = createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update('order_1|pay_1').digest('hex');
  assert.equal(verifyRazorpayCheckoutSignature('order_1', 'pay_1', signature), true);
  assert.equal(verifyRazorpayCheckoutSignature('order_2', 'pay_1', signature), false);
});

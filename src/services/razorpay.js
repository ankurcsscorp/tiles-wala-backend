import { createHmac, timingSafeEqual } from 'node:crypto';

const apiBase = () => process.env.RAZORPAY_API_BASE_URL || 'https://api.razorpay.com/v1';
export const razorpayConfigured = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_WEBHOOK_SECRET);

export function amountToPaise(amount) {
  const value = String(amount ?? '');
  if (!/^\d{1,14}(\.\d{1,2})?$/.test(value) || Number(value) <= 0) throw new Error('Payment amount must be a positive INR amount with up to two decimals');
  const [rupees, paise = ''] = value.split('.');
  const totalPaise = Number(rupees) * 100 + Number(paise.padEnd(2, '0'));
  if (!Number.isSafeInteger(totalPaise)) throw new Error('Payment amount exceeds the supported INR range');
  return totalPaise;
}

export async function createRazorpayOrder({ amount, receipt, notes }) {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) throw new Error('Razorpay is not configured');
  const response = await fetch(`${apiBase()}/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ amount: amountToPaise(amount), currency: 'INR', receipt: String(receipt).slice(0, 40), notes }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.id) throw new Error('Razorpay could not create a payment order');
  return { id: result.id, amount: result.amount, currency: result.currency, keyId: process.env.RAZORPAY_KEY_ID };
}

async function razorpayRequest(path, method, body) {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) throw new Error('Razorpay is not configured');
  const response = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('Razorpay payment operation failed');
  return result;
}

export async function createRazorpayRefund(paymentId, amount) {
  if (!paymentId) throw new Error('Razorpay payment ID is required');
  return razorpayRequest(`/payments/${encodeURIComponent(paymentId)}/refund`, 'POST', { amount: amountToPaise(amount) });
}

export async function getRazorpayRefund(refundId) {
  if (!refundId) throw new Error('Razorpay refund ID is required');
  return razorpayRequest(`/refunds/${encodeURIComponent(refundId)}`, 'GET');
}

function safeHexEqual(actual, expected) {
  if (!/^[a-f\d]+$/i.test(String(actual)) || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

export function verifyRazorpayWebhook(rawBody, signature) {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET || !Buffer.isBuffer(rawBody)) return false;
  const expected = createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  return safeHexEqual(signature, expected);
}

export function verifyRazorpayCheckoutSignature(orderId, paymentId, signature) {
  if (!process.env.RAZORPAY_KEY_SECRET || !orderId || !paymentId) return false;
  const expected = createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  return safeHexEqual(signature, expected);
}

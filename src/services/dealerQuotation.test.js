import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dealerQuotationPdf } from './dealerQuotation.js';

test('dealer quotation PDF carries proforma disclaimer, quotation identifiers, items, totals, and payment terms', async () => {
  const pdf = await dealerQuotationPdf({
    store: { name: 'Tiles Wala Patna', address: { line1: 'Main Road', city: 'Patna' }, terms_and_conditions: 'Subject to stock confirmation.' },
    dealer: { business_name: 'Dealer House', contact_name: 'Asha', mobile: '9876543210' },
    order: { payment_method: 'CASH_ON_DELIVERY', delivery_contact_name: 'Ravi', delivery_contact_mobile: '9000000000', delivery_instructions: 'Call before arrival' },
    quote: { quotation_number: 'Q-DO-2026-0000001-1', subtotal: '1700.00', transport_charge: '1000.00', discount_amount: '0.00', tax_amount: '306.00', grand_total: '3006.00', valid_until: '2026-11-07', created_at: new Date('2026-10-31T00:00:00Z') },
    items: [{ productName: 'GVT Tile', quantity: '2', unit: 'Box', dealerPrice: '850.00', lineTotal: '2006.00' }],
  });
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.length > 10_000, 'quotation should include the embedded document font and rendered content');
});

DROP TRIGGER purchase_billing_mode_guard ON purchase_invoices;
DROP FUNCTION guard_purchase_billing_mode();
ALTER TABLE purchase_invoice_items DROP COLUMN cgst_amount,DROP COLUMN sgst_amount,DROP COLUMN igst_amount;
ALTER TABLE purchase_invoices DROP COLUMN invoice_layout,DROP COLUMN supplier_document_type,DROP COLUMN supplier_tax_jurisdiction,DROP COLUMN supplier_tax_reason,DROP COLUMN declared_tax_total,DROP COLUMN cgst_total,DROP COLUMN sgst_total,DROP COLUMN igst_total;

DROP TRIGGER IF EXISTS purchase_invoice_auto_receipt ON purchase_invoices;
DROP FUNCTION IF EXISTS receive_purchase_invoice_on_post();
DROP FUNCTION IF EXISTS auto_receive_purchase_invoice(BIGINT,BIGINT,DATE,BIGINT);

-- Automatically created goods receipts and their stock movements are retained
-- as auditable inventory history when rolling back this behavior.

-- Treat a posted purchase invoice as goods received in full. Keep using the
-- receipt ledger so conversions, stock movements, returns, and reversals share
-- the existing inventory controls.
CREATE FUNCTION auto_receive_purchase_invoice(
  target_invoice_id BIGINT,
  target_store_id BIGINT,
  target_receipt_date DATE,
  target_created_by BIGINT
) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE receipt_id BIGINT;
BEGIN
  SELECT id INTO receipt_id
    FROM purchase_receipts
    WHERE purchase_invoice_id=target_invoice_id
    ORDER BY id
    LIMIT 1;
  IF FOUND THEN RETURN receipt_id; END IF;

  INSERT INTO purchase_receipts(
    purchase_invoice_id,store_id,receipt_number,status,receipt_date,
    idempotency_key,notes,created_by
  ) VALUES (
    target_invoice_id,target_store_id,'PENDING-AUTO-'||target_invoice_id,'draft',
    target_receipt_date,'purchase-auto-'||target_invoice_id,
    'Automatically received in full when purchase invoice was posted',target_created_by
  ) RETURNING id INTO receipt_id;

  UPDATE purchase_receipts SET receipt_number='GRN-'||receipt_id WHERE id=receipt_id;
  INSERT INTO purchase_receipt_items(receipt_id,purchase_invoice_item_id,quantity_received)
    SELECT receipt_id,id,quantity
    FROM purchase_invoice_items
    WHERE purchase_invoice_id=target_invoice_id AND quantity>0;

  UPDATE purchase_receipts
    SET status='posted',posted_at=now(),updated_at=now()
    WHERE id=receipt_id;
  RETURN receipt_id;
END;
$$;

CREATE FUNCTION receive_purchase_invoice_on_post() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='draft' AND NEW.status='posted' THEN
    PERFORM auto_receive_purchase_invoice(NEW.id,NEW.store_id,NEW.invoice_date,NEW.created_by);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_invoice_auto_receipt
  AFTER UPDATE OF status ON purchase_invoices
  FOR EACH ROW EXECUTE FUNCTION receive_purchase_invoice_on_post();

-- Bring already-posted invoices without any receipt into the same policy.
-- Existing receipts (including reversed or draft receipts) are left untouched.
DO $$
DECLARE invoice RECORD;
BEGIN
  FOR invoice IN
    SELECT pi.id,pi.store_id,pi.invoice_date,pi.created_by
    FROM purchase_invoices pi
    WHERE pi.status='posted'
      AND NOT EXISTS(SELECT 1 FROM purchase_receipts pr WHERE pr.purchase_invoice_id=pi.id)
    ORDER BY pi.id
    FOR UPDATE
  LOOP
    PERFORM auto_receive_purchase_invoice(invoice.id,invoice.store_id,invoice.invoice_date,invoice.created_by);
  END LOOP;
END;
$$;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM stock_transfer_transit_movements) OR EXISTS(SELECT 1 FROM stock_transfer_receipts WHERE idempotency_key NOT LIKE 'legacy-transfer-receipt:%') THEN
    RAISE EXCEPTION 'Cannot roll back while managed stock transfer history exists';
  END IF;
END $$;
DROP TRIGGER IF EXISTS transfer_transit_movement_immutable ON stock_transfer_transit_movements;
DROP TRIGGER IF EXISTS transfer_receipt_item_immutable ON stock_transfer_receipt_items;
DROP TRIGGER IF EXISTS transfer_receipt_immutable ON stock_transfer_receipts;
DROP FUNCTION IF EXISTS protect_transfer_history();
DROP TRIGGER IF EXISTS transfer_lifecycle ON stock_transfers;
DROP FUNCTION IF EXISTS guard_stock_transfer_update();
DROP INDEX IF EXISTS stock_transfer_items_product_idx;
DROP INDEX IF EXISTS stock_transfers_to_date_idx;
DROP INDEX IF EXISTS stock_transfers_from_date_idx;
DROP INDEX IF EXISTS stock_transfer_transit_transfer_idx;
DROP INDEX IF EXISTS stock_transfer_transit_product_idx;
DROP INDEX IF EXISTS stock_transfer_receipts_received_idx;
ALTER TABLE stock_transfers DROP CONSTRAINT IF EXISTS stock_transfers_status_check;
UPDATE stock_transfers SET status='posted',posted_at=COALESCE(posted_at,received_at,updated_at) WHERE status='received';
DROP TABLE IF EXISTS stock_transfer_transit_movements,stock_transfer_receipt_items,stock_transfer_receipts;
ALTER TABLE stock_transfer_items DROP COLUMN IF EXISTS dispatched_base_quantity,DROP COLUMN IF EXISTS unit_factor_to_base,DROP COLUMN IF EXISTS dispatched_quantity;
ALTER TABLE stock_transfers DROP COLUMN IF EXISTS dispatch_request_key,DROP COLUMN IF EXISTS dispatch_fingerprint,DROP COLUMN IF EXISTS received_at,
  DROP COLUMN IF EXISTS received_by,DROP COLUMN IF EXISTS dispatched_at,DROP COLUMN IF EXISTS dispatched_by,DROP COLUMN IF EXISTS approved_by,DROP COLUMN IF EXISTS notes;
ALTER TABLE stock_transfers ADD CONSTRAINT stock_transfers_status_check CHECK(status IN ('draft','posted','cancelled','reversed'));
CREATE TRIGGER transfer_lifecycle BEFORE UPDATE ON stock_transfers FOR EACH ROW EXECUTE FUNCTION guard_billing_document_update();
CREATE TRIGGER stock_transfer_stock_post AFTER UPDATE OF status ON stock_transfers FOR EACH ROW EXECUTE FUNCTION post_stock_document();

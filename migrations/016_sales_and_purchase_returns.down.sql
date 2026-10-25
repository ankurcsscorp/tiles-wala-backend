DROP TRIGGER IF EXISTS sales_return_stock_post ON sales_returns;
DROP FUNCTION IF EXISTS post_sales_return_stock();
DROP TRIGGER IF EXISTS purchase_return_received_quantity_guard ON purchase_returns;
DROP FUNCTION IF EXISTS validate_purchase_return_received_quantity();
DROP TRIGGER IF EXISTS sales_return_item_draft_only ON sales_return_items;
DROP FUNCTION IF EXISTS guard_return_item_write();
DROP TRIGGER IF EXISTS sales_return_approval_guard ON sales_returns;
DROP FUNCTION IF EXISTS guard_return_approval();
CREATE TRIGGER sales_return_item_draft_only BEFORE INSERT OR UPDATE OR DELETE ON sales_return_items FOR EACH ROW EXECUTE FUNCTION guard_billing_document_item_write();
CREATE TRIGGER sales_return_stock_post AFTER UPDATE OF status ON sales_returns FOR EACH ROW EXECUTE FUNCTION post_stock_document();
DROP INDEX IF EXISTS sales_return_invoice_status_idx;
DROP INDEX IF EXISTS purchase_return_invoice_status_idx;
DROP INDEX IF EXISTS sales_return_item_line_idx;
DROP INDEX IF EXISTS purchase_return_item_line_idx;
DROP INDEX IF EXISTS sales_returns_request_key_idx;
DROP INDEX IF EXISTS purchase_returns_request_key_idx;
ALTER TABLE sales_return_items DROP CONSTRAINT IF EXISTS sales_return_item_disposition_total,
  DROP COLUMN IF EXISTS reason,DROP COLUMN IF EXISTS product_condition,DROP COLUMN IF EXISTS restock_quantity,
  DROP COLUMN IF EXISTS quarantined_quantity,DROP COLUMN IF EXISTS supplier_return_pending_quantity,
  DROP COLUMN IF EXISTS tax_rate,DROP COLUMN IF EXISTS tax_adjustment;
ALTER TABLE purchase_return_items DROP COLUMN IF EXISTS reason,DROP COLUMN IF EXISTS tax_rate,DROP COLUMN IF EXISTS tax_adjustment;
ALTER TABLE sales_returns DROP COLUMN IF EXISTS reason,DROP COLUMN IF EXISTS notes,DROP COLUMN IF EXISTS approved_by,DROP COLUMN IF EXISTS approved_at,
  DROP COLUMN IF EXISTS refund_amount,DROP COLUMN IF EXISTS customer_credit,DROP COLUMN IF EXISTS tax_adjustment,DROP COLUMN IF EXISTS refund_method,
  DROP COLUMN IF EXISTS refund_reference,DROP COLUMN IF EXISTS idempotency_key;
ALTER TABLE purchase_returns DROP COLUMN IF EXISTS reason,DROP COLUMN IF EXISTS notes,DROP COLUMN IF EXISTS supplier_credit,
  DROP COLUMN IF EXISTS tax_adjustment,DROP COLUMN IF EXISTS idempotency_key;

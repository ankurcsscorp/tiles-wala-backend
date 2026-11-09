DROP TABLE IF EXISTS dealer_payment_webhook_events;
DROP TABLE IF EXISTS dealer_order_payment_attempts;
DROP INDEX IF EXISTS payments_dealer_order_idx;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_dealer_order_customer_check;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_dealer_order_link_fk;
ALTER TABLE payments DROP COLUMN IF EXISTS dealer_order_id;

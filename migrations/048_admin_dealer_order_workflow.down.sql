DROP TABLE IF EXISTS dealer_order_messages;
ALTER TABLE dealer_order_notifications DROP CONSTRAINT IF EXISTS dealer_order_notifications_event_type_check;
ALTER TABLE dealer_order_notifications ADD CONSTRAINT dealer_order_notifications_event_type_check
  CHECK(event_type IN ('QUOTATION_REVISED','ORDER_CANCELLED'));
ALTER TABLE dealer_order_quotations DROP COLUMN IF EXISTS expected_delivery_date;
ALTER TABLE dealer_orders DROP CONSTRAINT IF EXISTS dealer_orders_terms_confirmation_pair;
ALTER TABLE dealer_orders DROP CONSTRAINT IF EXISTS dealer_orders_stock_confirmation_pair;
ALTER TABLE dealer_orders DROP COLUMN IF EXISTS payment_terms_confirmed_by;
ALTER TABLE dealer_orders DROP COLUMN IF EXISTS payment_terms_confirmed_at;
ALTER TABLE dealer_orders DROP COLUMN IF EXISTS stock_confirmed_by;
ALTER TABLE dealer_orders DROP COLUMN IF EXISTS stock_confirmed_at;
ALTER TABLE dealer_orders DROP COLUMN IF EXISTS expected_delivery_date;

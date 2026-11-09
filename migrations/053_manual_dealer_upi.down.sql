DROP TABLE IF EXISTS dealer_manual_payment_claims;
DROP INDEX IF EXISTS payments_manual_dealer_utr_idx;
ALTER TABLE dealer_order_notifications DROP CONSTRAINT IF EXISTS dealer_order_notifications_event_type_check;
ALTER TABLE dealer_order_notifications ADD CONSTRAINT dealer_order_notifications_event_type_check CHECK(event_type IN ('QUOTATION_REVISED','ORDER_CANCELLED','ORDER_STATUS_UPDATED','ADMIN_MESSAGE','CLARIFICATION_REQUEST','STOCK_CONFIRMED','PAYMENT_TERMS_CONFIRMED','INVOICE_FINALIZED','SHIPMENT_UPDATED','DELIVERED'));
ALTER TABLE dealer_order_admin_notifications DROP CONSTRAINT IF EXISTS dealer_order_admin_notifications_event_type_check;
ALTER TABLE dealer_order_admin_notifications ADD CONSTRAINT dealer_order_admin_notifications_event_type_check CHECK(event_type IN ('ORDER_PLACED','QUOTATION_REVISED','ORDER_CANCELLED'));
ALTER TABLE stores DROP COLUMN IF EXISTS dealer_partial_payments_enabled;

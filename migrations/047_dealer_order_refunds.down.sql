ALTER TABLE dealer_order_payment_attempts DROP CONSTRAINT IF EXISTS dealer_payment_refund_fields_check;
ALTER TABLE dealer_order_payment_attempts DROP COLUMN IF EXISTS refund_reconciled_at;
ALTER TABLE dealer_order_payment_attempts DROP COLUMN IF EXISTS refund_requested_at;
ALTER TABLE dealer_order_payment_attempts DROP COLUMN IF EXISTS refund_requested_by;
ALTER TABLE dealer_order_payment_attempts DROP COLUMN IF EXISTS refund_status;
ALTER TABLE dealer_order_payment_attempts DROP COLUMN IF EXISTS provider_refund_id;

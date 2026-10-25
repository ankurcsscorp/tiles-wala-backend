DROP TRIGGER IF EXISTS allocation_customer_link_check ON payment_allocations;
DROP TRIGGER IF EXISTS payment_customer_link_check ON payments;
DROP FUNCTION IF EXISTS validate_customer_payment_link();
DROP INDEX IF EXISTS payments_customer_date_idx;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_customer_direction_check;
ALTER TABLE payments DROP COLUMN IF EXISTS customer_id;

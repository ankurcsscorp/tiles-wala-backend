-- This migration adds immutable controls and custom payment methods. Rollback
-- is refused after recorded reversal details or custom methods have been used.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM payments WHERE reversal_reason IS NOT NULL OR reversed_by IS NOT NULL OR reversed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot roll back payment management while payment reversal details exist';
  END IF;
  IF EXISTS(SELECT 1 FROM payments WHERE payment_method NOT IN ('cash','upi','card','bank_transfer','cheque','other')) THEN
    RAISE EXCEPTION 'Cannot roll back while payments use custom methods';
  END IF;
END $$;
DROP INDEX IF EXISTS payments_store_date_idx;
DROP INDEX IF EXISTS payments_status_direction_date_idx;
DROP INDEX IF EXISTS payment_method_active_idx;
DROP TRIGGER IF EXISTS payment_allocations_immutable ON payment_allocations;
DROP FUNCTION IF EXISTS protect_payment_allocations();
DROP TRIGGER IF EXISTS payments_immutable ON payments;
DROP FUNCTION IF EXISTS protect_payment_history();
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payment_method_fk;
ALTER TABLE payments ADD CONSTRAINT payments_payment_method_check CHECK(payment_method IN ('cash','upi','card','bank_transfer','cheque','other'));
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payment_reversal_fields_check;
ALTER TABLE payments DROP COLUMN IF EXISTS customer_request_key,DROP COLUMN IF EXISTS request_fingerprint,DROP COLUMN IF EXISTS reversal_reason,
  DROP COLUMN IF EXISTS reversed_by,DROP COLUMN IF EXISTS reversed_at;
DROP SEQUENCE IF EXISTS customer_receipt_number_seq;
DROP TABLE IF EXISTS payment_method_options;

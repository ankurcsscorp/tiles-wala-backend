ALTER TABLE dealer_order_payment_attempts
  ADD COLUMN provider_refund_id VARCHAR(80) UNIQUE,
  ADD COLUMN refund_status VARCHAR(24) CHECK(refund_status IS NULL OR refund_status IN ('created','pending','processed','failed')),
  ADD COLUMN refund_requested_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN refund_requested_at TIMESTAMPTZ,
  ADD COLUMN refund_reconciled_at TIMESTAMPTZ,
  ADD CONSTRAINT dealer_payment_refund_fields_check CHECK (
    (provider_refund_id IS NULL AND refund_status IS NULL AND refund_requested_at IS NULL AND refund_reconciled_at IS NULL)
    OR (provider_refund_id IS NOT NULL AND refund_status IS NOT NULL AND refund_requested_at IS NOT NULL)
  );

-- Dealer payments reuse the existing posted customer receipt ledger. Provider
-- attempts are only gateway state; they are not accounting entries.
ALTER TABLE payments
  ADD COLUMN dealer_order_id BIGINT,
  ADD CONSTRAINT payments_dealer_order_link_fk
    FOREIGN KEY (dealer_order_id, store_id) REFERENCES dealer_orders(id, store_id) ON DELETE RESTRICT,
  ADD CONSTRAINT payments_dealer_order_customer_check CHECK (
    dealer_order_id IS NULL OR (direction='in' AND customer_id IS NOT NULL AND sales_return_id IS NULL)
  );
CREATE INDEX payments_dealer_order_idx ON payments(dealer_order_id, payment_date, id) WHERE dealer_order_id IS NOT NULL;

CREATE TABLE dealer_order_payment_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES dealer_orders(id) ON DELETE RESTRICT,
  quotation_version INTEGER NOT NULL CHECK(quotation_version>0),
  provider VARCHAR(24) NOT NULL CHECK(provider='razorpay'),
  provider_order_id VARCHAR(80) NOT NULL UNIQUE,
  provider_payment_id VARCHAR(80) UNIQUE,
  provider_event_id VARCHAR(120),
  amount NUMERIC(18,2) NOT NULL CHECK(amount>0),
  status VARCHAR(24) NOT NULL DEFAULT 'created' CHECK(status IN ('created','pending_verification','paid','failed','expired','refund_pending','refunded','reconciliation_required')),
  idempotency_key VARCHAR(120) NOT NULL,
  callback_verified_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  payment_id BIGINT UNIQUE REFERENCES payments(id) ON DELETE RESTRICT,
  failure_reason VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(order_id,idempotency_key),
  CHECK ((status IN ('paid','refund_pending','refunded','reconciliation_required')) = (payment_id IS NOT NULL))
);
CREATE UNIQUE INDEX dealer_payment_event_idx ON dealer_order_payment_attempts(provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX dealer_payment_order_idx ON dealer_order_payment_attempts(order_id,created_at DESC);

CREATE TABLE dealer_payment_webhook_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider VARCHAR(24) NOT NULL CHECK(provider='razorpay'),
  provider_event_id VARCHAR(120) NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  processing_error VARCHAR(500),
  UNIQUE(provider,provider_event_id)
);

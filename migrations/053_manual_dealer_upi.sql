-- Direct UPI is a payment claim, not proof of receipt. Only an Admin review
-- creates a posted customer receipt in the shared payments ledger.
ALTER TABLE stores ADD COLUMN dealer_partial_payments_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Seed the provided receiving UPI ID only where a store has no existing UPI ID.
UPDATE stores
SET invoice_payment_details=jsonb_set(COALESCE(invoice_payment_details,'{}'::jsonb),'{upiId}','"8109961022@indianbk"'::jsonb,TRUE),updated_at=now()
WHERE NULLIF(btrim(invoice_payment_details->>'upiId'),'') IS NULL;

CREATE TABLE dealer_manual_payment_claims (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 order_id BIGINT NOT NULL REFERENCES dealer_orders(id) ON DELETE RESTRICT,
 dealer_id BIGINT NOT NULL REFERENCES dealer_profiles(id) ON DELETE RESTRICT,
 store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
 payment_id BIGINT UNIQUE REFERENCES payments(id) ON DELETE RESTRICT,
 attempt_reference VARCHAR(48) NOT NULL UNIQUE,
 requested_amount NUMERIC(18,2) NOT NULL CHECK(requested_amount>0),
 claimed_amount NUMERIC(18,2) CHECK(claimed_amount IS NULL OR claimed_amount>0),
 utr_number VARCHAR(80),
 paid_at TIMESTAMPTZ,
 status VARCHAR(24) NOT NULL DEFAULT 'initiated' CHECK(status IN ('initiated','pending_verification','verified','rejected')),
 verified_amount NUMERIC(18,2) CHECK(verified_amount IS NULL OR verified_amount>0),
 verified_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
 verified_at TIMESTAMPTZ,
 rejection_reason VARCHAR(1000),
 screenshot_data BYTEA,
 screenshot_mime VARCHAR(32) CHECK(screenshot_mime IS NULL OR screenshot_mime IN ('image/png','image/jpeg','image/webp')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(dealer_id,store_id) REFERENCES dealer_profiles(id,store_id) ON DELETE RESTRICT,
 CHECK ((status='verified')=(payment_id IS NOT NULL)),
 CHECK ((status='verified')=(verified_by IS NOT NULL AND verified_at IS NOT NULL AND verified_amount IS NOT NULL)),
 CHECK (status<>'rejected' OR rejection_reason IS NOT NULL),
 CHECK ((screenshot_data IS NULL)=(screenshot_mime IS NULL))
);
CREATE INDEX dealer_manual_claim_order_idx ON dealer_manual_payment_claims(order_id,created_at DESC);
CREATE INDEX dealer_manual_claim_review_idx ON dealer_manual_payment_claims(store_id,status,created_at) WHERE status='pending_verification';
CREATE UNIQUE INDEX dealer_manual_claim_utr_idx ON dealer_manual_payment_claims(store_id,upper(utr_number)) WHERE utr_number IS NOT NULL AND status<>'rejected';
CREATE UNIQUE INDEX payments_manual_dealer_utr_idx ON payments(store_id,upper(reference)) WHERE dealer_order_id IS NOT NULL AND payment_method='upi' AND status='posted' AND reference IS NOT NULL;

ALTER TABLE dealer_order_notifications DROP CONSTRAINT dealer_order_notifications_event_type_check;
ALTER TABLE dealer_order_notifications ADD CONSTRAINT dealer_order_notifications_event_type_check
 CHECK(event_type IN ('QUOTATION_REVISED','ORDER_CANCELLED','ORDER_STATUS_UPDATED','ADMIN_MESSAGE','CLARIFICATION_REQUEST','STOCK_CONFIRMED','PAYMENT_TERMS_CONFIRMED','INVOICE_FINALIZED','SHIPMENT_UPDATED','DELIVERED','DEALER_PAYMENT_SUBMITTED','DEALER_PAYMENT_VERIFIED','DEALER_PAYMENT_REJECTED'));
ALTER TABLE dealer_order_admin_notifications DROP CONSTRAINT dealer_order_admin_notifications_event_type_check;
ALTER TABLE dealer_order_admin_notifications ADD CONSTRAINT dealer_order_admin_notifications_event_type_check
 CHECK(event_type IN ('ORDER_PLACED','QUOTATION_REVISED','ORDER_CANCELLED','PAYMENT_REVIEW'));

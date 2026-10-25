-- Shared payment lifecycle and retry-safe customer receipts.
ALTER TABLE payments
  ADD COLUMN customer_request_key VARCHAR(120) UNIQUE,
  ADD COLUMN request_fingerprint CHAR(64),
  ADD COLUMN reversal_reason TEXT,
  ADD COLUMN reversed_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN reversed_at TIMESTAMPTZ,
  ADD CONSTRAINT payment_reversal_fields_check CHECK(
    (status='reversed' AND ((reversal_reason IS NULL AND reversed_by IS NULL AND reversed_at IS NULL) OR
      (length(btrim(COALESCE(reversal_reason,''))) BETWEEN 3 AND 1000 AND reversed_by IS NOT NULL AND reversed_at IS NOT NULL)))
    OR (status<>'reversed' AND reversal_reason IS NULL AND reversed_by IS NULL AND reversed_at IS NULL)
  );

CREATE SEQUENCE customer_receipt_number_seq;

CREATE TABLE payment_method_options (
  code VARCHAR(24) PRIMARY KEY,
  label VARCHAR(80) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(code ~ '^[a-z][a-z0-9_]{1,23}$')
);
INSERT INTO payment_method_options(code,label,is_system) VALUES
 ('cash','Cash',TRUE),('upi','UPI',TRUE),('bank_transfer','Bank transfer',TRUE),
 ('cheque','Cheque',TRUE),('card','Card',TRUE),('other','Other',TRUE);

-- Custom methods can be configured without a schema change. Existing payment
-- rows remain valid, while new rows must use an active configured code.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payment_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_payment_method_fk FOREIGN KEY(payment_method) REFERENCES payment_method_options(code) ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE FUNCTION protect_payment_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_data JSONB; after_data JSONB;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'payments are retained; reverse eligible payments instead' USING ERRCODE='23514'; END IF;
  IF OLD.status='posted' AND NEW.status='reversed' THEN
    IF NEW.reversed_at IS NULL OR NEW.reversed_by IS NULL OR length(btrim(COALESCE(NEW.reversal_reason,'')))<3 THEN
      RAISE EXCEPTION 'payment reversal requires actor, timestamp, and reason' USING ERRCODE='23514';
    END IF;
    before_data:=to_jsonb(OLD)-'status'-'reversal_reason'-'reversed_by'-'reversed_at';
    after_data:=to_jsonb(NEW)-'status'-'reversal_reason'-'reversed_by'-'reversed_at';
    IF before_data<>after_data THEN RAISE EXCEPTION 'payment amount and details are immutable; reverse and correct instead' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF to_jsonb(OLD)<>to_jsonb(NEW) THEN RAISE EXCEPTION 'payment records are immutable; reverse and correct instead' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_immutable BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION protect_payment_history();

CREATE FUNCTION protect_payment_allocations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment allocations are immutable; reverse the payment to release its allocation' USING ERRCODE='23514';
END $$;
CREATE TRIGGER payment_allocations_immutable BEFORE UPDATE OR DELETE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION protect_payment_allocations();

CREATE INDEX payments_store_date_idx ON payments(store_id,payment_date DESC,id DESC);
CREATE INDEX payments_status_direction_date_idx ON payments(status,direction,payment_date DESC);
CREATE INDEX payment_method_active_idx ON payment_method_options(is_active,label);

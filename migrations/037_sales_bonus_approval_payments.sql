ALTER TABLE sales_bonus_records
  ADD COLUMN IF NOT EXISTS approved_bonus NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payable_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS approved_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approval_note TEXT,
  ADD COLUMN IF NOT EXISTS recipient_name_snapshot VARCHAR(150);

CREATE TABLE IF NOT EXISTS sales_bonus_payments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sales_bonus_record_id BIGINT NOT NULL REFERENCES sales_bonus_records(id) ON DELETE RESTRICT,
  store_id BIGINT REFERENCES stores(id) ON DELETE RESTRICT,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('CASH','UPI','BANK_TRANSFER','OTHER')),
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  reference VARCHAR(120),
  notes TEXT,
  request_key VARCHAR(120) NOT NULL UNIQUE,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_bonus_payments_record_idx
  ON sales_bonus_payments(sales_bonus_record_id,payment_date,id);

ALTER TABLE sales_bonus_adjustments
  DROP CONSTRAINT IF EXISTS sales_bonus_adjustments_source_type_check;
ALTER TABLE sales_bonus_adjustments
  ADD CONSTRAINT sales_bonus_adjustments_source_type_check
  CHECK(source_type IN ('sales_return_item','invoice_reversal','sales_return_reversal','bonus_adjustment'));

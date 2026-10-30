ALTER TABLE sales_bonus_records
  ADD COLUMN IF NOT EXISTS admin_payment_override BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE sales_invoices
  ADD COLUMN referred_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN referred_by_name_snapshot VARCHAR(150);

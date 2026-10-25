ALTER TABLE stores
  ADD COLUMN city VARCHAR(100),
  ADD COLUMN state VARCHAR(100),
  ADD COLUMN pin_code VARCHAR(12),
  ADD COLUMN logo_url TEXT,
  ADD COLUMN gstin VARCHAR(15),
  ADD COLUMN invoice_footer TEXT,
  ADD COLUMN terms_and_conditions TEXT,
  ADD COLUMN invoice_numbering_period VARCHAR(16) NOT NULL DEFAULT 'yearly',
  ADD COLUMN invoice_number_padding SMALLINT NOT NULL DEFAULT 5 CHECK (invoice_number_padding BETWEEN 1 AND 12);

ALTER TABLE store_billing_config
  ADD COLUMN IF NOT EXISTS terms_and_conditions TEXT;

ALTER TABLE sales_invoices
  ADD COLUMN store_name_snapshot VARCHAR(160),
  ADD COLUMN store_address_snapshot JSONB,
  ADD COLUMN store_tax_id_snapshot VARCHAR(40),
  ADD COLUMN store_phone_snapshot VARCHAR(30),
  ADD COLUMN store_email_snapshot VARCHAR(254);
ALTER TABLE purchase_invoices
  ADD COLUMN store_name_snapshot VARCHAR(160),
  ADD COLUMN store_address_snapshot JSONB,
  ADD COLUMN store_tax_id_snapshot VARCHAR(40),
  ADD COLUMN store_phone_snapshot VARCHAR(30),
  ADD COLUMN store_email_snapshot VARCHAR(254);

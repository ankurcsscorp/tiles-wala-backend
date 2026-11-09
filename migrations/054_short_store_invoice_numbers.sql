-- Shorten the configured sequence width for future invoices only. Issued numbers are immutable.
CREATE TABLE invoice_number_padding_migration_backup (
  store_id BIGINT PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  previous_padding SMALLINT NOT NULL
);
INSERT INTO invoice_number_padding_migration_backup(store_id,previous_padding)
  SELECT id,invoice_number_padding FROM stores WHERE invoice_number_padding<>4;
ALTER TABLE stores ALTER COLUMN invoice_number_padding SET DEFAULT 4;
UPDATE stores SET invoice_number_padding=4 WHERE invoice_number_padding<>4;
ALTER TABLE stores DROP CONSTRAINT IF EXISTS stores_invoice_number_padding_check;
ALTER TABLE stores ADD CONSTRAINT stores_invoice_number_padding_check
  CHECK (invoice_number_padding BETWEEN 4 AND 12);

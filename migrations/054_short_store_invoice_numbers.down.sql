ALTER TABLE stores DROP CONSTRAINT IF EXISTS stores_invoice_number_padding_check;
UPDATE stores s SET invoice_number_padding=b.previous_padding
FROM invoice_number_padding_migration_backup b WHERE b.store_id=s.id;
ALTER TABLE stores ALTER COLUMN invoice_number_padding SET DEFAULT 5;
ALTER TABLE stores ADD CONSTRAINT stores_invoice_number_padding_check
  CHECK (invoice_number_padding BETWEEN 1 AND 12);
DROP TABLE invoice_number_padding_migration_backup;

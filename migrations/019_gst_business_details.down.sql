DROP INDEX IF EXISTS customers_gstin_unique;
DROP INDEX IF EXISTS suppliers_gstin_unique;
ALTER TABLE customers DROP COLUMN gst_details, DROP COLUMN gst_verified_at, DROP COLUMN gst_data_source;
ALTER TABLE suppliers DROP COLUMN gst_details, DROP COLUMN gst_verified_at, DROP COLUMN gst_data_source;

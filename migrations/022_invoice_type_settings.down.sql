DROP TRIGGER sales_invoice_type_guard ON sales_invoices;
DROP FUNCTION guard_sales_invoice_type();
DROP TABLE invoice_settings_audit;
ALTER TABLE sales_invoices DROP COLUMN invoice_type;
ALTER TABLE store_billing_config DROP COLUMN invoice_type, DROP COLUMN gst_registration_status,
 DROP COLUMN invoice_settings_updated_at, DROP COLUMN invoice_settings_updated_by;

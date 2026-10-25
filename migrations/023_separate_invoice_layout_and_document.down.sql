DROP TRIGGER sales_invoice_document_guard ON sales_invoices;
DROP FUNCTION guard_invoice_document_metadata();
ALTER TABLE products DROP COLUMN gst_supply_classification, DROP COLUMN gst_classification_reference;
ALTER TABLE sales_invoices DROP COLUMN invoice_layout, DROP COLUMN document_type, DROP COLUMN registration_category_snapshot, DROP COLUMN place_of_supply_state;
ALTER TABLE store_billing_config DROP COLUMN invoice_layout, DROP COLUMN default_document_type, DROP COLUMN gst_registration_category;

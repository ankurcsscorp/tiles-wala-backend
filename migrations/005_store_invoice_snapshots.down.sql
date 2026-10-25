DROP TRIGGER IF EXISTS purchase_invoice_store_snapshot ON purchase_invoices;
DROP FUNCTION IF EXISTS snapshot_purchase_invoice_store();
DROP TRIGGER IF EXISTS sales_invoice_store_snapshot ON sales_invoices;
DROP FUNCTION IF EXISTS snapshot_sales_invoice_store();

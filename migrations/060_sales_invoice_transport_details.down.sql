DROP TRIGGER IF EXISTS sales_invoice_transport_snapshot ON sales_invoices;
DROP FUNCTION IF EXISTS snapshot_sales_invoice_transport();
ALTER TABLE sales_invoices DROP CONSTRAINT IF EXISTS sales_invoice_transport_mode_check;
ALTER TABLE sales_invoices DROP COLUMN IF EXISTS vehicle_number, DROP COLUMN IF EXISTS driver_name,
  DROP COLUMN IF EXISTS driver_contact_number, DROP COLUMN IF EXISTS transport_mode_snapshot;

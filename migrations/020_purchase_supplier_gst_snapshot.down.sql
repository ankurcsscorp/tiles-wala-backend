DROP TRIGGER IF EXISTS purchase_supplier_gst_snapshot ON purchase_invoices;
DROP FUNCTION IF EXISTS snapshot_purchase_supplier_details();
ALTER TABLE purchase_invoices DROP COLUMN supplier_details_snapshot;

DROP TRIGGER IF EXISTS sales_invoice_revision_immutable ON sales_invoice_revisions;
DROP FUNCTION IF EXISTS guard_sales_invoice_revision_immutable();
DROP TABLE IF EXISTS sales_invoice_revisions;

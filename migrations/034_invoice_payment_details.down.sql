DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM sales_invoices WHERE payment_details_snapshot IS NOT NULL AND payment_details_snapshot<>'{}'::jsonb) THEN
    RAISE EXCEPTION 'Cannot remove payment instructions preserved on sales invoices';
  END IF;
END $$;
DROP TRIGGER IF EXISTS sales_invoice_payment_details_snapshot ON sales_invoices;
DROP FUNCTION IF EXISTS snapshot_sales_invoice_payment_details();
ALTER TABLE sales_invoices DROP COLUMN payment_details_snapshot;
ALTER TABLE stores DROP COLUMN invoice_payment_details;

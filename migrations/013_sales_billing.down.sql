-- Rollback is intentionally refused while unnumbered drafts exist. Export or
-- finalize/cancel those drafts before rolling this migration back.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM sales_invoices WHERE invoice_number IS NULL) THEN
    RAISE EXCEPTION 'Cannot roll back sales billing while unnumbered invoice drafts exist';
  END IF;
END $$;
DROP TRIGGER IF EXISTS sales_invoice_totals_valid ON sales_invoices;
DROP FUNCTION IF EXISTS validate_sales_invoice_posting();
DROP TRIGGER IF EXISTS sales_invoice_billing_snapshot ON sales_invoices;
DROP FUNCTION IF EXISTS snapshot_sales_invoice_billing();
DROP INDEX IF EXISTS sales_invoice_number_unique_idx;
DROP INDEX IF EXISTS sales_invoice_status_store_idx;
ALTER TABLE sales_invoices
  ALTER COLUMN invoice_number SET NOT NULL,
  DROP COLUMN invoice_discount,DROP COLUMN taxable_total,DROP COLUMN cgst_total,DROP COLUMN sgst_total,DROP COLUMN igst_total,
  DROP COLUMN additional_charges,DROP COLUMN round_off,DROP COLUMN salesperson_name_snapshot,DROP COLUMN customer_name_snapshot,
  DROP COLUMN customer_mobile_snapshot,DROP COLUMN customer_address_snapshot,DROP COLUMN customer_tax_id_snapshot,
  DROP COLUMN store_logo_snapshot,DROP COLUMN invoice_footer_snapshot,DROP COLUMN terms_snapshot,DROP COLUMN tax_jurisdiction_snapshot;
ALTER TABLE sales_invoice_items DROP COLUMN taxable_value,DROP COLUMN invoice_discount_amount,DROP COLUMN cgst_amount,DROP COLUMN sgst_amount,DROP COLUMN igst_amount,
  DROP COLUMN product_sku_snapshot,DROP COLUMN product_name_snapshot,DROP COLUMN product_snapshot,DROP COLUMN unit_code_snapshot,DROP COLUMN unit_name_snapshot,
  DROP COLUMN conversion_factor_to_base;
ALTER TABLE sales_invoices ADD CONSTRAINT sales_invoices_store_id_series_invoice_number_key UNIQUE(store_id,series,invoice_number);

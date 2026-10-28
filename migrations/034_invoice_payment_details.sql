-- Defaults belong to the store; printed sales documents retain the posted values.
ALTER TABLE stores ADD COLUMN invoice_payment_details JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK(jsonb_typeof(invoice_payment_details)='object');
ALTER TABLE sales_invoices ADD COLUMN payment_details_snapshot JSONB
  CHECK(payment_details_snapshot IS NULL OR jsonb_typeof(payment_details_snapshot)='object');

CREATE FUNCTION snapshot_sales_invoice_payment_details() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status<>'draft' AND (NEW.payment_details_snapshot IS DISTINCT FROM OLD.payment_details_snapshot OR NEW.terms_snapshot IS DISTINCT FROM OLD.terms_snapshot) THEN
    RAISE EXCEPTION 'Finalized invoice payment details and terms are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status='draft' AND NEW.status='posted' THEN
    SELECT s.invoice_payment_details INTO NEW.payment_details_snapshot FROM stores s WHERE s.id=NEW.store_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_invoice_payment_details_snapshot BEFORE UPDATE ON sales_invoices
FOR EACH ROW EXECUTE FUNCTION snapshot_sales_invoice_payment_details();
-- The existing sales_invoice_billing_snapshot trigger captures stores.terms_and_conditions.
-- Historical invoices are deliberately not backfilled from current payment settings.

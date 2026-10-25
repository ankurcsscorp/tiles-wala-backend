-- Preserve ambiguous historical zero-tax invoices without inferring an exemption.
ALTER TABLE store_billing_config
 ADD COLUMN invoice_type TEXT NOT NULL DEFAULT 'GST' CHECK(invoice_type IN ('GST','NON_GST')),
 ADD COLUMN gst_registration_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(gst_registration_status IN ('UNKNOWN','REGISTERED','UNREGISTERED')),
 ADD COLUMN invoice_settings_updated_at TIMESTAMPTZ,
 ADD COLUMN invoice_settings_updated_by BIGINT REFERENCES users(id);
ALTER TABLE sales_invoices ADD COLUMN invoice_type TEXT CHECK(invoice_type IN ('GST','NON_GST'));
-- Lifecycle guards protect posted records; backfill only the new metadata column.
ALTER TABLE sales_invoices DISABLE TRIGGER sales_invoice_lifecycle;
UPDATE sales_invoices si SET invoice_type='GST'
WHERE si.tax_total>0 OR si.cgst_total>0 OR si.sgst_total>0 OR si.igst_total>0
 OR EXISTS(SELECT 1 FROM sales_invoice_items li WHERE li.sales_invoice_id=si.id AND (li.tax_rate>0 OR li.tax_amount>0));
ALTER TABLE sales_invoices ENABLE TRIGGER sales_invoice_lifecycle;
CREATE TABLE invoice_settings_audit (
 id BIGSERIAL PRIMARY KEY, store_id BIGINT NOT NULL REFERENCES stores(id),
 changed_by BIGINT NOT NULL REFERENCES users(id), previous_settings JSONB NOT NULL,
 new_settings JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE FUNCTION guard_sales_invoice_type() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.invoice_type IS DISTINCT FROM OLD.invoice_type THEN
  RAISE EXCEPTION 'Invoice type cannot be converted; create a new draft' USING ERRCODE='23514';
 END IF;
 IF NEW.invoice_type='NON_GST' AND (TG_OP='INSERT' OR (OLD.status='draft' AND NEW.status='posted')) THEN
  IF NOT EXISTS(SELECT 1 FROM stores s JOIN store_billing_config c ON c.store_id=s.id
    WHERE s.id=NEW.store_id AND c.gst_registration_status='UNREGISTERED'
    AND NULLIF(trim(s.gstin),'') IS NULL AND NULLIF(trim(s.tax_id),'') IS NULL) THEN
   RAISE EXCEPTION 'Non-GST tax treatment is not established for this store' USING ERRCODE='23514';
  END IF;
  IF NEW.tax_total<>0 OR NEW.discount_total<>0 OR NEW.invoice_discount<>0 OR NEW.additional_charges<>0 OR NEW.round_off<>0 THEN
   RAISE EXCEPTION 'Non-GST invoices require quantity times rate without tax or adjustments' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM sales_invoice_items WHERE sales_invoice_id=NEW.id AND
    (tax_rate<>0 OR tax_amount<>0 OR cgst_amount<>0 OR sgst_amount<>0 OR igst_amount<>0 OR discount_amount<>0 OR invoice_discount_amount<>0
     OR line_total<>round(quantity*unit_price,2))) THEN
   RAISE EXCEPTION 'Invalid Non-GST invoice line calculations' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sales_invoice_type_guard BEFORE INSERT OR UPDATE ON sales_invoices FOR EACH ROW EXECUTE FUNCTION guard_sales_invoice_type();

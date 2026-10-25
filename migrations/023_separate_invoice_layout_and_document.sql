ALTER TABLE store_billing_config
 ADD COLUMN invoice_layout TEXT NOT NULL DEFAULT 'STANDARD_GST_LAYOUT' CHECK(invoice_layout IN ('STANDARD_GST_LAYOUT','SIMPLE_LAYOUT')),
 ADD COLUMN default_document_type TEXT NOT NULL DEFAULT 'GST_TAX_INVOICE' CHECK(default_document_type IN ('GST_TAX_INVOICE','BILL_OF_SUPPLY','NON_GST_COMMERCIAL')),
 ADD COLUMN gst_registration_category TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(gst_registration_category IN ('UNKNOWN','REGULAR','COMPOSITION'));
UPDATE store_billing_config SET invoice_layout='SIMPLE_LAYOUT',default_document_type='NON_GST_COMMERCIAL' WHERE invoice_type='NON_GST';
-- Existing invoice snapshots stay NULL and use their historical invoice_type; no finalized rows are updated.
ALTER TABLE sales_invoices
 ADD COLUMN invoice_layout TEXT CHECK(invoice_layout IN ('STANDARD_GST_LAYOUT','SIMPLE_LAYOUT')),
 ADD COLUMN document_type TEXT CHECK(document_type IN ('GST_TAX_INVOICE','BILL_OF_SUPPLY','NON_GST_COMMERCIAL')),
 ADD COLUMN registration_category_snapshot TEXT,
 ADD COLUMN place_of_supply_state TEXT;
ALTER TABLE products
 ADD COLUMN gst_supply_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(gst_supply_classification IN ('UNKNOWN','TAXABLE','EXEMPT','NON_TAXABLE')),
 ADD COLUMN gst_classification_reference TEXT;
CREATE FUNCTION guard_invoice_document_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE config RECORD;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.invoice_layout IS DISTINCT FROM OLD.invoice_layout OR NEW.document_type IS DISTINCT FROM OLD.document_type) THEN
  RAISE EXCEPTION 'Invoice appearance and document type are fixed on creation; create a replacement draft' USING ERRCODE='23514';
 END IF;
 IF NEW.document_type IS NULL THEN RETURN NEW; END IF;
 IF (NEW.document_type='GST_TAX_INVOICE' AND NEW.invoice_type IS DISTINCT FROM 'GST') OR
    (NEW.document_type='NON_GST_COMMERCIAL' AND NEW.invoice_type IS DISTINCT FROM 'NON_GST') OR
    (NEW.document_type='BILL_OF_SUPPLY' AND NEW.invoice_type IS NOT NULL) THEN
  RAISE EXCEPTION 'Invoice type and tax document disagree' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.status='draft' AND NEW.status='posted' THEN
  IF NEW.document_type='BILL_OF_SUPPLY' THEN
   SELECT c.*,s.gstin,s.tax_id,s.state INTO config FROM store_billing_config c JOIN stores s ON s.id=c.store_id WHERE s.id=NEW.store_id;
   IF config.gst_registration_status IS DISTINCT FROM 'REGISTERED' OR config.gst_registration_category NOT IN ('REGULAR','COMPOSITION')
      OR COALESCE(NULLIF(trim(config.gstin),''),NULLIF(trim(config.tax_id),'')) IS NULL THEN
    RAISE EXCEPTION 'Bill of Supply registration is not established' USING ERRCODE='23514';
   END IF;
   IF config.gst_registration_category='COMPOSITION' AND (NULLIF(trim(NEW.place_of_supply_state),'') IS NULL OR NULLIF(trim(config.state),'') IS NULL
      OR lower(trim(config.state))<>lower(trim(NEW.place_of_supply_state))) THEN
    RAISE EXCEPTION 'Composition billing requires a known domestic intra-state place of supply' USING ERRCODE='23514';
   END IF;
   IF NEW.tax_total<>0 OR NEW.cgst_total<>0 OR NEW.sgst_total<>0 OR NEW.igst_total<>0 THEN
    RAISE EXCEPTION 'Bill of Supply cannot collect GST' USING ERRCODE='23514';
   END IF;
   IF EXISTS(SELECT 1 FROM sales_invoice_items li JOIN products p ON p.id=li.product_id WHERE li.sales_invoice_id=NEW.id AND
     (li.tax_rate<>0 OR li.tax_amount<>0 OR p.gst_supply_classification='UNKNOWN' OR NULLIF(trim(p.hsn_code),'') IS NULL OR
      (config.gst_registration_category='REGULAR' AND p.gst_supply_classification NOT IN ('EXEMPT','NON_TAXABLE')) OR
      (p.gst_supply_classification IN ('EXEMPT','NON_TAXABLE') AND NULLIF(trim(p.gst_classification_reference),'') IS NULL))) THEN
    RAISE EXCEPTION 'Bill of Supply product eligibility is not established' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sales_invoice_document_guard BEFORE INSERT OR UPDATE ON sales_invoices FOR EACH ROW EXECUTE FUNCTION guard_invoice_document_metadata();

-- No historical rows are rewritten. NULL metadata retains the legacy purchase workflow.
ALTER TABLE purchase_invoices
 ADD COLUMN invoice_layout TEXT CHECK(invoice_layout IN ('STANDARD_GST_LAYOUT','SIMPLE_LAYOUT')),
 ADD COLUMN supplier_document_type TEXT CHECK(supplier_document_type IN ('GST_TAX_INVOICE','BILL_OF_SUPPLY','NON_GST_COMMERCIAL')),
 ADD COLUMN supplier_tax_jurisdiction TEXT CHECK(supplier_tax_jurisdiction IN ('INTRA_STATE','INTER_STATE')),
 ADD COLUMN supplier_tax_reason TEXT,
 ADD COLUMN declared_tax_total NUMERIC(18,2) CHECK(declared_tax_total>=0),
 ADD COLUMN cgst_total NUMERIC(18,2) NOT NULL DEFAULT 0,
 ADD COLUMN sgst_total NUMERIC(18,2) NOT NULL DEFAULT 0,
 ADD COLUMN igst_total NUMERIC(18,2) NOT NULL DEFAULT 0;
ALTER TABLE purchase_invoice_items
 ADD COLUMN cgst_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(cgst_amount>=0),
 ADD COLUMN sgst_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(sgst_amount>=0),
 ADD COLUMN igst_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(igst_amount>=0);
CREATE FUNCTION guard_purchase_billing_mode() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE supplier_gstin TEXT;
BEGIN
 IF TG_OP='UPDATE' AND NEW.invoice_layout IS DISTINCT FROM OLD.invoice_layout THEN
  RAISE EXCEPTION 'Purchase billing mode is fixed on creation; create a replacement draft' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.status='draft' AND NEW.status='posted' AND NEW.supplier_document_type IS NOT NULL THEN
  SELECT NULLIF(trim(tax_id),'') INTO supplier_gstin FROM suppliers WHERE id=NEW.supplier_id;
  IF NEW.supplier_document_type='GST_TAX_INVOICE' THEN
   IF supplier_gstin IS NULL OR NULLIF(trim(NEW.supplier_invoice_number),'') IS NULL OR NEW.supplier_tax_jurisdiction IS NULL OR NEW.declared_tax_total IS NULL OR NEW.declared_tax_total<>NEW.tax_total THEN
    RAISE EXCEPTION 'Match GST details to the supplier invoice before posting' USING ERRCODE='23514';
   END IF;
  ELSE
   IF NEW.tax_total<>0 OR EXISTS(SELECT 1 FROM purchase_invoice_items WHERE purchase_invoice_id=NEW.id AND (tax_rate<>0 OR tax_amount<>0)) THEN
    RAISE EXCEPTION 'A supplier invoice without GST cannot contain GST collection amounts' USING ERRCODE='23514';
   END IF;
   IF NEW.supplier_document_type='NON_GST_COMMERCIAL' AND supplier_gstin IS NOT NULL THEN
    RAISE EXCEPTION 'Registered supplier no-GST documents must be recorded using the actual Bill of Supply classification' USING ERRCODE='23514';
   END IF;
   IF NEW.supplier_document_type='BILL_OF_SUPPLY' AND (supplier_gstin IS NULL OR NULLIF(trim(NEW.supplier_tax_reason),'') IS NULL) THEN
    RAISE EXCEPTION 'Record the registered supplier and Bill of Supply basis' USING ERRCODE='23514';
   END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM purchase_invoice_items WHERE purchase_invoice_id=NEW.id AND tax_amount<>cgst_amount+sgst_amount+igst_amount) OR NEW.tax_total<>NEW.cgst_total+NEW.sgst_total+NEW.igst_total THEN
   RAISE EXCEPTION 'Purchase GST breakup does not match recorded supplier tax' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER purchase_billing_mode_guard BEFORE INSERT OR UPDATE ON purchase_invoices FOR EACH ROW EXECUTE FUNCTION guard_purchase_billing_mode();

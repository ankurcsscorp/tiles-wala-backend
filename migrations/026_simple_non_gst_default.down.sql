-- Restores old defaults/guards only. Does not rewrite invoice history or user preferences.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sales_invoices si JOIN stores s ON s.id=si.store_id LEFT JOIN store_billing_config c ON c.store_id=s.id
 WHERE si.invoice_type='NON_GST' AND (c.gst_registration_status IS DISTINCT FROM 'UNREGISTERED' OR NULLIF(trim(s.gstin),'') IS NOT NULL OR NULLIF(trim(s.tax_id),'') IS NOT NULL)) THEN
 RAISE EXCEPTION 'Non-GST records use the simplified policy; review/export these records before restoring the old registration guards'; END IF;
 IF EXISTS(SELECT 1 FROM purchase_invoices pi JOIN suppliers s ON s.id=pi.supplier_id
 WHERE pi.supplier_document_type='NON_GST_COMMERCIAL' AND NULLIF(trim(s.tax_id),'') IS NOT NULL) THEN
 RAISE EXCEPTION 'Non-GST purchase records use the simplified policy; review/export these records before restoring the old supplier guard'; END IF;
END $$;
ALTER TABLE store_billing_config ALTER COLUMN invoice_type SET DEFAULT 'GST',ALTER COLUMN invoice_layout SET DEFAULT 'STANDARD_GST_LAYOUT',ALTER COLUMN default_document_type SET DEFAULT 'GST_TAX_INVOICE';
CREATE OR REPLACE FUNCTION guard_sales_invoice_type() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION guard_purchase_billing_mode() RETURNS trigger LANGUAGE plpgsql AS $$
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

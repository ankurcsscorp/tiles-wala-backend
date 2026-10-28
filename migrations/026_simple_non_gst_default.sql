-- Two billing modes: new/unconfigured stores default to Simple Non-GST.
ALTER TABLE store_billing_config ALTER COLUMN invoice_type SET DEFAULT 'NON_GST',
 ALTER COLUMN invoice_layout SET DEFAULT 'SIMPLE_LAYOUT', ALTER COLUMN default_document_type SET DEFAULT 'NON_GST_COMMERCIAL';
-- Keep completed, detailed GST configurations as opted in; simplify other current defaults.
WITH previous AS (SELECT c.* FROM store_billing_config c WHERE NOT
 (c.invoice_layout='STANDARD_GST_LAYOUT' AND c.default_document_type='GST_TAX_INVOICE' AND c.gst_registration_status='REGISTERED' AND c.gst_registration_category='REGULAR') FOR UPDATE),
 changed AS (UPDATE store_billing_config c SET invoice_type='NON_GST',invoice_layout='SIMPLE_LAYOUT',default_document_type='NON_GST_COMMERCIAL'
 FROM previous p WHERE c.store_id=p.store_id AND (c.invoice_type<>'NON_GST' OR c.invoice_layout<>'SIMPLE_LAYOUT' OR c.default_document_type<>'NON_GST_COMMERCIAL') RETURNING c.*)
INSERT INTO audit_logs(store_id,action,entity_type,entity_id,before_data,after_data)
 SELECT n.store_id,'invoice_settings.simple_default_migration','store_billing_config',n.store_id,to_jsonb(p),to_jsonb(n) FROM changed n JOIN previous p ON p.store_id=n.store_id;
CREATE OR REPLACE FUNCTION guard_sales_invoice_type() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.invoice_type IS DISTINCT FROM OLD.invoice_type THEN
  RAISE EXCEPTION 'Invoice type cannot be converted; create a new draft' USING ERRCODE='23514';
 END IF;
 IF NEW.invoice_type='NON_GST' AND (TG_OP='INSERT' OR (OLD.status='draft' AND NEW.status='posted')) THEN
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

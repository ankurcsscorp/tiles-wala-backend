-- Restore the strict Simple Non-GST rule. Existing posted invoices are retained.
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

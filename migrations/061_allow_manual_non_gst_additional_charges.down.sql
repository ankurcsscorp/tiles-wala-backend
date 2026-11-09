-- Restore the prior rule: non-GST invoices only allow accepted dealer transport.
CREATE OR REPLACE FUNCTION guard_sales_invoice_type() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE accepted_transport NUMERIC(18,2);
BEGIN
 IF TG_OP='UPDATE' AND NEW.invoice_type IS DISTINCT FROM OLD.invoice_type THEN
  RAISE EXCEPTION 'Invoice type cannot be converted; create a new draft' USING ERRCODE='23514';
 END IF;
 IF NEW.invoice_type='NON_GST' AND (TG_OP='INSERT' OR (OLD.status='draft' AND NEW.status='posted')) THEN
  SELECT COALESCE(o.transport_charge,0) INTO accepted_transport FROM dealer_orders o WHERE o.id=NEW.dealer_order_id;
  accepted_transport:=COALESCE(accepted_transport,0);
  IF NEW.tax_total<>0 OR NEW.discount_total<>0 OR NEW.invoice_discount<>0 OR NEW.additional_charges<>accepted_transport OR NEW.round_off<>0 THEN
   RAISE EXCEPTION 'Non-GST invoices allow only the accepted dealer-order transport charge; tax, discounts, and round-off must be zero' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM sales_invoice_items WHERE sales_invoice_id=NEW.id AND
    (tax_rate<>0 OR tax_amount<>0 OR cgst_amount<>0 OR sgst_amount<>0 OR igst_amount<>0 OR discount_amount<>0 OR invoice_discount_amount<>0
     OR line_total<>round(quantity*unit_price,2))) THEN
   RAISE EXCEPTION 'Invalid Non-GST invoice line calculations' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;

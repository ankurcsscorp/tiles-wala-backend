-- Capture supplier identity only when a new draft posts. Historical invoices stay untouched.
ALTER TABLE purchase_invoices ADD COLUMN supplier_details_snapshot JSONB;
CREATE FUNCTION snapshot_purchase_supplier_details() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='draft' AND NEW.status='posted' THEN
    SELECT jsonb_build_object('name',s.name,'gstin',s.tax_id,'billingAddress',s.address,
      'city',s.city,'state',s.state,'pinCode',s.pin_code,'gstDetails',s.gst_details)
      INTO NEW.supplier_details_snapshot FROM suppliers s WHERE s.id=NEW.supplier_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_supplier_gst_snapshot BEFORE UPDATE OF status ON purchase_invoices
FOR EACH ROW EXECUTE FUNCTION snapshot_purchase_supplier_details();

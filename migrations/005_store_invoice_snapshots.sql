CREATE FUNCTION snapshot_sales_invoice_store() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='draft' AND NEW.status='posted' THEN
    SELECT s.name, jsonb_build_object('address',s.address,'city',s.city,'state',s.state,'pinCode',s.pin_code),
      COALESCE(s.gstin,s.tax_id), s.phone, s.email
    INTO NEW.store_name_snapshot, NEW.store_address_snapshot, NEW.store_tax_id_snapshot, NEW.store_phone_snapshot, NEW.store_email_snapshot
    FROM stores s WHERE s.id=NEW.store_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_invoice_store_snapshot BEFORE UPDATE OF status ON sales_invoices
FOR EACH ROW EXECUTE FUNCTION snapshot_sales_invoice_store();

CREATE FUNCTION snapshot_purchase_invoice_store() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='draft' AND NEW.status='posted' THEN
    SELECT s.name, jsonb_build_object('address',s.address,'city',s.city,'state',s.state,'pinCode',s.pin_code),
      COALESCE(s.gstin,s.tax_id), s.phone, s.email
    INTO NEW.store_name_snapshot, NEW.store_address_snapshot, NEW.store_tax_id_snapshot, NEW.store_phone_snapshot, NEW.store_email_snapshot
    FROM stores s WHERE s.id=NEW.store_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_invoice_store_snapshot BEFORE UPDATE OF status ON purchase_invoices
FOR EACH ROW EXECUTE FUNCTION snapshot_purchase_invoice_store();

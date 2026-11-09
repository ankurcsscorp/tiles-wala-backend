ALTER TABLE sales_invoices
  ADD COLUMN vehicle_number VARCHAR(30),
  ADD COLUMN driver_name VARCHAR(150),
  ADD COLUMN driver_contact_number VARCHAR(20),
  ADD COLUMN transport_mode_snapshot VARCHAR(16);

ALTER TABLE sales_invoices ADD CONSTRAINT sales_invoice_transport_mode_check
  CHECK (transport_mode_snapshot IS NULL OR transport_mode_snapshot IN ('SELF','TOTO','THELA','PICKUP'));

CREATE OR REPLACE FUNCTION snapshot_sales_invoice_transport() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='draft' AND NEW.status='posted' THEN
    IF NEW.dealer_order_id IS NOT NULL THEN
      SELECT COALESCE(NEW.vehicle_number, sh.vehicle_number),
             COALESCE(NEW.driver_name, sh.driver_name),
             COALESCE(NEW.driver_contact_number, sh.driver_mobile),
             COALESCE(NEW.transport_mode_snapshot, o.transport_mode)
        INTO NEW.vehicle_number, NEW.driver_name, NEW.driver_contact_number, NEW.transport_mode_snapshot
        FROM dealer_orders o LEFT JOIN dealer_order_shipments sh ON sh.order_id=o.id
       WHERE o.id=NEW.dealer_order_id;
    END IF;
    NEW.vehicle_number := NULLIF(upper(trim(NEW.vehicle_number)), '');
    NEW.driver_name := NULLIF(trim(NEW.driver_name), '');
    NEW.driver_contact_number := NULLIF(trim(NEW.driver_contact_number), '');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_invoice_transport_snapshot BEFORE UPDATE OF status ON sales_invoices
  FOR EACH ROW EXECUTE FUNCTION snapshot_sales_invoice_transport();

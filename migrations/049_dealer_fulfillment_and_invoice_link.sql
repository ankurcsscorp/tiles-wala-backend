-- Link dealer fulfillment to the existing sales invoice and inventory lifecycle.
ALTER TABLE sales_invoices
  ADD COLUMN dealer_order_id BIGINT,
  ADD CONSTRAINT sales_invoices_id_store_unique UNIQUE(id,store_id),
  ADD CONSTRAINT sales_invoice_dealer_order_store_fk FOREIGN KEY(dealer_order_id,store_id) REFERENCES dealer_orders(id,store_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX sales_invoice_dealer_order_unique
  ON sales_invoices(dealer_order_id) WHERE dealer_order_id IS NOT NULL;

ALTER TABLE dealer_orders
  ADD COLUMN sales_invoice_id BIGINT,
  ADD COLUMN delivered_at TIMESTAMPTZ,
  ADD COLUMN delivered_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN received_by VARCHAR(150),
  ADD COLUMN delivery_remarks TEXT,
  ADD COLUMN referred_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE dealer_orders ADD CONSTRAINT dealer_order_invoice_store_fk
  FOREIGN KEY(sales_invoice_id,store_id) REFERENCES sales_invoices(id,store_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX dealer_order_sales_invoice_unique
  ON dealer_orders(sales_invoice_id) WHERE sales_invoice_id IS NOT NULL;

CREATE TABLE dealer_order_shipments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL UNIQUE REFERENCES dealer_orders(id) ON DELETE RESTRICT,
  transporter_name VARCHAR(180),
  vehicle_number VARCHAR(40),
  driver_name VARCHAR(150),
  driver_mobile VARCHAR(30),
  dispatch_date DATE,
  estimated_delivery_date DATE,
  tracking_number VARCHAR(100),
  delivery_remarks TEXT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dealer_order_delivery_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES dealer_orders(id) ON DELETE RESTRICT,
  event_type VARCHAR(32) NOT NULL CHECK(event_type IN ('SHIPMENT_UPDATED','DISPATCHED','PARTIAL_DELIVERY','DELIVERED','EXCEPTION')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  remarks TEXT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dealer_order_delivery_events_idx ON dealer_order_delivery_events(order_id,created_at,id);

-- A dealer invoice ships to the saved order destination, not necessarily the customer's default address.
CREATE OR REPLACE FUNCTION snapshot_sales_invoice_billing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='draft' AND NEW.status='posted' THEN
    SELECT s.logo_url,s.invoice_footer,s.terms_and_conditions
      INTO NEW.store_logo_snapshot,NEW.invoice_footer_snapshot,NEW.terms_snapshot
      FROM stores s WHERE s.id=NEW.store_id;
    IF NEW.customer_id IS NOT NULL THEN
      SELECT c.name,c.phone,jsonb_build_object('billing',c.address,'shipping',COALESCE(o.delivery_address_snapshot,c.shipping_address),'city',c.city,'state',c.state,'pinCode',c.pin_code),c.tax_id
        INTO NEW.customer_name_snapshot,NEW.customer_mobile_snapshot,NEW.customer_address_snapshot,NEW.customer_tax_id_snapshot
        FROM customers c LEFT JOIN dealer_orders o ON o.id=NEW.dealer_order_id AND o.store_id=NEW.store_id WHERE c.id=NEW.customer_id;
    END IF;
    IF NEW.salesperson_name_snapshot IS NULL THEN
      SELECT u.name INTO NEW.salesperson_name_snapshot FROM users u WHERE u.id=NEW.created_by;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sales_invoice_billing_snapshot ON sales_invoices;
CREATE TRIGGER sales_invoice_billing_snapshot BEFORE UPDATE OF status ON sales_invoices
FOR EACH ROW EXECUTE FUNCTION snapshot_sales_invoice_billing();

ALTER TABLE dealer_order_messages DROP CONSTRAINT IF EXISTS dealer_order_messages_message_type_check;
ALTER TABLE dealer_order_messages ADD CONSTRAINT dealer_order_messages_message_type_check
  CHECK(message_type IN ('ADMIN_MESSAGE','CLARIFICATION_REQUEST','STOCK_CONFIRMED','STOCK_SHORTAGE','PAYMENT_TERMS_CONFIRMED','ORDER_STATUS_UPDATED','INVOICE_FINALIZED','SHIPMENT_UPDATED','PARTIAL_DELIVERY','DELIVERED','EXCEPTION'));

ALTER TABLE dealer_order_notifications DROP CONSTRAINT IF EXISTS dealer_order_notifications_event_type_check;
ALTER TABLE dealer_order_notifications ADD CONSTRAINT dealer_order_notifications_event_type_check
  CHECK(event_type IN ('ORDER_PLACED','QUOTATION_REVISED','ORDER_CANCELLED','ORDER_STATUS_UPDATED','ADMIN_MESSAGE','CLARIFICATION_REQUEST','STOCK_CONFIRMED','STOCK_SHORTAGE','PAYMENT_TERMS_CONFIRMED','INVOICE_FINALIZED','SHIPMENT_UPDATED','PARTIAL_DELIVERY','DELIVERED','EXCEPTION'));

ALTER TABLE dealer_order_admin_notifications DROP CONSTRAINT IF EXISTS dealer_order_admin_notifications_event_type_check;
ALTER TABLE dealer_order_admin_notifications ADD CONSTRAINT dealer_order_admin_notifications_event_type_check
  CHECK(event_type IN ('ORDER_PLACED','QUOTATION_REVISED','ORDER_CANCELLED','ORDER_STATUS_UPDATED','ADMIN_MESSAGE','CLARIFICATION_REQUEST','STOCK_CONFIRMED','STOCK_SHORTAGE','PAYMENT_TERMS_CONFIRMED','INVOICE_FINALIZED','SHIPMENT_UPDATED','PARTIAL_DELIVERY','DELIVERED','EXCEPTION'));

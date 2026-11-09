ALTER TABLE dealer_order_admin_notifications DROP CONSTRAINT IF EXISTS dealer_order_admin_notifications_event_type_check;
ALTER TABLE dealer_order_admin_notifications ADD CONSTRAINT dealer_order_admin_notifications_event_type_check
  CHECK(event_type IN ('ORDER_PLACED','QUOTATION_REVISED','ORDER_CANCELLED'));
ALTER TABLE dealer_order_notifications DROP CONSTRAINT IF EXISTS dealer_order_notifications_event_type_check;
ALTER TABLE dealer_order_notifications ADD CONSTRAINT dealer_order_notifications_event_type_check
  CHECK(event_type IN ('QUOTATION_REVISED','ORDER_CANCELLED','ORDER_STATUS_UPDATED','ADMIN_MESSAGE','CLARIFICATION_REQUEST','STOCK_CONFIRMED','PAYMENT_TERMS_CONFIRMED'));
ALTER TABLE dealer_order_messages DROP CONSTRAINT IF EXISTS dealer_order_messages_message_type_check;
ALTER TABLE dealer_order_messages ADD CONSTRAINT dealer_order_messages_message_type_check
  CHECK(message_type IN ('ADMIN_MESSAGE','CLARIFICATION_REQUEST','STOCK_CONFIRMED','STOCK_SHORTAGE','PAYMENT_TERMS_CONFIRMED'));
DROP TABLE IF EXISTS dealer_order_delivery_events;
DROP TABLE IF EXISTS dealer_order_shipments;
CREATE OR REPLACE FUNCTION snapshot_sales_invoice_billing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='draft' AND NEW.status='posted' THEN
    SELECT s.logo_url,s.invoice_footer,s.terms_and_conditions
      INTO NEW.store_logo_snapshot,NEW.invoice_footer_snapshot,NEW.terms_snapshot
      FROM stores s WHERE s.id=NEW.store_id;
    IF NEW.customer_id IS NOT NULL THEN
      SELECT c.name,c.phone,jsonb_build_object('billing',c.address,'shipping',c.shipping_address,'city',c.city,'state',c.state,'pinCode',c.pin_code),c.tax_id
        INTO NEW.customer_name_snapshot,NEW.customer_mobile_snapshot,NEW.customer_address_snapshot,NEW.customer_tax_id_snapshot
        FROM customers c WHERE c.id=NEW.customer_id;
    END IF;
    IF NEW.salesperson_name_snapshot IS NULL THEN
      SELECT u.name INTO NEW.salesperson_name_snapshot FROM users u WHERE u.id=NEW.created_by;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP INDEX IF EXISTS dealer_order_sales_invoice_unique;
ALTER TABLE dealer_orders DROP CONSTRAINT IF EXISTS dealer_order_invoice_store_fk;
ALTER TABLE dealer_orders DROP COLUMN IF EXISTS sales_invoice_id, DROP COLUMN IF EXISTS delivered_at,
  DROP COLUMN IF EXISTS delivered_by, DROP COLUMN IF EXISTS received_by, DROP COLUMN IF EXISTS delivery_remarks,
  DROP COLUMN IF EXISTS referred_by_user_id;
DROP INDEX IF EXISTS sales_invoice_dealer_order_unique;
ALTER TABLE sales_invoices DROP CONSTRAINT IF EXISTS sales_invoice_dealer_order_store_fk;
ALTER TABLE sales_invoices DROP CONSTRAINT IF EXISTS sales_invoices_id_store_unique;
ALTER TABLE sales_invoices DROP COLUMN IF EXISTS dealer_order_id;

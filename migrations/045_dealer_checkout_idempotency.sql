ALTER TABLE dealer_orders
  ADD COLUMN idempotency_key VARCHAR(128),
  ADD COLUMN request_hash CHAR(64),
  ADD COLUMN delivery_contact_name VARCHAR(150),
  ADD COLUMN delivery_contact_mobile VARCHAR(30),
  ADD COLUMN delivery_instructions TEXT;
ALTER TABLE dealer_orders ADD CONSTRAINT dealer_orders_payment_method_check
  CHECK(payment_method IS NULL OR payment_method IN ('UPI','CASH_ON_DELIVERY'));
ALTER TABLE dealer_order_quotations ADD COLUMN document_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX dealer_orders_idempotency_idx
  ON dealer_orders(dealer_id,idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE dealer_order_admin_notifications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES dealer_orders(id) ON DELETE CASCADE,
  event_type VARCHAR(32) NOT NULL CHECK(event_type IN ('ORDER_PLACED','QUOTATION_REVISED','ORDER_CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  read_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX dealer_order_admin_notifications_unread_idx
  ON dealer_order_admin_notifications(created_at DESC) WHERE read_at IS NULL;

CREATE TABLE dealer_order_notifications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES dealer_orders(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type VARCHAR(32) NOT NULL CHECK(event_type IN ('QUOTATION_REVISED','ORDER_CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);
CREATE INDEX dealer_order_notifications_user_idx ON dealer_order_notifications(user_id,created_at DESC);

CREATE OR REPLACE FUNCTION guard_dealer_order_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed BOOLEAN;
BEGIN
 IF NEW.status=OLD.status THEN RETURN NEW; END IF;
 allowed := CASE OLD.status
  WHEN 'PENDING_REVIEW' THEN NEW.status IN ('QUOTATION_SENT','REJECTED','CANCELLED')
  WHEN 'QUOTATION_SENT' THEN NEW.status IN ('AWAITING_DEALER_ACCEPTANCE','CONFIRMED','REJECTED','CANCELLED')
  WHEN 'AWAITING_DEALER_ACCEPTANCE' THEN NEW.status IN ('QUOTATION_SENT','CONFIRMED','REJECTED','CANCELLED')
  WHEN 'CONFIRMED' THEN NEW.status IN ('PROCESSING','CANCELLED')
  WHEN 'PROCESSING' THEN NEW.status IN ('READY_TO_DISPATCH','CANCELLED')
  WHEN 'READY_TO_DISPATCH' THEN NEW.status IN ('SHIPPED','CANCELLED')
  WHEN 'SHIPPED' THEN NEW.status='DELIVERED'
  WHEN 'DELIVERED' THEN NEW.status='COMPLETED'
  ELSE FALSE END;
 IF NOT allowed THEN RAISE EXCEPTION 'invalid dealer order status transition: % to %',OLD.status,NEW.status USING ERRCODE='23514'; END IF;
 IF NEW.status='CONFIRMED' THEN NEW.confirmed_at:=COALESCE(NEW.confirmed_at,now()); END IF;
 IF NEW.status='CANCELLED' THEN NEW.cancelled_at:=COALESCE(NEW.cancelled_at,now()); END IF;
 RETURN NEW;
END $$;

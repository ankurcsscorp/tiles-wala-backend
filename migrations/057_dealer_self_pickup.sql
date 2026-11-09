-- Add Self Pickup without replacing any store's existing transport prices.
UPDATE stores s
SET dealer_transport_options=jsonb_build_array(jsonb_build_object('code','SELF','label','Self Pickup','charge',0)) || s.dealer_transport_options
WHERE NOT EXISTS (
  SELECT 1 FROM jsonb_array_elements(s.dealer_transport_options) AS opt(value)
  WHERE value->>'code'='SELF'
);

ALTER TABLE dealer_orders DROP CONSTRAINT IF EXISTS dealer_orders_transport_mode_check;
ALTER TABLE dealer_orders ADD CONSTRAINT dealer_orders_transport_mode_check
  CHECK (transport_mode IS NULL OR transport_mode IN ('SELF','TOTO','THELA','PICKUP'));

CREATE OR REPLACE FUNCTION guard_dealer_order_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed BOOLEAN;
BEGIN
 IF NEW.status=OLD.status THEN RETURN NEW; END IF;
 allowed := CASE OLD.status
  WHEN 'PENDING_REVIEW' THEN NEW.status IN ('CONFIRMED','QUOTATION_SENT','REJECTED','CANCELLED')
  WHEN 'QUOTATION_SENT' THEN NEW.status IN ('AWAITING_DEALER_ACCEPTANCE','CONFIRMED','REJECTED','CANCELLED')
  WHEN 'AWAITING_DEALER_ACCEPTANCE' THEN NEW.status IN ('CONFIRMED','REJECTED','CANCELLED')
  WHEN 'CONFIRMED' THEN NEW.status IN ('PROCESSING','CANCELLED')
  WHEN 'PROCESSING' THEN NEW.status IN ('READY_TO_DISPATCH','CANCELLED')
  WHEN 'READY_TO_DISPATCH' THEN NEW.status IN ('SHIPPED','CANCELLED') OR (NEW.transport_mode='SELF' AND NEW.status='DELIVERED')
  WHEN 'SHIPPED' THEN NEW.status='DELIVERED'
  WHEN 'DELIVERED' THEN NEW.status='COMPLETED'
  ELSE FALSE END;
 IF NOT allowed THEN RAISE EXCEPTION 'invalid dealer order status transition: % to %',OLD.status,NEW.status USING ERRCODE='23514'; END IF;
 IF NEW.status='CONFIRMED' THEN NEW.confirmed_at:=COALESCE(NEW.confirmed_at,now()); END IF;
 IF NEW.status='CANCELLED' THEN NEW.cancelled_at:=COALESCE(NEW.cancelled_at,now()); END IF;
 RETURN NEW;
END $$;

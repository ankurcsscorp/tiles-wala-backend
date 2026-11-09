-- Allow the admin to confirm an unchanged, first dealer-submitted quotation.
-- Historical quotation and acceptance statuses remain valid.
ALTER TABLE dealer_orders
  ADD COLUMN confirmed_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

DROP TRIGGER IF EXISTS dealer_order_transition_guard ON dealer_orders;
CREATE TRIGGER dealer_order_transition_guard
BEFORE UPDATE OF status ON dealer_orders
FOR EACH ROW EXECUTE FUNCTION guard_dealer_order_transition();

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
  WHEN 'READY_TO_DISPATCH' THEN NEW.status IN ('SHIPPED','CANCELLED')
  WHEN 'SHIPPED' THEN NEW.status='DELIVERED'
  WHEN 'DELIVERED' THEN NEW.status='COMPLETED'
  ELSE FALSE END;
 IF NOT allowed THEN RAISE EXCEPTION 'invalid dealer order status transition: % to %',OLD.status,NEW.status USING ERRCODE='23514'; END IF;
 IF NEW.status='CONFIRMED' THEN NEW.confirmed_at:=COALESCE(NEW.confirmed_at,now()); END IF;
 IF NEW.status='CANCELLED' THEN NEW.cancelled_at:=COALESCE(NEW.cancelled_at,now()); END IF;
 RETURN NEW;
END $$;

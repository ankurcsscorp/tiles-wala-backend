-- Balances are projections of the immutable stock movement ledger.
CREATE FUNCTION guard_inventory_balance_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.quantity <> 0 OR pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'inventory balances must be established through stock movements' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF pg_trigger_depth() < 2 OR NEW.store_id <> OLD.store_id OR NEW.product_id <> OLD.product_id THEN
    RAISE EXCEPTION 'inventory balances must be changed through stock movements' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_balance_guard BEFORE INSERT OR UPDATE ON inventory_balances
FOR EACH ROW EXECUTE FUNCTION guard_inventory_balance_write();

CREATE FUNCTION protect_stock_movement_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock movements are immutable; record a reversal movement' USING ERRCODE='23514';
END $$;
CREATE TRIGGER stock_movement_immutable BEFORE UPDATE OR DELETE ON stock_movements
FOR EACH ROW EXECUTE FUNCTION protect_stock_movement_history();

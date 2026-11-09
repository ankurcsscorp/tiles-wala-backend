-- Make the primary/secondary measuring-unit relationship explicit while
-- retaining the existing base-unit stock ledger and product conversion table.
ALTER TABLE products
  ADD COLUMN primary_unit_id BIGINT REFERENCES units_of_measure(id) ON DELETE RESTRICT,
  ADD COLUMN secondary_unit_id BIGINT REFERENCES units_of_measure(id) ON DELETE RESTRICT,
  ADD COLUMN secondary_units_per_primary NUMERIC(18,6);

-- Existing base units are the established stock and measuring unit.
UPDATE products SET primary_unit_id=base_unit_id;
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE products ALTER COLUMN primary_unit_id SET NOT NULL;
CREATE OR REPLACE FUNCTION set_product_primary_unit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.primary_unit_id IS NULL THEN NEW.primary_unit_id:=NEW.base_unit_id; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER products_primary_unit_default BEFORE INSERT ON products
FOR EACH ROW EXECUTE FUNCTION set_product_primary_unit();
ALTER TABLE products ADD CONSTRAINT products_secondary_unit_pair_check CHECK (
  (secondary_unit_id IS NULL AND secondary_units_per_primary IS NULL) OR
  (secondary_unit_id IS NOT NULL AND secondary_units_per_primary IS NOT NULL AND secondary_units_per_primary > 0 AND secondary_unit_id <> primary_unit_id)
);
CREATE INDEX products_primary_unit_idx ON products(primary_unit_id);

-- Reject secondary-unit changes once stock or posted movement history exists.
CREATE OR REPLACE FUNCTION guard_product_unit_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.primary_unit_id IS DISTINCT FROM OLD.primary_unit_id OR NEW.secondary_unit_id IS DISTINCT FROM OLD.secondary_unit_id OR NEW.secondary_units_per_primary IS DISTINCT FROM OLD.secondary_units_per_primary)
     AND (EXISTS (SELECT 1 FROM inventory_balances WHERE product_id=OLD.id AND quantity<>0)
       OR EXISTS (SELECT 1 FROM stock_movements WHERE product_id=OLD.id)) THEN
    RAISE EXCEPTION 'Unit conversion cannot change while stock or inventory history exists; use an inventory adjustment workflow' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER products_unit_change_guard BEFORE UPDATE OF primary_unit_id,secondary_unit_id,secondary_units_per_primary ON products
FOR EACH ROW EXECUTE FUNCTION guard_product_unit_change();

DROP TRIGGER IF EXISTS products_unit_change_guard ON products;
DROP TRIGGER IF EXISTS products_primary_unit_default ON products;
DROP FUNCTION IF EXISTS guard_product_unit_change();
DROP FUNCTION IF EXISTS set_product_primary_unit();
DROP INDEX IF EXISTS products_primary_unit_idx;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_secondary_unit_pair_check;
ALTER TABLE products DROP COLUMN IF EXISTS secondary_units_per_primary;
ALTER TABLE products DROP COLUMN IF EXISTS secondary_unit_id;
ALTER TABLE products DROP COLUMN IF EXISTS primary_unit_id;

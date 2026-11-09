DROP TRIGGER IF EXISTS dealer_price_base_unit_valid ON products;
DROP TRIGGER IF EXISTS dealer_price_conversion_valid ON product_unit_conversions;
DROP TRIGGER IF EXISTS dealer_price_unit_valid ON dealer_product_unit_prices;
DROP FUNCTION IF EXISTS validate_dealer_product_unit_price();
DROP TRIGGER IF EXISTS orderable_dealer_price_remains ON dealer_product_unit_prices;
DROP TRIGGER IF EXISTS orderable_product_has_price ON products;
DROP FUNCTION IF EXISTS require_dealer_price_for_orderable_product();
DROP TABLE IF EXISTS dealer_product_unit_prices;
ALTER TABLE products DROP COLUMN IF EXISTS available_for_dealer_ordering;

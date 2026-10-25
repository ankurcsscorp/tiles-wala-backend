DROP TABLE IF EXISTS customer_balance_adjustments;
DROP INDEX IF EXISTS customers_type_active_idx;
DROP INDEX IF EXISTS customers_city_state_idx;
DROP INDEX IF EXISTS customers_alternate_mobile_idx;
DROP INDEX IF EXISTS customers_name_prefix_idx;
ALTER TABLE customers
  DROP COLUMN IF EXISTS notes,
  DROP COLUMN IF EXISTS payment_terms_days,
  DROP COLUMN IF EXISTS credit_limit,
  DROP COLUMN IF EXISTS customer_type,
  DROP COLUMN IF EXISTS pin_code,
  DROP COLUMN IF EXISTS state,
  DROP COLUMN IF EXISTS city,
  DROP COLUMN IF EXISTS shipping_address,
  DROP COLUMN IF EXISTS alternate_mobile;

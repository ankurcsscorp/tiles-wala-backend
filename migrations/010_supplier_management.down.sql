DROP TRIGGER IF EXISTS allocation_supplier_link_check ON payment_allocations;
DROP TRIGGER IF EXISTS payment_supplier_link_check ON payments;
DROP FUNCTION IF EXISTS validate_supplier_payment_link();
DROP INDEX IF EXISTS payments_supplier_date_idx;
ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_one_party_check,
  DROP CONSTRAINT IF EXISTS payments_supplier_direction_check,
  DROP COLUMN IF EXISTS supplier_id;
DROP TABLE IF EXISTS supplier_balance_adjustments;
DROP INDEX IF EXISTS suppliers_active_idx;
DROP INDEX IF EXISTS suppliers_city_state_idx;
DROP INDEX IF EXISTS suppliers_phone_idx;
DROP INDEX IF EXISTS suppliers_name_prefix_idx;
ALTER TABLE suppliers
  DROP COLUMN IF EXISTS notes,
  DROP COLUMN IF EXISTS payment_terms_days,
  DROP COLUMN IF EXISTS pin_code,
  DROP COLUMN IF EXISTS state,
  DROP COLUMN IF EXISTS city,
  DROP COLUMN IF EXISTS contact_person;

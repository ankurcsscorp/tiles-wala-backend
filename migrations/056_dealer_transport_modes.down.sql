ALTER TABLE dealer_orders DROP CONSTRAINT IF EXISTS dealer_orders_transport_mode_check;
ALTER TABLE dealer_orders DROP COLUMN IF EXISTS transport_mode;
ALTER TABLE stores DROP COLUMN IF EXISTS dealer_transport_options;

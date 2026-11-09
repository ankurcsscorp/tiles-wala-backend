ALTER TABLE stores
  ADD COLUMN dealer_transport_options JSONB NOT NULL DEFAULT '[{"code":"TOTO","label":"Toto","charge":400},{"code":"THELA","label":"Thela","charge":700},{"code":"PICKUP","label":"Pickup","charge":1000}]'::jsonb;

ALTER TABLE dealer_orders
  ADD COLUMN transport_mode VARCHAR(20);

ALTER TABLE dealer_orders
  ADD CONSTRAINT dealer_orders_transport_mode_check
  CHECK (transport_mode IS NULL OR transport_mode IN ('TOTO','THELA','PICKUP'));

COMMENT ON COLUMN dealer_orders.transport_mode IS 'Transport mode selected at order submission; NULL identifies historical orders with no known mode.';

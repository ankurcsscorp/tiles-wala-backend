ALTER TABLE dealer_product_unit_prices
  ADD COLUMN mrp NUMERIC(12,2) CHECK (mrp IS NULL OR mrp >= 0);

ALTER TABLE dealer_order_items
  ADD COLUMN mrp_snapshot NUMERIC(12,2) CHECK (mrp_snapshot IS NULL OR mrp_snapshot >= 0);

COMMENT ON COLUMN dealer_product_unit_prices.mrp IS
  'Optional maximum retail price for this product and selling unit; never used for order totals.';
COMMENT ON COLUMN dealer_order_items.mrp_snapshot IS
  'MRP captured when the dealer order was placed; NULL means it was not configured.';

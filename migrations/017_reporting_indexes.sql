-- Cover dashboard report filters that are not served efficiently by the
-- invoice/product-leading indexes used by transactional workflows.
CREATE INDEX stock_movements_store_created_idx
  ON stock_movements(store_id, created_at DESC, id DESC);
CREATE INDEX sales_returns_store_date_idx
  ON sales_returns(store_id, return_date DESC, id DESC);
CREATE INDEX purchase_returns_store_date_idx
  ON purchase_returns(store_id, return_date DESC, id DESC);

CREATE TABLE product_categories (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description VARCHAR(500),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX product_category_name_prefix_idx ON product_categories(lower(name) text_pattern_ops);

ALTER TABLE units_of_measure
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE products
  ADD COLUMN category_id BIGINT REFERENCES product_categories(id) ON DELETE RESTRICT,
  ADD COLUMN brand VARCHAR(120),
  ADD COLUMN collection VARCHAR(160),
  ADD COLUMN tile_size VARCHAR(80),
  ADD COLUMN finish VARCHAR(80),
  ADD COLUMN color VARCHAR(80),
  ADD COLUMN product_description TEXT,
  ADD COLUMN product_image_url TEXT,
  ADD COLUMN hsn_code VARCHAR(16),
  ADD COLUMN tax_rate NUMERIC(7,4) CHECK (tax_rate IS NULL OR tax_rate BETWEEN 0 AND 100),
  ADD COLUMN tax_inclusive BOOLEAN,
  ADD COLUMN purchase_unit_id BIGINT REFERENCES units_of_measure(id) ON DELETE RESTRICT,
  ADD COLUMN sales_unit_id BIGINT REFERENCES units_of_measure(id) ON DELETE RESTRICT,
  ADD COLUMN default_purchase_price NUMERIC(18,4) CHECK (default_purchase_price IS NULL OR default_purchase_price >= 0),
  ADD COLUMN default_selling_price NUMERIC(18,4) CHECK (default_selling_price IS NULL OR default_selling_price >= 0),
  ADD COLUMN reorder_threshold NUMERIC(18,4) CHECK (reorder_threshold IS NULL OR reorder_threshold >= 0);

CREATE INDEX products_category_active_idx ON products(category_id, is_active);
CREATE INDEX products_brand_prefix_idx ON products(lower(brand) text_pattern_ops);
CREATE INDEX products_collection_prefix_idx ON products(lower(collection) text_pattern_ops);
CREATE INDEX products_size_prefix_idx ON products(lower(tile_size) text_pattern_ops);
CREATE INDEX products_finish_prefix_idx ON products(lower(finish) text_pattern_ops);
CREATE INDEX products_sku_prefix_idx ON products(lower(sku) text_pattern_ops);
CREATE INDEX products_name_prefix_idx ON products(lower(name) text_pattern_ops);
CREATE INDEX products_color_prefix_idx ON products(lower(color) text_pattern_ops);

CREATE TABLE product_unit_conversions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  unit_id BIGINT NOT NULL REFERENCES units_of_measure(id) ON DELETE RESTRICT,
  factor_to_base NUMERIC(18,8) NOT NULL CHECK (factor_to_base > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(product_id, unit_id)
);
CREATE INDEX product_unit_conversion_unit_idx ON product_unit_conversions(unit_id);

-- Purchase and sales units must have explicit product-specific conversion factors unless they are the base unit.
CREATE FUNCTION validate_product_units() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE product_row products%ROWTYPE; target_product_id BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'products' THEN target_product_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN target_product_id := OLD.product_id;
  ELSE target_product_id := NEW.product_id;
  END IF;
  SELECT * INTO product_row FROM products WHERE id=target_product_id;
  IF NOT FOUND THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF product_row.purchase_unit_id IS NOT NULL AND product_row.purchase_unit_id <> product_row.base_unit_id AND NOT EXISTS (
    SELECT 1 FROM product_unit_conversions WHERE product_id=target_product_id AND unit_id=product_row.purchase_unit_id AND factor_to_base > 0
  ) THEN RAISE EXCEPTION 'purchase unit requires a product conversion factor' USING ERRCODE='23514'; END IF;
  IF product_row.sales_unit_id IS NOT NULL AND product_row.sales_unit_id <> product_row.base_unit_id AND NOT EXISTS (
    SELECT 1 FROM product_unit_conversions WHERE product_id=target_product_id AND unit_id=product_row.sales_unit_id AND factor_to_base > 0
  ) THEN RAISE EXCEPTION 'sales unit requires a product conversion factor' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE CONSTRAINT TRIGGER product_unit_conversion_check AFTER INSERT OR UPDATE ON products
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_product_units();
CREATE CONSTRAINT TRIGGER conversion_unit_check AFTER INSERT OR UPDATE OR DELETE ON product_unit_conversions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_product_units();

INSERT INTO units_of_measure(code,name,decimal_places) VALUES
  ('BOX','Box',4),('PCS','Piece',4),('SQFT','Square foot',4),('SQM','Square meter',4)
ON CONFLICT(code) DO NOTHING;

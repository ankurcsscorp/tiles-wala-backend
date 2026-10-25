DO $$
BEGIN
  IF EXISTS (SELECT upper(sku) FROM products GROUP BY upper(sku) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Existing product SKUs collide when compared case-insensitively; resolve those rows before applying migration 007';
  END IF;
END $$;
CREATE UNIQUE INDEX products_sku_case_insensitive_unique ON products(upper(sku));

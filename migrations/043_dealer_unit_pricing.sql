ALTER TABLE products
  ADD COLUMN available_for_dealer_ordering BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE dealer_product_unit_prices (
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  unit_id BIGINT NOT NULL REFERENCES units_of_measure(id) ON DELETE RESTRICT,
  dealer_price NUMERIC(18,4) NOT NULL CHECK(dealer_price>=0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(product_id,unit_id)
);
CREATE INDEX dealer_unit_price_unit_idx ON dealer_product_unit_prices(unit_id,product_id);

CREATE FUNCTION validate_dealer_product_unit_price() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid BIGINT; uid BIGINT;
BEGIN
 IF TG_TABLE_NAME='dealer_product_unit_prices' THEN
   IF TG_OP='DELETE' THEN pid:=OLD.product_id; uid:=OLD.unit_id;
   ELSE pid:=NEW.product_id; uid:=NEW.unit_id; END IF;
   IF EXISTS(SELECT 1 FROM products p WHERE p.id=pid) AND NOT EXISTS(
     SELECT 1 FROM products p WHERE p.id=pid AND p.base_unit_id=uid
     UNION ALL SELECT 1 FROM product_unit_conversions c WHERE c.product_id=pid AND c.unit_id=uid
   ) THEN RAISE EXCEPTION 'dealer price unit must be the product base unit or a configured product conversion' USING ERRCODE='23514'; END IF;
 ELSE
   IF TG_TABLE_NAME='products' THEN pid:=NEW.id;
   ELSIF TG_OP='DELETE' THEN pid:=OLD.product_id;
   ELSE pid:=NEW.product_id; END IF;
   IF EXISTS(SELECT 1 FROM dealer_product_unit_prices d WHERE d.product_id=pid AND NOT (
     EXISTS(SELECT 1 FROM products p WHERE p.id=pid AND p.base_unit_id=d.unit_id)
     OR EXISTS(SELECT 1 FROM product_unit_conversions c WHERE c.product_id=pid AND c.unit_id=d.unit_id)
   )) THEN RAISE EXCEPTION 'configured product conversions cannot be removed while dealer prices use those units' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE CONSTRAINT TRIGGER dealer_price_unit_valid
AFTER INSERT OR UPDATE ON dealer_product_unit_prices DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_dealer_product_unit_price();
CREATE CONSTRAINT TRIGGER dealer_price_conversion_valid
AFTER INSERT OR UPDATE OR DELETE ON product_unit_conversions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_dealer_product_unit_price();
CREATE CONSTRAINT TRIGGER dealer_price_base_unit_valid
AFTER UPDATE OF base_unit_id ON products DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_dealer_product_unit_price();

CREATE FUNCTION require_dealer_price_for_orderable_product() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid BIGINT;
BEGIN
 IF TG_TABLE_NAME='products' THEN pid:=NEW.id;
 ELSIF TG_OP='DELETE' THEN pid:=OLD.product_id;
 ELSE pid:=NEW.product_id; END IF;
 IF EXISTS(SELECT 1 FROM products p WHERE p.id=pid AND p.available_for_dealer_ordering=TRUE)
   AND NOT EXISTS(SELECT 1 FROM dealer_product_unit_prices d WHERE d.product_id=pid)
 THEN RAISE EXCEPTION 'dealer ordering requires at least one explicit unit price' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE CONSTRAINT TRIGGER orderable_product_has_price
AFTER INSERT OR UPDATE ON products DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_dealer_price_for_orderable_product();
CREATE CONSTRAINT TRIGGER orderable_dealer_price_remains
AFTER INSERT OR UPDATE OR DELETE ON dealer_product_unit_prices DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_dealer_price_for_orderable_product();

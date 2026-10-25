-- Inventory adjustments and automatic stock posting for inventory documents.
-- inventory_balances remains a derived, trigger-maintained projection of stock_movements.

CREATE TABLE stock_adjustments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled','reversed')),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  idempotency_key VARCHAR(120) NOT NULL UNIQUE,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  adjustment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_adjustments_store_date_idx ON stock_adjustments(store_id, adjustment_date DESC);

CREATE TABLE stock_adjustment_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  adjustment_id BIGINT NOT NULL REFERENCES stock_adjustments(id) ON DELETE RESTRICT,
  line_number INTEGER NOT NULL CHECK(line_number > 0),
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  unit_id BIGINT NOT NULL REFERENCES units_of_measure(id) ON DELETE RESTRICT,
  quantity NUMERIC(18,4) NOT NULL CHECK(quantity > 0),
  direction VARCHAR(8) NOT NULL CHECK(direction IN ('increase','decrease')),
  UNIQUE(adjustment_id, line_number)
);
CREATE INDEX stock_adjustment_product_idx ON stock_adjustment_items(product_id, adjustment_id);

CREATE FUNCTION guard_stock_adjustment_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'adjustments must be created as drafts' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_adjustment_insert_draft BEFORE INSERT ON stock_adjustments FOR EACH ROW EXECUTE FUNCTION guard_stock_adjustment_insert();
CREATE TRIGGER stock_adjustment_lifecycle BEFORE UPDATE ON stock_adjustments FOR EACH ROW EXECUTE FUNCTION guard_billing_document_update();
CREATE TRIGGER stock_adjustment_no_delete BEFORE DELETE ON stock_adjustments FOR EACH ROW EXECUTE FUNCTION block_posted_document_delete();

CREATE FUNCTION guard_stock_adjustment_item_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status TEXT; parent_id BIGINT;
BEGIN
  parent_id := CASE WHEN TG_OP='DELETE' THEN OLD.adjustment_id ELSE NEW.adjustment_id END;
  SELECT status INTO parent_status FROM stock_adjustments WHERE id=parent_id FOR UPDATE;
  IF parent_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'adjustment lines can only be changed while the document is a draft' USING ERRCODE='23514'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER stock_adjustment_item_draft_only BEFORE INSERT OR UPDATE OR DELETE ON stock_adjustment_items FOR EACH ROW EXECUTE FUNCTION guard_stock_adjustment_item_write();

-- Convert quantities from their entered unit to the product's shared base unit.
CREATE FUNCTION product_quantity_in_base(p_product BIGINT, p_unit BIGINT, p_quantity NUMERIC) RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE base_unit BIGINT; factor NUMERIC;
BEGIN
  SELECT base_unit_id INTO base_unit FROM products WHERE id=p_product;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown product %', p_product USING ERRCODE='23503'; END IF;
  IF p_unit=base_unit THEN RETURN p_quantity; END IF;
  SELECT factor_to_base INTO factor FROM product_unit_conversions WHERE product_id=p_product AND unit_id=p_unit;
  IF factor IS NULL THEN RAISE EXCEPTION 'missing unit conversion for product %, unit %', p_product, p_unit USING ERRCODE='23514'; END IF;
  RETURN p_quantity * factor;
END $$;

CREATE FUNCTION post_stock_document() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line RECORD; delta NUMERIC(18,4); source_label TEXT; line_table TEXT; parent_column TEXT;
        source_store BIGINT; movement_label TEXT; expected_lines BIGINT; valid_lines BIGINT;
        source_quantity NUMERIC; returned_quantity NUMERIC;
BEGIN
  IF OLD.status=NEW.status THEN RETURN NEW; END IF;
  IF NEW.status='posted' AND OLD.status='draft' THEN
    IF TG_TABLE_NAME='purchase_invoices' THEN source_label:='purchase_invoice'; line_table:='purchase_invoice_items'; parent_column:='purchase_invoice_id';
    ELSIF TG_TABLE_NAME='sales_invoices' THEN source_label:='sales_invoice'; line_table:='sales_invoice_items'; parent_column:='sales_invoice_id';
    ELSIF TG_TABLE_NAME='sales_returns' THEN source_label:='sales_return'; line_table:='sales_return_items'; parent_column:='sales_return_id';
    ELSIF TG_TABLE_NAME='purchase_returns' THEN source_label:='purchase_return'; line_table:='purchase_return_items'; parent_column:='purchase_return_id';
    ELSIF TG_TABLE_NAME='stock_adjustments' THEN source_label:='stock_adjustment'; line_table:='stock_adjustment_items'; parent_column:='adjustment_id';
    ELSIF TG_TABLE_NAME='stock_transfers' THEN source_label:='stock_transfer'; line_table:='stock_transfer_items'; parent_column:='transfer_id';
    ELSE RAISE EXCEPTION 'unsupported stock document %', TG_TABLE_NAME; END IF;
    IF TG_TABLE_NAME='sales_returns' THEN
      IF NOT EXISTS(SELECT 1 FROM sales_invoices WHERE id=NEW.sales_invoice_id AND store_id=NEW.store_id AND status='posted') THEN
        RAISE EXCEPTION 'sales return must reference a posted invoice in the same store' USING ERRCODE='23514';
      END IF;
      PERFORM 1 FROM sales_invoices WHERE id=NEW.sales_invoice_id FOR UPDATE;
      SELECT count(*) INTO expected_lines FROM sales_return_items WHERE sales_return_id=NEW.id;
      SELECT count(*) INTO valid_lines FROM sales_return_items ri JOIN sales_invoice_items si ON si.id=ri.sales_invoice_item_id AND si.product_id=ri.product_id WHERE ri.sales_return_id=NEW.id;
      IF expected_lines=0 OR expected_lines<>valid_lines THEN RAISE EXCEPTION 'sales return lines must reference their original product lines' USING ERRCODE='23514'; END IF;
      FOR line IN SELECT ri.*, si.unit_id FROM sales_return_items ri JOIN sales_invoice_items si ON si.id=ri.sales_invoice_item_id WHERE ri.sales_return_id=NEW.id ORDER BY ri.id LOOP
        SELECT si.quantity,COALESCE(SUM(ri.quantity) FILTER (WHERE sr.status='posted'),0) INTO source_quantity,returned_quantity FROM sales_invoice_items si
          LEFT JOIN sales_return_items ri ON ri.sales_invoice_item_id=si.id LEFT JOIN sales_returns sr ON sr.id=ri.sales_return_id
          WHERE si.id=line.sales_invoice_item_id GROUP BY si.quantity;
        IF returned_quantity>source_quantity THEN RAISE EXCEPTION 'sales returns exceed the invoiced quantity for line %',line.sales_invoice_item_id USING ERRCODE='23514'; END IF;
        delta := product_quantity_in_base(line.product_id,line.unit_id,line.quantity);
        INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by)
        VALUES(NEW.store_id,line.product_id,'sales_return',delta,source_label,NEW.id,line.id,source_label||':'||NEW.id||':'||line.id,NEW.created_by);
      END LOOP;
      RETURN NEW;
    ELSIF TG_TABLE_NAME='purchase_returns' THEN
      IF NOT EXISTS(SELECT 1 FROM purchase_invoices WHERE id=NEW.purchase_invoice_id AND store_id=NEW.store_id AND status='posted') THEN
        RAISE EXCEPTION 'purchase return must reference a posted invoice in the same store' USING ERRCODE='23514';
      END IF;
      PERFORM 1 FROM purchase_invoices WHERE id=NEW.purchase_invoice_id FOR UPDATE;
      SELECT count(*) INTO expected_lines FROM purchase_return_items WHERE purchase_return_id=NEW.id;
      SELECT count(*) INTO valid_lines FROM purchase_return_items ri JOIN purchase_invoice_items pi ON pi.id=ri.purchase_invoice_item_id AND pi.product_id=ri.product_id WHERE ri.purchase_return_id=NEW.id;
      IF expected_lines=0 OR expected_lines<>valid_lines THEN RAISE EXCEPTION 'purchase return lines must reference their original product lines' USING ERRCODE='23514'; END IF;
      FOR line IN SELECT ri.*, pi.unit_id FROM purchase_return_items ri JOIN purchase_invoice_items pi ON pi.id=ri.purchase_invoice_item_id WHERE ri.purchase_return_id=NEW.id ORDER BY ri.id LOOP
        SELECT pi.quantity,COALESCE(SUM(ri.quantity) FILTER (WHERE pr.status='posted'),0) INTO source_quantity,returned_quantity FROM purchase_invoice_items pi
          LEFT JOIN purchase_return_items ri ON ri.purchase_invoice_item_id=pi.id LEFT JOIN purchase_returns pr ON pr.id=ri.purchase_return_id
          WHERE pi.id=line.purchase_invoice_item_id GROUP BY pi.quantity;
        IF returned_quantity>source_quantity THEN RAISE EXCEPTION 'purchase returns exceed the invoiced quantity for line %',line.purchase_invoice_item_id USING ERRCODE='23514'; END IF;
        delta := -product_quantity_in_base(line.product_id,line.unit_id,line.quantity);
        INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by)
        VALUES(NEW.store_id,line.product_id,'purchase_return',delta,source_label,NEW.id,line.id,source_label||':'||NEW.id||':'||line.id,NEW.created_by);
      END LOOP;
      RETURN NEW;
    END IF;
    FOR line IN EXECUTE format('SELECT * FROM %I WHERE %I=$1 ORDER BY line_number,id',line_table,parent_column) USING NEW.id LOOP
      delta := product_quantity_in_base(line.product_id,line.unit_id,line.quantity);
      IF TG_TABLE_NAME IN ('sales_invoices','purchase_returns') THEN delta := -delta; END IF;
      IF TG_TABLE_NAME='stock_adjustments' THEN
        IF line.direction='decrease' THEN delta := -delta; END IF;
      END IF;
      IF TG_TABLE_NAME='stock_transfers' THEN
        INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by)
        VALUES(NEW.from_store_id,line.product_id,'transfer_out',-delta,source_label,NEW.id,line.id,'transfer:'||NEW.id||':'||line.id||':out',NEW.created_by);
        INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by)
        VALUES(NEW.to_store_id,line.product_id,'transfer_in',delta,source_label,NEW.id,line.id,'transfer:'||NEW.id||':'||line.id||':in',NEW.created_by);
      ELSE
        source_store := NEW.store_id;
        movement_label := CASE WHEN TG_TABLE_NAME='stock_adjustments' THEN 'adjustment' WHEN TG_TABLE_NAME='sales_invoices' THEN 'sale' WHEN TG_TABLE_NAME='purchase_invoices' THEN 'purchase' WHEN TG_TABLE_NAME='sales_returns' THEN 'sales_return' ELSE 'purchase_return' END;
        INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by)
        VALUES(source_store,line.product_id,movement_label,delta,source_label,NEW.id,line.id,source_label||':'||NEW.id||':'||line.id,NEW.created_by);
      END IF;
    END LOOP;
  ELSIF NEW.status='reversed' AND OLD.status='posted' THEN
    source_label := CASE TG_TABLE_NAME WHEN 'purchase_invoices' THEN 'purchase_invoice' WHEN 'sales_invoices' THEN 'sales_invoice' WHEN 'sales_returns' THEN 'sales_return' WHEN 'purchase_returns' THEN 'purchase_return' WHEN 'stock_transfers' THEN 'stock_transfer' ELSE 'stock_adjustment' END;
    FOR line IN SELECT * FROM stock_movements WHERE source_type=source_label AND source_id=NEW.id ORDER BY id LOOP
      INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,reversal_of_id,idempotency_key,created_by)
      VALUES(line.store_id,line.product_id,'reversal',-line.quantity_delta,'document_reversal',NEW.id,line.id,line.id,'reversal:'||line.id,NEW.created_by);
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER purchase_invoice_stock_post AFTER UPDATE OF status ON purchase_invoices FOR EACH ROW EXECUTE FUNCTION post_stock_document();
CREATE TRIGGER sales_invoice_stock_post AFTER UPDATE OF status ON sales_invoices FOR EACH ROW EXECUTE FUNCTION post_stock_document();
CREATE TRIGGER sales_return_stock_post AFTER UPDATE OF status ON sales_returns FOR EACH ROW EXECUTE FUNCTION post_stock_document();
CREATE TRIGGER purchase_return_stock_post AFTER UPDATE OF status ON purchase_returns FOR EACH ROW EXECUTE FUNCTION post_stock_document();
CREATE TRIGGER stock_transfer_stock_post AFTER UPDATE OF status ON stock_transfers FOR EACH ROW EXECUTE FUNCTION post_stock_document();
CREATE TRIGGER stock_adjustment_stock_post AFTER UPDATE OF status ON stock_adjustments FOR EACH ROW EXECUTE FUNCTION post_stock_document();

CREATE INDEX stock_movements_created_at_idx ON stock_movements(created_at DESC);
CREATE INDEX inventory_balances_product_idx ON inventory_balances(product_id, store_id);

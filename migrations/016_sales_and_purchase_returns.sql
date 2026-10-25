-- Return workflows extend the existing return documents and retain invoice links.
ALTER TABLE sales_returns
  ADD COLUMN reason TEXT,
  ADD COLUMN notes TEXT,
  ADD COLUMN approved_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN approved_at TIMESTAMPTZ,
  ADD COLUMN refund_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
  ADD COLUMN customer_credit NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (customer_credit >= 0),
  ADD COLUMN tax_adjustment NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (tax_adjustment >= 0),
  ADD COLUMN refund_method VARCHAR(24) CHECK (refund_method IN ('cash','upi','card','bank_transfer','cheque','other')),
  ADD COLUMN refund_reference VARCHAR(120),
  ADD COLUMN idempotency_key VARCHAR(120);
CREATE UNIQUE INDEX sales_returns_request_key_idx ON sales_returns(idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE sales_return_items
  ADD COLUMN reason TEXT,
  ADD COLUMN product_condition VARCHAR(24) NOT NULL DEFAULT 'resalable' CHECK (product_condition IN ('resalable','damaged','unsuitable')),
  ADD COLUMN restock_quantity NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (restock_quantity >= 0),
  ADD COLUMN quarantined_quantity NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (quarantined_quantity >= 0),
  ADD COLUMN supplier_return_pending_quantity NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (supplier_return_pending_quantity >= 0),
  ADD COLUMN tax_rate NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  ADD COLUMN tax_adjustment NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (tax_adjustment >= 0);
-- Preserve the existing behavior of historical sales returns, whose posted quantities were fully restocked.
ALTER TABLE sales_return_items DISABLE TRIGGER sales_return_item_draft_only;
UPDATE sales_return_items SET restock_quantity=quantity WHERE restock_quantity=0 AND quarantined_quantity=0 AND supplier_return_pending_quantity=0;
ALTER TABLE sales_return_items ENABLE TRIGGER sales_return_item_draft_only;
ALTER TABLE sales_return_items ADD CONSTRAINT sales_return_item_disposition_total CHECK (restock_quantity + quarantined_quantity + supplier_return_pending_quantity = quantity);
ALTER TABLE purchase_returns
  ADD COLUMN reason TEXT,
  ADD COLUMN notes TEXT,
  ADD COLUMN supplier_credit NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (supplier_credit >= 0),
  ADD COLUMN tax_adjustment NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (tax_adjustment >= 0),
  ADD COLUMN idempotency_key VARCHAR(120);
CREATE UNIQUE INDEX purchase_returns_request_key_idx ON purchase_returns(idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE purchase_return_items
  ADD COLUMN reason TEXT,
  ADD COLUMN tax_rate NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  ADD COLUMN tax_adjustment NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (tax_adjustment >= 0);
ALTER TABLE sales_returns DISABLE TRIGGER sales_return_lifecycle;
ALTER TABLE purchase_returns DISABLE TRIGGER purchase_return_lifecycle;
UPDATE sales_returns SET customer_credit=total WHERE customer_credit=0 AND refund_amount=0;
UPDATE purchase_returns SET supplier_credit=total WHERE supplier_credit=0;
ALTER TABLE sales_returns ENABLE TRIGGER sales_return_lifecycle;
ALTER TABLE purchase_returns ENABLE TRIGGER purchase_return_lifecycle;

-- An approval freezes the sales return draft until it is posted or cancelled.
CREATE FUNCTION guard_return_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approved_at IS NOT NULL AND OLD.status='draft' AND NEW.status='draft' AND
     (to_jsonb(NEW)-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at') THEN
    RAISE EXCEPTION 'approved return is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.approved_at IS NOT NULL AND NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION 'return approval cannot be changed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_return_approval_guard BEFORE UPDATE ON sales_returns FOR EACH ROW EXECUTE FUNCTION guard_return_approval();

CREATE OR REPLACE FUNCTION guard_return_item_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id BIGINT; parent_status TEXT; approved_at_value TIMESTAMPTZ;
BEGIN
  parent_id := CASE WHEN TG_OP='DELETE' THEN OLD.sales_return_id ELSE NEW.sales_return_id END;
  SELECT status,approved_at INTO parent_status,approved_at_value FROM sales_returns WHERE id=parent_id FOR UPDATE;
  IF parent_status IS DISTINCT FROM 'draft' OR approved_at_value IS NOT NULL THEN
    RAISE EXCEPTION 'return lines can only be changed before approval' USING ERRCODE='23514';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER sales_return_item_draft_only ON sales_return_items;
CREATE TRIGGER sales_return_item_draft_only BEFORE INSERT OR UPDATE OR DELETE ON sales_return_items FOR EACH ROW EXECUTE FUNCTION guard_return_item_write();

-- Replace the generic sales-return stock hook: only approved restock quantities enter sellable inventory.
DROP TRIGGER sales_return_stock_post ON sales_returns;
CREATE FUNCTION post_sales_return_stock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line RECORD; source_quantity NUMERIC; returned_quantity NUMERIC;
BEGIN
  IF OLD.status=NEW.status THEN RETURN NEW; END IF;
  IF OLD.status='draft' AND NEW.status='posted' THEN
    IF NEW.approved_at IS NULL OR NEW.approved_by IS NULL THEN
      RAISE EXCEPTION 'sales return must be approved before posting' USING ERRCODE='23514';
    END IF;
    PERFORM 1 FROM sales_invoices WHERE id=NEW.sales_invoice_id AND store_id=NEW.store_id AND status='posted' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'sales return must reference a posted invoice in the same store' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS(SELECT 1 FROM sales_return_items WHERE sales_return_id=NEW.id) THEN RAISE EXCEPTION 'sales return requires at least one item' USING ERRCODE='23514'; END IF;
    FOR line IN
      SELECT ri.*,si.quantity AS invoiced_quantity,si.unit_id,si.unit_price AS original_price,
             COALESCE((SELECT sum(x.quantity) FROM sales_return_items x JOIN sales_returns xr ON xr.id=x.sales_return_id
                       WHERE x.sales_invoice_item_id=si.id AND xr.status='posted'),0) AS previously_returned
      FROM sales_return_items ri JOIN sales_invoice_items si ON si.id=ri.sales_invoice_item_id AND si.sales_invoice_id=NEW.sales_invoice_id AND si.product_id=ri.product_id
      WHERE ri.sales_return_id=NEW.id ORDER BY ri.id
    LOOP
      IF line.previously_returned + line.quantity > line.invoiced_quantity THEN
        RAISE EXCEPTION 'sales return quantity exceeds the remaining invoiced quantity for line %',line.sales_invoice_item_id USING ERRCODE='23514';
      END IF;
      IF line.restock_quantity > 0 THEN
        INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by)
        VALUES(NEW.store_id,line.product_id,'sales_return',product_quantity_in_base(line.product_id,line.unit_id,line.restock_quantity),
          'sales_return',NEW.id,line.id,'sales_return:'||NEW.id||':'||line.id,NEW.created_by);
      END IF;
    END LOOP;
  ELSIF OLD.status='posted' AND NEW.status='reversed' THEN
    INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,reversal_of_id,idempotency_key,created_by)
    SELECT sm.store_id,sm.product_id,'reversal',-sm.quantity_delta,'document_reversal',NEW.id,sm.id,sm.id,'reversal:'||sm.id,NEW.created_by
    FROM stock_movements sm WHERE sm.source_type='sales_return' AND sm.source_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_return_stock_post AFTER UPDATE OF status ON sales_returns FOR EACH ROW EXECUTE FUNCTION post_sales_return_stock();

-- A purchase return can only credit quantities that were actually received into this store.
CREATE FUNCTION validate_purchase_return_received_quantity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line RECORD; already_returned NUMERIC; quantity_received NUMERIC;
BEGIN
  IF OLD.status='draft' AND NEW.status='posted' THEN
    PERFORM 1 FROM purchase_invoices WHERE id=NEW.purchase_invoice_id AND store_id=NEW.store_id AND status='posted' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'purchase return must reference a posted invoice in the same store' USING ERRCODE='23514'; END IF;
    FOR line IN SELECT ri.*,pi.quantity AS ordered_quantity FROM purchase_return_items ri
      JOIN purchase_invoice_items pi ON pi.id=ri.purchase_invoice_item_id AND pi.purchase_invoice_id=NEW.purchase_invoice_id
      WHERE ri.purchase_return_id=NEW.id ORDER BY ri.id
    LOOP
      SELECT COALESCE(sum(pri.quantity_received) FILTER(WHERE pr.status='posted'),0) INTO quantity_received
      FROM purchase_receipt_items pri JOIN purchase_receipts pr ON pr.id=pri.receipt_id WHERE pri.purchase_invoice_item_id=line.purchase_invoice_item_id;
      SELECT COALESCE(sum(pri.quantity),0) INTO already_returned FROM purchase_return_items pri
      JOIN purchase_returns pr ON pr.id=pri.purchase_return_id WHERE pri.purchase_invoice_item_id=line.purchase_invoice_item_id AND pr.status='posted';
      IF already_returned+line.quantity>quantity_received THEN
        RAISE EXCEPTION 'purchase return quantity exceeds received quantity for line %',line.purchase_invoice_item_id USING ERRCODE='23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_return_received_quantity_guard BEFORE UPDATE OF status ON purchase_returns FOR EACH ROW EXECUTE FUNCTION validate_purchase_return_received_quantity();

CREATE INDEX sales_return_invoice_status_idx ON sales_returns(sales_invoice_id,status);
CREATE INDEX purchase_return_invoice_status_idx ON purchase_returns(purchase_invoice_id,status);
CREATE INDEX sales_return_item_line_idx ON sales_return_items(sales_invoice_item_id);
CREATE INDEX purchase_return_item_line_idx ON purchase_return_items(purchase_invoice_item_id);

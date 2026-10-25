-- Purchase accounting documents and explicit partial goods receipts.
ALTER TABLE purchase_invoices
  ADD COLUMN freight_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (freight_amount >= 0),
  ADD COLUMN additional_charges NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (additional_charges >= 0),
  ADD COLUMN round_off NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (round_off BETWEEN -1000000 AND 1000000),
  ADD CONSTRAINT purchase_invoice_id_store_unique UNIQUE(id,store_id);
ALTER TABLE payments ADD COLUMN purchase_request_key VARCHAR(120) UNIQUE;
ALTER TABLE purchase_invoice_items
  ADD COLUMN taxable_value NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(taxable_value >= 0),
  ADD COLUMN product_sku_snapshot VARCHAR(80),
  ADD COLUMN product_name_snapshot VARCHAR(200),
  ADD COLUMN hsn_code_snapshot VARCHAR(16),
  ADD COLUMN product_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN unit_code_snapshot VARCHAR(24),
  ADD COLUMN unit_name_snapshot VARCHAR(80),
  ADD COLUMN conversion_factor_to_base NUMERIC(18,8) NOT NULL DEFAULT 1 CHECK(conversion_factor_to_base>0),
  ADD CONSTRAINT purchase_item_taxable_value_check CHECK(taxable_value=round(quantity*unit_price,2)-discount_amount) NOT VALID,
  ADD CONSTRAINT purchase_item_tax_amount_check CHECK(tax_amount=round(taxable_value*tax_rate/100,2)) NOT VALID,
  ADD CONSTRAINT purchase_item_total_check CHECK(line_total=taxable_value+tax_amount) NOT VALID;
UPDATE purchase_invoice_items pii SET conversion_factor_to_base=CASE WHEN pii.unit_id=p.base_unit_id THEN 1 ELSE COALESCE(
  (SELECT c.factor_to_base FROM product_unit_conversions c WHERE c.product_id=p.id AND c.unit_id=pii.unit_id),1) END
FROM products p WHERE p.id=pii.product_id;

CREATE TABLE purchase_receipts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_invoice_id BIGINT NOT NULL,
  store_id BIGINT NOT NULL,
  receipt_number VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','cancelled','reversed')),
  receipt_date DATE NOT NULL DEFAULT CURRENT_DATE,
  idempotency_key VARCHAR(120) NOT NULL UNIQUE,
  notes TEXT,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(purchase_invoice_id,store_id) REFERENCES purchase_invoices(id,store_id) ON DELETE RESTRICT,
  UNIQUE(store_id,receipt_number)
);
CREATE INDEX purchase_receipts_invoice_idx ON purchase_receipts(purchase_invoice_id,receipt_date,id);
CREATE TABLE purchase_receipt_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id BIGINT NOT NULL REFERENCES purchase_receipts(id) ON DELETE RESTRICT,
  purchase_invoice_item_id BIGINT NOT NULL REFERENCES purchase_invoice_items(id) ON DELETE RESTRICT,
  quantity_received NUMERIC(18,4) NOT NULL CHECK(quantity_received > 0),
  UNIQUE(receipt_id,purchase_invoice_item_id)
);
CREATE INDEX purchase_receipt_item_invoice_line_idx ON purchase_receipt_items(purchase_invoice_item_id,receipt_id);

CREATE SEQUENCE purchase_payment_number_seq;

-- A purchase invoice records the supplier's bill. Inventory is posted only from explicit receipt documents.
DROP TRIGGER IF EXISTS purchase_invoice_stock_post ON purchase_invoices;

CREATE FUNCTION validate_purchase_invoice_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_count BIGINT; calc_subtotal NUMERIC(18,2); calc_discount NUMERIC(18,2); calc_tax NUMERIC(18,2); calc_total NUMERIC(18,2);
BEGIN
  IF OLD.status='draft' AND NEW.status='posted' THEN
    SELECT count(*),COALESCE(sum(round(quantity*unit_price,2)),0),COALESCE(sum(discount_amount),0),
      COALESCE(sum(tax_amount),0),COALESCE(sum(line_total),0)
    INTO line_count,calc_subtotal,calc_discount,calc_tax,calc_total FROM purchase_invoice_items WHERE purchase_invoice_id=NEW.id;
    IF line_count>0 AND (NEW.subtotal<>calc_subtotal OR NEW.discount_total<>calc_discount OR NEW.tax_total<>calc_tax OR
      NEW.total<>calc_total+NEW.freight_amount+NEW.additional_charges+NEW.round_off) THEN
      RAISE EXCEPTION 'purchase invoice totals do not match its item calculations' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_invoice_totals_valid BEFORE UPDATE OF status ON purchase_invoices FOR EACH ROW EXECUTE FUNCTION validate_purchase_invoice_posting();

CREATE FUNCTION guard_purchase_receipt_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status<>'draft' THEN RAISE EXCEPTION 'purchase receipts must be created as drafts' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_receipt_insert_draft BEFORE INSERT ON purchase_receipts FOR EACH ROW EXECUTE FUNCTION guard_purchase_receipt_insert();
CREATE TRIGGER purchase_receipt_lifecycle BEFORE UPDATE ON purchase_receipts FOR EACH ROW EXECUTE FUNCTION guard_billing_document_update();
CREATE TRIGGER purchase_receipt_no_delete BEFORE DELETE ON purchase_receipts FOR EACH ROW EXECUTE FUNCTION block_posted_document_delete();

CREATE FUNCTION guard_purchase_receipt_item_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt_status TEXT; target_id BIGINT;
BEGIN
  target_id:=CASE WHEN TG_OP='DELETE' THEN OLD.receipt_id ELSE NEW.receipt_id END;
  SELECT status INTO receipt_status FROM purchase_receipts WHERE id=target_id FOR UPDATE;
  IF receipt_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'receipt lines can only be changed while the receipt is a draft' USING ERRCODE='23514'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER purchase_receipt_item_draft_only BEFORE INSERT OR UPDATE OR DELETE ON purchase_receipt_items FOR EACH ROW EXECUTE FUNCTION guard_purchase_receipt_item_write();

CREATE FUNCTION post_purchase_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line RECORD; total_received NUMERIC(18,4); expected_lines BIGINT; valid_lines BIGINT;
BEGIN
  IF OLD.status=NEW.status THEN RETURN NEW; END IF;
  IF NEW.status='posted' AND OLD.status='draft' THEN
    PERFORM 1 FROM purchase_invoices WHERE id=NEW.purchase_invoice_id AND store_id=NEW.store_id AND status='posted' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'goods can only be received against a posted purchase invoice' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS(SELECT 1 FROM purchase_receipt_items WHERE receipt_id=NEW.id) THEN RAISE EXCEPTION 'receipt must have at least one item' USING ERRCODE='23514'; END IF;
    SELECT count(*) INTO expected_lines FROM purchase_receipt_items WHERE receipt_id=NEW.id;
    SELECT count(*) INTO valid_lines FROM purchase_receipt_items pri JOIN purchase_invoice_items pii ON pii.id=pri.purchase_invoice_item_id
      WHERE pri.receipt_id=NEW.id AND pii.purchase_invoice_id=NEW.purchase_invoice_id;
    IF expected_lines<>valid_lines THEN RAISE EXCEPTION 'receipt items must belong to the selected purchase invoice' USING ERRCODE='23514'; END IF;
    FOR line IN SELECT pri.*,pii.product_id,pii.unit_id,pii.conversion_factor_to_base,pii.quantity AS invoice_quantity
      FROM purchase_receipt_items pri JOIN purchase_invoice_items pii ON pii.id=pri.purchase_invoice_item_id
      WHERE pri.receipt_id=NEW.id AND pii.purchase_invoice_id=NEW.purchase_invoice_id ORDER BY pii.id LOOP
      SELECT COALESCE(SUM(pri2.quantity_received) FILTER(WHERE pr.status='posted'),0) INTO total_received
        FROM purchase_receipt_items pri2 JOIN purchase_receipts pr ON pr.id=pri2.receipt_id
        WHERE pri2.purchase_invoice_item_id=line.purchase_invoice_item_id;
      IF total_received>line.invoice_quantity THEN RAISE EXCEPTION 'received quantity exceeds invoice quantity for line %',line.purchase_invoice_item_id USING ERRCODE='23514'; END IF;
      INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by)
      VALUES(NEW.store_id,line.product_id,'purchase',(line.quantity_received*line.conversion_factor_to_base)::NUMERIC(18,4),
        'purchase_receipt',NEW.id,line.id,'purchase_receipt:'||NEW.id||':'||line.id,NEW.created_by);
    END LOOP;
  ELSIF NEW.status='reversed' AND OLD.status='posted' THEN
    FOR line IN SELECT * FROM stock_movements WHERE source_type='purchase_receipt' AND source_id=NEW.id ORDER BY id LOOP
      INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,reversal_of_id,idempotency_key,created_by)
      VALUES(line.store_id,line.product_id,'reversal',-line.quantity_delta,'purchase_rcpt_reversal',NEW.id,line.id,line.id,
        'purchase_receipt_reversal:'||line.id,NEW.created_by);
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_receipt_stock_post AFTER UPDATE OF status ON purchase_receipts FOR EACH ROW EXECUTE FUNCTION post_purchase_receipt();

CREATE INDEX purchase_invoice_supplier_date_idx ON purchase_invoices(supplier_id,invoice_date DESC);
CREATE INDEX purchase_invoice_status_store_idx ON purchase_invoices(store_id,status,invoice_date DESC);

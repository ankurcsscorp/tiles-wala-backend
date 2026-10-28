-- Extend existing return documents. No historical invoice/return amounts are rewritten.
ALTER TABLE sales_returns ADD COLUMN workflow_version SMALLINT NOT NULL DEFAULT 1,
 ADD COLUMN settlement_mode TEXT NOT NULL DEFAULT 'ADJUST' CHECK(settlement_mode IN ('ADJUST','CREDIT','REFUND')),
 ADD COLUMN adjusted_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(adjusted_amount>=0),
 ADD COLUMN unapplied_credit NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(unapplied_credit>=0),
 ADD COLUMN outstanding_before NUMERIC(18,2) NOT NULL DEFAULT 0,
 ADD COLUMN document_snapshot JSONB, ADD COLUMN finalization_key VARCHAR(120),
 ADD COLUMN request_fingerprint TEXT;
ALTER TABLE purchase_returns ADD COLUMN workflow_version SMALLINT NOT NULL DEFAULT 1,
 ADD COLUMN settlement_mode TEXT NOT NULL DEFAULT 'ADJUST' CHECK(settlement_mode IN ('ADJUST','CREDIT','REFUND')),
 ADD COLUMN adjusted_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(adjusted_amount>=0),
 ADD COLUMN unapplied_credit NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(unapplied_credit>=0),
 ADD COLUMN outstanding_before NUMERIC(18,2) NOT NULL DEFAULT 0,
 ADD COLUMN refund_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(refund_amount>=0),
 ADD COLUMN refund_method VARCHAR(24), ADD COLUMN refund_reference VARCHAR(120), ADD COLUMN refund_date DATE,
 ADD COLUMN supplier_credit_note_reference VARCHAR(120), ADD COLUMN supplier_credit_note_date DATE,
 ADD COLUMN document_snapshot JSONB, ADD COLUMN finalization_key VARCHAR(120), ADD COLUMN request_fingerprint TEXT;
ALTER TABLE sales_returns ADD COLUMN refund_date DATE;
ALTER TABLE sales_return_items ADD COLUMN taxable_adjustment NUMERIC(18,2),
 ADD COLUMN cgst_adjustment NUMERIC(18,2), ADD COLUMN sgst_adjustment NUMERIC(18,2), ADD COLUMN igst_adjustment NUMERIC(18,2),
 ADD COLUMN return_snapshot JSONB, ADD COLUMN conversion_factor_to_base NUMERIC(18,8), ADD COLUMN rate_change_reason TEXT;
ALTER TABLE purchase_return_items ADD COLUMN taxable_adjustment NUMERIC(18,2),
 ADD COLUMN cgst_adjustment NUMERIC(18,2), ADD COLUMN sgst_adjustment NUMERIC(18,2), ADD COLUMN igst_adjustment NUMERIC(18,2),
 ADD COLUMN return_snapshot JSONB, ADD COLUMN conversion_factor_to_base NUMERIC(18,8), ADD COLUMN rate_change_reason TEXT,
 ADD COLUMN stock_bucket TEXT NOT NULL DEFAULT 'SELLABLE' CHECK(stock_bucket IN ('SELLABLE','DAMAGED'));
ALTER TABLE payments ADD COLUMN sales_return_id BIGINT REFERENCES sales_returns(id) ON DELETE RESTRICT,
 ADD COLUMN purchase_return_id BIGINT REFERENCES purchase_returns(id) ON DELETE RESTRICT,
 ADD CONSTRAINT payment_return_refund_check CHECK(
 (sales_return_id IS NULL AND purchase_return_id IS NULL) OR
 (sales_return_id IS NOT NULL AND purchase_return_id IS NULL AND direction='out' AND customer_id IS NULL AND supplier_id IS NULL) OR
 (purchase_return_id IS NOT NULL AND sales_return_id IS NULL AND direction='in' AND customer_id IS NULL AND supplier_id IS NULL));
CREATE UNIQUE INDEX one_sales_return_refund ON payments(sales_return_id) WHERE sales_return_id IS NOT NULL;
CREATE UNIQUE INDEX one_purchase_return_refund ON payments(purchase_return_id) WHERE purchase_return_id IS NOT NULL;
CREATE TABLE return_credit_allocations(
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 store_id BIGINT NOT NULL REFERENCES stores(id),
 sales_return_id BIGINT REFERENCES sales_returns(id), purchase_return_id BIGINT REFERENCES purchase_returns(id),
 sales_invoice_id BIGINT REFERENCES sales_invoices(id), purchase_invoice_id BIGINT REFERENCES purchase_invoices(id),
 amount NUMERIC(18,2) NOT NULL CHECK(amount>0), created_by BIGINT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK((sales_return_id IS NOT NULL AND sales_invoice_id IS NOT NULL AND purchase_return_id IS NULL AND purchase_invoice_id IS NULL) OR
 (purchase_return_id IS NOT NULL AND purchase_invoice_id IS NOT NULL AND sales_return_id IS NULL AND sales_invoice_id IS NULL)),
 UNIQUE(sales_return_id,sales_invoice_id), UNIQUE(purchase_return_id,purchase_invoice_id));
CREATE INDEX return_credit_sales_invoice_idx ON return_credit_allocations(sales_invoice_id);
CREATE INDEX return_credit_purchase_invoice_idx ON return_credit_allocations(purchase_invoice_id);
CREATE VIEW sales_return_accounting AS SELECT r.id,r.store_id,r.sales_invoice_id,r.status,r.return_date,r.return_number,r.total,
 CASE WHEN r.workflow_version=1 THEN r.refund_amount ELSE COALESCE(p.amount,0) END::numeric(18,2) refund_amount,
 (r.total-CASE WHEN r.workflow_version=1 THEN r.refund_amount ELSE COALESCE(p.amount,0) END)::numeric(18,2) customer_credit,p.id AS refund_payment_id,p.payment_number AS refund_payment_number,p.payment_date AS refund_payment_date
 FROM sales_returns r LEFT JOIN payments p ON p.sales_return_id=r.id AND p.status='posted';
CREATE VIEW purchase_return_accounting AS SELECT r.id,r.store_id,r.purchase_invoice_id,r.status,r.return_date,r.return_number,r.total,
 COALESCE(p.amount,0)::numeric(18,2) refund_amount,(r.total-COALESCE(p.amount,0))::numeric(18,2) supplier_credit,p.id AS refund_payment_id,p.payment_number AS refund_payment_number,p.payment_date AS refund_payment_date
 FROM purchase_returns r LEFT JOIN payments p ON p.purchase_return_id=r.id AND p.status='posted';
CREATE VIEW sales_invoice_return_credits AS
 SELECT id,store_id,sales_invoice_id,status,customer_credit AS total,0::numeric AS refund_amount,customer_credit FROM sales_returns WHERE workflow_version=1
 UNION ALL SELECT r.id,r.store_id,a.sales_invoice_id,r.status,a.amount,0::numeric,a.amount FROM return_credit_allocations a JOIN sales_returns r ON r.id=a.sales_return_id;
CREATE VIEW purchase_invoice_return_credits AS
 SELECT id,store_id,purchase_invoice_id,status,total,supplier_credit FROM purchase_returns WHERE workflow_version=1
 UNION ALL SELECT r.id,r.store_id,a.purchase_invoice_id,r.status,a.amount,a.amount FROM return_credit_allocations a JOIN purchase_returns r ON r.id=a.purchase_return_id;
CREATE TABLE return_inventory_movements(
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, store_id BIGINT NOT NULL REFERENCES stores(id),product_id BIGINT NOT NULL REFERENCES products(id),
 sales_return_item_id BIGINT REFERENCES sales_return_items(id), purchase_return_item_id BIGINT REFERENCES purchase_return_items(id),
 bucket TEXT NOT NULL CHECK(bucket IN ('DAMAGED','PENDING_INSPECTION')),quantity_delta NUMERIC(18,4) NOT NULL CHECK(quantity_delta<>0),
 source_type TEXT NOT NULL,source_id BIGINT NOT NULL,idempotency_key VARCHAR(160) UNIQUE NOT NULL,
 reason TEXT NOT NULL,created_by BIGINT REFERENCES users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX return_inventory_balance_idx ON return_inventory_movements(store_id,product_id,bucket);
CREATE FUNCTION guard_return_inventory_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE available NUMERIC;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Return stock evidence is immutable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('return_bucket:'||NEW.store_id||':'||NEW.product_id||':'||NEW.bucket,0));
 SELECT COALESCE(sum(quantity_delta),0) INTO available FROM return_inventory_movements WHERE store_id=NEW.store_id AND product_id=NEW.product_id AND bucket=NEW.bucket;
 IF available+NEW.quantity_delta<0 THEN RAISE EXCEPTION 'Insufficient non-sellable inventory in %',NEW.bucket USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER return_inventory_guard BEFORE INSERT OR UPDATE OR DELETE ON return_inventory_movements FOR EACH ROW EXECUTE FUNCTION guard_return_inventory_movement();
CREATE FUNCTION immutable_return_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_store BIGINT;parent_party BIGINT;invoice_party BIGINT;credit NUMERIC;used NUMERIC;parent_status TEXT;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Return credit allocations are immutable' USING ERRCODE='23514'; END IF;
 IF NEW.sales_return_id IS NOT NULL THEN
  SELECT r.store_id,i.customer_id,r.customer_credit,r.status INTO parent_store,parent_party,credit,parent_status FROM sales_returns r JOIN sales_invoices i ON i.id=r.sales_invoice_id WHERE r.id=NEW.sales_return_id FOR UPDATE OF r;
  SELECT customer_id INTO invoice_party FROM sales_invoices WHERE id=NEW.sales_invoice_id AND store_id=NEW.store_id AND status='posted' FOR UPDATE;
  SELECT COALESCE(sum(amount),0) INTO used FROM return_credit_allocations WHERE sales_return_id=NEW.sales_return_id;
 ELSE
  SELECT r.store_id,i.supplier_id,r.supplier_credit,r.status INTO parent_store,parent_party,credit,parent_status FROM purchase_returns r JOIN purchase_invoices i ON i.id=r.purchase_invoice_id WHERE r.id=NEW.purchase_return_id FOR UPDATE OF r;
  SELECT supplier_id INTO invoice_party FROM purchase_invoices WHERE id=NEW.purchase_invoice_id AND store_id=NEW.store_id AND status='posted' FOR UPDATE;
  SELECT COALESCE(sum(amount),0) INTO used FROM return_credit_allocations WHERE purchase_return_id=NEW.purchase_return_id;
 END IF;
 IF parent_status IS DISTINCT FROM 'draft' OR parent_store IS DISTINCT FROM NEW.store_id OR parent_party IS DISTINCT FROM invoice_party OR invoice_party IS NULL OR used+NEW.amount>credit THEN
  RAISE EXCEPTION 'Return credit allocation exceeds available credit or crosses store/party boundaries' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER return_credit_guard BEFORE INSERT OR UPDATE OR DELETE ON return_credit_allocations FOR EACH ROW EXECUTE FUNCTION immutable_return_allocation();
-- Replace return-specific stock hooks only; the shared inventory ledger remains authoritative.
DROP TRIGGER sales_return_stock_post ON sales_returns;
DROP TRIGGER purchase_return_stock_post ON purchase_returns;
DROP TRIGGER purchase_return_received_quantity_guard ON purchase_returns;
CREATE FUNCTION post_return_invoice_stock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line RECORD;prior NUMERIC;eligible NUMERIC;factor NUMERIC;kind TEXT;original_id BIGINT;expected INTEGER;matched INTEGER;
BEGIN
 IF OLD.status=NEW.status THEN RETURN NEW; END IF;
 kind:=CASE TG_TABLE_NAME WHEN 'sales_returns' THEN 'sales_return' ELSE 'purchase_return' END;
 IF OLD.status='draft' AND NEW.status='posted' THEN
  IF kind='sales_return' THEN
   IF NEW.approved_at IS NULL OR NEW.approved_by IS NULL THEN RAISE EXCEPTION 'Sales return requires manager approval' USING ERRCODE='23514'; END IF;
   PERFORM 1 FROM sales_invoices WHERE id=NEW.sales_invoice_id AND store_id=NEW.store_id AND status='posted' FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Original sales invoice is not posted in this store' USING ERRCODE='23514'; END IF;
   SELECT count(*) INTO expected FROM sales_return_items WHERE sales_return_id=NEW.id;
   SELECT count(*) INTO matched FROM sales_return_items ri JOIN sales_invoice_items si ON si.id=ri.sales_invoice_item_id AND si.sales_invoice_id=NEW.sales_invoice_id AND si.product_id=ri.product_id WHERE ri.sales_return_id=NEW.id;
   IF expected=0 OR expected<>matched THEN RAISE EXCEPTION 'Invalid original sales return lines' USING ERRCODE='23514'; END IF;
   FOR line IN SELECT ri.*,si.quantity AS source_quantity,si.unit_id FROM sales_return_items ri JOIN sales_invoice_items si ON si.id=ri.sales_invoice_item_id WHERE ri.sales_return_id=NEW.id ORDER BY ri.product_id,ri.id LOOP
    SELECT COALESCE(sum(x.quantity),0) INTO prior FROM sales_return_items x JOIN sales_returns r ON r.id=x.sales_return_id WHERE x.sales_invoice_item_id=line.sales_invoice_item_id AND r.status='posted' AND r.id<>NEW.id;
    IF prior+line.quantity>line.source_quantity THEN RAISE EXCEPTION 'Sales return exceeds remaining quantity' USING ERRCODE='23514'; END IF;
    factor:=COALESCE(line.conversion_factor_to_base,product_quantity_in_base(line.product_id,line.unit_id,1));
    IF line.restock_quantity>0 THEN
     INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by)
     VALUES(NEW.store_id,line.product_id,'sales_return',round(line.restock_quantity*factor,4),kind,NEW.id,line.id,kind||':'||NEW.id||':'||line.id,NEW.created_by);
    END IF;
    IF line.quarantined_quantity>0 THEN
     INSERT INTO return_inventory_movements(store_id,product_id,sales_return_item_id,bucket,quantity_delta,source_type,source_id,idempotency_key,reason,created_by)
     VALUES(NEW.store_id,line.product_id,line.id,CASE WHEN line.product_condition='damaged' THEN 'DAMAGED' ELSE 'PENDING_INSPECTION' END,round(line.quarantined_quantity*factor,4),kind,NEW.id,kind||':'||NEW.id||':'||line.id||':quarantine',COALESCE(line.reason,'Returned goods'),NEW.created_by);
    END IF;
    IF line.supplier_return_pending_quantity>0 THEN
     INSERT INTO return_inventory_movements(store_id,product_id,sales_return_item_id,bucket,quantity_delta,source_type,source_id,idempotency_key,reason,created_by)
     VALUES(NEW.store_id,line.product_id,line.id,'PENDING_INSPECTION',round(line.supplier_return_pending_quantity*factor,4),kind,NEW.id,kind||':'||NEW.id||':'||line.id||':pending',COALESCE(line.reason,'Pending receipt/inspection'),NEW.created_by);
    END IF;
   END LOOP;
  ELSE
   PERFORM 1 FROM purchase_invoices WHERE id=NEW.purchase_invoice_id AND store_id=NEW.store_id AND status='posted' FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Original purchase invoice is not posted in this store' USING ERRCODE='23514'; END IF;
   SELECT count(*) INTO expected FROM purchase_return_items WHERE purchase_return_id=NEW.id;
   SELECT count(*) INTO matched FROM purchase_return_items ri JOIN purchase_invoice_items pi ON pi.id=ri.purchase_invoice_item_id AND pi.purchase_invoice_id=NEW.purchase_invoice_id AND pi.product_id=ri.product_id WHERE ri.purchase_return_id=NEW.id;
   IF expected=0 OR expected<>matched THEN RAISE EXCEPTION 'Invalid original purchase return lines' USING ERRCODE='23514'; END IF;
   FOR line IN SELECT ri.*,pi.quantity AS source_quantity,pi.unit_id FROM purchase_return_items ri JOIN purchase_invoice_items pi ON pi.id=ri.purchase_invoice_item_id WHERE ri.purchase_return_id=NEW.id ORDER BY ri.product_id,ri.id LOOP
    SELECT COALESCE(sum(x.quantity),0) INTO prior FROM purchase_return_items x JOIN purchase_returns r ON r.id=x.purchase_return_id WHERE x.purchase_invoice_item_id=line.purchase_invoice_item_id AND r.status='posted' AND r.id<>NEW.id;
    SELECT COALESCE(sum(x.quantity_received) FILTER(WHERE pr.status='posted'),0) INTO eligible FROM purchase_receipt_items x JOIN purchase_receipts pr ON pr.id=x.receipt_id WHERE x.purchase_invoice_item_id=line.purchase_invoice_item_id;
    IF prior+line.quantity>LEAST(eligible,line.source_quantity) THEN RAISE EXCEPTION 'Purchase return exceeds received/remaining quantity' USING ERRCODE='23514'; END IF;
    factor:=COALESCE(line.conversion_factor_to_base,product_quantity_in_base(line.product_id,line.unit_id,1));
    IF line.stock_bucket='DAMAGED' THEN
     INSERT INTO return_inventory_movements(store_id,product_id,purchase_return_item_id,bucket,quantity_delta,source_type,source_id,idempotency_key,reason,created_by)
     VALUES(NEW.store_id,line.product_id,line.id,'DAMAGED',-round(line.quantity*factor,4),kind,NEW.id,kind||':'||NEW.id||':'||line.id,COALESCE(line.reason,'Return to supplier'),NEW.created_by);
    ELSE
     INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,idempotency_key,created_by)
     VALUES(NEW.store_id,line.product_id,'purchase_return',-round(line.quantity*factor,4),kind,NEW.id,line.id,kind||':'||NEW.id||':'||line.id,NEW.created_by);
    END IF;
   END LOOP;
  END IF;
 ELSIF OLD.status='posted' AND NEW.status='reversed' THEN
  IF EXISTS(SELECT 1 FROM payments p WHERE (kind='sales_return' AND p.sales_return_id=NEW.id OR kind='purchase_return' AND p.purchase_return_id=NEW.id) AND p.status='posted') THEN RAISE EXCEPTION 'Reverse the recorded refund payment before reversing this return' USING ERRCODE='23514'; END IF;
  IF kind='sales_return' AND EXISTS(SELECT 1 FROM return_inventory_movements m JOIN sales_return_items ri ON ri.id=m.sales_return_item_id WHERE ri.sales_return_id=NEW.id AND m.source_type='return_inspection') THEN RAISE EXCEPTION 'Inspected stock requires a reviewed inventory correction before return reversal' USING ERRCODE='23514'; END IF;
  INSERT INTO stock_movements(store_id,product_id,movement_type,quantity_delta,source_type,source_id,source_line_id,reversal_of_id,idempotency_key,created_by)
   SELECT store_id,product_id,'reversal',-quantity_delta,'document_reversal',NEW.id,id,id,'reversal:'||id,NEW.created_by FROM stock_movements sm WHERE source_type=kind AND source_id=NEW.id;
  INSERT INTO return_inventory_movements(store_id,product_id,sales_return_item_id,purchase_return_item_id,bucket,quantity_delta,source_type,source_id,idempotency_key,reason,created_by)
   SELECT store_id,product_id,sales_return_item_id,purchase_return_item_id,bucket,-quantity_delta,'return_reversal',NEW.id,'reverse_bucket:'||id,'Return reversal',NEW.created_by FROM return_inventory_movements WHERE source_type=kind AND source_id=NEW.id ORDER BY id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sales_return_stock_post AFTER UPDATE OF status ON sales_returns FOR EACH ROW EXECUTE FUNCTION post_return_invoice_stock();
CREATE TRIGGER purchase_return_stock_post AFTER UPDATE OF status ON purchase_returns FOR EACH ROW EXECUTE FUNCTION post_return_invoice_stock();

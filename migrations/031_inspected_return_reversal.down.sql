DO $$ BEGIN IF EXISTS(SELECT 1 FROM sales_bonus_adjustments WHERE source_type='sales_return_reversal') THEN RAISE EXCEPTION 'Return reversal evidence is in use; use a forward correction'; END IF; END $$;
ALTER TABLE sales_bonus_adjustments DROP CONSTRAINT sales_bonus_adjustments_source_type_check;
ALTER TABLE sales_bonus_adjustments ADD CONSTRAINT sales_bonus_adjustments_source_type_check CHECK(source_type IN ('sales_return_item','invoice_reversal'));
CREATE OR REPLACE FUNCTION post_return_invoice_stock() RETURNS trigger LANGUAGE plpgsql AS $$
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

-- Repair stock posting for invoices whose item records have no adjustment direction.
-- Nested IF statements avoid resolving line.direction for sales and purchase items.
-- Replaces only the function; existing stock movements and balances remain intact.
CREATE OR REPLACE FUNCTION post_stock_document() RETURNS trigger LANGUAGE plpgsql AS $$
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

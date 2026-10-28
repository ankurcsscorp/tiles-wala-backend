-- Refuse destructive rollback once new return evidence has been used.
DO $$ BEGIN IF EXISTS(SELECT 1 FROM sales_returns WHERE workflow_version=2) OR EXISTS(SELECT 1 FROM purchase_returns WHERE workflow_version=2) OR EXISTS(SELECT 1 FROM return_inventory_movements) THEN RAISE EXCEPTION 'Export return/refund/credit evidence and use a forward correction; workflow 028 is in use'; END IF; END $$;
DROP TRIGGER sales_return_stock_post ON sales_returns; DROP TRIGGER purchase_return_stock_post ON purchase_returns;
DROP FUNCTION post_return_invoice_stock();
DROP VIEW sales_invoice_return_credits,purchase_invoice_return_credits,sales_return_accounting,purchase_return_accounting;
DROP TABLE return_credit_allocations,return_inventory_movements;
DROP FUNCTION immutable_return_allocation(),guard_return_inventory_movement();
ALTER TABLE payments DROP COLUMN sales_return_id,DROP COLUMN purchase_return_id;
ALTER TABLE sales_return_items DROP COLUMN taxable_adjustment,DROP COLUMN cgst_adjustment,DROP COLUMN sgst_adjustment,DROP COLUMN igst_adjustment,DROP COLUMN return_snapshot,DROP COLUMN conversion_factor_to_base,DROP COLUMN rate_change_reason;
ALTER TABLE purchase_return_items DROP COLUMN taxable_adjustment,DROP COLUMN cgst_adjustment,DROP COLUMN sgst_adjustment,DROP COLUMN igst_adjustment,DROP COLUMN return_snapshot,DROP COLUMN conversion_factor_to_base,DROP COLUMN rate_change_reason,DROP COLUMN stock_bucket;
ALTER TABLE sales_returns DROP COLUMN workflow_version,DROP COLUMN settlement_mode,DROP COLUMN adjusted_amount,DROP COLUMN unapplied_credit,DROP COLUMN outstanding_before,DROP COLUMN document_snapshot,DROP COLUMN finalization_key,DROP COLUMN request_fingerprint,DROP COLUMN refund_date;
ALTER TABLE purchase_returns DROP COLUMN workflow_version,DROP COLUMN settlement_mode,DROP COLUMN adjusted_amount,DROP COLUMN unapplied_credit,DROP COLUMN outstanding_before,DROP COLUMN refund_amount,DROP COLUMN refund_method,DROP COLUMN refund_reference,DROP COLUMN refund_date,DROP COLUMN supplier_credit_note_reference,DROP COLUMN supplier_credit_note_date,DROP COLUMN document_snapshot,DROP COLUMN finalization_key,DROP COLUMN request_fingerprint;
DROP FUNCTION post_sales_return_stock();
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


CREATE TRIGGER purchase_return_stock_post AFTER UPDATE OF status ON purchase_returns FOR EACH ROW EXECUTE FUNCTION post_stock_document();
CREATE TRIGGER purchase_return_received_quantity_guard BEFORE UPDATE OF status ON purchase_returns FOR EACH ROW EXECUTE FUNCTION validate_purchase_return_received_quantity();

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM sales_invoice_revisions WHERE revision_type='FINANCIAL') OR EXISTS(SELECT 1 FROM sales_bonus_adjustments WHERE source_type='invoice_revision') THEN
    RAISE EXCEPTION 'Cannot roll back migration 063 while financial invoice revisions exist';
  END IF;
  IF EXISTS(SELECT 1 FROM payment_allocation_reversals GROUP BY allocation_id HAVING count(*)>1) THEN RAISE EXCEPTION 'Cannot roll back migration 063 while allocations have multiple releases'; END IF;
END $$;
DROP INDEX payment_allocation_reversal_allocation_idx;
CREATE UNIQUE INDEX payment_allocation_reversal_once_idx ON payment_allocation_reversals(allocation_id);
ALTER TABLE sales_bonus_adjustments DROP CONSTRAINT sales_bonus_adjustments_source_type_check;
ALTER TABLE sales_bonus_adjustments ADD CONSTRAINT sales_bonus_adjustments_source_type_check CHECK(source_type IN ('sales_return_item','invoice_reversal','sales_return_reversal'));
CREATE OR REPLACE FUNCTION guard_billing_document_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_status TEXT; new_status TEXT; old_data JSONB; new_data JSONB;
BEGIN
  old_status:=OLD.status;new_status:=NEW.status;
  IF old_status='draft' THEN
    IF new_status NOT IN ('draft','posted','cancelled') THEN RAISE EXCEPTION 'invalid document transition: % to %',old_status,new_status USING ERRCODE='23514'; END IF;
    IF new_status='posted' AND NEW.posted_at IS NULL THEN RAISE EXCEPTION 'posted documents require posted_at' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF old_status='posted' AND new_status='cancelled' AND TG_TABLE_NAME='sales_invoices' THEN
    old_data:=to_jsonb(OLD)-'status'-'updated_at'-'cancellation_reason'-'cancellation_date'-'cancelled_by'-'duplicate_of_invoice_id'-'cancellation_remarks';
    new_data:=to_jsonb(NEW)-'status'-'updated_at'-'cancellation_reason'-'cancellation_date'-'cancelled_by'-'duplicate_of_invoice_id'-'cancellation_remarks';
    IF old_data<>new_data OR NEW.cancellation_reason IS NULL OR NEW.cancelled_by IS NULL OR NEW.cancellation_date IS NULL THEN RAISE EXCEPTION 'posted invoice cancellation requires immutable invoice data and complete cancellation metadata' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF old_status='posted' THEN
    IF new_status NOT IN ('posted','reversed') THEN RAISE EXCEPTION 'posted documents can only remain posted, be reversed, or be cancelled' USING ERRCODE='23514'; END IF;
    old_data:=to_jsonb(OLD)-'status'-'updated_at';new_data:=to_jsonb(NEW)-'status'-'updated_at';
    IF old_data<>new_data THEN RAISE EXCEPTION 'posted document fields are immutable' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF old_status IN ('cancelled','reversed') AND new_status<>old_status THEN RAISE EXCEPTION 'cancelled and reversed documents are terminal' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_billing_document_item_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status TEXT; parent_id BIGINT;
BEGIN
  IF TG_TABLE_NAME='sales_invoice_items' THEN
    parent_id:=CASE WHEN TG_OP='DELETE' THEN OLD.sales_invoice_id ELSE NEW.sales_invoice_id END;
    SELECT status INTO parent_status FROM sales_invoices WHERE id=parent_id FOR UPDATE;
  ELSIF TG_TABLE_NAME='purchase_invoice_items' THEN
    parent_id:=CASE WHEN TG_OP='DELETE' THEN OLD.purchase_invoice_id ELSE NEW.purchase_invoice_id END;
    SELECT status INTO parent_status FROM purchase_invoices WHERE id=parent_id FOR UPDATE;
  ELSIF TG_TABLE_NAME='sales_return_items' THEN
    parent_id:=CASE WHEN TG_OP='DELETE' THEN OLD.sales_return_id ELSE NEW.sales_return_id END;
    SELECT status INTO parent_status FROM sales_returns WHERE id=parent_id FOR UPDATE;
  ELSIF TG_TABLE_NAME='purchase_return_items' THEN
    parent_id:=CASE WHEN TG_OP='DELETE' THEN OLD.purchase_return_id ELSE NEW.purchase_return_id END;
    SELECT status INTO parent_status FROM purchase_returns WHERE id=parent_id FOR UPDATE;
  ELSE
    parent_id:=CASE WHEN TG_OP='DELETE' THEN OLD.transfer_id ELSE NEW.transfer_id END;
    SELECT status INTO parent_status FROM stock_transfers WHERE id=parent_id FOR UPDATE;
  END IF;
  IF parent_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'document lines can only be changed while the parent is a draft' USING ERRCODE='23514'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP FUNCTION sales_invoice_revision_authorized(BIGINT);
DROP TABLE sales_invoice_revision_contexts;
ALTER TABLE sales_invoice_revisions DROP COLUMN impact_snapshot;
ALTER TABLE sales_invoice_revisions DROP CONSTRAINT sales_invoice_revisions_revision_type_check;
ALTER TABLE sales_invoice_revisions ADD CONSTRAINT sales_invoice_revisions_revision_type_check CHECK(revision_type IN ('OPERATIONAL'));
ALTER TABLE sales_invoice_revisions ADD CONSTRAINT sales_invoice_revisions_financial_difference_check CHECK(financial_difference=0);
CREATE OR REPLACE FUNCTION validate_payment_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payments%ROWTYPE; inv_total NUMERIC(18,2); allocated NUMERIC(18,2);
BEGIN
  SELECT * INTO p FROM payments WHERE id=NEW.payment_id FOR UPDATE;
  IF p.status <> 'posted' THEN RAISE EXCEPTION 'payment must be posted before allocation' USING ERRCODE='23514'; END IF;
  IF NEW.direction='in' THEN
    SELECT total INTO inv_total FROM sales_invoices WHERE id=NEW.sales_invoice_id AND store_id=NEW.store_id AND status='posted' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'sales invoice must be posted in the same store' USING ERRCODE='23514'; END IF;
  ELSE
    SELECT total INTO inv_total FROM purchase_invoices WHERE id=NEW.purchase_invoice_id AND store_id=NEW.store_id AND status='posted' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'purchase invoice must be posted in the same store' USING ERRCODE='23514'; END IF;
  END IF;
  SELECT COALESCE(sum(a.amount-COALESCE(r.amount,0)),0) INTO allocated FROM payment_allocations a
    LEFT JOIN payment_allocation_reversals r ON r.allocation_id=a.id WHERE a.payment_id=NEW.payment_id AND a.id<>COALESCE(NEW.id,0);
  IF allocated + NEW.amount > p.amount THEN RAISE EXCEPTION 'allocations exceed payment amount' USING ERRCODE='23514'; END IF;
  IF NEW.direction='in' THEN
    SELECT COALESCE(sum(a.amount-COALESCE(r.amount,0)),0) INTO allocated FROM payment_allocations a
      JOIN payments paid ON paid.id=a.payment_id AND paid.status='posted'
      LEFT JOIN payment_allocation_reversals r ON r.allocation_id=a.id
      WHERE a.sales_invoice_id=NEW.sales_invoice_id AND a.id<>COALESCE(NEW.id,0);
  ELSE
    SELECT COALESCE(sum(a.amount-COALESCE(r.amount,0)),0) INTO allocated FROM payment_allocations a
      JOIN payments paid ON paid.id=a.payment_id AND paid.status='posted'
      LEFT JOIN payment_allocation_reversals r ON r.allocation_id=a.id
      WHERE a.purchase_invoice_id=NEW.purchase_invoice_id AND a.id<>COALESCE(NEW.id,0);
  END IF;
  IF allocated + NEW.amount > inv_total THEN RAISE EXCEPTION 'allocations exceed invoice total' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

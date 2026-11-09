DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM sales_invoice_cancellation_events) OR EXISTS(SELECT 1 FROM payment_allocation_reversals) THEN
    RAISE EXCEPTION 'Cancellation and allocation reversal evidence is in use; use a forward correction';
  END IF;
END $$;
DROP TABLE sales_invoice_cancellation_events;
DROP TABLE payment_allocation_reversals;
ALTER TABLE sales_invoices DROP COLUMN cancellation_reason,DROP COLUMN cancellation_date,DROP COLUMN cancelled_by,DROP COLUMN duplicate_of_invoice_id,DROP COLUMN cancellation_remarks;
DROP FUNCTION guard_payment_allocation_reversal_immutable();
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
  SELECT COALESCE(sum(amount),0) INTO allocated FROM payment_allocations WHERE payment_id=NEW.payment_id AND id<>COALESCE(NEW.id,0);
  IF allocated + NEW.amount > p.amount THEN RAISE EXCEPTION 'allocations exceed payment amount' USING ERRCODE='23514'; END IF;
  IF NEW.direction='in' THEN SELECT COALESCE(sum(amount),0) INTO allocated FROM payment_allocations WHERE sales_invoice_id=NEW.sales_invoice_id AND id<>COALESCE(NEW.id,0);
  ELSE SELECT COALESCE(sum(amount),0) INTO allocated FROM payment_allocations WHERE purchase_invoice_id=NEW.purchase_invoice_id AND id<>COALESCE(NEW.id,0); END IF;
  IF allocated + NEW.amount > inv_total THEN RAISE EXCEPTION 'allocations exceed invoice total' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_billing_document_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_status TEXT; new_status TEXT; old_data JSONB; new_data JSONB;
BEGIN
  old_status:=OLD.status;new_status:=NEW.status;
  IF old_status='draft' THEN
    IF new_status NOT IN ('draft','posted','cancelled') THEN RAISE EXCEPTION 'invalid document transition: % to %',old_status,new_status USING ERRCODE='23514'; END IF;
    IF new_status='posted' AND NEW.posted_at IS NULL THEN RAISE EXCEPTION 'posted documents require posted_at' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF old_status='posted' THEN
    IF new_status NOT IN ('posted','reversed') THEN RAISE EXCEPTION 'posted documents can only remain posted or be reversed' USING ERRCODE='23514'; END IF;
    old_data:=to_jsonb(OLD)-'status'-'updated_at';new_data:=to_jsonb(NEW)-'status'-'updated_at';
    IF old_data<>new_data THEN RAISE EXCEPTION 'posted document fields are immutable' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF old_status IN ('cancelled','reversed') AND new_status<>old_status THEN RAISE EXCEPTION 'cancelled and reversed documents are terminal' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

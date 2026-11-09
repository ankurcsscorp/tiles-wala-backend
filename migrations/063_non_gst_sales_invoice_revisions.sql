-- Allow narrowly authorized, transactional revisions of posted non-GST invoices.
-- The API creates and removes the context row inside the same transaction.
ALTER TABLE sales_invoice_revisions
  DROP CONSTRAINT sales_invoice_revisions_revision_type_check,
  ADD CONSTRAINT sales_invoice_revisions_revision_type_check CHECK (revision_type IN ('OPERATIONAL','FINANCIAL')),
  DROP CONSTRAINT sales_invoice_revisions_financial_difference_check,
  ADD COLUMN impact_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(impact_snapshot)='object');

CREATE TABLE sales_invoice_revision_contexts (
  backend_pid INTEGER NOT NULL,
  transaction_id BIGINT NOT NULL,
  invoice_id BIGINT NOT NULL REFERENCES sales_invoices(id) ON DELETE RESTRICT,
  actor_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  PRIMARY KEY(backend_pid,transaction_id,invoice_id)
);

CREATE FUNCTION sales_invoice_revision_authorized(p_invoice_id BIGINT) RETURNS BOOLEAN
LANGUAGE SQL VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM sales_invoice_revision_contexts
    WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current() AND invoice_id=p_invoice_id)
$$;

CREATE OR REPLACE FUNCTION guard_billing_document_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_status TEXT; new_status TEXT; old_data JSONB; new_data JSONB;
BEGIN
  old_status:=OLD.status;new_status:=NEW.status;
  IF old_status='draft' THEN
    IF new_status NOT IN ('draft','posted','cancelled') THEN RAISE EXCEPTION 'invalid document transition: % to %',old_status,new_status USING ERRCODE='23514'; END IF;
    IF new_status='posted' AND NEW.posted_at IS NULL THEN RAISE EXCEPTION 'posted documents require posted_at' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='sales_invoices' AND old_status='posted' AND new_status='posted' AND sales_invoice_revision_authorized(OLD.id) THEN
    old_data:=to_jsonb(OLD)-ARRAY['updated_at','customer_name_snapshot','customer_mobile_snapshot','customer_address_snapshot','place_of_supply_state','due_date','notes','vehicle_number','driver_name','driver_contact_number','transport_mode_snapshot','invoice_discount','additional_charges','round_off','subtotal','discount_total','taxable_total','tax_total','cgst_total','sgst_total','igst_total','total','tax_jurisdiction_snapshot'];
    new_data:=to_jsonb(NEW)-ARRAY['updated_at','customer_name_snapshot','customer_mobile_snapshot','customer_address_snapshot','place_of_supply_state','due_date','notes','vehicle_number','driver_name','driver_contact_number','transport_mode_snapshot','invoice_discount','additional_charges','round_off','subtotal','discount_total','taxable_total','tax_total','cgst_total','sgst_total','igst_total','total','tax_jurisdiction_snapshot'];
    IF old_data<>new_data THEN RAISE EXCEPTION 'invoice revision attempted to change a protected issued field' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF old_status='posted' AND new_status='cancelled' THEN
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
    IF parent_status='posted' AND sales_invoice_revision_authorized(parent_id) THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
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

ALTER TABLE sales_bonus_adjustments DROP CONSTRAINT sales_bonus_adjustments_source_type_check;
ALTER TABLE sales_bonus_adjustments ADD CONSTRAINT sales_bonus_adjustments_source_type_check CHECK(source_type IN ('sales_return_item','invoice_reversal','sales_return_reversal','invoice_revision'));

-- Multiple later revisions may release more of a receipt allocation. Each
-- release remains its own immutable row; consumers aggregate by allocation.
DROP INDEX payment_allocation_reversal_once_idx;
CREATE INDEX payment_allocation_reversal_allocation_idx ON payment_allocation_reversals(allocation_id,id);

CREATE OR REPLACE FUNCTION validate_payment_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payments%ROWTYPE; inv_total NUMERIC(18,2); allocated NUMERIC(18,2);
BEGIN
  SELECT * INTO p FROM payments WHERE id=NEW.payment_id FOR UPDATE;
  IF p.status<>'posted' THEN RAISE EXCEPTION 'payment must be posted before allocation' USING ERRCODE='23514'; END IF;
  IF NEW.direction='in' THEN
    SELECT total INTO inv_total FROM sales_invoices WHERE id=NEW.sales_invoice_id AND store_id=NEW.store_id AND status='posted' FOR UPDATE;
  ELSE
    SELECT total INTO inv_total FROM purchase_invoices WHERE id=NEW.purchase_invoice_id AND store_id=NEW.store_id AND status='posted' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment allocation must reference a posted invoice in the same store' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(sum(a.amount-COALESCE(r.amount,0)),0) INTO allocated FROM payment_allocations a
    LEFT JOIN (SELECT allocation_id,sum(amount) amount FROM payment_allocation_reversals GROUP BY allocation_id) r ON r.allocation_id=a.id
    WHERE a.payment_id=NEW.payment_id AND a.id<>COALESCE(NEW.id,0);
  IF allocated+NEW.amount>p.amount THEN RAISE EXCEPTION 'allocations exceed payment amount' USING ERRCODE='23514'; END IF;
  IF NEW.direction='in' THEN
    SELECT COALESCE(sum(a.amount-COALESCE(r.amount,0)),0) INTO allocated FROM payment_allocations a
      JOIN payments paid ON paid.id=a.payment_id AND paid.status='posted'
      LEFT JOIN (SELECT allocation_id,sum(amount) amount FROM payment_allocation_reversals GROUP BY allocation_id) r ON r.allocation_id=a.id
      WHERE a.sales_invoice_id=NEW.sales_invoice_id AND a.id<>COALESCE(NEW.id,0);
  ELSE
    SELECT COALESCE(sum(a.amount-COALESCE(r.amount,0)),0) INTO allocated FROM payment_allocations a
      JOIN payments paid ON paid.id=a.payment_id AND paid.status='posted'
      LEFT JOIN (SELECT allocation_id,sum(amount) amount FROM payment_allocation_reversals GROUP BY allocation_id) r ON r.allocation_id=a.id
      WHERE a.purchase_invoice_id=NEW.purchase_invoice_id AND a.id<>COALESCE(NEW.id,0);
  END IF;
  IF allocated+NEW.amount>inv_total THEN RAISE EXCEPTION 'allocations exceed invoice total' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

ALTER TABLE sales_invoices
  ADD COLUMN cancellation_reason TEXT,
  ADD COLUMN cancellation_date DATE,
  ADD COLUMN cancelled_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN duplicate_of_invoice_id BIGINT REFERENCES sales_invoices(id) ON DELETE RESTRICT,
  ADD COLUMN cancellation_remarks TEXT;

CREATE TABLE payment_allocation_reversals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  allocation_id BIGINT NOT NULL REFERENCES payment_allocations(id) ON DELETE RESTRICT,
  amount NUMERIC(18,2) NOT NULL CHECK(amount > 0),
  reason TEXT NOT NULL,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payment_allocation_reversal_once_idx ON payment_allocation_reversals(allocation_id);
CREATE FUNCTION guard_payment_allocation_reversal_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'payment allocation reversal history is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER payment_allocation_reversal_immutable BEFORE UPDATE OR DELETE ON payment_allocation_reversals
  FOR EACH ROW EXECUTE FUNCTION guard_payment_allocation_reversal_immutable();

CREATE TABLE sales_invoice_cancellation_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sales_invoice_id BIGINT NOT NULL REFERENCES sales_invoices(id) ON DELETE RESTRICT,
  store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  cancellation_date DATE NOT NULL,
  duplicate_of_invoice_id BIGINT REFERENCES sales_invoices(id) ON DELETE RESTRICT,
  remarks TEXT,
  allocation_settlement JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(sales_invoice_id)
);
CREATE TRIGGER sales_invoice_cancellation_event_immutable BEFORE UPDATE OR DELETE ON sales_invoice_cancellation_events
  FOR EACH ROW EXECUTE FUNCTION guard_payment_allocation_reversal_immutable();

CREATE OR REPLACE FUNCTION guard_billing_document_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_status TEXT; new_status TEXT; old_data JSONB; new_data JSONB;
BEGIN
  old_status:=OLD.status;new_status:=NEW.status;
  IF old_status='draft' THEN
    IF new_status NOT IN ('draft','posted','cancelled') THEN RAISE EXCEPTION 'invalid document transition: % to %',old_status,new_status USING ERRCODE='23514'; END IF;
    IF new_status='posted' AND NEW.posted_at IS NULL THEN RAISE EXCEPTION 'posted documents require posted_at' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF old_status='posted' AND new_status='cancelled' THEN
    old_data:=to_jsonb(OLD)-'status'-'updated_at'-'cancellation_reason'-'cancellation_date'-'cancelled_by'-'duplicate_of_invoice_id'-'cancellation_remarks';
    new_data:=to_jsonb(NEW)-'status'-'updated_at'-'cancellation_reason'-'cancellation_date'-'cancelled_by'-'duplicate_of_invoice_id'-'cancellation_remarks';
    IF old_data<>new_data OR NEW.cancellation_reason IS NULL OR NEW.cancelled_by IS NULL OR NEW.cancellation_date IS NULL THEN
      RAISE EXCEPTION 'posted invoice cancellation requires immutable invoice data and complete cancellation metadata' USING ERRCODE='23514';
    END IF;
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

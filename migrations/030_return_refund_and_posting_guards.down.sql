DO $$ BEGIN IF EXISTS(SELECT 1 FROM sales_returns WHERE refund_method IS NOT NULL AND refund_method NOT IN ('cash','upi','card','bank_transfer','cheque','other')) THEN RAISE EXCEPTION 'Configured refund methods are in use; use a forward correction'; END IF; END $$;
DROP TRIGGER return_invoice_totals ON sales_returns; DROP TRIGGER return_invoice_totals ON purchase_returns; DROP FUNCTION validate_return_invoice_totals();
DROP TRIGGER allocation_refund_guard ON payment_allocations; DROP FUNCTION reject_refund_invoice_allocation();
ALTER TABLE sales_returns DROP CONSTRAINT sales_returns_refund_method_fk;
ALTER TABLE purchase_returns DROP CONSTRAINT purchase_returns_refund_method_fk;
ALTER TABLE sales_returns ADD CONSTRAINT sales_returns_refund_method_check CHECK(refund_method IN ('cash','upi','card','bank_transfer','cheque','other'));
CREATE OR REPLACE FUNCTION validate_payment_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payments%ROWTYPE; inv_total NUMERIC(18,2); allocated NUMERIC(18,2);
BEGIN
  SELECT * INTO p FROM payments WHERE id=NEW.payment_id FOR UPDATE;
  IF p.status <> 'posted' THEN RAISE EXCEPTION 'payment must be posted before allocation' USING ERRCODE='23514'; END IF;
  IF NEW.direction='in' THEN
    SELECT total INTO inv_total FROM sales_invoices WHERE id=NEW.sales_invoice_id AND store_id=NEW.store_id AND status='posted' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'sales invoice must be posted in the same store' USING ERRCODE='23514'; END IF;
    SELECT COALESCE(sum(amount),0) INTO allocated FROM payment_allocations WHERE payment_id=NEW.payment_id AND id<>COALESCE(NEW.id,0);
    IF allocated + NEW.amount > p.amount THEN RAISE EXCEPTION 'allocations exceed payment amount' USING ERRCODE='23514'; END IF;
    SELECT COALESCE(sum(a.amount),0) INTO allocated FROM payment_allocations a JOIN payments paid ON paid.id=a.payment_id AND paid.status='posted' WHERE a.sales_invoice_id=NEW.sales_invoice_id AND a.id<>COALESCE(NEW.id,0);
  ELSE
    SELECT total INTO inv_total FROM purchase_invoices WHERE id=NEW.purchase_invoice_id AND store_id=NEW.store_id AND status='posted' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'purchase invoice must be posted in the same store' USING ERRCODE='23514'; END IF;
    SELECT COALESCE(sum(amount),0) INTO allocated FROM payment_allocations WHERE payment_id=NEW.payment_id AND id<>COALESCE(NEW.id,0);
    IF allocated + NEW.amount > p.amount THEN RAISE EXCEPTION 'allocations exceed payment amount' USING ERRCODE='23514'; END IF;
    SELECT COALESCE(sum(a.amount),0) INTO allocated FROM payment_allocations a JOIN payments paid ON paid.id=a.payment_id AND paid.status='posted' WHERE a.purchase_invoice_id=NEW.purchase_invoice_id AND a.id<>COALESCE(NEW.id,0);
  END IF;
  IF allocated + NEW.amount > inv_total THEN RAISE EXCEPTION 'allocations exceed invoice total' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

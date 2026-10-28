-- Restore the original allocation-capacity guard; financial history is retained.
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
    SELECT COALESCE(sum(amount),0) INTO allocated FROM payment_allocations WHERE sales_invoice_id=NEW.sales_invoice_id AND id<>COALESCE(NEW.id,0);
  ELSE
    SELECT total INTO inv_total FROM purchase_invoices WHERE id=NEW.purchase_invoice_id AND store_id=NEW.store_id AND status='posted' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'purchase invoice must be posted in the same store' USING ERRCODE='23514'; END IF;
    SELECT COALESCE(sum(amount),0) INTO allocated FROM payment_allocations WHERE payment_id=NEW.payment_id AND id<>COALESCE(NEW.id,0);
    IF allocated + NEW.amount > p.amount THEN RAISE EXCEPTION 'allocations exceed payment amount' USING ERRCODE='23514'; END IF;
    SELECT COALESCE(sum(amount),0) INTO allocated FROM payment_allocations WHERE purchase_invoice_id=NEW.purchase_invoice_id AND id<>COALESCE(NEW.id,0);
  END IF;
  IF allocated + NEW.amount > inv_total THEN RAISE EXCEPTION 'allocations exceed invoice total' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

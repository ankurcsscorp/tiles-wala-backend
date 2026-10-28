-- Configured methods apply to return refunds too; preserve all historical evidence.
ALTER TABLE sales_returns DROP CONSTRAINT sales_returns_refund_method_check;
ALTER TABLE sales_returns ADD CONSTRAINT sales_returns_refund_method_fk FOREIGN KEY(refund_method) REFERENCES payment_method_options(code);
ALTER TABLE purchase_returns ADD CONSTRAINT purchase_returns_refund_method_fk FOREIGN KEY(refund_method) REFERENCES payment_method_options(code);
CREATE FUNCTION validate_return_invoice_totals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE totals RECORD;refund RECORD;applied NUMERIC;bad BOOLEAN;
BEGIN
 IF OLD.status='draft' AND NEW.status='posted' AND NEW.workflow_version=2 THEN
  IF TG_TABLE_NAME='sales_returns' THEN
   SELECT sum(line_total) amount,sum(tax_adjustment) tax INTO totals FROM sales_return_items WHERE sales_return_id=NEW.id;
   SELECT EXISTS(SELECT 1 FROM sales_return_items x WHERE x.sales_return_id=NEW.id AND (x.return_snapshot IS NULL OR x.conversion_factor_to_base IS NULL OR x.conversion_factor_to_base<=0 OR x.taxable_adjustment+x.tax_adjustment<>x.line_total OR (COALESCE((x.return_snapshot->>'taxBreakupKnown')::boolean,FALSE) AND x.cgst_adjustment+x.sgst_adjustment+x.igst_adjustment<>x.tax_adjustment))) INTO bad;
   SELECT COALESCE(sum(amount),0) INTO applied FROM return_credit_allocations WHERE sales_return_id=NEW.id;
   SELECT * INTO refund FROM payments WHERE sales_return_id=NEW.id AND status='posted';
   IF NEW.customer_credit<>NEW.total-NEW.refund_amount THEN RAISE EXCEPTION 'Customer credit does not match return/refund' USING ERRCODE='23514'; END IF;
  ELSE
   SELECT sum(line_total) amount,sum(tax_adjustment) tax INTO totals FROM purchase_return_items WHERE purchase_return_id=NEW.id;
   SELECT EXISTS(SELECT 1 FROM purchase_return_items x WHERE x.purchase_return_id=NEW.id AND (x.return_snapshot IS NULL OR x.conversion_factor_to_base IS NULL OR x.conversion_factor_to_base<=0 OR x.taxable_adjustment+x.tax_adjustment<>x.line_total OR (COALESCE((x.return_snapshot->>'taxBreakupKnown')::boolean,FALSE) AND x.cgst_adjustment+x.sgst_adjustment+x.igst_adjustment<>x.tax_adjustment))) INTO bad;
   SELECT COALESCE(sum(amount),0) INTO applied FROM return_credit_allocations WHERE purchase_return_id=NEW.id;
   SELECT * INTO refund FROM payments WHERE purchase_return_id=NEW.id AND status='posted';
   IF NEW.supplier_credit<>NEW.total-NEW.refund_amount THEN RAISE EXCEPTION 'Supplier credit does not match return/refund' USING ERRCODE='23514'; END IF;
  END IF;
  IF bad OR totals.amount IS NULL OR totals.amount<>NEW.total OR totals.tax<>NEW.tax_adjustment OR applied<>NEW.adjusted_amount OR NEW.unapplied_credit<>NEW.total-NEW.refund_amount-applied THEN
   RAISE EXCEPTION 'Return totals, settlement or original tax snapshots do not reconcile' USING ERRCODE='23514'; END IF;
  IF (NEW.refund_amount>0 AND (refund.id IS NULL OR refund.amount<>NEW.refund_amount OR refund.payment_method IS DISTINCT FROM NEW.refund_method)) OR (NEW.refund_amount=0 AND refund.id IS NOT NULL) THEN
   RAISE EXCEPTION 'Return refund must match its separately recorded payment' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER return_invoice_totals BEFORE UPDATE OF status ON sales_returns FOR EACH ROW EXECUTE FUNCTION validate_return_invoice_totals();
CREATE TRIGGER return_invoice_totals BEFORE UPDATE OF status ON purchase_returns FOR EACH ROW EXECUTE FUNCTION validate_return_invoice_totals();
CREATE FUNCTION reject_refund_invoice_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM payments WHERE id=NEW.payment_id AND (sales_return_id IS NOT NULL OR purchase_return_id IS NOT NULL)) THEN
  RAISE EXCEPTION 'Refund payments cannot be allocated to invoices' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER allocation_refund_guard BEFORE INSERT ON payment_allocations FOR EACH ROW EXECUTE FUNCTION reject_refund_invoice_allocation();

CREATE OR REPLACE FUNCTION validate_payment_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payments%ROWTYPE; inv_total NUMERIC(18,2); allocated NUMERIC(18,2);
BEGIN
  SELECT * INTO p FROM payments WHERE id=NEW.payment_id FOR UPDATE;
  IF p.status <> 'posted' THEN RAISE EXCEPTION 'payment must be posted before allocation' USING ERRCODE='23514'; END IF;
  IF NEW.direction='in' THEN
    SELECT i.total-COALESCE((SELECT sum(c.total) FROM sales_invoice_return_credits c WHERE c.sales_invoice_id=i.id AND c.status='posted'),0) INTO inv_total FROM sales_invoices i WHERE i.id=NEW.sales_invoice_id AND i.store_id=NEW.store_id AND i.status='posted' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'sales invoice must be posted in the same store' USING ERRCODE='23514'; END IF;
    SELECT COALESCE(sum(amount),0) INTO allocated FROM payment_allocations WHERE payment_id=NEW.payment_id AND id<>COALESCE(NEW.id,0);
    IF allocated + NEW.amount > p.amount THEN RAISE EXCEPTION 'allocations exceed payment amount' USING ERRCODE='23514'; END IF;
    SELECT COALESCE(sum(a.amount),0) INTO allocated FROM payment_allocations a JOIN payments paid ON paid.id=a.payment_id AND paid.status='posted' WHERE a.sales_invoice_id=NEW.sales_invoice_id AND a.id<>COALESCE(NEW.id,0);
  ELSE
    SELECT i.total-COALESCE((SELECT sum(c.total) FROM purchase_invoice_return_credits c WHERE c.purchase_invoice_id=i.id AND c.status='posted'),0) INTO inv_total FROM purchase_invoices i WHERE i.id=NEW.purchase_invoice_id AND i.store_id=NEW.store_id AND i.status='posted' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'purchase invoice must be posted in the same store' USING ERRCODE='23514'; END IF;
    SELECT COALESCE(sum(amount),0) INTO allocated FROM payment_allocations WHERE payment_id=NEW.payment_id AND id<>COALESCE(NEW.id,0);
    IF allocated + NEW.amount > p.amount THEN RAISE EXCEPTION 'allocations exceed payment amount' USING ERRCODE='23514'; END IF;
    SELECT COALESCE(sum(a.amount),0) INTO allocated FROM payment_allocations a JOIN payments paid ON paid.id=a.payment_id AND paid.status='posted' WHERE a.purchase_invoice_id=NEW.purchase_invoice_id AND a.id<>COALESCE(NEW.id,0);
  END IF;
  IF allocated + NEW.amount > inv_total THEN RAISE EXCEPTION 'allocations exceed invoice total' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

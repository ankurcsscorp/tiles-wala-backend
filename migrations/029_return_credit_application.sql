-- Retained credit can be applied later without changing the return or prior allocation evidence.
DO $$ DECLARE constraint_row RECORD; BEGIN
 FOR constraint_row IN SELECT conname FROM pg_constraint WHERE conrelid='return_credit_allocations'::regclass AND contype='u' LOOP
  EXECUTE format('ALTER TABLE return_credit_allocations DROP CONSTRAINT %I',constraint_row.conname);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION immutable_return_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_store BIGINT;parent_party BIGINT;invoice_party BIGINT;credit NUMERIC;used NUMERIC;parent_status TEXT;due NUMERIC;target BIGINT;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Return credit allocations are immutable' USING ERRCODE='23514'; END IF;
 IF NEW.sales_return_id IS NOT NULL THEN
  SELECT r.store_id,i.customer_id,r.customer_credit,r.status INTO parent_store,parent_party,credit,parent_status FROM sales_returns r JOIN sales_invoices i ON i.id=r.sales_invoice_id WHERE r.id=NEW.sales_return_id FOR UPDATE OF r;
  IF parent_status='posted' THEN SELECT customer_credit INTO credit FROM sales_return_accounting WHERE id=NEW.sales_return_id; END IF;
  SELECT customer_id INTO invoice_party FROM sales_invoices WHERE id=NEW.sales_invoice_id AND store_id=NEW.store_id AND status='posted' FOR UPDATE;
  SELECT COALESCE(sum(amount),0) INTO used FROM return_credit_allocations WHERE sales_return_id=NEW.sales_return_id;
  SELECT i.total-COALESCE((SELECT sum(a.amount) FROM payment_allocations a JOIN payments p ON p.id=a.payment_id WHERE a.sales_invoice_id=i.id AND p.status='posted'),0)-COALESCE((SELECT sum(c.total) FROM sales_invoice_return_credits c WHERE c.sales_invoice_id=i.id AND c.status='posted'),0)-CASE WHEN parent_status='draft' THEN COALESCE((SELECT sum(a.amount) FROM return_credit_allocations a WHERE a.sales_return_id=NEW.sales_return_id AND a.sales_invoice_id=i.id),0) ELSE 0 END INTO due FROM sales_invoices i WHERE id=NEW.sales_invoice_id;
 ELSE
  SELECT r.store_id,i.supplier_id,r.supplier_credit,r.status INTO parent_store,parent_party,credit,parent_status FROM purchase_returns r JOIN purchase_invoices i ON i.id=r.purchase_invoice_id WHERE r.id=NEW.purchase_return_id FOR UPDATE OF r;
  IF parent_status='posted' THEN SELECT supplier_credit INTO credit FROM purchase_return_accounting WHERE id=NEW.purchase_return_id; END IF;
  SELECT supplier_id INTO invoice_party FROM purchase_invoices WHERE id=NEW.purchase_invoice_id AND store_id=NEW.store_id AND status='posted' FOR UPDATE;
  SELECT COALESCE(sum(amount),0) INTO used FROM return_credit_allocations WHERE purchase_return_id=NEW.purchase_return_id;
  SELECT i.total-COALESCE((SELECT sum(a.amount) FROM payment_allocations a JOIN payments p ON p.id=a.payment_id WHERE a.purchase_invoice_id=i.id AND p.status='posted'),0)-COALESCE((SELECT sum(c.total) FROM purchase_invoice_return_credits c WHERE c.purchase_invoice_id=i.id AND c.status='posted'),0)-CASE WHEN parent_status='draft' THEN COALESCE((SELECT sum(a.amount) FROM return_credit_allocations a WHERE a.purchase_return_id=NEW.purchase_return_id AND a.purchase_invoice_id=i.id),0) ELSE 0 END INTO due FROM purchase_invoices i WHERE id=NEW.purchase_invoice_id;
 END IF;
 IF parent_status NOT IN ('draft','posted') OR parent_store IS DISTINCT FROM NEW.store_id OR parent_party IS DISTINCT FROM invoice_party OR invoice_party IS NULL OR used+NEW.amount>credit OR NEW.amount>GREATEST(COALESCE(due,0),0) THEN
  RAISE EXCEPTION 'Return credit exceeds available invoice/return credit or crosses store/party boundaries' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

DO $$ BEGIN IF EXISTS(SELECT 1 FROM return_credit_allocations GROUP BY sales_return_id,sales_invoice_id,purchase_return_id,purchase_invoice_id HAVING count(*)>1) THEN RAISE EXCEPTION 'Credit application evidence exists; use a forward correction'; END IF; END $$;
ALTER TABLE return_credit_allocations ADD CONSTRAINT return_credit_allocations_sales_return_id_sales_invoice_id_key UNIQUE(sales_return_id,sales_invoice_id),ADD CONSTRAINT return_credit_allocations_purchase_return_id_purchase_invoice_id_key UNIQUE(purchase_return_id,purchase_invoice_id);
CREATE OR REPLACE FUNCTION immutable_return_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_store BIGINT;parent_party BIGINT;invoice_party BIGINT;credit NUMERIC;used NUMERIC;parent_status TEXT;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Return credit allocations are immutable' USING ERRCODE='23514'; END IF;
 IF NEW.sales_return_id IS NOT NULL THEN
  SELECT r.store_id,i.customer_id,r.customer_credit,r.status INTO parent_store,parent_party,credit,parent_status FROM sales_returns r JOIN sales_invoices i ON i.id=r.sales_invoice_id WHERE r.id=NEW.sales_return_id FOR UPDATE OF r;
  SELECT customer_id INTO invoice_party FROM sales_invoices WHERE id=NEW.sales_invoice_id AND store_id=NEW.store_id AND status='posted' FOR UPDATE;
  SELECT COALESCE(sum(amount),0) INTO used FROM return_credit_allocations WHERE sales_return_id=NEW.sales_return_id;
 ELSE
  SELECT r.store_id,i.supplier_id,r.supplier_credit,r.status INTO parent_store,parent_party,credit,parent_status FROM purchase_returns r JOIN purchase_invoices i ON i.id=r.purchase_invoice_id WHERE r.id=NEW.purchase_return_id FOR UPDATE OF r;
  SELECT supplier_id INTO invoice_party FROM purchase_invoices WHERE id=NEW.purchase_invoice_id AND store_id=NEW.store_id AND status='posted' FOR UPDATE;
  SELECT COALESCE(sum(amount),0) INTO used FROM return_credit_allocations WHERE purchase_return_id=NEW.purchase_return_id;
 END IF;
 IF parent_status IS DISTINCT FROM 'draft' OR parent_store IS DISTINCT FROM NEW.store_id OR parent_party IS DISTINCT FROM invoice_party OR invoice_party IS NULL OR used+NEW.amount>credit THEN
  RAISE EXCEPTION 'Return credit allocation exceeds available credit or crosses store/party boundaries' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

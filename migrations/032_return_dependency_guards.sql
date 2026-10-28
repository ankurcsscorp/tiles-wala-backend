-- Keep return quantities and applied credits valid when related documents reverse.
CREATE FUNCTION guard_invoice_return_dependencies() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='posted' AND NEW.status='reversed' THEN
  IF TG_TABLE_NAME='sales_invoices' THEN
   IF EXISTS(SELECT 1 FROM sales_returns WHERE sales_invoice_id=NEW.id AND status='posted') OR
      EXISTS(SELECT 1 FROM sales_invoice_return_credits WHERE sales_invoice_id=NEW.id AND status='posted') THEN
    RAISE EXCEPTION 'Reverse related returns before reversing this sales invoice' USING ERRCODE='23514';
   END IF;
  ELSE
   IF EXISTS(SELECT 1 FROM purchase_returns WHERE purchase_invoice_id=NEW.id AND status='posted') OR
      EXISTS(SELECT 1 FROM purchase_invoice_return_credits WHERE purchase_invoice_id=NEW.id AND status='posted') THEN
    RAISE EXCEPTION 'Reverse related returns before reversing this purchase invoice' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sales_invoice_return_dependencies BEFORE UPDATE OF status ON sales_invoices FOR EACH ROW EXECUTE FUNCTION guard_invoice_return_dependencies();
CREATE TRIGGER purchase_invoice_return_dependencies BEFORE UPDATE OF status ON purchase_invoices FOR EACH ROW EXECUTE FUNCTION guard_invoice_return_dependencies();
CREATE FUNCTION guard_receipt_return_dependencies() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='posted' AND NEW.status='reversed' THEN
  PERFORM 1 FROM purchase_invoices WHERE id=NEW.purchase_invoice_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM purchase_receipt_items item WHERE item.receipt_id=NEW.id AND
    COALESCE((SELECT sum(ri.quantity) FROM purchase_return_items ri JOIN purchase_returns r ON r.id=ri.purchase_return_id WHERE ri.purchase_invoice_item_id=item.purchase_invoice_item_id AND r.status='posted'),0) >
    COALESCE((SELECT sum(other.quantity_received) FROM purchase_receipt_items other JOIN purchase_receipts receipt ON receipt.id=other.receipt_id WHERE other.purchase_invoice_item_id=item.purchase_invoice_item_id AND receipt.status='posted' AND receipt.id<>NEW.id),0)) THEN
   RAISE EXCEPTION 'Reverse related purchase returns before reversing goods required by those returns' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER purchase_receipt_return_dependencies BEFORE UPDATE OF status ON purchase_receipts FOR EACH ROW EXECUTE FUNCTION guard_receipt_return_dependencies();

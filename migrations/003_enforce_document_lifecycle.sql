-- Drafts may post or cancel. Posted documents may only be reversed, and are immutable.
CREATE FUNCTION guard_billing_document_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_status TEXT; new_status TEXT; old_data JSONB; new_data JSONB;
BEGIN
  old_status := OLD.status;
  new_status := NEW.status;
  IF old_status = 'draft' THEN
    IF new_status NOT IN ('draft','posted','cancelled') THEN
      RAISE EXCEPTION 'invalid document transition: % to %', old_status, new_status USING ERRCODE='23514';
    END IF;
    IF new_status = 'posted' AND NEW.posted_at IS NULL THEN
      RAISE EXCEPTION 'posted documents require posted_at' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF old_status = 'posted' THEN
    IF new_status NOT IN ('posted','reversed') THEN
      RAISE EXCEPTION 'posted documents can only remain posted or be reversed' USING ERRCODE='23514';
    END IF;
    old_data := to_jsonb(OLD) - 'status' - 'updated_at';
    new_data := to_jsonb(NEW) - 'status' - 'updated_at';
    IF old_data <> new_data THEN
      RAISE EXCEPTION 'posted document fields are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF old_status IN ('cancelled','reversed') AND new_status <> old_status THEN
    RAISE EXCEPTION 'cancelled and reversed documents are terminal' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION guard_billing_document_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'billing documents must be created as drafts' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER sales_invoice_insert_draft BEFORE INSERT ON sales_invoices FOR EACH ROW EXECUTE FUNCTION guard_billing_document_insert();
CREATE TRIGGER purchase_invoice_insert_draft BEFORE INSERT ON purchase_invoices FOR EACH ROW EXECUTE FUNCTION guard_billing_document_insert();
CREATE TRIGGER sales_return_insert_draft BEFORE INSERT ON sales_returns FOR EACH ROW EXECUTE FUNCTION guard_billing_document_insert();
CREATE TRIGGER purchase_return_insert_draft BEFORE INSERT ON purchase_returns FOR EACH ROW EXECUTE FUNCTION guard_billing_document_insert();
CREATE TRIGGER transfer_insert_draft BEFORE INSERT ON stock_transfers FOR EACH ROW EXECUTE FUNCTION guard_billing_document_insert();
CREATE TRIGGER sales_invoice_lifecycle BEFORE UPDATE ON sales_invoices FOR EACH ROW EXECUTE FUNCTION guard_billing_document_update();
CREATE TRIGGER purchase_invoice_lifecycle BEFORE UPDATE ON purchase_invoices FOR EACH ROW EXECUTE FUNCTION guard_billing_document_update();
CREATE TRIGGER sales_return_lifecycle BEFORE UPDATE ON sales_returns FOR EACH ROW EXECUTE FUNCTION guard_billing_document_update();
CREATE TRIGGER purchase_return_lifecycle BEFORE UPDATE ON purchase_returns FOR EACH ROW EXECUTE FUNCTION guard_billing_document_update();
CREATE TRIGGER transfer_lifecycle BEFORE UPDATE ON stock_transfers FOR EACH ROW EXECUTE FUNCTION guard_billing_document_update();

CREATE FUNCTION guard_billing_document_item_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status TEXT; parent_id BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'sales_invoice_items' THEN
    parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.sales_invoice_id ELSE NEW.sales_invoice_id END;
    SELECT status INTO parent_status FROM sales_invoices WHERE id=parent_id FOR UPDATE;
  ELSIF TG_TABLE_NAME = 'purchase_invoice_items' THEN
    parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.purchase_invoice_id ELSE NEW.purchase_invoice_id END;
    SELECT status INTO parent_status FROM purchase_invoices WHERE id=parent_id FOR UPDATE;
  ELSIF TG_TABLE_NAME = 'sales_return_items' THEN
    parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.sales_return_id ELSE NEW.sales_return_id END;
    SELECT status INTO parent_status FROM sales_returns WHERE id=parent_id FOR UPDATE;
  ELSIF TG_TABLE_NAME = 'purchase_return_items' THEN
    parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.purchase_return_id ELSE NEW.purchase_return_id END;
    SELECT status INTO parent_status FROM purchase_returns WHERE id=parent_id FOR UPDATE;
  ELSE
    parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.transfer_id ELSE NEW.transfer_id END;
    SELECT status INTO parent_status FROM stock_transfers WHERE id=parent_id FOR UPDATE;
  END IF;
  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'document lines can only be changed while the parent is a draft' USING ERRCODE='23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER sales_invoice_item_draft_only BEFORE INSERT OR UPDATE OR DELETE ON sales_invoice_items FOR EACH ROW EXECUTE FUNCTION guard_billing_document_item_write();
CREATE TRIGGER purchase_invoice_item_draft_only BEFORE INSERT OR UPDATE OR DELETE ON purchase_invoice_items FOR EACH ROW EXECUTE FUNCTION guard_billing_document_item_write();
CREATE TRIGGER sales_return_item_draft_only BEFORE INSERT OR UPDATE OR DELETE ON sales_return_items FOR EACH ROW EXECUTE FUNCTION guard_billing_document_item_write();
CREATE TRIGGER purchase_return_item_draft_only BEFORE INSERT OR UPDATE OR DELETE ON purchase_return_items FOR EACH ROW EXECUTE FUNCTION guard_billing_document_item_write();
CREATE TRIGGER transfer_item_draft_only BEFORE INSERT OR UPDATE OR DELETE ON stock_transfer_items FOR EACH ROW EXECUTE FUNCTION guard_billing_document_item_write();

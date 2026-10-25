-- Sales invoice snapshots and numbering are finalized atomically with inventory posting.
ALTER TABLE sales_invoices
  ALTER COLUMN invoice_number DROP NOT NULL,
  ADD COLUMN invoice_discount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(invoice_discount >= 0),
  ADD COLUMN taxable_total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(taxable_total >= 0),
  ADD COLUMN cgst_total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(cgst_total >= 0),
  ADD COLUMN sgst_total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(sgst_total >= 0),
  ADD COLUMN igst_total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(igst_total >= 0),
  ADD COLUMN additional_charges NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(additional_charges >= 0),
  ADD COLUMN round_off NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(round_off BETWEEN -1000000 AND 1000000),
  ADD COLUMN salesperson_name_snapshot VARCHAR(150),
  ADD COLUMN customer_name_snapshot VARCHAR(150),
  ADD COLUMN customer_mobile_snapshot VARCHAR(30),
  ADD COLUMN customer_address_snapshot JSONB,
  ADD COLUMN customer_tax_id_snapshot VARCHAR(40),
  ADD COLUMN store_logo_snapshot TEXT,
  ADD COLUMN invoice_footer_snapshot TEXT,
  ADD COLUMN terms_snapshot TEXT,
  ADD COLUMN tax_jurisdiction_snapshot VARCHAR(16) CHECK(tax_jurisdiction_snapshot IS NULL OR tax_jurisdiction_snapshot IN ('intra_state','inter_state'));

ALTER TABLE sales_invoices DROP CONSTRAINT IF EXISTS sales_invoices_store_id_series_invoice_number_key;
CREATE UNIQUE INDEX sales_invoice_number_unique_idx ON sales_invoices(store_id,series,invoice_number) WHERE invoice_number IS NOT NULL;
CREATE INDEX sales_invoice_status_store_idx ON sales_invoices(store_id,status,invoice_date DESC);

ALTER TABLE sales_invoice_items
  ADD COLUMN taxable_value NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(taxable_value >= 0),
  ADD COLUMN invoice_discount_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(invoice_discount_amount >= 0),
  ADD COLUMN cgst_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(cgst_amount >= 0),
  ADD COLUMN sgst_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(sgst_amount >= 0),
  ADD COLUMN igst_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(igst_amount >= 0),
  ADD COLUMN product_sku_snapshot VARCHAR(80),
  ADD COLUMN product_name_snapshot VARCHAR(200),
  ADD COLUMN product_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN unit_code_snapshot VARCHAR(24),
  ADD COLUMN unit_name_snapshot VARCHAR(80),
  ADD COLUMN conversion_factor_to_base NUMERIC(18,8) NOT NULL DEFAULT 1 CHECK(conversion_factor_to_base > 0);

UPDATE sales_invoice_items sii SET
  taxable_value=GREATEST(round(sii.quantity*sii.unit_price,2)-sii.discount_amount,0),
  product_sku_snapshot=p.sku,product_name_snapshot=p.name,
  product_snapshot=jsonb_build_object('brand',p.brand,'collection',p.collection,'tileSize',p.tile_size,'finish',p.finish,'color',p.color,'hsnCode',p.hsn_code),
  unit_code_snapshot=u.code,unit_name_snapshot=u.name,
  conversion_factor_to_base=CASE WHEN sii.unit_id=p.base_unit_id THEN 1 ELSE COALESCE((SELECT c.factor_to_base FROM product_unit_conversions c WHERE c.product_id=p.id AND c.unit_id=sii.unit_id),1) END
FROM products p, units_of_measure u
WHERE p.id=sii.product_id AND u.id=sii.unit_id;

CREATE FUNCTION snapshot_sales_invoice_billing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='draft' AND NEW.status='posted' THEN
    SELECT s.logo_url,s.invoice_footer,s.terms_and_conditions
      INTO NEW.store_logo_snapshot,NEW.invoice_footer_snapshot,NEW.terms_snapshot
      FROM stores s WHERE s.id=NEW.store_id;
    IF NEW.customer_id IS NOT NULL THEN
      SELECT c.name,c.phone,jsonb_build_object('billing',c.address,'shipping',c.shipping_address,'city',c.city,'state',c.state,'pinCode',c.pin_code),c.tax_id
        INTO NEW.customer_name_snapshot,NEW.customer_mobile_snapshot,NEW.customer_address_snapshot,NEW.customer_tax_id_snapshot
        FROM customers c WHERE c.id=NEW.customer_id;
    END IF;
    IF NEW.salesperson_name_snapshot IS NULL THEN
      SELECT u.name INTO NEW.salesperson_name_snapshot FROM users u WHERE u.id=NEW.created_by;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_invoice_billing_snapshot BEFORE UPDATE OF status ON sales_invoices
FOR EACH ROW EXECUTE FUNCTION snapshot_sales_invoice_billing();

CREATE FUNCTION validate_sales_invoice_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_count BIGINT; calc_subtotal NUMERIC(18,2); calc_discount NUMERIC(18,2); calc_taxable NUMERIC(18,2);
        calc_tax NUMERIC(18,2); calc_cgst NUMERIC(18,2); calc_sgst NUMERIC(18,2); calc_igst NUMERIC(18,2); calc_total NUMERIC(18,2);
BEGIN
  IF OLD.status='draft' AND NEW.status='posted' THEN
    SELECT count(*),COALESCE(sum(round(quantity*unit_price,2)),0),COALESCE(sum(discount_amount+invoice_discount_amount),0),
      COALESCE(sum(taxable_value),0),COALESCE(sum(tax_amount),0),COALESCE(sum(cgst_amount),0),COALESCE(sum(sgst_amount),0),COALESCE(sum(igst_amount),0),
      COALESCE(sum(line_total),0)
      INTO item_count,calc_subtotal,calc_discount,calc_taxable,calc_tax,calc_cgst,calc_sgst,calc_igst,calc_total
      FROM sales_invoice_items WHERE sales_invoice_id=NEW.id;
    IF item_count=0 THEN RAISE EXCEPTION 'sales invoice must contain at least one item' USING ERRCODE='23514'; END IF;
    IF NEW.invoice_number IS NULL OR length(btrim(NEW.invoice_number))=0 THEN RAISE EXCEPTION 'finalized sales invoice requires an invoice number' USING ERRCODE='23514'; END IF;
    IF NEW.subtotal<>calc_subtotal OR NEW.discount_total<>calc_discount OR NEW.taxable_total<>calc_taxable OR NEW.tax_total<>calc_tax OR
      NEW.cgst_total<>calc_cgst OR NEW.sgst_total<>calc_sgst OR NEW.igst_total<>calc_igst OR
      NEW.total<>calc_total+NEW.additional_charges+NEW.round_off THEN
      RAISE EXCEPTION 'sales invoice totals do not match item calculations' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_invoice_totals_valid BEFORE UPDATE OF status ON sales_invoices
FOR EACH ROW EXECUTE FUNCTION validate_sales_invoice_posting();

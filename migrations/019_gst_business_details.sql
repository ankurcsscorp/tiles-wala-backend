-- tax_id already stores GSTIN. Master records are shared across every store.
-- Do not merge or alter historical party data to make a unique index succeed.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM customers WHERE NULLIF(upper(trim(tax_id)), '') IS NOT NULL GROUP BY upper(trim(tax_id)) HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM suppliers WHERE NULLIF(upper(trim(tax_id)), '') IS NOT NULL GROUP BY upper(trim(tax_id)) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate GSTINs exist within the customer or supplier master. Review these records before applying migration 019; no records were changed.';
  END IF;
END $$;
ALTER TABLE customers ADD COLUMN gst_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN gst_verified_at TIMESTAMPTZ, ADD COLUMN gst_data_source VARCHAR(60);
ALTER TABLE suppliers ADD COLUMN gst_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN gst_verified_at TIMESTAMPTZ, ADD COLUMN gst_data_source VARCHAR(60);
CREATE UNIQUE INDEX customers_gstin_unique ON customers (upper(trim(tax_id))) WHERE NULLIF(trim(tax_id), '') IS NOT NULL;
CREATE UNIQUE INDEX suppliers_gstin_unique ON suppliers (upper(trim(tax_id))) WHERE NULLIF(trim(tax_id), '') IS NOT NULL;
-- Uniqueness is independent per master; one GSTIN may be both a customer and supplier.

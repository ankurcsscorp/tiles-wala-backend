CREATE TABLE sales_invoice_revisions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id BIGINT NOT NULL,
  store_id BIGINT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  revision_type VARCHAR(24) NOT NULL CHECK (revision_type IN ('OPERATIONAL')),
  changed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reason VARCHAR(500) NOT NULL CHECK (length(trim(reason)) >= 3),
  previous_snapshot JSONB NOT NULL CHECK (jsonb_typeof(previous_snapshot)='object'),
  updated_snapshot JSONB NOT NULL CHECK (jsonb_typeof(updated_snapshot)='object'),
  financial_difference NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (financial_difference=0),
  idempotency_key VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (invoice_id,store_id) REFERENCES sales_invoices(id,store_id) ON DELETE RESTRICT,
  UNIQUE(invoice_id,revision_number),
  UNIQUE(invoice_id,idempotency_key)
);

CREATE INDEX sales_invoice_revisions_store_idx ON sales_invoice_revisions(store_id,invoice_id,revision_number DESC);

CREATE FUNCTION guard_sales_invoice_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sales invoice revision history is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER sales_invoice_revision_immutable BEFORE UPDATE OR DELETE ON sales_invoice_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_sales_invoice_revision_immutable();

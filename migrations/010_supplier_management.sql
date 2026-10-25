-- Extend the existing shared supplier master; do not create a duplicate table.
ALTER TABLE suppliers
  ADD COLUMN contact_person VARCHAR(150),
  ADD COLUMN city VARCHAR(100),
  ADD COLUMN state VARCHAR(100),
  ADD COLUMN pin_code VARCHAR(12),
  ADD COLUMN payment_terms_days SMALLINT NOT NULL DEFAULT 0 CHECK (payment_terms_days BETWEEN 0 AND 365),
  ADD COLUMN notes TEXT;

CREATE INDEX suppliers_name_prefix_idx ON suppliers(lower(name) text_pattern_ops);
CREATE INDEX suppliers_phone_idx ON suppliers(phone);
CREATE INDEX suppliers_city_state_idx ON suppliers(city,state);
CREATE INDEX suppliers_active_idx ON suppliers(is_active,name);

CREATE TABLE supplier_balance_adjustments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  adjustment_type VARCHAR(24) NOT NULL CHECK (adjustment_type IN ('opening_balance','adjustment')),
  direction VARCHAR(8) NOT NULL CHECK (direction IN ('debit','credit')),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  status VARCHAR(16) NOT NULL DEFAULT 'posted' CHECK (status IN ('draft','posted','reversed')),
  adjustment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  note TEXT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reversed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX supplier_one_opening_balance_idx
  ON supplier_balance_adjustments(supplier_id) WHERE adjustment_type='opening_balance' AND status <> 'reversed';
CREATE INDEX supplier_adjustment_ledger_idx ON supplier_balance_adjustments(supplier_id,store_id,adjustment_date,id);
CREATE INDEX supplier_adjustment_store_idx ON supplier_balance_adjustments(store_id,status,adjustment_date);

-- Outbound payments can be attributed to a supplier even before invoice allocation.
ALTER TABLE payments
  ADD COLUMN supplier_id BIGINT REFERENCES suppliers(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payments_supplier_direction_check CHECK (supplier_id IS NULL OR direction='out'),
  ADD CONSTRAINT payments_one_party_check CHECK (customer_id IS NULL OR supplier_id IS NULL);
CREATE INDEX payments_supplier_date_idx ON payments(supplier_id,store_id,payment_date DESC) WHERE supplier_id IS NOT NULL;

-- Backfill only unambiguous historical outbound payments.
UPDATE payments p SET supplier_id=attributed.supplier_id
FROM (
  SELECT pa.payment_id,min(pi.supplier_id) AS supplier_id
  FROM payment_allocations pa
  JOIN purchase_invoices pi ON pi.id=pa.purchase_invoice_id
  WHERE pa.direction='out'
  GROUP BY pa.payment_id
  HAVING count(DISTINCT pi.supplier_id)=1
) attributed
WHERE p.id=attributed.payment_id AND p.direction='out' AND p.supplier_id IS NULL;

CREATE FUNCTION validate_supplier_payment_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_payment_id BIGINT; payment_supplier_id BIGINT;
BEGIN
  IF TG_TABLE_NAME='payments' THEN
    IF NEW.direction <> 'out' AND NEW.supplier_id IS NOT NULL THEN
      RAISE EXCEPTION 'only outbound payments can reference a supplier';
    END IF;
    target_payment_id := NEW.id;
  ELSE
    target_payment_id := NEW.payment_id;
  END IF;

  SELECT supplier_id INTO payment_supplier_id FROM payments WHERE id=target_payment_id;
  IF payment_supplier_id IS NULL THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM payment_allocations pa
    JOIN purchase_invoices pi ON pi.id=pa.purchase_invoice_id
    WHERE pa.payment_id=target_payment_id AND pa.direction='out'
      AND pi.supplier_id IS DISTINCT FROM payment_supplier_id
  ) THEN
    RAISE EXCEPTION 'payment supplier does not match allocated purchase invoice supplier';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER payment_supplier_link_check
AFTER INSERT OR UPDATE ON payments DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_supplier_payment_link();
CREATE CONSTRAINT TRIGGER allocation_supplier_link_check
AFTER INSERT OR UPDATE ON payment_allocations DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_supplier_payment_link();

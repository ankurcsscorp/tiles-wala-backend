-- Link inbound payments to a customer even when all or part of the receipt is
-- not yet allocated to an invoice (for example, a customer advance).
ALTER TABLE payments
  ADD COLUMN customer_id BIGINT REFERENCES customers(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payments_customer_direction_check CHECK (customer_id IS NULL OR direction='in');

CREATE INDEX payments_customer_date_idx ON payments(customer_id, store_id, payment_date DESC) WHERE customer_id IS NOT NULL;

-- Attribute historical receipts when all allocated sales invoices belong to
-- the same customer. Ambiguous or unallocated legacy receipts are left alone.
UPDATE payments p SET customer_id = attributed.customer_id
FROM (
  SELECT pa.payment_id, min(si.customer_id) AS customer_id
  FROM payment_allocations pa
  JOIN sales_invoices si ON si.id=pa.sales_invoice_id
  WHERE pa.direction='in' AND si.customer_id IS NOT NULL
  GROUP BY pa.payment_id
  HAVING count(DISTINCT si.customer_id)=1
) attributed
WHERE p.id=attributed.payment_id AND p.direction='in' AND p.customer_id IS NULL;

CREATE FUNCTION validate_customer_payment_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_payment_id BIGINT; payment_customer_id BIGINT; linked_customer_id BIGINT;
BEGIN
  IF TG_TABLE_NAME='payments' THEN
    IF NEW.direction <> 'in' AND NEW.customer_id IS NOT NULL THEN
      RAISE EXCEPTION 'only inbound payments can reference a customer';
    END IF;
    target_payment_id := NEW.id;
  ELSE
    target_payment_id := NEW.payment_id;
  END IF;

  SELECT customer_id INTO payment_customer_id FROM payments WHERE id=target_payment_id;
  IF payment_customer_id IS NULL THEN
    IF TG_TABLE_NAME='payments' THEN RETURN NEW; ELSE RETURN NEW; END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM payment_allocations pa
    JOIN sales_invoices si ON si.id=pa.sales_invoice_id
    WHERE pa.payment_id=target_payment_id AND pa.direction='in'
      AND si.customer_id IS DISTINCT FROM payment_customer_id
  ) THEN
    RAISE EXCEPTION 'payment customer does not match allocated invoice customer';
  END IF;
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER payment_customer_link_check
AFTER INSERT OR UPDATE ON payments DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_customer_payment_link();
CREATE CONSTRAINT TRIGGER allocation_customer_link_check
AFTER INSERT OR UPDATE ON payment_allocations DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_customer_payment_link();

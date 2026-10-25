-- Extend the existing shared customer master. phone is the primary mobile number;
-- contact numbers intentionally remain non-unique.
ALTER TABLE customers
  ADD COLUMN alternate_mobile VARCHAR(30),
  ADD COLUMN shipping_address JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN city VARCHAR(100),
  ADD COLUMN state VARCHAR(100),
  ADD COLUMN pin_code VARCHAR(12),
  ADD COLUMN customer_type VARCHAR(24) NOT NULL DEFAULT 'individual'
    CHECK (customer_type IN ('individual','business','contractor','other')),
  ADD COLUMN credit_limit NUMERIC(18,2) CHECK (credit_limit IS NULL OR credit_limit >= 0),
  ADD COLUMN payment_terms_days SMALLINT NOT NULL DEFAULT 0 CHECK (payment_terms_days BETWEEN 0 AND 365),
  ADD COLUMN notes TEXT;

CREATE INDEX customers_name_prefix_idx ON customers(lower(name) text_pattern_ops);
CREATE INDEX customers_alternate_mobile_idx ON customers(alternate_mobile);
CREATE INDEX customers_city_state_idx ON customers(city, state);
CREATE INDEX customers_type_active_idx ON customers(customer_type, is_active);

-- Opening balances and subsequent corrections are immutable posted ledger rows.
-- They are store-attributed so store-wise balances remain reconcilable.
CREATE TABLE customer_balance_adjustments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
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
CREATE UNIQUE INDEX customer_one_opening_balance_idx
  ON customer_balance_adjustments(customer_id) WHERE adjustment_type='opening_balance' AND status <> 'reversed';
CREATE INDEX customer_adjustment_ledger_idx ON customer_balance_adjustments(customer_id, store_id, adjustment_date, id);
CREATE INDEX customer_adjustment_store_idx ON customer_balance_adjustments(store_id, status, adjustment_date);

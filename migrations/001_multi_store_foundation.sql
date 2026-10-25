-- Multi-store billing foundation. Existing users and application tables are untouched.
CREATE TABLE stores (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  legal_name VARCHAR(200), tax_id VARCHAR(40),
  address JSONB NOT NULL DEFAULT '{}'::jsonb,
  phone VARCHAR(30), email VARCHAR(254), currency_code CHAR(3) NOT NULL DEFAULT 'INR',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_store_assignments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  role VARCHAR(32) NOT NULL DEFAULT 'staff' CHECK (role IN ('owner','manager','cashier','inventory','staff')),
  is_default BOOLEAN NOT NULL DEFAULT FALSE, is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, store_id)
);
CREATE UNIQUE INDEX user_store_one_default_idx ON user_store_assignments(user_id) WHERE is_default AND is_active;
CREATE INDEX user_store_store_idx ON user_store_assignments(store_id, is_active);

CREATE TABLE units_of_measure (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code VARCHAR(24) NOT NULL UNIQUE, name VARCHAR(80) NOT NULL,
  decimal_places SMALLINT NOT NULL DEFAULT 2 CHECK (decimal_places BETWEEN 0 AND 6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE products (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku VARCHAR(80) NOT NULL UNIQUE, name VARCHAR(200) NOT NULL,
  description TEXT, base_unit_id BIGINT NOT NULL REFERENCES units_of_measure(id) ON DELETE RESTRICT,
  barcode VARCHAR(100) UNIQUE, is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX products_name_idx ON products(name);

CREATE TABLE customers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code VARCHAR(50) UNIQUE, name VARCHAR(180) NOT NULL,
  phone VARCHAR(30), email VARCHAR(254), tax_id VARCHAR(40), address JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX customers_phone_idx ON customers(phone);
CREATE TABLE suppliers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code VARCHAR(50) UNIQUE, name VARCHAR(180) NOT NULL,
  phone VARCHAR(30), email VARCHAR(254), tax_id VARCHAR(40), address JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE store_billing_config (
  store_id BIGINT PRIMARY KEY REFERENCES stores(id) ON DELETE RESTRICT,
  tax_inclusive BOOLEAN NOT NULL DEFAULT FALSE,
  default_tax_rate NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (default_tax_rate BETWEEN 0 AND 100),
  invoice_prefix VARCHAR(24) NOT NULL DEFAULT 'INV',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE inventory_balances (
  store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, product_id)
);

CREATE TABLE invoice_number_sequences (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  document_type VARCHAR(24) NOT NULL CHECK (document_type IN ('sale','purchase','sales_return','purchase_return','transfer')),
  series VARCHAR(32) NOT NULL, period_key VARCHAR(16) NOT NULL,
  next_number BIGINT NOT NULL DEFAULT 1 CHECK (next_number > 0),
  UNIQUE (store_id, document_type, series, period_key)
);

CREATE TABLE purchase_invoices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  series VARCHAR(32) NOT NULL, invoice_number VARCHAR(64) NOT NULL,
  supplier_invoice_number VARCHAR(80), status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled','reversed')),
  invoice_date DATE NOT NULL DEFAULT CURRENT_DATE, due_date DATE,
  subtotal NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0), discount_total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (discount_total >= 0), tax_total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (tax_total >= 0), total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  notes TEXT, created_by BIGINT REFERENCES users(id) ON DELETE SET NULL, posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, series, invoice_number), UNIQUE (store_id, supplier_id, supplier_invoice_number)
);
CREATE INDEX purchase_invoice_date_idx ON purchase_invoices(store_id, invoice_date DESC);
CREATE TABLE purchase_invoice_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_invoice_id BIGINT NOT NULL REFERENCES purchase_invoices(id) ON DELETE RESTRICT,
  line_number INTEGER NOT NULL CHECK (line_number > 0), product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  description VARCHAR(240) NOT NULL, unit_id BIGINT NOT NULL REFERENCES units_of_measure(id) ON DELETE RESTRICT,
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0), unit_price NUMERIC(18,4) NOT NULL CHECK (unit_price >= 0), discount_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0), tax_rate NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100), tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0), line_total NUMERIC(18,2) NOT NULL CHECK (line_total >= 0),
  UNIQUE (purchase_invoice_id, line_number)
);

CREATE TABLE sales_invoices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  customer_id BIGINT REFERENCES customers(id) ON DELETE RESTRICT,
  series VARCHAR(32) NOT NULL, invoice_number VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled','reversed')),
  invoice_date DATE NOT NULL DEFAULT CURRENT_DATE, due_date DATE,
  subtotal NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0), discount_total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (discount_total >= 0), tax_total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (tax_total >= 0), total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  notes TEXT, created_by BIGINT REFERENCES users(id) ON DELETE SET NULL, posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, series, invoice_number)
);
CREATE INDEX sales_invoice_date_idx ON sales_invoices(store_id, invoice_date DESC);
CREATE INDEX sales_invoice_customer_idx ON sales_invoices(customer_id, invoice_date DESC);
CREATE TABLE sales_invoice_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sales_invoice_id BIGINT NOT NULL REFERENCES sales_invoices(id) ON DELETE RESTRICT,
  line_number INTEGER NOT NULL CHECK (line_number > 0), product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  description VARCHAR(240) NOT NULL, unit_id BIGINT NOT NULL REFERENCES units_of_measure(id) ON DELETE RESTRICT,
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0), unit_price NUMERIC(18,4) NOT NULL CHECK (unit_price >= 0), discount_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0), tax_rate NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100), tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0), line_total NUMERIC(18,2) NOT NULL CHECK (line_total >= 0),
  UNIQUE (sales_invoice_id, line_number)
);

CREATE TABLE payments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  payment_number VARCHAR(64) NOT NULL, direction VARCHAR(12) NOT NULL CHECK (direction IN ('in','out')),
  status VARCHAR(16) NOT NULL DEFAULT 'posted' CHECK (status IN ('draft','posted','voided','reversed')),
  payment_method VARCHAR(24) NOT NULL CHECK (payment_method IN ('cash','upi','card','bank_transfer','cheque','other')),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0), payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  reference VARCHAR(120), notes TEXT, created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(store_id, payment_number), UNIQUE(id, store_id, direction)
);
CREATE TABLE payment_allocations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id BIGINT NOT NULL, store_id BIGINT NOT NULL,
  direction VARCHAR(12) NOT NULL CHECK (direction IN ('in','out')),
  sales_invoice_id BIGINT REFERENCES sales_invoices(id) ON DELETE RESTRICT,
  purchase_invoice_id BIGINT REFERENCES purchase_invoices(id) ON DELETE RESTRICT,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(payment_id, store_id, direction) REFERENCES payments(id, store_id, direction) ON DELETE RESTRICT,
  CHECK ((direction = 'in' AND sales_invoice_id IS NOT NULL AND purchase_invoice_id IS NULL) OR (direction = 'out' AND purchase_invoice_id IS NOT NULL AND sales_invoice_id IS NULL)),
  UNIQUE(payment_id, sales_invoice_id), UNIQUE(payment_id, purchase_invoice_id)
);
CREATE INDEX payment_alloc_sales_idx ON payment_allocations(sales_invoice_id) WHERE sales_invoice_id IS NOT NULL;
CREATE INDEX payment_alloc_purchase_idx ON payment_allocations(purchase_invoice_id) WHERE purchase_invoice_id IS NOT NULL;

CREATE TABLE stock_transfers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_number VARCHAR(64) NOT NULL, from_store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT, to_store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled','reversed')),
  transfer_date DATE NOT NULL DEFAULT CURRENT_DATE, created_by BIGINT REFERENCES users(id) ON DELETE SET NULL, posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(from_store_id <> to_store_id), UNIQUE(from_store_id, transfer_number)
);
CREATE TABLE stock_transfer_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, transfer_id BIGINT NOT NULL REFERENCES stock_transfers(id) ON DELETE RESTRICT,
  line_number INTEGER NOT NULL CHECK (line_number > 0), product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  unit_id BIGINT NOT NULL REFERENCES units_of_measure(id) ON DELETE RESTRICT, quantity NUMERIC(18,4) NOT NULL CHECK(quantity > 0),
  UNIQUE(transfer_id, line_number)
);

CREATE TABLE sales_returns (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  sales_invoice_id BIGINT NOT NULL REFERENCES sales_invoices(id) ON DELETE RESTRICT, series VARCHAR(32) NOT NULL, return_number VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','cancelled','reversed')), return_date DATE NOT NULL DEFAULT CURRENT_DATE,
  total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(total >= 0), created_by BIGINT REFERENCES users(id) ON DELETE SET NULL, posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(store_id, series, return_number)
);
CREATE TABLE sales_return_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, sales_return_id BIGINT NOT NULL REFERENCES sales_returns(id) ON DELETE RESTRICT,
  sales_invoice_item_id BIGINT NOT NULL REFERENCES sales_invoice_items(id) ON DELETE RESTRICT, product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity NUMERIC(18,4) NOT NULL CHECK(quantity > 0), unit_price NUMERIC(18,4) NOT NULL CHECK(unit_price >= 0), line_total NUMERIC(18,2) NOT NULL CHECK(line_total >= 0),
  UNIQUE(sales_return_id, sales_invoice_item_id)
);
CREATE TABLE purchase_returns (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  purchase_invoice_id BIGINT NOT NULL REFERENCES purchase_invoices(id) ON DELETE RESTRICT, series VARCHAR(32) NOT NULL, return_number VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','cancelled','reversed')), return_date DATE NOT NULL DEFAULT CURRENT_DATE,
  total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(total >= 0), created_by BIGINT REFERENCES users(id) ON DELETE SET NULL, posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(store_id, series, return_number)
);
CREATE TABLE purchase_return_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, purchase_return_id BIGINT NOT NULL REFERENCES purchase_returns(id) ON DELETE RESTRICT,
  purchase_invoice_item_id BIGINT NOT NULL REFERENCES purchase_invoice_items(id) ON DELETE RESTRICT, product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity NUMERIC(18,4) NOT NULL CHECK(quantity > 0), unit_cost NUMERIC(18,4) NOT NULL CHECK(unit_cost >= 0), line_total NUMERIC(18,2) NOT NULL CHECK(line_total >= 0),
  UNIQUE(purchase_return_id, purchase_invoice_item_id)
);

CREATE TABLE stock_movements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT, movement_type VARCHAR(20) NOT NULL CHECK(movement_type IN ('purchase','sale','sales_return','purchase_return','transfer_in','transfer_out','adjustment','reversal')),
  quantity_delta NUMERIC(18,4) NOT NULL CHECK(quantity_delta <> 0), source_type VARCHAR(24) NOT NULL, source_id BIGINT NOT NULL, source_line_id BIGINT NOT NULL,
  reversal_of_id BIGINT REFERENCES stock_movements(id) ON DELETE RESTRICT, idempotency_key VARCHAR(120) NOT NULL UNIQUE,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source_type, source_id, source_line_id, movement_type)
);
CREATE INDEX stock_movements_store_product_date_idx ON stock_movements(store_id, product_id, created_at DESC);
CREATE INDEX stock_movements_source_idx ON stock_movements(source_type, source_id);

CREATE TABLE audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, store_id BIGINT REFERENCES stores(id) ON DELETE RESTRICT,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL, action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(80) NOT NULL, entity_id BIGINT, before_data JSONB, after_data JSONB,
  request_id VARCHAR(100), ip_address INET, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_store_date_idx ON audit_logs(store_id, created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs(entity_type, entity_id, created_at DESC);

-- Inventory ledger is authoritative: balances are maintained by the movement trigger.
CREATE FUNCTION apply_stock_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resulting NUMERIC(18,4);
BEGIN
  INSERT INTO inventory_balances(store_id, product_id, quantity) VALUES(NEW.store_id, NEW.product_id, 0)
    ON CONFLICT(store_id, product_id) DO NOTHING;
  UPDATE inventory_balances SET quantity = quantity + NEW.quantity_delta, updated_at = now()
    WHERE store_id = NEW.store_id AND product_id = NEW.product_id AND quantity + NEW.quantity_delta >= 0
    RETURNING quantity INTO resulting;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient stock for store %, product %', NEW.store_id, NEW.product_id USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_movement_apply AFTER INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();

-- Serialized checks prevent concurrent allocations from exceeding payment or invoice totals.
CREATE FUNCTION validate_payment_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payments%ROWTYPE; inv_total NUMERIC(18,2); allocated NUMERIC(18,2);
BEGIN
  SELECT * INTO p FROM payments WHERE id=NEW.payment_id FOR UPDATE;
  IF p.status <> 'posted' THEN RAISE EXCEPTION 'payment must be posted before allocation' USING ERRCODE='23514'; END IF;
  IF NEW.direction='in' THEN
    SELECT total INTO inv_total FROM sales_invoices WHERE id=NEW.sales_invoice_id AND store_id=NEW.store_id AND status='posted' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'sales invoice must be posted in the same store' USING ERRCODE='23514'; END IF;
    SELECT COALESCE(sum(amount),0) INTO allocated FROM payment_allocations WHERE payment_id=NEW.payment_id AND id<>COALESCE(NEW.id,0);
    IF allocated + NEW.amount > p.amount THEN RAISE EXCEPTION 'allocations exceed payment amount' USING ERRCODE='23514'; END IF;
    SELECT COALESCE(sum(amount),0) INTO allocated FROM payment_allocations WHERE sales_invoice_id=NEW.sales_invoice_id AND id<>COALESCE(NEW.id,0);
  ELSE
    SELECT total INTO inv_total FROM purchase_invoices WHERE id=NEW.purchase_invoice_id AND store_id=NEW.store_id AND status='posted' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'purchase invoice must be posted in the same store' USING ERRCODE='23514'; END IF;
    SELECT COALESCE(sum(amount),0) INTO allocated FROM payment_allocations WHERE payment_id=NEW.payment_id AND id<>COALESCE(NEW.id,0);
    IF allocated + NEW.amount > p.amount THEN RAISE EXCEPTION 'allocations exceed payment amount' USING ERRCODE='23514'; END IF;
    SELECT COALESCE(sum(amount),0) INTO allocated FROM payment_allocations WHERE purchase_invoice_id=NEW.purchase_invoice_id AND id<>COALESCE(NEW.id,0);
  END IF;
  IF allocated + NEW.amount > inv_total THEN RAISE EXCEPTION 'allocations exceed invoice total' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_allocation_validate BEFORE INSERT OR UPDATE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION validate_payment_allocation();

CREATE FUNCTION block_posted_document_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('posted','reversed') THEN RAISE EXCEPTION 'posted documents cannot be deleted; reverse them instead' USING ERRCODE='23514'; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER sales_invoice_no_delete BEFORE DELETE ON sales_invoices FOR EACH ROW EXECUTE FUNCTION block_posted_document_delete();
CREATE TRIGGER purchase_invoice_no_delete BEFORE DELETE ON purchase_invoices FOR EACH ROW EXECUTE FUNCTION block_posted_document_delete();
CREATE TRIGGER sales_return_no_delete BEFORE DELETE ON sales_returns FOR EACH ROW EXECUTE FUNCTION block_posted_document_delete();
CREATE TRIGGER purchase_return_no_delete BEFORE DELETE ON purchase_returns FOR EACH ROW EXECUTE FUNCTION block_posted_document_delete();
CREATE TRIGGER transfer_no_delete BEFORE DELETE ON stock_transfers FOR EACH ROW EXECUTE FUNCTION block_posted_document_delete();

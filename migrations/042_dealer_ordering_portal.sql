-- Dealer identity extends users and links to the shared customer ledger where configured.
CREATE TABLE dealer_profiles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  business_name VARCHAR(180) NOT NULL,
  contact_name VARCHAR(150),
  mobile VARCHAR(30), email VARCHAR(254),
  billing_address JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivery_address JSONB NOT NULL DEFAULT '{}'::jsonb,
  tax_id VARCHAR(40),
  store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  customer_id BIGINT REFERENCES customers(id) ON DELETE RESTRICT,
  account_status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK(account_status IN ('active','on_hold','closed')),
  credit_limit NUMERIC(18,2) CHECK(credit_limit IS NULL OR credit_limit>=0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(id,store_id)
);
CREATE INDEX dealer_profiles_store_idx ON dealer_profiles(store_id,account_status);

CREATE TABLE dealer_delivery_addresses (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dealer_id BIGINT NOT NULL REFERENCES dealer_profiles(id) ON DELETE RESTRICT,
  label VARCHAR(80) NOT NULL, address JSONB NOT NULL,
  contact_name VARCHAR(150), mobile VARCHAR(30), is_default BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dealer_one_default_delivery_idx ON dealer_delivery_addresses(dealer_id) WHERE is_default AND is_active;

CREATE SEQUENCE dealer_order_number_seq;
CREATE TABLE dealer_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_number VARCHAR(64) NOT NULL UNIQUE,
  dealer_id BIGINT NOT NULL REFERENCES dealer_profiles(id) ON DELETE RESTRICT,
  store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING_REVIEW' CHECK(status IN ('PENDING_REVIEW','QUOTATION_SENT','AWAITING_DEALER_ACCEPTANCE','CONFIRMED','PROCESSING','READY_TO_DISPATCH','SHIPPED','DELIVERED','COMPLETED','REJECTED','CANCELLED')),
  quotation_number VARCHAR(64), quotation_version INTEGER NOT NULL DEFAULT 0 CHECK(quotation_version>=0),
  subtotal NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(subtotal>=0), transport_charge NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(transport_charge>=0), discount_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(discount_amount>=0), tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(tax_amount>=0), grand_total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(grand_total>=0),
  payment_method VARCHAR(24), payment_status VARCHAR(24) NOT NULL DEFAULT 'UNPAID' CHECK(payment_status IN ('UNPAID','PENDING_VERIFICATION','PARTIALLY_PAID','PAID','REFUND_PENDING','REFUNDED')),
  billing_address_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb, delivery_address_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT, created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ,
  FOREIGN KEY(dealer_id,store_id) REFERENCES dealer_profiles(id,store_id) ON DELETE RESTRICT,
  UNIQUE(id,store_id)
);
CREATE INDEX dealer_orders_scope_idx ON dealer_orders(dealer_id,store_id,created_at DESC);
CREATE INDEX dealer_orders_store_status_idx ON dealer_orders(store_id,status,created_at DESC);

CREATE TABLE dealer_order_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES dealer_orders(id) ON DELETE RESTRICT,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  unit_id BIGINT NOT NULL REFERENCES units_of_measure(id) ON DELETE RESTRICT,
  quantity NUMERIC(18,4) NOT NULL CHECK(quantity>0),
  dealer_price_snapshot NUMERIC(18,4) NOT NULL CHECK(dealer_price_snapshot>=0),
  product_name_snapshot VARCHAR(200) NOT NULL, unit_snapshot VARCHAR(80) NOT NULL,
  line_subtotal NUMERIC(18,2) NOT NULL CHECK(line_subtotal>=0),
  tax_snapshot NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK(tax_snapshot BETWEEN 0 AND 100),
  line_total NUMERIC(18,2) NOT NULL CHECK(line_total>=0)
);
CREATE INDEX dealer_order_items_order_idx ON dealer_order_items(order_id,id);

CREATE TABLE dealer_order_status_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES dealer_orders(id) ON DELETE RESTRICT,
  previous_status VARCHAR(32), new_status VARCHAR(32) NOT NULL,
  changed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  remarks TEXT, changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dealer_order_history_idx ON dealer_order_status_history(order_id,changed_at,id);

CREATE TABLE dealer_order_quotations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES dealer_orders(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK(version>0), quotation_number VARCHAR(64) NOT NULL,
  subtotal NUMERIC(18,2) NOT NULL CHECK(subtotal>=0), transport_charge NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(transport_charge>=0),
  discount_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(discount_amount>=0), tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(tax_amount>=0), grand_total NUMERIC(18,2) NOT NULL CHECK(grand_total>=0),
  items_snapshot JSONB NOT NULL CHECK(jsonb_typeof(items_snapshot)='array'), billing_address_snapshot JSONB NOT NULL, delivery_address_snapshot JSONB NOT NULL,
  valid_until DATE, created_by BIGINT REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(order_id,version), UNIQUE(quotation_number)
);

CREATE FUNCTION guard_dealer_order_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed BOOLEAN;
BEGIN
 IF NEW.status=OLD.status THEN RETURN NEW; END IF;
 allowed := CASE OLD.status
  WHEN 'PENDING_REVIEW' THEN NEW.status IN ('QUOTATION_SENT','REJECTED','CANCELLED')
  WHEN 'QUOTATION_SENT' THEN NEW.status IN ('AWAITING_DEALER_ACCEPTANCE','CONFIRMED','REJECTED','CANCELLED')
  WHEN 'AWAITING_DEALER_ACCEPTANCE' THEN NEW.status IN ('CONFIRMED','REJECTED','CANCELLED')
  WHEN 'CONFIRMED' THEN NEW.status IN ('PROCESSING','CANCELLED')
  WHEN 'PROCESSING' THEN NEW.status IN ('READY_TO_DISPATCH','CANCELLED')
  WHEN 'READY_TO_DISPATCH' THEN NEW.status IN ('SHIPPED','CANCELLED')
  WHEN 'SHIPPED' THEN NEW.status='DELIVERED'
  WHEN 'DELIVERED' THEN NEW.status='COMPLETED'
  ELSE FALSE END;
 IF NOT allowed THEN RAISE EXCEPTION 'invalid dealer order status transition: % to %',OLD.status,NEW.status USING ERRCODE='23514'; END IF;
 IF NEW.status='CONFIRMED' THEN NEW.confirmed_at:=COALESCE(NEW.confirmed_at,now()); END IF;
 IF NEW.status='CANCELLED' THEN NEW.cancelled_at:=COALESCE(NEW.cancelled_at,now()); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dealer_order_transition_guard BEFORE UPDATE OF status ON dealer_orders FOR EACH ROW EXECUTE FUNCTION guard_dealer_order_transition();

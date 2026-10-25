-- Bridge the legacy bonus workflow to billing without changing configured rates or existing records.
CREATE TABLE IF NOT EXISTS sales_bonus_product_config (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_name VARCHAR(200) NOT NULL UNIQUE,
  default_cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  default_bonus_percentage NUMERIC(5,2) NOT NULL DEFAULT 0,
  unit_label VARCHAR(40) NOT NULL DEFAULT 'Box',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sales_bonus_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  selected_user_type VARCHAR(30) NOT NULL,
  total_quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_selling_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_gross_profit NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_gross_bonus NUMERIC(12,2) NOT NULL DEFAULT 0,
  final_user_bonus NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total_amount_paid >= 0),
  payment_method VARCHAR(10) CHECK (payment_method IN ('UPI', 'CASH')),
  is_fully_paid BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sales_bonus_record_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sales_bonus_record_id BIGINT NOT NULL REFERENCES sales_bonus_records(id) ON DELETE CASCADE,
  product_name VARCHAR(200) NOT NULL,
  cost_price NUMERIC(12,2) NOT NULL,
  selling_price NUMERIC(12,2) NOT NULL,
  quantity NUMERIC(12,2) NOT NULL,
  total_cost NUMERIC(12,2) NOT NULL,
  total_selling_amount NUMERIC(12,2) NOT NULL,
  gross_profit NUMERIC(12,2) NOT NULL,
  bonus_percentage NUMERIC(5,2) NOT NULL,
  gross_bonus NUMERIC(12,2) NOT NULL,
  user_bonus NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE sales_bonus_product_config
  ADD COLUMN IF NOT EXISTS product_id BIGINT REFERENCES products(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS eligible_category_id BIGINT REFERENCES product_categories(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS sales_bonus_product_config_product_unique
  ON sales_bonus_product_config(product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sales_bonus_product_config_category_idx
  ON sales_bonus_product_config(eligible_category_id) WHERE is_active;

ALTER TABLE sales_invoices
  ADD COLUMN IF NOT EXISTS salesperson_user_id BIGINT REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE sales_bonus_records
  ADD COLUMN IF NOT EXISTS source_sales_invoice_id BIGINT REFERENCES sales_invoices(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS store_id BIGINT REFERENCES stores(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS sales_bonus_invoice_user_unique
  ON sales_bonus_records(source_sales_invoice_id,user_id) WHERE source_sales_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sales_bonus_store_created_idx
  ON sales_bonus_records(store_id,created_at DESC) WHERE store_id IS NOT NULL;
ALTER TABLE sales_bonus_record_items
  ADD COLUMN IF NOT EXISTS source_sales_invoice_item_id BIGINT REFERENCES sales_invoice_items(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS category_id_snapshot BIGINT,
  ADD COLUMN IF NOT EXISTS unit_label_snapshot VARCHAR(80);

CREATE TABLE IF NOT EXISTS sales_bonus_integration_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id=1),
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  eligibility_basis VARCHAR(24) NOT NULL DEFAULT 'invoice_finalized'
    CHECK (eligibility_basis IN ('invoice_finalized','fully_collected')),
  updated_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO sales_bonus_integration_settings(id) VALUES(1) ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS sales_bonus_adjustments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sales_bonus_record_id BIGINT NOT NULL REFERENCES sales_bonus_records(id) ON DELETE RESTRICT,
  store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  source_type VARCHAR(24) NOT NULL CHECK(source_type IN ('sales_return_item','invoice_reversal')),
  source_id BIGINT NOT NULL,
  source_item_id BIGINT NOT NULL DEFAULT 0,
  amount NUMERIC(12,2) NOT NULL CHECK(amount <> 0),
  reason TEXT NOT NULL,
  created_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(sales_bonus_record_id,source_type,source_id,source_item_id)
);
CREATE INDEX IF NOT EXISTS sales_bonus_adjustment_record_idx
  ON sales_bonus_adjustments(sales_bonus_record_id,created_at,id);
CREATE INDEX IF NOT EXISTS sales_bonus_adjustment_store_idx
  ON sales_bonus_adjustments(store_id,created_at DESC);

CREATE TABLE IF NOT EXISTS sales_invoice_bonus_recipients (
  sales_invoice_id BIGINT NOT NULL REFERENCES sales_invoices(id) ON DELETE RESTRICT,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  user_type VARCHAR(30) NOT NULL CHECK(user_type IN ('Salesperson','Tile Mistire')),
  created_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(sales_invoice_id,user_id)
);

-- Preserve each billing item's category and unit at draft save time for later eligibility checks.
UPDATE sales_invoice_items li SET product_snapshot=li.product_snapshot || jsonb_build_object('categoryId',p.category_id)
FROM products p WHERE p.id=li.product_id AND NOT (li.product_snapshot ? 'categoryId');

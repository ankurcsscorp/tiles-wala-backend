ALTER TABLE dealer_orders
  ADD COLUMN expected_delivery_date DATE,
  ADD COLUMN stock_confirmed_at TIMESTAMPTZ,
  ADD COLUMN stock_confirmed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN payment_terms_confirmed_at TIMESTAMPTZ,
  ADD COLUMN payment_terms_confirmed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT dealer_orders_stock_confirmation_pair CHECK ((stock_confirmed_at IS NULL)=(stock_confirmed_by IS NULL)),
  ADD CONSTRAINT dealer_orders_terms_confirmation_pair CHECK ((payment_terms_confirmed_at IS NULL)=(payment_terms_confirmed_by IS NULL));

ALTER TABLE dealer_order_quotations ADD COLUMN expected_delivery_date DATE;

ALTER TABLE dealer_order_notifications DROP CONSTRAINT dealer_order_notifications_event_type_check;
ALTER TABLE dealer_order_notifications ADD CONSTRAINT dealer_order_notifications_event_type_check
  CHECK(event_type IN ('QUOTATION_REVISED','ORDER_CANCELLED','ORDER_STATUS_UPDATED','ADMIN_MESSAGE','CLARIFICATION_REQUEST','STOCK_CONFIRMED','PAYMENT_TERMS_CONFIRMED'));

CREATE TABLE dealer_order_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES dealer_orders(id) ON DELETE RESTRICT,
  message_type VARCHAR(32) NOT NULL CHECK(message_type IN ('ADMIN_MESSAGE','CLARIFICATION_REQUEST','STOCK_CONFIRMED','STOCK_SHORTAGE','PAYMENT_TERMS_CONFIRMED')),
  body TEXT NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 2000),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(metadata)='object'),
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dealer_order_messages_timeline_idx ON dealer_order_messages(order_id,created_at,id);

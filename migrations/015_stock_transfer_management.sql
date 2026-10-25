-- Dispatch/receipt workflow with an explicit, separately reconciled in-transit ledger.
DROP TRIGGER IF EXISTS transfer_lifecycle ON stock_transfers;
DROP TRIGGER IF EXISTS stock_transfer_stock_post ON stock_transfers;

DO $$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='stock_transfers'::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP EXECUTE format('ALTER TABLE stock_transfers DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;

ALTER TABLE stock_transfers
  ADD COLUMN notes TEXT,
  ADD COLUMN approved_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN dispatched_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN dispatched_at TIMESTAMPTZ,
  ADD COLUMN received_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN received_at TIMESTAMPTZ,
  ADD COLUMN dispatch_request_key VARCHAR(120) UNIQUE,
  ADD COLUMN dispatch_fingerprint CHAR(64),
  ADD CONSTRAINT stock_transfers_status_check CHECK(status IN ('draft','dispatched','received','cancelled','reversed')) NOT VALID;

ALTER TABLE stock_transfer_items
  ADD COLUMN dispatched_quantity NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK(dispatched_quantity>=0 AND dispatched_quantity<=quantity),
  ADD COLUMN unit_factor_to_base NUMERIC(18,8),
  ADD COLUMN dispatched_base_quantity NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK(dispatched_base_quantity>=0);

CREATE TABLE stock_transfer_receipts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id BIGINT NOT NULL UNIQUE REFERENCES stock_transfers(id) ON DELETE RESTRICT,
  idempotency_key VARCHAR(120) NOT NULL UNIQUE,
  request_fingerprint CHAR(64),
  received_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE stock_transfer_receipt_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id BIGINT NOT NULL REFERENCES stock_transfer_receipts(id) ON DELETE RESTRICT,
  transfer_item_id BIGINT NOT NULL UNIQUE REFERENCES stock_transfer_items(id) ON DELETE RESTRICT,
  received_quantity NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK(received_quantity>=0),
  damaged_quantity NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK(damaged_quantity>=0),
  shortage_quantity NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK(shortage_quantity>=0),
  received_base_quantity NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK(received_base_quantity>=0),
  damaged_base_quantity NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK(damaged_base_quantity>=0),
  shortage_base_quantity NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK(shortage_base_quantity>=0),
  discrepancy_reason TEXT,
  CHECK((damaged_quantity=0 AND shortage_quantity=0) OR length(btrim(COALESCE(discrepancy_reason,''))) BETWEEN 3 AND 1000)
);
CREATE INDEX stock_transfer_receipts_received_idx ON stock_transfer_receipts(received_at DESC);

-- Append-only ledger for the virtual IN_TRANSIT inventory location. Dispatch adds
-- to transit; receipt, shortage, and damage dispositions remove stock from it.
CREATE TABLE stock_transfer_transit_movements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id BIGINT NOT NULL REFERENCES stock_transfers(id) ON DELETE RESTRICT,
  transfer_item_id BIGINT NOT NULL REFERENCES stock_transfer_items(id) ON DELETE RESTRICT,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  movement_type VARCHAR(16) NOT NULL CHECK(movement_type IN ('dispatched','received','damaged','shortage')),
  quantity_delta NUMERIC(18,4) NOT NULL CHECK(quantity_delta<>0),
  idempotency_key VARCHAR(160) NOT NULL UNIQUE,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK((movement_type='dispatched' AND quantity_delta>0) OR (movement_type<>'dispatched' AND quantity_delta<0)),
  UNIQUE(transfer_id,transfer_item_id,movement_type)
);
CREATE INDEX stock_transfer_transit_product_idx ON stock_transfer_transit_movements(product_id,created_at DESC);
CREATE INDEX stock_transfer_transit_transfer_idx ON stock_transfer_transit_movements(transfer_id,transfer_item_id);

CREATE FUNCTION guard_stock_transfer_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_data JSONB; new_data JSONB;
BEGIN
  IF OLD.status='draft' AND NEW.status IN ('draft','dispatched','cancelled') THEN
    IF NEW.status='dispatched' AND (NEW.dispatched_at IS NULL OR NEW.dispatched_by IS NULL OR NEW.approved_by IS NULL) THEN
      RAISE EXCEPTION 'dispatch requires dispatcher, approver, and timestamp' USING ERRCODE='23514';
    END IF;
    IF NEW.status='dispatched' AND ((SELECT count(*) FROM stock_transfer_items WHERE transfer_id=NEW.id AND dispatched_quantity>0)<>
       (SELECT count(*) FROM stock_transfer_items WHERE transfer_id=NEW.id) OR
       (SELECT count(*) FROM stock_transfer_transit_movements WHERE transfer_id=NEW.id AND movement_type='dispatched')<>
       (SELECT count(*) FROM stock_transfer_items WHERE transfer_id=NEW.id) OR
       (SELECT count(*) FROM stock_movements WHERE source_type='stock_transfer' AND source_id=NEW.id AND movement_type='transfer_out')<>
       (SELECT count(*) FROM stock_transfer_items WHERE transfer_id=NEW.id) OR
       EXISTS(SELECT 1 FROM stock_transfer_items i WHERE i.transfer_id=NEW.id AND
         COALESCE(-(SELECT SUM(m.quantity_delta) FROM stock_movements m WHERE m.source_type='stock_transfer' AND m.source_id=NEW.id AND m.source_line_id=i.id AND m.movement_type='transfer_out'),0)<>i.dispatched_base_quantity) OR
       EXISTS(SELECT 1 FROM stock_transfer_items i WHERE i.transfer_id=NEW.id AND
         COALESCE((SELECT SUM(m.quantity_delta) FROM stock_transfer_transit_movements m WHERE m.transfer_id=NEW.id AND m.transfer_item_id=i.id AND m.movement_type='dispatched'),0)<>i.dispatched_base_quantity)) THEN
      RAISE EXCEPTION 'dispatch must post each transfer line to stock and transit ledgers' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='dispatched' AND NEW.status IN ('dispatched','received') THEN
    IF NEW.status='received' THEN
      IF NEW.received_at IS NULL OR NEW.received_by IS NULL THEN
        RAISE EXCEPTION 'receipt requires receiver and timestamp' USING ERRCODE='23514';
      END IF;
      IF NOT EXISTS(SELECT 1 FROM stock_transfer_receipts WHERE transfer_id=NEW.id) OR
         (SELECT count(*) FROM stock_transfer_items WHERE transfer_id=NEW.id)<>
         (SELECT count(*) FROM stock_transfer_receipt_items ri JOIN stock_transfer_receipts r ON r.id=ri.receipt_id WHERE r.transfer_id=NEW.id) OR
         EXISTS(SELECT 1 FROM stock_transfer_items i JOIN stock_transfer_receipts r ON r.transfer_id=i.transfer_id
           LEFT JOIN stock_transfer_receipt_items ri ON ri.receipt_id=r.id AND ri.transfer_item_id=i.id
           WHERE i.transfer_id=NEW.id AND COALESCE(ri.received_base_quantity+ri.damaged_base_quantity+ri.shortage_base_quantity,0)<>i.dispatched_base_quantity) OR
         EXISTS(SELECT 1 FROM stock_transfer_items i JOIN stock_transfer_receipts r ON r.transfer_id=i.transfer_id
           JOIN stock_transfer_receipt_items ri ON ri.receipt_id=r.id AND ri.transfer_item_id=i.id WHERE i.transfer_id=NEW.id AND
           COALESCE((SELECT SUM(m.quantity_delta) FROM stock_movements m WHERE m.source_type='stock_transfer_receipt' AND m.source_id=NEW.id AND m.source_line_id=i.id AND m.movement_type='transfer_in'),0)<>ri.received_base_quantity) OR
         EXISTS(SELECT 1 FROM stock_transfer_transit_movements WHERE transfer_id=NEW.id GROUP BY transfer_item_id HAVING SUM(quantity_delta)<>0) THEN
        RAISE EXCEPTION 'receipt must reconcile every dispatched transfer line' USING ERRCODE='23514';
      END IF;
    END IF;
    old_data:=to_jsonb(OLD)-'status'-'updated_at'-'received_at'-'received_by';
    new_data:=to_jsonb(NEW)-'status'-'updated_at'-'received_at'-'received_by';
    IF old_data<>new_data THEN RAISE EXCEPTION 'dispatched transfer details are immutable' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF to_jsonb(OLD)<>to_jsonb(NEW) THEN RAISE EXCEPTION 'received and cancelled transfers are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION protect_transfer_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'transfer receipt and transit history is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER transfer_receipt_immutable BEFORE UPDATE OR DELETE ON stock_transfer_receipts FOR EACH ROW EXECUTE FUNCTION protect_transfer_history();
CREATE TRIGGER transfer_receipt_item_immutable BEFORE UPDATE OR DELETE ON stock_transfer_receipt_items FOR EACH ROW EXECUTE FUNCTION protect_transfer_history();
CREATE TRIGGER transfer_transit_movement_immutable BEFORE UPDATE OR DELETE ON stock_transfer_transit_movements FOR EACH ROW EXECUTE FUNCTION protect_transfer_history();

-- Preserve the prior one-step transfer records as completed receipts. Their
-- existing paired store movements already represent a completed transfer.
INSERT INTO stock_transfer_receipts(transfer_id,idempotency_key,received_by,received_at,notes)
SELECT id,'legacy-transfer-receipt:'||id,COALESCE(created_by,(SELECT id FROM users ORDER BY id LIMIT 1)),COALESCE(posted_at,updated_at,now()),'Migrated from completed transfer'
FROM stock_transfers WHERE status='posted';
DROP TRIGGER IF EXISTS transfer_item_draft_only ON stock_transfer_items;
UPDATE stock_transfer_items i SET dispatched_quantity=i.quantity,
  unit_factor_to_base=COALESCE((SELECT -m.quantity_delta/NULLIF(i.quantity,0) FROM stock_movements m WHERE m.source_type='stock_transfer' AND m.source_id=t.id AND m.source_line_id=i.id AND m.movement_type='transfer_out'),
    (SELECT CASE WHEN i.unit_id=p.base_unit_id THEN 1 ELSE c.factor_to_base END FROM products p LEFT JOIN product_unit_conversions c ON c.product_id=p.id AND c.unit_id=i.unit_id WHERE p.id=i.product_id)),
  dispatched_base_quantity=COALESCE((SELECT -m.quantity_delta FROM stock_movements m WHERE m.source_type='stock_transfer' AND m.source_id=t.id AND m.source_line_id=i.id AND m.movement_type='transfer_out'),
    i.quantity*(SELECT CASE WHEN i.unit_id=p.base_unit_id THEN 1 ELSE c.factor_to_base END FROM products p LEFT JOIN product_unit_conversions c ON c.product_id=p.id AND c.unit_id=i.unit_id WHERE p.id=i.product_id))
FROM stock_transfers t WHERE t.id=i.transfer_id AND t.status='posted';
INSERT INTO stock_transfer_receipt_items(receipt_id,transfer_item_id,received_quantity,received_base_quantity)
SELECT r.id,i.id,i.quantity,i.dispatched_base_quantity FROM stock_transfer_receipts r JOIN stock_transfer_items i ON i.transfer_id=r.transfer_id;
UPDATE stock_transfers SET status='received',dispatched_at=COALESCE(posted_at,updated_at,now()),received_at=COALESCE(posted_at,updated_at,now()),dispatched_by=created_by,received_by=created_by,approved_by=created_by
WHERE status='posted';
CREATE TRIGGER transfer_item_draft_only BEFORE INSERT OR UPDATE OR DELETE ON stock_transfer_items FOR EACH ROW EXECUTE FUNCTION guard_billing_document_item_write();
CREATE TRIGGER transfer_lifecycle BEFORE UPDATE ON stock_transfers FOR EACH ROW EXECUTE FUNCTION guard_stock_transfer_update();
ALTER TABLE stock_transfers VALIDATE CONSTRAINT stock_transfers_status_check;

CREATE INDEX stock_transfers_from_date_idx ON stock_transfers(from_store_id,transfer_date DESC,id DESC);
CREATE INDEX stock_transfers_to_date_idx ON stock_transfers(to_store_id,transfer_date DESC,id DESC);
CREATE INDEX stock_transfer_items_product_idx ON stock_transfer_items(product_id,transfer_id);

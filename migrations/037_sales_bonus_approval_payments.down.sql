DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM sales_bonus_payments) THEN
    RAISE EXCEPTION 'Sales bonus payment history exists; use a forward correction';
  END IF;
END $$;
DROP INDEX IF EXISTS sales_bonus_payments_record_idx;
DROP TABLE sales_bonus_payments;
ALTER TABLE sales_bonus_adjustments DROP CONSTRAINT IF EXISTS sales_bonus_adjustments_source_type_check;
ALTER TABLE sales_bonus_adjustments ADD CONSTRAINT sales_bonus_adjustments_source_type_check
  CHECK(source_type IN ('sales_return_item','invoice_reversal','sales_return_reversal'));
ALTER TABLE sales_bonus_records
  DROP COLUMN recipient_name_snapshot,
  DROP COLUMN approval_note,
  DROP COLUMN approved_at,
  DROP COLUMN approved_by,
  DROP COLUMN payable_amount,
  DROP COLUMN approved_bonus;

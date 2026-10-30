DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM sales_bonus_records WHERE admin_payment_override=TRUE AND total_amount_paid>0) THEN
    RAISE EXCEPTION 'Sales bonus payments used the admin collection override; use a forward correction';
  END IF;
END $$;

ALTER TABLE sales_bonus_records
  DROP COLUMN IF EXISTS admin_payment_override;

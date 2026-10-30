DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM sales_bonus_records WHERE approval_risk=TRUE) THEN
    RAISE EXCEPTION 'Risk approvals exist; retain the approval reason and snapshot or use a forward correction';
  END IF;
END $$;

ALTER TABLE sales_bonus_records
  DROP COLUMN unpaid_invoice_amount_at_approval,
  DROP COLUMN approval_risk;

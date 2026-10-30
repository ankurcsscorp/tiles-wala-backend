-- Automatically calculate bonuses from posted invoices for their selected referral.
UPDATE sales_bonus_integration_settings
SET is_enabled=TRUE,updated_at=now()
WHERE id=1;

-- Existing bonus records remain as financial history; this only disables future automatic processing.
UPDATE sales_bonus_integration_settings
SET is_enabled=FALSE,updated_at=now()
WHERE id=1;

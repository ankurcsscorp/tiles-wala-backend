DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM role_permission_settings WHERE user_type = 'Dealer') THEN
    RAISE EXCEPTION 'Dealer role permissions exist; remove or migrate them before rolling back';
  END IF;
END $$;

ALTER TABLE role_permission_settings
  DROP CONSTRAINT role_permission_settings_user_type_check,
  ADD CONSTRAINT role_permission_settings_user_type_check
    CHECK (user_type IN ('Salesperson', 'Tile Mistire', 'Plumber Mistiri'));

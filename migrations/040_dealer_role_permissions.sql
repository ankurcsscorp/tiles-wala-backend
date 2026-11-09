ALTER TABLE role_permission_settings
  DROP CONSTRAINT role_permission_settings_user_type_check,
  ADD CONSTRAINT role_permission_settings_user_type_check
    CHECK (user_type IN ('Salesperson', 'Tile Mistire', 'Plumber Mistiri', 'Dealer'));

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM users WHERE NOT is_active OR permission_overrides<>'{}'::jsonb)
 OR EXISTS(SELECT 1 FROM role_permission_settings) THEN
  RAISE EXCEPTION 'Export and explicitly clear configured access restrictions before rollback';
 END IF;
END $$;
DROP TABLE role_permission_settings;
ALTER TABLE users DROP COLUMN permission_overrides,DROP COLUMN is_active;

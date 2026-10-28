ALTER TABLE users
 ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE,
 ADD COLUMN permission_overrides JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(permission_overrides)='object');
CREATE TABLE role_permission_settings (
 user_type VARCHAR(30) PRIMARY KEY CHECK(user_type IN ('Salesperson','Tile Mistire','Plumber Mistiri')),
 permissions JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(permissions)='object'),
 updated_by BIGINT REFERENCES users(id), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Defaults live in the application; existing identities, assignments and access remain intact.

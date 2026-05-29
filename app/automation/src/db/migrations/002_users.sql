-- Alert Insurance — RBAC user table
-- Roles: super_admin (full control) | chat_user (chat only)

CREATE TABLE IF NOT EXISTS app_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('super_admin', 'chat_user')),
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_by    UUID REFERENCES app_users(id) ON DELETE SET NULL,
  last_login    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_users_username_idx ON app_users(username);
CREATE INDEX IF NOT EXISTS app_users_role_idx     ON app_users(role);

-- Link audit events to users (backfill-safe: nullable FK)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'audit_events' AND column_name = 'actor_role'
  ) THEN
    ALTER TABLE audit_events ADD COLUMN actor_role TEXT;
  END IF;
END $$;

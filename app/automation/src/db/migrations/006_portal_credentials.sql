-- Portal credentials vault — AES-256-GCM encrypted per-portal credentials.
-- password and extra fields are encrypted at the application layer before insert.

CREATE TABLE IF NOT EXISTS portal_credentials (
  portal_id    TEXT PRIMARY KEY,
  username     TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  iv           TEXT NOT NULL,
  auth_tag     TEXT NOT NULL,
  extra_enc    TEXT,
  extra_iv     TEXT,
  extra_tag    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

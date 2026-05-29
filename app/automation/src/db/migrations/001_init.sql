-- Alert Insurance Automation — initial schema

-- ── Insurance company registry ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insurance_companies (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  logo_url             TEXT NOT NULL DEFAULT '',
  insurance_types      TEXT[] NOT NULL DEFAULT '{}',
  playbook_version     TEXT NOT NULL DEFAULT '1.0',
  enabled              BOOLEAN NOT NULL DEFAULT true,
  credential_secret_key TEXT NOT NULL DEFAULT '',
  last_tested_at       TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Audit events (append-only, indefinite retention) ──────────────────────
CREATE TABLE IF NOT EXISTS audit_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     TEXT NOT NULL,
  user_email  TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  portal_id   TEXT,
  ins_type    TEXT,
  action      TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  duration_ms INTEGER,
  meta        JSONB
);

CREATE INDEX IF NOT EXISTS idx_audit_session  ON audit_events (session_id);
CREATE INDEX IF NOT EXISTS idx_audit_user     ON audit_events (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts       ON audit_events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action   ON audit_events (action);

-- ── Quote results (7-day TTL for chat users) ──────────────────────────────
CREATE TABLE IF NOT EXISTS quote_results (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  portal_id      TEXT NOT NULL,
  portal_name    TEXT NOT NULL DEFAULT '',
  ins_type       TEXT NOT NULL,
  reg_number     TEXT,
  vehicle_make   TEXT,
  vehicle_model  TEXT,
  premium        NUMERIC,
  idv            NUMERIC,
  quote_data     JSONB NOT NULL DEFAULT '{}',
  screenshot_key TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days')
);

CREATE INDEX IF NOT EXISTS idx_quotes_user      ON quote_results (user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_session   ON quote_results (session_id);
CREATE INDEX IF NOT EXISTS idx_quotes_reg       ON quote_results (reg_number);
CREATE INDEX IF NOT EXISTS idx_quotes_expires   ON quote_results (expires_at);

-- ── Session state (lightweight, backed by in-memory Map for Phase 1) ──────
-- Phase 2 will move this to Redis. For now, sessions live in-process.
-- This table serves as a persistent backup for crash recovery.
CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  state_json    JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 minutes')
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- ── Seed default companies (can be updated via admin panel) ───────────────
INSERT INTO insurance_companies (id, name, insurance_types, enabled, credential_secret_key)
VALUES
  ('bajaj_motor',   'Bajaj Allianz Motor Insurance', ARRAY['motor'],           false, 'bajaj_motor_creds'),
  ('icici_motor',   'ICICI Lombard Motor Insurance', ARRAY['motor'],           false, 'icici_motor_creds'),
  ('hdfc_motor',    'HDFC Ergo Motor Insurance',     ARRAY['motor'],           false, 'hdfc_motor_creds'),
  ('tata_motor',    'Tata AIG Motor Insurance',      ARRAY['motor'],           false, 'tata_motor_creds'),
  ('star_health',   'Star Health Insurance',         ARRAY['health'],          false, 'star_health_creds'),
  ('niva_health',   'Niva Bupa Health Insurance',    ARRAY['health'],          false, 'niva_health_creds'),
  ('care_health',   'Care Health Insurance',         ARRAY['health'],          true,  'care_health_creds'),
  ('uiic',         'United India Insurance Company', ARRAY['motor'],           true,  'uiic_creds')
ON CONFLICT (id) DO NOTHING;

-- ── Portal session storage ────────────────────────────────────────────────
-- Stores Playwright `storageState` blobs captured from human-logged-in browser
-- sessions via the Alert Insurance Chrome extension. Used by the quote replay
-- flow to skip portal login entirely.
--
-- TTL: sessions persist indefinitely. They are deleted only when:
--   1. Replay detects the portal redirected back to login (session expired)
--   2. Admin explicitly revokes via the dashboard
--   3. A newer session for the same (user_id, portal_id) replaces it
--
-- Storage state structure (Playwright):
-- {
--   "cookies":   [{ name, value, domain, path, expires, httpOnly, secure, sameSite }, ...],
--   "origins":   [{ origin, localStorage: [{name, value}, ...] }, ...]
-- }

CREATE TABLE IF NOT EXISTS portal_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL,        -- admin who captured the session
  portal_id     TEXT NOT NULL,        -- e.g. 'uiic'
  storage_state JSONB NOT NULL,       -- Playwright storageState shape
  status        TEXT NOT NULL DEFAULT 'active',  -- active | expired | revoked
  last_used_at  TIMESTAMPTZ,          -- updated each time a replay uses it
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Latest active session per (user, portal) — used to find the session for replay
CREATE INDEX IF NOT EXISTS idx_portal_sessions_active
  ON portal_sessions (user_id, portal_id, created_at DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_portal_sessions_portal
  ON portal_sessions (portal_id, created_at DESC);

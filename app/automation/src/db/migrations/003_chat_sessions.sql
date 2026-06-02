-- Persist chat sessions so they survive backend restarts.
-- The in-memory Map remains the fast path; this table is a backing store.

CREATE TABLE IF NOT EXISTS chat_sessions (
  session_id   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  state        JSONB NOT NULL,
  history      JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '30 minutes'
);

CREATE INDEX IF NOT EXISTS chat_sessions_user_id_idx ON chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS chat_sessions_expires_at_idx ON chat_sessions(expires_at);

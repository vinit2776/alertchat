-- Persisted post-quote pending actions.
-- Lets the "Get Payment Link" button survive backend restarts: rather than
-- holding a live Playwright Page in memory, we save the storage state
-- (cookies + localStorage) and the URL the quote landed on. On /proceed
-- we acquire a fresh browser context, restore the state, navigate to the
-- URL, and run the buy_flow steps.

CREATE TABLE IF NOT EXISTS pending_buy_actions (
  session_id     TEXT NOT NULL,
  portal_id      TEXT NOT NULL,
  portal_name    TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  storage_state  JSONB NOT NULL,                            -- Playwright cookies + localStorage
  resume_url     TEXT NOT NULL,                             -- URL to navigate to before buy_flow
  status         TEXT NOT NULL DEFAULT 'quoted'
                 CHECK (status IN ('quoted','payment_pending','paid','expired')),
  quote_ref      TEXT,
  payment_url    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '10 minutes',
  PRIMARY KEY (session_id, portal_id)
);

CREATE INDEX IF NOT EXISTS pending_buy_actions_user_id_idx     ON pending_buy_actions(user_id);
CREATE INDEX IF NOT EXISTS pending_buy_actions_expires_at_idx  ON pending_buy_actions(expires_at);

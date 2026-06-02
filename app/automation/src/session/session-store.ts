import type Anthropic from '@anthropic-ai/sdk';
import { query, queryOne } from '../db/client';
import { SessionState } from '../types';

/**
 * Write-through session store: in-memory Map for speed,
 * PostgreSQL chat_sessions table for persistence across restarts.
 *
 * - Reads check cache first, fall back to DB and warm the cache.
 * - Writes update cache immediately, then persist to DB asynchronously.
 * - On boot, the cache is empty — it warms lazily as sessions are accessed.
 * - DB write failures are logged but don't break the request.
 */

export interface SessionEntry {
  state:   SessionState;
  history: Anthropic.MessageParam[];
}

const cache = new Map<string, SessionEntry>();

// 30 minutes — matches the DB TTL
const SESSION_TTL_MS = 30 * 60 * 1000;

// ── Read ──────────────────────────────────────────────────────────────────

export async function loadEntry(sessionId: string): Promise<SessionEntry | null> {
  // Cache hit?
  const cached = cache.get(sessionId);
  if (cached) {
    if (isExpired(cached.state)) {
      cache.delete(sessionId);
      return null;
    }
    return cached;
  }

  // Cache miss — try DB
  try {
    const row = await queryOne<{ state: any; history: any; expires_at: string }>(
      `SELECT state, history, expires_at
       FROM chat_sessions
       WHERE session_id = $1 AND expires_at > now()`,
      [sessionId],
    );
    if (!row) return null;

    const entry: SessionEntry = {
      state:   row.state as SessionState,
      history: (row.history as Anthropic.MessageParam[]) ?? [],
    };
    cache.set(sessionId, entry);
    return entry;
  } catch (err: any) {
    // DB unavailable — silently fall back to cache-only behaviour
    console.warn('[session-store] DB read failed:', err.message);
    return null;
  }
}

/** Sync getter — only returns cache hits. Use loadEntry() for full lookup. */
export function getCached(sessionId: string): SessionEntry | null {
  const cached = cache.get(sessionId);
  if (!cached) return null;
  if (isExpired(cached.state)) {
    cache.delete(sessionId);
    return null;
  }
  return cached;
}

// ── Write ─────────────────────────────────────────────────────────────────

export function saveEntry(entry: SessionEntry): void {
  cache.set(entry.state.sessionId, entry);
  // Persist asynchronously — don't block the request
  persistEntry(entry).catch(err => {
    console.warn('[session-store] DB write failed:', err.message);
  });
}

async function persistEntry(entry: SessionEntry): Promise<void> {
  const { state, history } = entry;
  await query(
    `INSERT INTO chat_sessions (session_id, user_id, state, history, expires_at)
     VALUES ($1, $2, $3, $4, now() + INTERVAL '30 minutes')
     ON CONFLICT (session_id) DO UPDATE
       SET state = EXCLUDED.state,
           history = EXCLUDED.history,
           updated_at = now(),
           expires_at = now() + INTERVAL '30 minutes'`,
    [
      state.sessionId,
      state.userId,
      JSON.stringify(state),
      JSON.stringify(history),
    ],
  );
}

// ── Delete ────────────────────────────────────────────────────────────────

export function deleteEntry(sessionId: string): void {
  cache.delete(sessionId);
  query('DELETE FROM chat_sessions WHERE session_id = $1', [sessionId])
    .catch(err => console.warn('[session-store] DB delete failed:', err.message));
}

// ── Stats ─────────────────────────────────────────────────────────────────

export function cacheSize(): number {
  return cache.size;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function isExpired(state: SessionState): boolean {
  return Date.now() - state.updatedAt > SESSION_TTL_MS;
}

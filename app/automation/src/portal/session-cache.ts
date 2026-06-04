/**
 * Portal session cache — DB-backed lookup of human-captured Playwright
 * `storageState` blobs keyed by (user, portal). Used by quote.routes.ts to
 * skip portal login when an active session exists.
 */

import { query, queryOne } from '../db/client';

export interface ActivePortalSession {
  id:            string;
  storageState:  unknown;       // Playwright StorageState
  capturedAt:    string;        // ISO timestamp
  lastUsedAt:    string | null;
}

/** Return the newest active session for this user+portal, or null. */
export async function findActiveSession(
  userId:   string,
  portalId: string,
): Promise<ActivePortalSession | null> {
  const row = await queryOne<{
    id: string; storage_state: unknown; created_at: string; last_used_at: string | null;
  }>(
    `SELECT id, storage_state, created_at, last_used_at
     FROM portal_sessions
     WHERE user_id = $1 AND portal_id = $2 AND status = 'active'
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, portalId]
  );
  if (!row) return null;
  return {
    id:           row.id,
    storageState: row.storage_state,
    capturedAt:   row.created_at,
    lastUsedAt:   row.last_used_at,
  };
}

/** List session status for every portal_id provided. */
export async function listSessionStatus(
  userId:    string,
  portalIds: string[],
): Promise<Array<{ portalId: string; sessionId: string | null; capturedAt: string | null; lastUsedAt: string | null }>> {
  if (portalIds.length === 0) return [];
  const rows = await query<{
    portal_id: string; id: string | null; created_at: string | null; last_used_at: string | null;
  }>(
    `SELECT DISTINCT ON (portal_id) portal_id, id, created_at, last_used_at
     FROM portal_sessions
     WHERE user_id = $1 AND portal_id = ANY($2) AND status = 'active'
     ORDER BY portal_id, created_at DESC`,
    [userId, portalIds]
  );
  const byPortal = new Map(rows.map(r => [r.portal_id, r]));
  return portalIds.map(pid => {
    const r = byPortal.get(pid);
    return {
      portalId:   pid,
      sessionId:  r?.id ?? null,
      capturedAt: r?.created_at ?? null,
      lastUsedAt: r?.last_used_at ?? null,
    };
  });
}

/** Touch last_used_at after a successful skipLogin replay. */
export async function touchSession(sessionId: string): Promise<void> {
  await query(`UPDATE portal_sessions SET last_used_at = now() WHERE id = $1`, [sessionId]);
}

/** Mark a session expired so the UI prompts a fresh capture. */
export async function expireSession(sessionId: string): Promise<void> {
  await query(`UPDATE portal_sessions SET status = 'expired' WHERE id = $1`, [sessionId]);
}

/** Revoke any active sessions for (user, portal). Returns count revoked. */
export async function revokeUserPortalSessions(userId: string, portalId: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE portal_sessions SET status = 'revoked'
     WHERE user_id = $1 AND portal_id = $2 AND status = 'active'
     RETURNING id`,
    [userId, portalId]
  );
  return rows.length;
}

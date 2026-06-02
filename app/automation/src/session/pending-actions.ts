import { query, queryOne } from '../db/client';

/**
 * Persisted per-session post-quote pending actions.
 *
 * After a quote is generated, we save:
 *   - storageState (Playwright cookies + localStorage at the result page)
 *   - resumeUrl    (URL the quote landed on)
 *
 * On "Get Payment Link" we acquire a FRESH browser context, restore the
 * storage state, navigate to resumeUrl, and run the buy_flow steps.
 *
 * This means the pool slot is released after every quote — the held-page
 * design previously blocked horizontal scaling and broke on every restart.
 *
 * Key: `${sessionId}:${portalId}` (PRIMARY KEY in chat_pending_buy_actions).
 */

export type PendingActionStatus = 'quoted' | 'payment_pending' | 'paid' | 'expired';

export interface PendingAction {
  sessionId:    string;
  portalId:     string;
  portalName:   string;
  userId:       string;
  storageState: unknown;          // Playwright StorageState
  resumeUrl:    string;
  quoteRef?:    string;
  paymentUrl?:  string;
  status:       PendingActionStatus;
  createdAt:    number;
  expiresAt:    number;
}

const ACTION_TTL_MS = 10 * 60 * 1000;  // 10 min — agent must forward the link quickly

interface DbRow {
  session_id:    string;
  portal_id:     string;
  portal_name:   string;
  user_id:       string;
  storage_state: unknown;
  resume_url:    string;
  status:        PendingActionStatus;
  quote_ref:     string | null;
  payment_url:   string | null;
  created_at:    string;
  expires_at:    string;
}

function rowToAction(r: DbRow): PendingAction {
  return {
    sessionId:    r.session_id,
    portalId:     r.portal_id,
    portalName:   r.portal_name,
    userId:       r.user_id,
    storageState: r.storage_state,
    resumeUrl:    r.resume_url,
    quoteRef:     r.quote_ref   ?? undefined,
    paymentUrl:   r.payment_url ?? undefined,
    status:       r.status,
    createdAt:    new Date(r.created_at).getTime(),
    expiresAt:    new Date(r.expires_at).getTime(),
  };
}

// ── Public API (matches legacy in-memory interface) ──────────────────────

export interface RegisterInput {
  sessionId:    string;
  portalId:     string;
  portalName:   string;
  userId:       string;
  storageState: unknown;
  resumeUrl:    string;
  quoteRef?:    string;
}

export async function register(input: RegisterInput): Promise<PendingAction> {
  const expiresAt = new Date(Date.now() + ACTION_TTL_MS);
  const rows = await query<DbRow>(
    `INSERT INTO pending_buy_actions
       (session_id, portal_id, portal_name, user_id, storage_state, resume_url, quote_ref, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (session_id, portal_id) DO UPDATE SET
       portal_name   = EXCLUDED.portal_name,
       storage_state = EXCLUDED.storage_state,
       resume_url    = EXCLUDED.resume_url,
       quote_ref     = EXCLUDED.quote_ref,
       status        = 'quoted',
       expires_at    = EXCLUDED.expires_at
     RETURNING *`,
    [
      input.sessionId, input.portalId, input.portalName, input.userId,
      JSON.stringify(input.storageState), input.resumeUrl,
      input.quoteRef ?? null, expiresAt,
    ],
  );
  return rowToAction(rows[0]);
}

export async function lookup(sessionId: string, portalId: string): Promise<PendingAction | undefined> {
  const row = await queryOne<DbRow>(
    `SELECT * FROM pending_buy_actions
     WHERE session_id = $1 AND portal_id = $2 AND expires_at > now()`,
    [sessionId, portalId],
  );
  return row ? rowToAction(row) : undefined;
}

export async function update(
  sessionId: string,
  portalId:  string,
  patch:     { status?: PendingActionStatus; paymentUrl?: string; quoteRef?: string },
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let   i = 1;
  if (patch.status      !== undefined) { sets.push(`status = $${i++}`);      vals.push(patch.status); }
  if (patch.paymentUrl  !== undefined) { sets.push(`payment_url = $${i++}`); vals.push(patch.paymentUrl); }
  if (patch.quoteRef    !== undefined) { sets.push(`quote_ref = $${i++}`);   vals.push(patch.quoteRef); }
  if (!sets.length) return;
  vals.push(sessionId, portalId);
  await query(
    `UPDATE pending_buy_actions SET ${sets.join(', ')}
     WHERE session_id = $${i++} AND portal_id = $${i}`,
    vals,
  );
}

export async function discard(sessionId: string, portalId: string): Promise<void> {
  await query('DELETE FROM pending_buy_actions WHERE session_id = $1 AND portal_id = $2',
    [sessionId, portalId]);
}

export async function listForSession(sessionId: string): Promise<PendingAction[]> {
  const rows = await query<DbRow>(
    'SELECT * FROM pending_buy_actions WHERE session_id = $1 AND expires_at > now() ORDER BY created_at',
    [sessionId],
  );
  return rows.map(rowToAction);
}

// ── Background sweeper ────────────────────────────────────────────────────
// Deletes expired rows so the table doesn't grow indefinitely. Runs every
// 60s in process; the unique-key TTL is also enforced at lookup-time.

let sweepTimer: NodeJS.Timeout | null = null;

export function startPendingActionsSweeper(_unused?: unknown, intervalMs = 60_000): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(async () => {
    try {
      await query('DELETE FROM pending_buy_actions WHERE expires_at < now()');
    } catch (err: any) {
      console.warn('[pending-actions] sweep failed:', err.message);
    }
  }, intervalMs);
  sweepTimer.unref();
}

export function stopPendingActionsSweeper(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

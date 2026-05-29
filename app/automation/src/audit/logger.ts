import { query } from '../db/client';
import { AuditEvent } from '../types';

/**
 * Fire-and-forget audit event writer.
 * Never throws — errors are logged to stderr only.
 * Never awaited in hot paths.
 */
export function logEvent(event: AuditEvent): void {
  writeEvent(event).catch(err => {
    console.error('[audit] Failed to write event:', err?.message, event.action);
  });
}

async function writeEvent(event: AuditEvent): Promise<void> {
  await query(
    `INSERT INTO audit_events
       (user_id, user_email, session_id, portal_id, ins_type, action, outcome, duration_ms, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      event.userId,
      event.userEmail,
      event.sessionId,
      event.portalId ?? null,
      event.insType  ?? null,
      event.action,
      event.outcome,
      event.durationMs ?? null,
      event.meta ? JSON.stringify(event.meta) : null,
    ]
  );
}

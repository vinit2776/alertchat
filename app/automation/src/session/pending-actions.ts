import { Page } from 'playwright';

/**
 * Per-session post-quote pending actions.
 *
 * After a quote is generated, we keep the Playwright Page alive so the agent
 * can click "Get Payment Link" within the TTL window.
 *
 * Key: `${sessionId}:${portalId}`
 */

export interface PendingAction {
  sessionId:   string;
  portalId:    string;
  portalName:  string;
  sessionKey:  string;        // pool sessionKey for later release
  page:        Page;
  quoteRef?:   string;        // portal-side quote/policy reference, if captured
  paymentUrl?: string;        // payment link, once captured
  status:      'quoted' | 'payment_pending' | 'paid' | 'expired' | 'released';
  createdAt:   number;
  expiresAt:   number;        // auto-released after this
}

const ACTION_TTL_MS = 10 * 60 * 1000;  // 10 min — agent must forward the link quickly

const actions = new Map<string, PendingAction>();

export function actionKey(sessionId: string, portalId: string): string {
  return `${sessionId}:${portalId}`;
}

export function register(action: Omit<PendingAction, 'createdAt' | 'expiresAt' | 'status'>): PendingAction {
  const now = Date.now();
  const full: PendingAction = {
    ...action,
    status:    'quoted',
    createdAt: now,
    expiresAt: now + ACTION_TTL_MS,
  };
  actions.set(actionKey(action.sessionId, action.portalId), full);
  return full;
}

export function lookup(sessionId: string, portalId: string): PendingAction | undefined {
  const a = actions.get(actionKey(sessionId, portalId));
  if (a && Date.now() > a.expiresAt) {
    actions.delete(actionKey(sessionId, portalId));
    return undefined;
  }
  return a;
}

export function update(sessionId: string, portalId: string, patch: Partial<PendingAction>): void {
  const a = actions.get(actionKey(sessionId, portalId));
  if (a) Object.assign(a, patch);
}

export function discard(sessionId: string, portalId: string): void {
  actions.delete(actionKey(sessionId, portalId));
}

export function listForSession(sessionId: string): PendingAction[] {
  return Array.from(actions.values()).filter(a => a.sessionId === sessionId);
}

/** Sweep — called periodically to surface expired actions for cleanup */
export function sweepExpired(): PendingAction[] {
  const now    = Date.now();
  const expired: PendingAction[] = [];
  for (const [k, a] of actions.entries()) {
    if (now > a.expiresAt) {
      expired.push(a);
      actions.delete(k);
    }
  }
  return expired;
}

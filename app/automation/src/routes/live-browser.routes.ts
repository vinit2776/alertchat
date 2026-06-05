/**
 * Live Browser — interactive portal login capture.
 *
 * Flow:
 *  1. POST /start      → opens Playwright (headed-style) for a portal, returns sessionId + first screenshot
 *  2. GET  /:id/stream → SSE stream of screenshots at ~2 fps; emits session_captured when login detected
 *  3. POST /:id/click  → forward click {x,y} (in image-space) to Playwright
 *  4. POST /:id/type   → type text into focused element
 *  5. POST /:id/key    → press a named key (Enter, Tab, Backspace, …)
 *  6. DELETE /:id      → close the session
 *
 * On success_indicator detection: captures storageState → saves to portal_sessions →
 * emits session_captured event → closes the Playwright context.
 *
 * VIEWPORT is always 1280×800. The frontend scales click coordinates from the
 * displayed image size back to viewport space before sending.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { chromium, BrowserContext, Page } from 'playwright';
import { requireAdmin } from '../middleware/auth';
import { query, queryOne } from '../db/client';
import { logEvent } from '../audit/logger';
import { loadPlaybook } from '../portal/playbook-runner';

const router = Router();

// ── In-memory session store ────────────────────────────────────────────────

const VIEWPORT   = { width: 1280, height: 800 };
const IDLE_TTL   = 10 * 60 * 1000;   // 10 min inactivity → auto-close
const FRAME_RATE = 600;               // ms between pushed frames

interface LiveSession {
  id:             string;
  portalId:       string;
  userId:         string;
  context:        BrowserContext;
  page:           Page;
  createdAt:      number;
  lastActivityAt: number;
  sseClients:     Set<Response>;
  frameTimer:     ReturnType<typeof setInterval> | null;
  done:           boolean;
}

const sessions = new Map<string, LiveSession>();

// Sweep stale sessions every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActivityAt > IDLE_TTL) {
      closeSession(id, 'idle_timeout').catch(() => {});
    }
  }
}, 2 * 60 * 1000).unref?.();

async function closeSession(id: string, reason: string): Promise<void> {
  const s = sessions.get(id);
  if (!s || s.done) return;
  s.done = true;
  if (s.frameTimer) clearInterval(s.frameTimer);
  broadcastEvent(s, { type: 'session_closed', reason });
  s.sseClients.forEach(res => { try { res.end(); } catch {} });
  sessions.delete(id);
  try { await s.context.close(); } catch {}
}

function broadcastEvent(s: LiveSession, payload: Record<string, unknown>): void {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  s.sseClients.forEach(res => { try { res.write(data); } catch {} });
}

async function pushFrame(s: LiveSession): Promise<void> {
  if (s.done) return;
  try {
    const buf = await s.page.screenshot({ type: 'jpeg', quality: 70 });
    broadcastEvent(s, { type: 'frame', image: buf.toString('base64'), ts: Date.now() });
  } catch {}
}

async function checkSuccessAndCapture(s: LiveSession): Promise<boolean> {
  if (s.done) return false;
  try {
    let playbook: ReturnType<typeof loadPlaybook>;
    try { playbook = loadPlaybook(s.portalId); } catch { return false; }

    const indicator = playbook.login?.success_indicator;
    if (!indicator) return false;

    const found = await s.page.locator(indicator).first().isVisible({ timeout: 800 }).catch(() => false);
    if (!found) return false;

    // Capture storageState
    const storageState = await s.context.storageState();

    // Revoke old sessions for this user+portal
    await query(
      `UPDATE portal_sessions SET status = 'revoked'
       WHERE user_id = $1 AND portal_id = $2 AND status = 'active'`,
      [s.userId, s.portalId],
    );

    // Save new session
    const row = await queryOne<{ id: string }>(
      `INSERT INTO portal_sessions (user_id, portal_id, storage_state)
       VALUES ($1, $2, $3) RETURNING id`,
      [s.userId, s.portalId, JSON.stringify(storageState)],
    );

    broadcastEvent(s, {
      type:       'session_captured',
      portalId:   s.portalId,
      sessionDbId: row?.id,
      cookieCount: storageState.cookies.length,
      message:    `Session captured (${storageState.cookies.length} cookies) — portal is ready`,
      ts:         Date.now(),
    });

    await closeSession(s.id, 'session_captured');
    return true;
  } catch (err: any) {
    console.error('[live-browser] capture error:', err?.message);
    return false;
  }
}

// ── POST /api/admin/live-browser/start ────────────────────────────────────

router.post('/start', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { portalId } = req.body as { portalId: string };
    if (!portalId) { res.status(400).json({ success: false, message: 'portalId required' }); return; }

    let loginUrl: string;
    let triggerSelector: string | undefined;
    let dismissSelectors: string[] = [];
    let usernameSelector = 'input[type=text], input[name*=user], input[id*=user]';

    try {
      const pb = loadPlaybook(portalId);
      loginUrl         = `${pb.base_url}${pb.login.url}`;
      triggerSelector  = (pb.login as any).trigger_selector;
      dismissSelectors = (pb.login as any).dismiss_modals ?? [];
      usernameSelector = pb.login.username_field ?? usernameSelector;
    } catch {
      res.status(404).json({ success: false, message: `No playbook found for ${portalId}` });
      return;
    }

    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled', '--disable-gpu',
      ],
    });

    const context = await browser.newContext({ viewport: VIEWPORT });
    const page    = await context.newPage();

    // Navigate — use networkidle for JS-heavy portals; fall back gracefully on timeout
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    // Dismiss any promo modals that block the login form
    for (const sel of dismissSelectors) {
      await page.locator(sel).first().click({ timeout: 3_000 }).catch(() => {});
    }

    // Some portals (e.g. Oriental) show login as a modal triggered by a button click
    if (triggerSelector) {
      await page.locator(triggerSelector).first().click({ timeout: 5_000 }).catch(() => {});
    }

    // Wait for the login form to actually render (Angular / jQuery portals need this)
    await page.waitForSelector(usernameSelector, { timeout: 15_000 }).catch(() => {});
    // Extra buffer for slow portals
    await page.waitForTimeout(800);

    const id = `lb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const session: LiveSession = {
      id, portalId,
      userId:   req.user!.sub,
      context, page,
      createdAt:      Date.now(),
      lastActivityAt: Date.now(),
      sseClients:     new Set(),
      frameTimer:     null,
      done:           false,
    };
    sessions.set(id, session);

    // First screenshot — login form should be visible by now
    const buf = await page.screenshot({ type: 'jpeg', quality: 80 });

    logEvent({
      userId: req.user!.sub, userEmail: req.user!.email, sessionId: id,
      action: 'admin_action' as any, outcome: 'success',
      meta: { action: 'live_browser_start', portalId },
    });

    res.json({
      success: true, sessionId: id, portalId,
      loginUrl,
      viewport: VIEWPORT,
      screenshot: buf.toString('base64'),
    });
  } catch (err) { next(err); }
});

// ── GET /api/admin/live-browser/:id/stream (SSE) ──────────────────────────

router.get('/:id/stream', requireAdmin, (req: Request, res: Response) => {
  const s = sessions.get(req.params.id);
  if (!s || s.userId !== req.user!.sub) { res.status(404).end(); return; }

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders?.();

  s.sseClients.add(res);

  // Start frame-push timer if this is the first client
  if (!s.frameTimer) {
    s.frameTimer = setInterval(async () => {
      if (s.done) return;
      s.lastActivityAt = Date.now();
      await pushFrame(s);
      await checkSuccessAndCapture(s);
    }, FRAME_RATE);
  }

  // Heartbeat
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 15_000);

  req.on('close', () => {
    clearInterval(hb);
    s.sseClients.delete(res);
    // Stop frame timer when no clients are listening
    if (s.sseClients.size === 0 && s.frameTimer) {
      clearInterval(s.frameTimer);
      s.frameTimer = null;
    }
  });
});

// ── POST /api/admin/live-browser/:id/click ────────────────────────────────

router.post('/:id/click', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const s = sessions.get(req.params.id);
    if (!s || s.userId !== req.user!.sub) { res.status(404).json({ success: false, message: 'Session not found' }); return; }
    if (s.done) { res.status(410).json({ success: false, message: 'Session closed' }); return; }

    const { x, y } = req.body as { x: number; y: number };
    if (typeof x !== 'number' || typeof y !== 'number') {
      res.status(400).json({ success: false, message: 'x and y required' }); return;
    }

    s.lastActivityAt = Date.now();
    await s.page.mouse.click(x, y);

    // Small wait then screenshot so frontend sees result immediately
    await s.page.waitForTimeout(300);
    const buf = await s.page.screenshot({ type: 'jpeg', quality: 80 });

    // Check if login happened after click
    await checkSuccessAndCapture(s);

    res.json({ success: true, screenshot: buf.toString('base64') });
  } catch (err) { next(err); }
});

// ── POST /api/admin/live-browser/:id/type ─────────────────────────────────

router.post('/:id/type', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const s = sessions.get(req.params.id);
    if (!s || s.userId !== req.user!.sub) { res.status(404).json({ success: false, message: 'Session not found' }); return; }
    if (s.done) { res.status(410).json({ success: false, message: 'Session closed' }); return; }

    const { text } = req.body as { text: string };
    if (!text) { res.status(400).json({ success: false, message: 'text required' }); return; }

    s.lastActivityAt = Date.now();
    await s.page.keyboard.type(text, { delay: 50 });

    const buf = await s.page.screenshot({ type: 'jpeg', quality: 80 });
    res.json({ success: true, screenshot: buf.toString('base64') });
  } catch (err) { next(err); }
});

// ── POST /api/admin/live-browser/:id/key ──────────────────────────────────

router.post('/:id/key', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const s = sessions.get(req.params.id);
    if (!s || s.userId !== req.user!.sub) { res.status(404).json({ success: false, message: 'Session not found' }); return; }
    if (s.done) { res.status(410).json({ success: false, message: 'Session closed' }); return; }

    const { key } = req.body as { key: string };
    if (!key) { res.status(400).json({ success: false, message: 'key required' }); return; }

    s.lastActivityAt = Date.now();
    await s.page.keyboard.press(key);

    await s.page.waitForTimeout(400);
    const buf = await s.page.screenshot({ type: 'jpeg', quality: 80 });

    await checkSuccessAndCapture(s);

    res.json({ success: true, screenshot: buf.toString('base64') });
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/live-browser/:id ────────────────────────────────────

router.delete('/:id', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await closeSession(req.params.id, 'user_closed');
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;

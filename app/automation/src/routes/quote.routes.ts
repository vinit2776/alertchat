import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../middleware/auth';
import { ensureSession, persistSession } from '../ai/conversation';
import { browserPool } from '../session/pool';
import { runBuyFlow, loadPlaybook, CaptchaRequiredError } from '../portal/playbook-runner';
import { getEnabledCompanies } from '../portal/registry';
import { computeMotorFields } from '../portal/field-computer';
import { logEvent } from '../audit/logger';
import { query } from '../db/client';
import { emitProgress, onProgress, offProgress, cleanupProgress } from '../session/progress';
import type { ProgressEvent } from '../session/progress';
import { register as registerAction, lookup as lookupAction, update as updateAction, discard as discardAction } from '../session/pending-actions';
import { getConnector, getConnectorType } from '../connectors/registry';

const router = Router();

// POST /api/quotes/:sessionId/start  — trigger browser automation
router.post('/:sessionId/start', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.params;
    const user = req.user!;

    const state = await ensureSession(sessionId);
    if (!state) {
      res.status(404).json({ success: false, message: 'Session not found' });
      return;
    }
    if (state.userId !== user.sub) {
      res.status(403).json({ success: false, message: 'Not your session' });
      return;
    }
    if (state.status !== 'confirming') {
      res.status(400).json({
        success: false,
        message: `Cannot start quote — session status is "${state.status}" (must be "confirming")`,
      });
      return;
    }

    const enabledCompanies = await getEnabledCompanies(state.insuranceType);
    const targetCompanies  = enabledCompanies.filter(c => state.selectedCompanies.includes(c.id));

    if (!targetCompanies.length) {
      res.status(400).json({ success: false, message: 'No enabled companies are selected for this session' });
      return;
    }

    const poolStatus = browserPool.status();

    // API-based companies don't consume browser pool slots
    const portalCompanies = targetCompanies.filter(c => getConnectorType(c.id) === 'portal');
    const apiCompanies    = targetCompanies.filter(c => getConnectorType(c.id) === 'api');

    const portalSlots = Math.min(portalCompanies.length, poolStatus.free);

    if (portalCompanies.length > 0 && portalSlots === 0) {
      res.status(503).json({
        success:  false,
        message:  'All browser slots are busy. Please try again in a few minutes.',
        poolStatus,
      });
      return;
    }

    // API companies always start; portal companies limited by pool slots
    const canStart = portalSlots + apiCompanies.length;

    // Mark session as filling before starting async work
    state.status = 'filling';
    persistSession(sessionId);

    // All API companies start immediately; portal companies limited by pool slots
    const companiesStarted = [
      ...apiCompanies,
      ...portalCompanies.slice(0, portalSlots),
    ];
    const companiesQueued  = portalCompanies.slice(portalSlots);

    if (companiesQueued.length) {
      // Future: BullMQ queue. For now, inform the user.
      console.info(`[Quote] ${companiesQueued.length} companies queued (pool full): ${companiesQueued.map(c => c.id).join(', ')}`);
    }

    // ── Return immediately — quote work continues in background ──────────────
    // This dodges Cloudflare's ~100s tunnel timeout. Results are delivered
    // via the already-open SSE stream as each portal completes, plus an
    // `all_complete` event when everything is done.
    res.json({
      success:        true,
      sessionStatus:  state.status,
      asyncMode:      true,
      message:        'Quote generation started — results will stream over the SSE channel',
      queued:         companiesQueued.map(c => ({ id: c.id, name: c.name })),
      startedPortals: companiesStarted.map(c => ({ id: c.id, name: c.name })),
    });

    // ── Background: run all jobs, emit per-insurer results via SSE ──────────
    // Portal connectors consume a browser pool slot.
    // API connectors (e.g. Bajaj) run directly — no pool slot needed.
    (async () => {
    const enrichedFields =
      state.insuranceType === 'motor'
        ? computeMotorFields(state.confirmedFields)
        : state.confirmedFields;

    const { findActiveSession, touchSession, expireSession } = await import('../portal/session-cache');

    const jobs = companiesStarted.map(async (company) => {
      const connector     = getConnector(company.id);
      const isPortal      = connector.type === 'portal';
      const sessionKey    = `${sessionId}:${company.id}`;
      let acquired        = false;

      try {
        let result: any;

        if (isPortal) {
          // ── Portal path: check for an active human-captured session ────
          const portalSession = await findActiveSession(user.sub, company.id);

          if (!portalSession) {
            // No active session — refuse to attempt automated login (which
            // would burn an attempt against bot detection). Surface a clear
            // result the UI can render with a "Capture session" button.
            result = {
              portalId:   company.id,
              portalName: company.name,
              success:    false,
              premium:    null,
              idv:        null,
              rawData:    {},
              durationMs: 0,
              errorMessage:    `No active ${company.id.toUpperCase()} portal session. An admin must capture a session before quotes can run.`,
              needsSession:    true,    // ← UI uses this to show "Capture session" button
              portalSessionId: null,
            };
            emitProgress(sessionId, {
              type: 'error', portalId: company.id, portalName: company.name,
              message: result.errorMessage, ts: Date.now(),
            });
            return result;
          }

          // ── Portal path: acquire browser slot using captured session ──
          const { slotId, context } = await browserPool.acquire(sessionKey, portalSession.storageState);
          acquired = true;

          logEvent({
            userId: user.sub, userEmail: user.email, sessionId, portalId: company.id,
            action: 'browser_context_assigned', outcome: 'success',
            meta: { slotId },
          });

          try {
            result = await connector.getQuote(
              enrichedFields,
              sessionId, user.sub, user.email,
              {
                browserContext: context,
                onProgress:     (event) => emitProgress(sessionId, event),
                skipLogin:      true,   // Always skip login — we already have a session
              },
            );
            // Touch session on success so we can show last_used_at in admin
            if (result.success) await touchSession(portalSession.id).catch(() => {});
          } catch (err: any) {
            if (err?.name === 'SessionExpiredError') {
              await expireSession(portalSession.id).catch(() => {});
              result = {
                portalId:        company.id,
                portalName:      company.name,
                success:         false,
                premium:         null,
                idv:             null,
                rawData:         {},
                durationMs:      0,
                errorMessage:    `${company.id.toUpperCase()} session expired. Admin must capture a fresh session.`,
                sessionExpired:  true,
                needsSession:    true,
                portalSessionId: portalSession.id,
              };
            } else {
              throw err;
            }
          }

          // Persist resume state to DB so /proceed can restart after pool eviction
          if (result.success && result.resumeState) {
            try {
              const playbook = loadPlaybook(company.id);
              await registerAction({
                sessionId,
                portalId:     company.id,
                portalName:   playbook.name ?? company.name,
                userId:       user.sub,
                storageState: result.resumeState.storageState,
                resumeUrl:    result.resumeState.resumeUrl,
                quoteRef:     result.quoteRef ?? undefined,
              });
            } catch (err: any) {
              console.error('[Quote] Failed to persist pending action:', err.message);
            }
          }

        } else {
          // ── API path: call directly, no browser needed ──────────────────
          logEvent({
            userId: user.sub, userEmail: user.email, sessionId, portalId: company.id,
            action: 'browser_context_assigned', outcome: 'success',
            meta: { mode: 'api', connectorType: connector.type },
          });

          result = await connector.getQuote(
            enrichedFields,
            sessionId, user.sub, user.email,
            { onProgress: (event) => emitProgress(sessionId, event) },
          );
        }

        // Strip non-serialisable fields before emitting to the HTTP client
        const { resumeState, screenshotBase64, ...clientResult } = result;

        emitProgress(sessionId, {
          type:       'quote_complete',
          portalId:   company.id,
          portalName: company.name,
          message:    '',
          ts:         Date.now(),
          result:     clientResult,
        });

        return clientResult;

      } finally {
        if (acquired) await browserPool.release(sessionKey);
      }
    });

    const settled = await Promise.allSettled(jobs);

    const results = settled.map((r, i) => {
      if (r.status === 'fulfilled') {
        // Check if captcha was returned inside a successful result shape
        const val = r.value as any;
        if (val?.captchaRequired) {
          emitProgress(sessionId, {
            type: 'captcha_required', portalId: val.portalId ?? companiesStarted[i].id,
            portalName: companiesStarted[i].name,
            message: 'Captcha needs human input', ts: Date.now(), result: val,
          });
        }
        return val;
      }

      // Unexpected thrown error (pool full, network crash, etc.)
      const company = companiesStarted[i];
      const err     = r.reason;
      const rejectedResult: any = {
        portalId: company.id, portalName: company.name,
        success: false, premium: null, idv: null,
        rawData: {},
        captchaRequired:    err instanceof CaptchaRequiredError || false,
        captchaImageBase64: err instanceof CaptchaRequiredError ? err.captchaImageBase64 : undefined,
        errorMessage: err?.message ?? 'Unknown error', durationMs: 0,
      };
      emitProgress(sessionId, {
        type: rejectedResult.captchaRequired ? 'captcha_required' : 'quote_complete',
        portalId: company.id, portalName: company.name,
        message: '', ts: Date.now(), result: rejectedResult,
      });
      return rejectedResult;
    });

    // Persist to DB (no-op if DATABASE_URL not set)
    const regNumber   = state.confirmedFields.registration_number ?? null;
    const vehicleMake = state.confirmedFields.make  ?? null;
    const vehicleModel= state.confirmedFields.model ?? null;

    for (const qr of results) {
      await query(
        `INSERT INTO quote_results
           (id, session_id, user_id, portal_id, ins_type,
            reg_number, vehicle_make, vehicle_model,
            premium, idv, quote_data, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + INTERVAL '7 days')`,
        [
          uuidv4(), sessionId, user.sub, qr.portalId, state.insuranceType,
          regNumber, vehicleMake, vehicleModel,
          qr.premium, qr.idv,
          JSON.stringify({
            success:         qr.success,
            rawData:         qr.rawData,
            errorMessage:    qr.errorMessage,
            // Persist fields so a Phase 2 cookie-handoff retry can replay the quote
            confirmedFields: state.confirmedFields,
          }),
        ],
      );
    }

    // Update session status
    const anySuccess = results.some(r => r.success);
    state.status = anySuccess ? 'complete' : 'error';
    persistSession(sessionId);

    logEvent({
      userId: user.sub, userEmail: user.email, sessionId,
      action: 'session_end',
      outcome: anySuccess ? 'success' : 'failure',
      meta: {
        reason: 'quote_complete',
        successCount: results.filter(r => r.success).length,
        failCount:    results.filter(r => !r.success).length,
      },
    });

    // Emit all_complete and clean up the SSE emitter
    emitProgress(sessionId, {
      type: 'all_complete', portalId: '', portalName: '',
      message: `All quotes done — ${results.filter(r => r.success).length}/${results.length} succeeded`,
      ts: Date.now(),
    });
    // Give SSE a beat to flush, then clean up
    setTimeout(() => cleanupProgress(sessionId), 2000);
    })().catch(err => {
      console.error('[Quote] Background job failed:', err);
      emitProgress(sessionId, {
        type: 'error', portalId: '', portalName: '',
        message: `Background error: ${err.message}`, ts: Date.now(),
      });
      cleanupProgress(sessionId);
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/quotes/:sessionId/proceed/:portalId  — Reconstruct the post-quote
// browser state from DB and run the buy_flow to capture the payment URL.
router.post('/:sessionId/proceed/:portalId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId, portalId } = req.params;
    const user = req.user!;

    const state = await ensureSession(sessionId);
    if (!state || state.userId !== user.sub) {
      res.status(403).json({ success: false, message: 'Session not found or not yours' });
      return;
    }

    const action = await lookupAction(sessionId, portalId);
    if (!action) {
      res.status(404).json({
        success: false,
        message: 'No pending action for this portal. The quote may have expired (10 min TTL). Please re-run the quote.',
      });
      return;
    }
    if (action.userId !== user.sub) {
      res.status(403).json({ success: false, message: 'Not your pending action' });
      return;
    }

    logEvent({
      userId: user.sub, userEmail: user.email, sessionId, portalId,
      action: 'form_step_filled', outcome: 'pending',
      meta: { phase: 'buy_flow_start' },
    });

    // Acquire a fresh browser context with the persisted storage state
    // (cookies + localStorage). Use a distinct sessionKey to allow the same
    // session to run multiple buy flows in parallel without colliding.
    const sessionKey = `${sessionId}:${portalId}:proceed`;
    let acquired = false;
    try {
      const { context } = await browserPool.acquire(sessionKey, action.storageState);
      acquired = true;

      const result = await runBuyFlow(
        portalId, context, action.resumeUrl,
        (event) => emitProgress(sessionId, event),
      );

      if (result.paymentUrl) {
        await updateAction(sessionId, portalId, {
          paymentUrl: result.paymentUrl,
          status:     'payment_pending',
          quoteRef:   result.confirmationNumber ?? undefined,
        });
      }

      logEvent({
        userId: user.sub, userEmail: user.email, sessionId, portalId,
        action: result.paymentUrl ? 'form_step_filled' : 'form_step_failed',
        outcome: result.paymentUrl ? 'success' : 'failure',
        meta: { phase: 'buy_flow_complete', hasPaymentUrl: !!result.paymentUrl },
      });

      res.json({
        success:            !!result.paymentUrl,
        paymentUrl:         result.paymentUrl,
        confirmationNumber: result.confirmationNumber,
        policyPdfUrl:       result.policyPdfUrl,
        errorMessage:       result.errorMessage,
        ...(result.errorMessage ? { screenshotBase64: result.screenshotBase64 } : {}),
      });
    } finally {
      if (acquired) await browserPool.release(sessionKey);
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/quotes/:sessionId/release/:portalId  — Agent abandons buy flow.
// Pool slots aren't held anymore (resume state is in DB), so this just
// deletes the persisted pending action.
router.post('/:sessionId/release/:portalId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId, portalId } = req.params;
    const user = req.user!;

    const state = await ensureSession(sessionId);
    if (!state || state.userId !== user.sub) {
      res.status(403).json({ success: false, message: 'Not your session' });
      return;
    }

    await discardAction(sessionId, portalId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/quotes/:sessionId/progress  — SSE stream of real-time automation steps
// EventSource cannot set headers, so we accept the JWT as a ?token= query param.
router.get('/:sessionId/progress', async (req: Request, res: Response) => {
  // Manual auth — accept ?token= as fallback for EventSource
  const rawToken = req.query.token as string | undefined
    ?? req.headers.authorization?.replace(/^Bearer\s+/, '');

  if (!rawToken) {
    res.status(401).json({ success: false, message: 'Missing token' });
    return;
  }

  let user: { sub: string; email: string; role: string };
  try {
    const { config } = require('../config/env');
    const jwt = require('jsonwebtoken');
    user = jwt.verify(rawToken, config.jwtSecret) as any;
  } catch {
    res.status(401).json({ success: false, message: 'Token expired or invalid' });
    return;
  }

  const { sessionId } = req.params;
  const state = await ensureSession(sessionId);
  if (!state || state.userId !== user.sub) {
    res.status(403).json({ success: false, message: 'Not your session' });
    return;
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');  // disable nginx proxy buffering
  res.flushHeaders();

  // Initial connection acknowledgement
  res.write('data: ' + JSON.stringify({ type: 'connected', ts: Date.now() }) + '\n\n');

  // Keep-alive ping every 20s (prevents idle connection timeout)
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(ping); }
  }, 20_000);

  const handler = (event: ProgressEvent) => {
    try {
      res.write('data: ' + JSON.stringify(event) + '\n\n');
    } catch { /* client already disconnected */ }
  };

  onProgress(sessionId, handler);

  req.on('close', () => {
    clearInterval(ping);
    offProgress(sessionId, handler);
  });
});

// GET /api/quotes/pool  — pool status (admin)
router.get('/pool', requireAuth, (_req, res) => {
  res.json({ success: true, pool: browserPool.status() });
});

export default router;

import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../middleware/auth';
import { ensureSession, persistSession } from '../ai/conversation';
import { browserPool } from '../session/pool';
import { runPlaybook, runBuyFlow, loadPlaybook, CaptchaRequiredError } from '../portal/playbook-runner';
import { getEnabledCompanies } from '../portal/registry';
import { computeMotorFields } from '../portal/field-computer';
import { logEvent } from '../audit/logger';
import { query } from '../db/client';
import { emitProgress, onProgress, offProgress, cleanupProgress } from '../session/progress';
import type { ProgressEvent } from '../session/progress';
import { register as registerAction, lookup as lookupAction, update as updateAction, discard as discardAction } from '../session/pending-actions';

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
    const canStart   = Math.min(targetCompanies.length, poolStatus.free);

    if (canStart === 0) {
      res.status(503).json({
        success: false,
        message: 'All browser slots are busy. Please try again in a few minutes.',
        poolStatus,
      });
      return;
    }

    // Mark session as filling before starting async work
    state.status = 'filling';
    persistSession(sessionId);

    const companiesStarted  = targetCompanies.slice(0, canStart);
    const companiesQueued   = targetCompanies.slice(canStart);

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

    // ── Background: run all portal jobs, emit per-portal results via SSE ─────
    // Don't await — let the request return now.
    (async () => {
    // Run in parallel — one browser context per company
    const jobs = companiesStarted.map(async (company) => {
      const sessionKey = `${sessionId}:${company.id}`;
      let acquired = false;

      try {
        const { slotId, context } = await browserPool.acquire(sessionKey);
        acquired = true;

        logEvent({
          userId: user.sub, userEmail: user.email, sessionId, portalId: company.id,
          action: 'browser_context_assigned', outcome: 'success',
          meta: { slotId },
        });

        const enrichedFields =
          state.insuranceType === 'motor'
            ? computeMotorFields(state.confirmedFields)
            : state.confirmedFields;

        const playbook  = loadPlaybook(company.id);
        const hasBuyFlow = !!playbook.buy_flow;

        const result = await runPlaybook(
          company.id, enrichedFields, context,
          sessionId, user.sub, user.email,
          undefined,   // captchaText
          undefined,   // debugMode
          (event) => emitProgress(sessionId, event),  // SSE progress
          hasBuyFlow,  // extractResumeState — only when a buy_flow is configured
        );

        // If we got resume state, persist it to DB so /proceed can restart the
        // browser even after restart / multi-instance / pool eviction.
        if (result.success && result.resumeState) {
          try {
            await registerAction({
              sessionId,
              portalId:     company.id,
              portalName:   playbook.name,
              userId:       user.sub,
              storageState: result.resumeState.storageState,
              resumeUrl:    result.resumeState.resumeUrl,
              quoteRef:     result.quoteRef ?? undefined,
            });
          } catch (err: any) {
            console.error('[Quote] Failed to persist pending action:', err.message);
          }
        }

        // Strip non-serialisable fields before returning to the HTTP client
        const { resumeState, screenshotBase64, ...clientResult } = result;

        // Emit per-portal quote_complete event so the frontend can render this card NOW
        emitProgress(sessionId, {
          type:       'quote_complete',
          portalId:   company.id,
          portalName: playbook.name,
          message:    '',
          ts:         Date.now(),
          result:     clientResult,
        });

        return clientResult;
      } finally {
        // Always release the pool slot — resume state lives in DB now
        if (acquired) await browserPool.release(sessionKey);
      }
    });

    const settled = await Promise.allSettled(jobs);

    const results = settled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const company = companiesStarted[i];
      const err = r.reason;
      let rejectedResult: any;
      if (err instanceof CaptchaRequiredError) {
        rejectedResult = {
          portalId: company.id, portalName: company.name,
          success: false, premium: null, idv: null,
          rawData: {},
          captchaRequired:    true,
          captchaImageBase64: err.captchaImageBase64,
          errorMessage: err.message, durationMs: 0,
        };
        // Emit captcha_required event so the frontend renders the captcha UI
        emitProgress(sessionId, {
          type: 'captcha_required', portalId: company.id, portalName: company.name,
          message: 'Captcha needs human input', ts: Date.now(), result: rejectedResult,
        });
      } else {
        rejectedResult = {
          portalId: company.id, portalName: company.name,
          success: false, premium: null, idv: null,
          rawData: {},
          errorMessage: err?.message ?? 'Unknown error', durationMs: 0,
        };
        emitProgress(sessionId, {
          type: 'quote_complete', portalId: company.id, portalName: company.name,
          message: '', ts: Date.now(), result: rejectedResult,
        });
      }
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
          JSON.stringify({ success: qr.success, rawData: qr.rawData, error: qr.errorMessage }),
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

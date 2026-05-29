import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../middleware/auth';
import { getSession } from '../ai/conversation';
import { browserPool } from '../session/pool';
import { runPlaybook, CaptchaRequiredError } from '../portal/playbook-runner';
import { getEnabledCompanies } from '../portal/registry';
import { computeMotorFields } from '../portal/field-computer';
import { logEvent } from '../audit/logger';
import { query } from '../db/client';
import { emitProgress, onProgress, offProgress, cleanupProgress } from '../session/progress';
import type { ProgressEvent } from '../session/progress';

const router = Router();

// POST /api/quotes/:sessionId/start  — trigger browser automation
router.post('/:sessionId/start', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.params;
    const user = req.user!;

    const state = getSession(sessionId);
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

    const companiesStarted  = targetCompanies.slice(0, canStart);
    const companiesQueued   = targetCompanies.slice(canStart);

    if (companiesQueued.length) {
      // Future: BullMQ queue. For now, inform the user.
      console.info(`[Quote] ${companiesQueued.length} companies queued (pool full): ${companiesQueued.map(c => c.id).join(', ')}`);
    }

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

        return await runPlaybook(
          company.id, enrichedFields, context,
          sessionId, user.sub, user.email,
          undefined,   // captchaText
          undefined,   // debugMode
          (event) => emitProgress(sessionId, event),  // SSE progress
        );
      } finally {
        if (acquired) await browserPool.release(sessionKey);
      }
    });

    const settled = await Promise.allSettled(jobs);
    // All portals done — clean up the per-session EventEmitter
    cleanupProgress(sessionId);

    const results = settled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const company = companiesStarted[i];
      const err = r.reason;
      if (err instanceof CaptchaRequiredError) {
        // Return captcha challenge — client must re-call with captchaText
        return {
          portalId: company.id, portalName: company.name,
          success: false, premium: null, idv: null,
          screenshotBase64: null, rawData: {},
          captchaRequired: true,
          captchaImageBase64: err.captchaImageBase64,
          errorMessage: err.message, durationMs: 0,
        };
      }
      return {
        portalId: company.id, portalName: company.name,
        success: false, premium: null, idv: null,
        screenshotBase64: null, rawData: {},
        errorMessage: err?.message ?? 'Unknown error', durationMs: 0,
      };
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

    // Strip large screenshot from main response
    const clientResults = results.map(({ screenshotBase64, ...rest }) => rest);

    res.json({
      success:        true,
      sessionStatus:  state.status,
      results:        clientResults,
      queued:         companiesQueued.map(c => ({ id: c.id, name: c.name })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/quotes/:sessionId/progress  — SSE stream of real-time automation steps
// EventSource cannot set headers, so we accept the JWT as a ?token= query param.
router.get('/:sessionId/progress', (req: Request, res: Response) => {
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
  const state = getSession(sessionId);
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

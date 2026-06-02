import rateLimit, { Options } from 'express-rate-limit';
import { Request, Response } from 'express';

/**
 * Per-route rate limiting. Three tiers — tuned to the actual cost of each
 * endpoint, not arbitrary numbers.
 *
 *   - global:   100 req/min/IP   — generous default for everything
 *   - login:    10 req/min/IP    — brute-force defence (no user yet)
 *   - upload:   20 req/min/user  — OCR costs ~$0.003/call
 *   - quote:    5 req/min/user   — each holds a Chromium slot for 90s
 *   - wizard:   30 req/min/user  — light, but cap to avoid spam
 *
 * Per-user limits use the JWT sub claim (req.user.sub) — the rate-limit
 * package only sees Express req objects, so we read from req.user, which
 * the requireAuth middleware populates before this runs.
 */

// Per-user key: prefer authenticated user ID, fall back to IP
function userKey(req: Request): string {
  return req.user?.sub ?? (req.ip ?? 'unknown');
}

// Reusable handler so the JSON shape is consistent
function rateLimitHandler(_req: Request, res: Response): void {
  res.status(429).json({
    success: false,
    message: 'Too many requests — please slow down and try again in a minute.',
  });
}

const baseOptions: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  handler:         rateLimitHandler,
};

// ── Global (per-IP) — catches everything not specifically rate-limited ────
export const globalLimit = rateLimit({
  ...baseOptions,
  windowMs: 60_000,
  limit:    100,
});

// ── Login (per-IP) — protects against brute force / credential stuffing ──
export const loginLimit = rateLimit({
  ...baseOptions,
  windowMs: 60_000,
  limit:    10,
});

// ── Document upload (per-user) — caps OCR cost ────────────────────────────
export const uploadLimit = rateLimit({
  ...baseOptions,
  windowMs: 60_000,
  limit:    20,
  keyGenerator: userKey,
});

// ── Quote (per-user) — caps Chromium pool consumption ────────────────────
export const quoteLimit = rateLimit({
  ...baseOptions,
  windowMs: 60_000,
  limit:    5,
  keyGenerator: userKey,
});

// ── Wizard (per-user) — light, just spam protection ───────────────────────
export const wizardLimit = rateLimit({
  ...baseOptions,
  windowMs: 60_000,
  limit:    30,
  keyGenerator: userKey,
});

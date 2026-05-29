import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { JwtPayload } from '../types';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

// ── Token extraction ───────────────────────────────────────────────────────

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  if (req.query.token) return req.query.token as string; // SSE fallback
  return null;
}

// ── requireAuth — any valid JWT (super_admin or chat_user) ─────────────────

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ success: false, message: 'Missing Authorization header' });
    return;
  }
  try {
    req.user = jwt.verify(token, config.jwtSecret) as JwtPayload;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Token expired or invalid' });
  }
}

// ── requireSuperAdmin — only super_admin role ──────────────────────────────

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (req.user?.role !== 'super_admin') {
      res.status(403).json({ success: false, message: 'Super admin access required' });
      return;
    }
    next();
  });
}

// ── requireAdmin — alias kept for backward compat (same as requireSuperAdmin)
export const requireAdmin = requireSuperAdmin;

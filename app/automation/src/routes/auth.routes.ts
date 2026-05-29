import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query, queryOne } from '../db/client';
import { requireAuth } from '../middleware/auth';
import { config } from '../config/env';
import { logEvent } from '../audit/logger';

const router = Router();

interface DbUser {
  id:            string;
  username:      string;
  email:         string;
  password_hash: string;
  role:          'super_admin' | 'chat_user';
  enabled:       boolean;
}

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ success: false, message: 'username and password are required' });
      return;
    }

    const user = await queryOne<DbUser>(
      'SELECT * FROM app_users WHERE username = $1',
      [username],
    );

    if (!user) {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }
    if (!user.enabled) {
      res.status(403).json({ success: false, message: 'Account disabled. Contact your administrator.' });
      return;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    // Update last_login (fire-and-forget)
    query('UPDATE app_users SET last_login = now() WHERE id = $1', [user.id]).catch(() => {});

    const token = jwt.sign(
      { sub: user.id, username: user.username, email: user.email, role: user.role },
      config.jwtSecret,
      { expiresIn: config.jwtExpires } as jwt.SignOptions,
    );

    logEvent({
      userId: user.id, userEmail: user.email, sessionId: 'login',
      action: 'session_start', outcome: 'success',
      meta: { role: user.role },
    } as any);

    res.json({
      success: true,
      token,
      user: { id: user.id, username: user.username, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req: Request, res: Response) => {
  res.json({ success: true, user: req.user });
});

export default router;

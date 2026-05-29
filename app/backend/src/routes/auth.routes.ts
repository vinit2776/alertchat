import { Router, Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service';
import { findByUsername, verifyPassword, signToken, listUsers } from '../services/user.service';
import { requireAuth, requireAdmin } from '../middleware/requireAuth';

const router = Router();

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ success: false, message: 'username and password are required' });
      return;
    }

    const user = findByUsername(username);
    if (!user || !(await verifyPassword(user, password))) {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    const token = signToken(user);
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

// GET /api/auth/users  — admin only
router.get('/users', requireAdmin, (_req: Request, res: Response) => {
  res.json({ success: true, users: listUsers() });
});

// GET /api/auth/status — CHI token pool state (existing, kept for compatibility)
router.get('/status', (_req: Request, res: Response) => {
  res.json({ success: true, data: authService.poolStatus() });
});

// POST /api/auth/refresh — force CHI token pool refresh (existing)
router.post('/refresh', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = await authService.getSessionAndToken();
    res.json({ success: true, data: { sessionId, pool: authService.poolStatus() } });
  } catch (err) {
    next(err);
  }
});

export default router;

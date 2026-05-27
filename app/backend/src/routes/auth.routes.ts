import { Router, Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service';

const router = Router();

// GET /api/auth/status — show current token pool state (debug/admin)
router.get('/status', (_req: Request, res: Response) => {
  res.json({ success: true, data: authService.poolStatus() });
});

// POST /api/auth/refresh — force refresh the token pool
router.post('/refresh', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = await authService.getSessionAndToken();
    res.json({ success: true, data: { sessionId, pool: authService.poolStatus() } });
  } catch (err) {
    next(err);
  }
});

export default router;

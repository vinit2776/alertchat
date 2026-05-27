import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { processChat, clearSession } from '../services/chat.service';

const router = Router();

// POST /api/chat
// Body: { sessionId?: string, message: string }
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { message, sessionId } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ success: false, message: 'message is required' });
      return;
    }

    const sid = sessionId || uuidv4();
    const result = await processChat(sid, message.trim());

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/chat/:sessionId  — reset conversation
router.delete('/:sessionId', (req: Request, res: Response) => {
  clearSession(req.params.sessionId);
  res.json({ success: true, message: 'Session cleared' });
});

export default router;

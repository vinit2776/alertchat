import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  createSession, ensureSession, processMessage, deleteSession, getSessionStats,
} from '../ai/conversation';
import { getEnabledCompanies } from '../portal/registry';
import { logEvent } from '../audit/logger';
import { InsuranceType } from '../types';

const router = Router();

// POST /api/chat/session  — start a new quote session
router.post('/session', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { insuranceType, selectedCompanyIds } = req.body as {
      insuranceType: InsuranceType;
      selectedCompanyIds?: string[];
    };
    const user = req.user!;

    if (!['motor', 'health', 'property', 'travel'].includes(insuranceType)) {
      res.status(400).json({ success: false, message: 'Invalid insuranceType' });
      return;
    }

    // Resolve to enabled companies only
    const enabledCompanies  = await getEnabledCompanies(insuranceType);
    const companyIds = selectedCompanyIds?.length
      ? enabledCompanies.filter(c => selectedCompanyIds.includes(c.id)).map(c => c.id)
      : enabledCompanies.map(c => c.id);

    const state = createSession(user.sub, user.email, insuranceType, companyIds);

    res.json({
      success:    true,
      sessionId:  state.sessionId,
      status:     state.status,
      companies:  enabledCompanies.filter(c => companyIds.includes(c.id)).map(c => ({ id: c.id, name: c.name, logoUrl: c.logoUrl })),
      welcome:    `I'll help you get ${insuranceType} insurance quotes from ${companyIds.length} insurer(s). To start, please upload the Registration Certificate (RC) or tell me the vehicle details.`,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/:sessionId/message  — send a chat message
router.post('/:sessionId/message', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.params;
    const { message }   = req.body as { message: string };
    const user = req.user!;

    if (!message?.trim()) {
      res.status(400).json({ success: false, message: 'message is required' });
      return;
    }

    const state = await ensureSession(sessionId);
    if (!state) {
      res.status(404).json({ success: false, message: 'Session not found' });
      return;
    }
    if (state.userId !== user.sub) {
      res.status(403).json({ success: false, message: 'Not your session' });
      return;
    }

    const enabledCompanies = await getEnabledCompanies(state.insuranceType);
    const companyNames = enabledCompanies
      .filter(c => state.selectedCompanies.includes(c.id))
      .map(c => c.name);

    const result = await processMessage(sessionId, user.sub, user.email, message.trim(), companyNames);

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// GET /api/chat/:sessionId  — get session state
router.get('/:sessionId', requireAuth, async (req: Request, res: Response) => {
  const state = await ensureSession(req.params.sessionId);
  if (!state) { res.status(404).json({ success: false, message: 'Session not found' }); return; }
  if (state.userId !== req.user!.sub) { res.status(403).json({ success: false, message: 'Not your session' }); return; }
  res.json({ success: true, session: state });
});

// DELETE /api/chat/:sessionId  — end session
router.delete('/:sessionId', requireAuth, async (req: Request, res: Response) => {
  const user  = req.user!;
  const state = await ensureSession(req.params.sessionId);
  if (state && state.userId !== user.sub) { res.status(403).json({ success: false, message: 'Not your session' }); return; }

  if (state) {
    logEvent({
      userId: user.sub, userEmail: user.email, sessionId: req.params.sessionId,
      action: 'session_end', outcome: 'success', meta: { reason: 'user_closed' },
    });
  }
  deleteSession(req.params.sessionId);
  res.json({ success: true });
});

// GET /api/chat/stats (admin)
router.get('/stats', requireAuth, (_req, res) => {
  res.json({ success: true, ...getSessionStats() });
});

export default router;

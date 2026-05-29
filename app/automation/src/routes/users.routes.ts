import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../db/client';
import { requireSuperAdmin, requireAuth } from '../middleware/auth';

const router = Router();

// ── List all users ─────────────────────────────────────────────────────────
router.get('/', requireSuperAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const users = await query<{
      id: string; username: string; email: string; role: string;
      enabled: boolean; last_login: string | null; created_at: string; created_by_username: string | null;
    }>(
      `SELECT u.id, u.username, u.email, u.role, u.enabled, u.last_login, u.created_at,
              c.username AS created_by_username
       FROM app_users u
       LEFT JOIN app_users c ON c.id = u.created_by
       ORDER BY u.created_at ASC`,
    );
    res.json({ success: true, users });
  } catch (err) { next(err); }
});

// ── Create user ────────────────────────────────────────────────────────────
router.post('/', requireSuperAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, email, password, role } = req.body;
    const creator = req.user!;

    if (!username || !email || !password || !role) {
      res.status(400).json({ success: false, message: 'username, email, password, role are required' });
      return;
    }
    if (!['super_admin', 'chat_user'].includes(role)) {
      res.status(400).json({ success: false, message: 'role must be super_admin or chat_user' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
      return;
    }

    const hash = await bcrypt.hash(password, 10);

    const [user] = await query<{ id: string; username: string; email: string; role: string }>(
      `INSERT INTO app_users (username, email, password_hash, role, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, email, role`,
      [username, email.toLowerCase(), hash, role, creator.sub],
    );

    res.status(201).json({ success: true, user });
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ success: false, message: 'Username or email already exists' });
      return;
    }
    next(err);
  }
});

// ── Update user (role / enabled) ───────────────────────────────────────────
router.patch('/:id', requireSuperAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const actor  = req.user!;
    const { role, enabled } = req.body;

    // Prevent super_admin from disabling themselves
    if (id === actor.sub && enabled === false) {
      res.status(400).json({ success: false, message: 'You cannot disable your own account' });
      return;
    }

    const updates: string[] = ['updated_at = now()'];
    const params: unknown[] = [];
    let   i = 1;

    if (role !== undefined) {
      if (!['super_admin', 'chat_user'].includes(role)) {
        res.status(400).json({ success: false, message: 'Invalid role' });
        return;
      }
      updates.push(`role = $${i++}`);
      params.push(role);
    }
    if (enabled !== undefined) {
      updates.push(`enabled = $${i++}`);
      params.push(Boolean(enabled));
    }

    params.push(id);
    const [user] = await query<{ id: string; username: string; email: string; role: string; enabled: boolean }>(
      `UPDATE app_users SET ${updates.join(', ')} WHERE id = $${i} RETURNING id, username, email, role, enabled`,
      params,
    );

    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
    res.json({ success: true, user });
  } catch (err) { next(err); }
});

// ── Reset password ─────────────────────────────────────────────────────────
router.post('/:id/reset-password', requireSuperAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 8) {
      res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
      return;
    }

    const hash = await bcrypt.hash(newPassword, 10);
    const [user] = await query<{ id: string; username: string }>(
      'UPDATE app_users SET password_hash = $1, updated_at = now() WHERE id = $2 RETURNING id, username',
      [hash, id],
    );

    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }
    res.json({ success: true, message: `Password reset for ${user.username}` });
  } catch (err) { next(err); }
});

// ── Delete user ────────────────────────────────────────────────────────────
router.delete('/:id', requireSuperAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const actor  = req.user!;

    if (id === actor.sub) {
      res.status(400).json({ success: false, message: 'You cannot delete your own account' });
      return;
    }

    await query('DELETE FROM app_users WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Per-user audit trail (super_admin) ────────────────────────────────────
router.get('/:id/audit', requireSuperAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const limit  = Math.min(parseInt(req.query.limit as string || '100'), 500);
    const offset = parseInt(req.query.offset as string || '0');

    const [meta] = await query<{ username: string; email: string; role: string }>(
      'SELECT username, email, role FROM app_users WHERE id = $1',
      [id],
    );
    if (!meta) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    const events = await query(
      `SELECT id, ts, session_id, portal_id, ins_type, action, outcome, duration_ms, meta
       FROM audit_events
       WHERE user_id = $1
       ORDER BY ts DESC
       LIMIT $2 OFFSET $3`,
      [id, limit, offset],
    );

    const [{ total }] = await query<{ total: string }>(
      'SELECT COUNT(*) AS total FROM audit_events WHERE user_id = $1',
      [id],
    );

    res.json({ success: true, user: meta, events, total: parseInt(total), limit, offset });
  } catch (err) { next(err); }
});

// ── Own audit trail (any authenticated user can see their own) ─────────────
router.get('/me/audit', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const limit  = Math.min(parseInt(req.query.limit as string || '50'), 100);

    const events = await query(
      `SELECT ts, session_id, portal_id, ins_type, action, outcome, duration_ms
       FROM audit_events
       WHERE user_id = $1
       ORDER BY ts DESC
       LIMIT $2`,
      [userId, limit],
    );

    res.json({ success: true, events });
  } catch (err) { next(err); }
});

export default router;

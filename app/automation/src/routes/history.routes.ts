import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { query } from '../db/client';
import { QuoteResult } from '../types';

const router = Router();

// GET /api/history  — user's quotes from the last 7 days
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user     = req.user!;
    const { search, portalId, limit = '50', offset = '0' } = req.query as Record<string, string>;

    let sql = `
      SELECT * FROM quote_results
      WHERE user_id = $1 AND expires_at > now()
    `;
    const params: unknown[] = [user.sub];
    let i = 2;

    if (search) {
      sql += ` AND (reg_number ILIKE $${i} OR vehicle_make ILIKE $${i} OR portal_name ILIKE $${i})`;
      params.push(`%${search}%`);
      i++;
    }
    if (portalId) {
      sql += ` AND portal_id = $${i}`;
      params.push(portalId);
      i++;
    }

    sql += ` ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`;
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const rows = await query<any>(sql, params);
    res.json({ success: true, quotes: rows.map(rowToQuote) });
  } catch (err) {
    next(err);
  }
});

// GET /api/history/:id  — single quote detail
router.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user!;
    const rows = await query<any>(
      'SELECT * FROM quote_results WHERE id = $1 AND user_id = $2 AND expires_at > now()',
      [req.params.id, user.sub]
    );
    if (!rows.length) { res.status(404).json({ success: false, message: 'Quote not found' }); return; }
    res.json({ success: true, quote: rowToQuote(rows[0]) });
  } catch (err) {
    next(err);
  }
});

function rowToQuote(row: any): QuoteResult {
  return {
    id:           row.id,
    sessionId:    row.session_id,
    userId:       row.user_id,
    portalId:     row.portal_id,
    portalName:   row.portal_name,
    insType:      row.ins_type,
    regNumber:    row.reg_number,
    vehicleMake:  row.vehicle_make,
    vehicleModel: row.vehicle_model,
    premium:      row.premium ? parseFloat(row.premium) : null,
    idv:          row.idv     ? parseFloat(row.idv)     : null,
    quoteData:    row.quote_data,
    screenshotKey: row.screenshot_key,
    createdAt:    row.created_at.toISOString(),
    expiresAt:    row.expires_at.toISOString(),
  };
}

export default router;

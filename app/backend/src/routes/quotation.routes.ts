import { Router, Request, Response, NextFunction } from 'express';
import { getQuotation } from '../services/quotation.service';

const router = Router();

// POST /api/quotation
// Body: { postedField: { field_1, field_2, ... } }
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { postedField } = req.body;

    if (!postedField || typeof postedField !== 'object') {
      res.status(400).json({ success: false, message: 'postedField is required' });
      return;
    }

    const data = await getQuotation(postedField);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

export default router;

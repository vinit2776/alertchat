import { Router, Request, Response, NextFunction } from 'express';
import { getAllQuestions } from '../services/questions.service';
import { PRODUCT_META, ProductCode } from '../types/chi.types';

const router = Router();

// GET /api/questions/:productCode
router.get('/:productCode', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const productCode = req.params.productCode.toUpperCase() as ProductCode;
    const meta = PRODUCT_META[productCode];

    if (!meta) {
      res.status(400).json({ success: false, message: `Unknown product: ${productCode}` });
      return;
    }

    const data = await getAllQuestions(meta.productId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

export default router;

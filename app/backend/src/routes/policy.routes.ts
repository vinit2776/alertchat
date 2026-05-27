import { Router, Request, Response, NextFunction } from 'express';
import {
  createPolicy,
  getPolicyStatus,
  getPolicyPDF,
  buildPaymentFormHtml,
} from '../services/policy.service';
import { PRODUCT_META, ProductCode } from '../types/chi.types';

const router = Router();

// POST /api/policy/create/:productCode
router.post('/create/:productCode', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const productCode = req.params.productCode.toUpperCase() as ProductCode;

    if (!PRODUCT_META[productCode]) {
      res.status(400).json({ success: false, message: `Unknown product: ${productCode}` });
      return;
    }

    const data = await createPolicy(productCode, req.body);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/policy/status/:proposalNum
router.get('/status/:proposalNum', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getPolicyStatus(req.params.proposalNum);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/policy/pdf/:policyNum
router.get('/pdf/:policyNum', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ltype = (req.query.ltype as string) || 'POLSCHD';
    const data = await getPolicyPDF(req.params.policyNum, ltype);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// POST /api/policy/payment — returns HTML redirect page for browser
// Body: { proposalNum, csrfToken, returnUrl }
router.post('/payment', (req: Request, res: Response) => {
  const { proposalNum, csrfToken, returnUrl } = req.body;

  if (!proposalNum || !csrfToken || !returnUrl) {
    res.status(400).json({ success: false, message: 'proposalNum, csrfToken and returnUrl are required' });
    return;
  }

  const html = buildPaymentFormHtml(proposalNum, csrfToken, returnUrl);
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// GET /api/policy/products — list all supported products
router.get('/products', (_req: Request, res: Response) => {
  const products = Object.entries(PRODUCT_META).map(([code, meta]) => ({
    code,
    ...meta,
  }));
  res.json({ success: true, data: products });
});

export default router;

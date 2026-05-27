import { Request, Response, NextFunction } from 'express';

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  console.error('[Error]', err?.message || err);

  const status = err?.response?.status || err?.status || 500;
  const message = err?.response?.data?.responseData?.message || err?.message || 'Internal server error';

  res.status(status).json({ success: false, message });
}

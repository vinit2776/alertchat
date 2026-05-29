import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth';
import { extractDocument } from '../document/ocr';
import { applyOcrResult, getSession } from '../ai/conversation';
import { logEvent } from '../audit/logger';

const router  = Router();
const storage = multer.memoryStorage();
const upload  = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// POST /api/documents/upload/:sessionId
router.post('/upload/:sessionId', requireAuth, upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.params;
    const user = req.user!;

    if (!req.file) {
      res.status(400).json({ success: false, message: 'No file uploaded or unsupported format (JPEG, PNG, WEBP, PDF only)' });
      return;
    }

    const state = getSession(sessionId);
    if (!state) { res.status(404).json({ success: false, message: 'Session not found' }); return; }
    if (state.userId !== user.sub) { res.status(403).json({ success: false, message: 'Not your session' }); return; }

    // Log upload event (file name + size, no content)
    logEvent({
      userId: user.sub, userEmail: user.email, sessionId,
      action: 'document_uploaded', outcome: 'pending',
      meta: { filename: req.file.originalname, sizeBytes: req.file.size, mimeType: req.file.mimetype },
    });

    let extractedDoc;
    try {
      extractedDoc = await extractDocument(req.file.buffer, req.file.mimetype);
    } catch (err: any) {
      logEvent({
        userId: user.sub, userEmail: user.email, sessionId,
        action: 'ocr_failed', outcome: 'failure',
        meta: { error: err.message, filename: req.file.originalname },
      });
      res.status(422).json({ success: false, message: `Document extraction failed: ${err.message}` });
      return;
    }

    const updatedState = applyOcrResult(sessionId, user.sub, user.email, extractedDoc);

    res.json({
      success:        true,
      docType:        extractedDoc.docType,
      confidence:     extractedDoc.confidence,
      fieldsExtracted: Object.keys(extractedDoc.fields).length,
      missingFields:  updatedState?.missingRequired ?? [],
      message: extractedDoc.confidence >= 0.7
        ? `Got it! Extracted ${Object.keys(extractedDoc.fields).length} fields from your ${extractedDoc.docType}.`
        : `Document extracted with low confidence (${Math.round(extractedDoc.confidence * 100)}%). Please verify details.`,
    });
  } catch (err) {
    next(err);
  }
});

export default router;

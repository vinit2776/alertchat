import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { uploadDocument } from '../services/document.service';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// POST /api/documents/upload
// multipart/form-data: file, documentType (optional)
router.post('/upload', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: 'No file uploaded' });
      return;
    }

    const documentType = (req.body.documentType as string) || 'OVD_KYC';
    const data = await uploadDocument(req.file.buffer, req.file.originalname, req.file.mimetype, documentType);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

export default router;

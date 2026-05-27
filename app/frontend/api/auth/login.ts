import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHmac, timingSafeEqual } from 'crypto';

const SECRET     = process.env.JWT_SECRET       || 'change-me-in-production';
const USERNAME   = process.env.AUTH_USERNAME     || 'demo';
const PASSWORD   = process.env.AUTH_PASSWORD     || 'care2024';
const TOKEN_TTL  = 24 * 60 * 60 * 1000; // 24 hours

function signToken(payload: object): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyToken(token: string): { sub: string; exp: number } | null {
  try {
    const [data, sig] = token.split('.');
    const expected = createHmac('sha256', SECRET).update(data).digest('base64url');
    const sigBuf  = Buffer.from(sig,      'base64url');
    const expBuf  = Buffer.from(expected, 'base64url');
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const { username, password } = req.body ?? {};

  // Pad to same length before comparing to avoid timing-safe-equal length mismatch throws
  function safeEqual(a: string, b: string): boolean {
    const maxLen = Math.max(a.length, b.length);
    const aBuf   = Buffer.alloc(maxLen); Buffer.from(a).copy(aBuf);
    const bBuf   = Buffer.alloc(maxLen); Buffer.from(b).copy(bBuf);
    return timingSafeEqual(aBuf, bBuf) && a.length === b.length;
  }

  if (!safeEqual(username ?? '', USERNAME) || !safeEqual(password ?? '', PASSWORD)) {
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  }

  const token = signToken({ sub: username, exp: Date.now() + TOKEN_TTL });
  return res.json({ success: true, token });
}

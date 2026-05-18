import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function seoAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.SEO_ADMIN_TOKEN;
  if (!expected) {
    res.status(503).json({ error: 'SEO admin auth not configured' });
    return;
  }
  const provided = req.headers['x-admin-token'];
  const token = typeof provided === 'string' ? provided : '';
  if (!safeEqual(token, expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

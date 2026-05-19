import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';

const EXPECTED_TOKEN_LENGTH = 64;

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
  if (expected.length !== EXPECTED_TOKEN_LENGTH) {
    logger.error(
      `SEO_ADMIN_TOKEN length is ${expected.length}, expected ${EXPECTED_TOKEN_LENGTH} hex chars. ` +
      `Refusing all SEO requests to prevent authentication bypass.`
    );
    res.status(503).json({ error: 'SEO admin token misconfigured' });
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

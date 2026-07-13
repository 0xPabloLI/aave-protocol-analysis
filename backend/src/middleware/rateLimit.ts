import rateLimit from 'express-rate-limit';

/**
 * Thin wrapper around express-rate-limit for backward-compatible call sites.
 * CodeQL recognises the underlying express-rate-limit package.
 */
export function rateLimitMiddleware(windowMs: number, max: number) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
  });
}

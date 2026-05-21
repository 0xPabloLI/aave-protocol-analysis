import type { NextFunction, Request, Response } from 'express';

const CACHE_CONTROL = {
  // Core real-time APIs: always revalidate to match frontend staleTime expectations.
  coreRealtime: 'no-cache, must-revalidate',
  // Public side-data API (categories=6h, FDV=15m, forecast=10m); s-maxage aligned to
  // the shortest source TTL (forecast=10m) so edge cache never serves data older than
  // any individual source's freshness contract.
  sideDataMeta: 'public, max-age=60, s-maxage=600, stale-while-revalidate=600',
  // Never cache health checks.
  noStore: 'no-store',
} as const;

function setCacheControlIfMissing(res: Response, value: string): void {
  if (!res.getHeader('Cache-Control')) {
    res.setHeader('Cache-Control', value);
  }
}

export function apiCacheHeadersMiddleware(req: Request, res: Response, next: NextFunction): void {
  const path = req.path;

  if (path === '/health' || path === '/api/health') {
    setCacheControlIfMissing(res, CACHE_CONTROL.noStore);
    next();
    return;
  }

  if (path.startsWith('/api/markets')) {
    setCacheControlIfMissing(res, CACHE_CONTROL.coreRealtime);
    next();
    return;
  }

  if (path.startsWith('/api/meta/side-data')) {
    setCacheControlIfMissing(res, CACHE_CONTROL.sideDataMeta);
    next();
    return;
  }

  next();
}

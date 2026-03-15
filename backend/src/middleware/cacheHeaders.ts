import type { NextFunction, Request, Response } from 'express';

const CACHE_CONTROL = {
  // Core real-time APIs: always revalidate to match frontend staleTime expectations.
  coreRealtime: 'no-cache, must-revalidate',
  // Side-data APIs with slower update cadence.
  coingeckoFdv: 'public, max-age=60, s-maxage=300, stale-while-revalidate=300',
  coingeckoCategories: 'public, max-age=3600, s-maxage=21600, stale-while-revalidate=21600',
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

  if (path.startsWith('/api/campaigns/forecast-states')) {
    setCacheControlIfMissing(res, CACHE_CONTROL.coreRealtime);
    next();
    return;
  }

  if (path.startsWith('/api/coingecko-fdv')) {
    setCacheControlIfMissing(res, CACHE_CONTROL.coingeckoFdv);
    next();
    return;
  }

  if (path.startsWith('/api/meta/side-data')) {
    // Meta payload contains FDV (5m), forecast (10m), and categories (6h); use the shortest TTL.
    setCacheControlIfMissing(res, CACHE_CONTROL.coingeckoFdv);
    next();
    return;
  }

  if (path.startsWith('/api/coingecko-categories')) {
    setCacheControlIfMissing(res, CACHE_CONTROL.coingeckoCategories);
    next();
    return;
  }

  next();
}

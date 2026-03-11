# Cloudflare + API Cache Playbook

Last updated: 2026-03-11

This document explains why AaveAPY backend API caching is configured by endpoint class, how it aligns with frontend `staleTime`, and how to apply matching Cloudflare rules.

## 1) Design Goal

The core requirement is:

- frontend `staleTime` defines **when to re-check freshness**
- re-check should validate against latest origin state
- unchanged responses should still be cheap on bandwidth/latency

This is why core real-time APIs use `no-cache + ETag`, while lower-frequency side-data APIs use edge/browser TTL.

## 2) Why Not One Global Cache TTL

Different endpoints have materially different freshness needs:

- `/api/markets`, `/api/rate-inputs`, `/api/campaigns/forecast-states` directly affect APY/simulation decisions and should be revalidated at each frontend refetch point.
- `/api/coingecko-fdv`, `/api/coingecko-categories` are side-data with slower update cadence and can tolerate TTL-based caching.

Using one global TTL either:

- makes core APY data too stale, or
- destroys cache hit rate for side-data.

## 3) Current Backend Header Policy

Implemented in:

- `backend/src/middleware/cacheHeaders.ts`
- `backend/src/server.ts` (`compression` + `app.set('etag', 'weak')`)

Header policy:

- core realtime:
  - paths: `/api/markets*`, `/api/rate-inputs*`, `/api/campaigns/forecast-states*`
  - `Cache-Control: no-cache, must-revalidate`
  - with `ETag` (conditional request -> `304` when unchanged)
- side data:
  - `/api/coingecko-fdv*` -> `public, max-age=60, s-maxage=300, stale-while-revalidate=300`
  - `/api/coingecko-categories*` -> `public, max-age=3600, s-maxage=21600, stale-while-revalidate=21600`
- health:
  - `/health`, `/api/health` -> `no-store`

Compression:

- `compression` middleware enabled, with `br`/`gzip` negotiated by client/proxy.

## 4) Frontend `staleTime` Compatibility

`staleTime` and HTTP cache are not duplicates:

- `staleTime` decides **when** the frontend sends a new request.
- cache headers decide **how** that request is served (edge hit, browser hit, revalidate with `If-None-Match`, or full origin payload).

For core realtime APIs:

- `staleTime` controls check frequency.
- `ETag` makes unchanged checks cheap (`304`).

For side-data APIs:

- TTL-based caching reduces repeated transfer and origin load.

## 5) Cloudflare Rule Strategy

Given API hostnames are proxied (orange cloud), create two ordered rules:

1. `bypass-core-realtime-api` (highest priority)
   - match host + path for:
     - `/api/markets*`
     - `/api/rate-inputs*`
     - `/api/campaigns/forecast-states*`
   - action: `Bypass cache`

2. `cache-side-data-api`
   - match host + path for:
     - `/api/coingecko-fdv*`
     - `/api/coingecko-categories*`
   - action:
     - `Eligible for cache`
     - `Edge TTL: Respect origin`
     - `Browser TTL: Respect origin`

Additionally:

- keep Brotli enabled in Cloudflare Speed/Optimization
- avoid `Cache Everything` on core realtime APIs
- purge cache once after introducing new rules

## 6) Verification Checklist

1. Compression:
   - `curl -I -H 'Accept-Encoding: br,gzip' https://<api-host>/api/markets`
   - expect `Content-Encoding: br` or `gzip`
2. Core revalidation:
   - `curl -I https://<api-host>/api/markets`
   - expect `Cache-Control: no-cache, must-revalidate` and `ETag`
3. 304 behavior:
   - resend with `If-None-Match` from previous ETag
   - expect `304` when unchanged
4. Side-data edge caching:
   - repeated `curl -I` on `/api/coingecko-categories`
   - expect `CF-Cache-Status` moves toward `HIT`


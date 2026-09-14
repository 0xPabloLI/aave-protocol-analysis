# aave-browser-rendering

Cloudflare Worker (Durable Object + Puppeteer Browser Rendering) used as the
Merit dynamic-info fallback by the fetcher.

## Local development / Interactive QA path

1. **Install**: from `workers/`, run `npm install` (or `npm ci`).
2. **Auth gate**: `Browser Rendering` is a Cloudflare service — browser-backed
   actions (`extractCampaignInfo`, `extractSelfAuth`, `extractDynamicInfo`,
   `debugSessions`) require a Cloudflare account:
   `npx wrangler login` (opens browser), then run dev in remote mode:
   `npm run dev -- --remote`.
   The health/limits routes below work without any auth.
3. **Launch**: `npm run dev` (local mode) — Worker listens on
   `http://localhost:8787`.
4. **Drive interactions**:
   - Liveness: `curl http://localhost:8787/health` → `{"status": "ok"}`
   - Browser quota: `curl http://localhost:8787/limits`
   - Pool stats (no browser launch): `curl -X POST http://localhost:8787/ -H 'Content-Type: application/json' -d '{"action":"getStats"}'`
   - Browser-backed extraction (requires remote mode + CF auth): POST
     `{"action":"extractCampaignInfo","key":"https://app.aavechan.com/merit/..."}`

## Tests

- `npm test` — unit (rate-limit detection, semaphore, secure randomness) +
  integration (routing, DO request contract) via node:test/tsx; no browser or
  CF account needed.
- `npm run test:coverage` — same suite under c8 with ratcheted thresholds.

## API schema

`openapi.yaml` describes the three HTTP surfaces (health, limits, DO actions).

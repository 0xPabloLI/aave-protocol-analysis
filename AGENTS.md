# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

Two-service TypeScript codebase that fetches and serves Aave V3 market data across 17+ chains, 20+ markets, and 229+ token reserves. Integrates incentive data from Merit, Merkl, and Brevis protocols.

**Architecture**: Backend API (`backend/`) runs `fetchMarketsPayload()` (from packaged root `dist/index.js`) on a cron + startup warmup and keeps markets in **memory**; `GET /api/markets` reads that snapshot only. The optional root Data Fetcher (`npm run dev` at repo root) **writes** `data/runtime` / `data/debug` files for exports and debugging; the backend does **not** read `data/runtime/aave-formatted-data.json` to serve the API.

## Development Commands

### Root Directory (Data Fetcher)
```bash
npm install              # Install dependencies
npm run dev              # Run data fetcher with tsx (writes to data/)
npm run build            # Compile TypeScript to dist/
npm start                # Run compiled fetcher (node dist/index.js)
```

### Backend API (`backend/`)
```bash
cd backend
npm install              # Install backend dependencies
npm run dev              # Start dev server with tsx on http://localhost:3001
npm run build            # Compile backend TypeScript to dist/
npm start                # Run compiled server (production mode)
./deploy.sh pm2          # Deploy with PM2 (local testing)
./deploy.sh local        # Run directly without PM2
```

### Deployment
```bash
# Local PM2 deployment (from backend/)
cd backend && ./deploy.sh pm2

# Remote production deployment (from root)
./deploy.sh [host]       # SSH-based deployment to remote server

# PM2 management
pm2 status               # Check status
pm2 logs aave-backend    # View logs
pm2 restart aave-backend # Restart service
pm2 stop aave-backend    # Stop service
```

### Data Workflow (Backend)
Serving `/api/markets` does **not** depend on any pre-generated `data/runtime/*.json` file. Start the backend and wait for startup warmup (`refreshMarketsSnapshot()` + other caches). Optional: run the root fetcher (`npm run dev` at repo root) only when you need on-disk exports (`aave-formatted-data.json`, CSV, debug snapshots).

### Architecture Notes (Read Before Cache/Data-Flow Changes)
- `docs/merkl-merit-cache-architecture.md` — Merkl/Merit cache layers, file roles, fallback chains; includes **which `GET /v4/opportunities` fields `merkl-api.ts` reads** (tables + Mermaid diagrams)
- `docs/backend/data-freshness-mechanism.md` — TTL configuration, freshness thresholds, staleness handling
- `docs/development-best-practices.md` — general implementation patterns (naming, API design, change management)
- `docs/deploy/cloudflare-complete-guide.md` — Cloudflare Workers, API caching, concurrency control
- If you change cache layers, file paths/layout, data-flow boundaries, or fallback chains, update relevant docs in the same PR/commit set.
- When adding/changing a TTL, first verify the upstream data update cadence (docs or observed timestamps) and document the reasoning if non-obvious.

### Local Git Hook Policy (Mandatory)
- This repo uses local `pre-commit` and `pre-push` hooks to run `npm run ci:remote`.
- If `ci:remote` fails, hooks must automatically attempt `npm run ci:auto-fix`, then rerun `ci:remote`.
- If checks still fail after auto-fix, stop the commit/push and fix the root cause before retrying.
- Do not bypass hooks as a normal workflow.
- If local checks fail repeatedly, rely on CI remediation PR flow as a fallback path, then merge validated fixes back to the working branch.
- Do not merge feature/dependency branches into `main` locally. Use remote merge via GitHub PR only (merge button / auto-merge / `gh pr merge`).
- Preferred flow: push branch → open PR against target branch → wait CI green → remote merge.

**Lock File Drift Prevention**:
- `pre-commit` auto-stages any unstaged `package-lock.json` / `backend/package-lock.json` changes to prevent local/CI audit drift.
- `pre-push` blocks push if lock files have uncommitted changes, since CI uses committed versions.

## Code Architecture

### Data Flow Pipeline

```
External APIs → Backend Cron Jobs → In-Memory Snapshots → REST Clients
     ↓                    ↓                   ↓
[Aave SDK, Merit,    [cron-write every      [API-read-only:
 Merkl, Brevis,       1-10 minutes]          never triggers
 CoinGecko APIs]                             external fetches]
```

**Key Architectural Concepts**:

1. **Cron-Write/API-Read-Only**: All data endpoints use this pattern. Cron jobs periodically fetch fresh data; API requests only read from in-memory snapshots, never triggering external API calls.

2. **Startup Warmup**: All caches are pre-populated in `server.ts` before `app.listen()` because cron doesn't run immediately. Server only accepts requests after all data is ready.

3. **Internalized Fetcher**: The data fetcher logic (`src/index.ts`) is imported directly into backend and executed via cron, eliminating file-based communication. Data lives entirely in memory.

### Module Responsibilities

#### Data Fetcher (`src/`)
- `index.ts` - Main orchestrator: fetches from all APIs, builds chain-token indices, merges incentive data, writes output with metadata
- `merit-api.ts` - Merit APR fetcher; groups by supply/borrow requirements and self-supply/borrow patterns
- `merkl-api.ts` - Merkl opportunities fetcher; processes campaign breakdowns and calculates aggregate APRs
- `brevis-api.ts` - Brevis Linea Surge fetcher; builds `chainId-tokenAddress` index for matching
- `logger.ts` - Winston logger (console + rotating file logs to `logs/`)

**Matching Strategy**: Each API uses different identifiers:
- Merit: `chainId-tokenAddress` keys (direct match)
- Merkl: Chain name + token symbol (case-insensitive)
- Brevis: `chainId-tokenAddress` index (direct match)

#### Backend API (`backend/src/`)

**Core Services**:
- `services/marketsService.ts` - Unified data fetcher (markets + on-chain data); parallel fetch from Aave API + RPC; single `fetchedAt` for consistent staleness
- `services/onchainDataService.ts` - On-chain data fetcher (`deficit`, `baseVariableBorrowRate`) via `UiPoolDataProvider.getReservesHumanized()`; per-chain cache with 30-min TTL; cron every 1 min at :10
- `services/updateScheduler.ts` - Cron scheduler (markets 1m unified, forecast 10m, FDV 5m, categories 6h)
- `services/merklForecastService.ts` - Merkl forecast data processor; metricsCache (dynamic TTL 10m-6h) + campaignOpportunityCache (5m)

**Request Handlers**:
- `controllers/marketsController.ts` - `GET /api/markets` reads in-memory snapshot only (cron-write/API-read-only)
- `controllers/coingeckoController.ts` - CoinGecko categories data handler
- `controllers/merklForecastController.ts` - Merkl forecast endpoints

**Infrastructure**:
- `server.ts` - Express app setup; loads initial cache, starts scheduler, registers routes
- `routes/` - Route definitions (`markets.ts`, `coingecko.ts`, `campaigns.ts`, etc.)
- `middleware/cors.ts` - CORS config (allow-all in dev, whitelist in production via `FRONTEND_URL`)
- `types/index.ts` - TypeScript interfaces
- `env.ts` - Environment variable validation and loading
- `logger.ts` - Winston logger (backend logs to `backend/logs/`)

### Critical Architectural Patterns

#### 1. ES Modules with .js Extensions
Both services use `"type": "module"`. **ALWAYS** use `.js` extensions in imports, even for `.ts` files:
```typescript
import { logger } from './logger.js';  // ✅ Correct
import { logger } from './logger';     // ❌ Wrong
```

#### 2. Optional Field Omission in JSON
Backend uses custom JSON serialization to omit `undefined` values and empty arrays (not `null`). Fields like `supplyApy`, `meritSupplys`, `merklSupplyAprBreakdowns` only appear if they have data.

#### 3. APR to APY Conversion
`convertAprToApy()` uses monthly compounding: `(1 + APR/12)^12 - 1`

#### 4. Refresh concurrency (markets snapshot)
`marketsService.refreshMarketsSnapshot()` uses a single `refreshInProgress` promise so concurrent cron/handlers await the same in-flight refresh instead of stacking fetches.

#### 5. Metadata-Based Timestamps
Data files include `_metadata.timestamp` (written by fetcher). Backend prioritizes this over file mtime, ensuring accurate staleness detection even if file is copied/touched.

### API Endpoints

**公开 API 共 4 条 URL / 3 个逻辑端点**（完整列表与详细说明见 `docs/api/api-documentation.md`）。`GET /api/markets` 使用 `markets-v2` 结构：根级 `snapshot + reserves`；价格主字段在 `reserves[].tokenPrice`。

```
GET /health                        # Health check with environment info
GET /api/health                    # Same handler as /health (API namespace)
GET /api/markets                   # markets-v2 snapshot + full reserves (no query params)
GET /api/meta/side-data            # Aggregated side data (categories + fdv + forecast)
```

**Markets 数据新鲜度**（cron-write/API-read-only）:
- `GET /api/markets` — 响应含 `{ snapshot, reserves }`；`staleTimeMs` 提示前端缓存窗口；服务端由 cron 每分钟刷新，**请求不触发拉取**
  - 每个 reserve 含可选 `deficit` / `baseVariableBorrowRate`（来自 on-chain 缓存合并或回退）
  - Deficit 获取失败时优雅降级：仍可有 `deficit: "0"` 等回退行为（见 `marketsService`）
- `GET /api/meta/side-data` 聚合 categories / fdv / forecast 三类内部缓存快照；这些子缓存仍各自按独立 cadence 预热，但不再单独对外暴露。

## Configuration

### Environment Variables
Configure in **repo root `.env`** (single source of truth):
```bash
PORT=3001                          # Server port
NODE_ENV=development               # Environment mode
FRONTEND_URL=https://example.com   # CORS whitelist (production only, comma-separated)
ALLOWED_DEV_ORIGINS=...            # Dev CORS whitelist
DOPPLER_TOKEN=...                  # Doppler secrets (production)
MERKL_FORECAST_RESULT_CACHE_TTL_MS=600000             # Forecast result cache TTL (default 10m, aligned with metricsMin)
MERKL_FORECAST_OPPORTUNITY_META_CACHE_TTL_MS=300000   # Opportunity meta cache TTL (default 5m)
MERKL_METRICS_CACHE_TTL_MS=1800000                    # Metrics cache default TTL (default 30m, dynamic cadence-based)
```

**Priority**: System env vars > `.env` file > defaults

### TypeScript Configuration
- **Root** `tsconfig.json` - Compiles `src/` → `dist/` (excludes backend)
- **Backend** `backend/tsconfig.json` - Compiles `backend/src/` → `backend/dist/`

Both use `"module": "ESNext"` with `"target": "ES2022"`.

### Data Files (`data/`, gitignored)
```
runtime/aave-formatted-data.json          # Written by root fetcher; same pipeline shape as API payload, but API uses memory (not this file)
runtime/merkl-opportunity-meta-lite.json  # Merkl forecast runtime-lite snapshot (backend reads for forecast)
runtime/merit-campaign-metadata-cache.json # Merit campaign metadata cache (time/message/link)
exports/aave-formatted-data.csv           # CSV export
debug/aave-all-markets-data.json          # Raw Aave SDK response
debug/aave-all-markets-error.json         # Error snapshot
debug/brevis-raw-data.json                # Brevis raw data with API responses
debug/merkl-raw-data.json                 # Merkl raw data (debug)
debug/merit-raw-data.json                 # Merit raw data (debug)
debug/merit-merkl-raw-data.json           # Merit↔Merkl round estimation debug
```

### Logging
- **Data Fetcher**: Winston logs to `logs/combined.log` + `logs/error.log` (root)
- **Backend API**: Winston logs to `backend/logs/` (PM2 errors to `backend/logs/pm2-error.log`)
- Both: 5MB rotation, keep 5 files

## Common Patterns & Gotchas

### Data Matching Strategy
Each incentive API uses different identifiers:
- **Merit**: `chainId-tokenAddress` (e.g., `"1-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"`)
- **Merkl**: Chain name + symbol case-insensitive (e.g., `ethereum` + `USDC`)
- **Brevis**: `chainId-tokenAddress` index
- **Token price delivery**: keep full reserve rows in `reserves` and attach `tokenPrice` inline.
- **Reward token rule**: Merkl reward token prices are not output in `/api/markets` for now; if a reward token is an Aave `aToken`, do not emit a separate price entry.

### Reserve Size Definitions
- `reserves[].reserveSizeUsd` = **total supply in USD** (not supply − borrowed). This matches the Aave reserve `size.usd` surface.
- `reserve.size.raw` composition: `availableLiquidity + totalVariableDebt`, where `totalVariableDebt = totalScaledVariableDebt × variableBorrowIndex ÷ 10²⁷`. See `docs/api/native-apr-calculation.md` for derivation.
- `reserves[].deficit` = **raw token units** from `UiPoolDataProvider.getReservesHumanized()` (Aave v3.3.0+); for simulation utilization denominator adjustment. Absent if RPC failed. **Not included** in `reserve.size`.
- `reserves[].baseVariableBorrowRate` = **RAY (1e27)** from same RPC call; for simulated borrow rate calculation. Absent if RPC failed.
- `borrowInfo.availableLiquidity` remains the right field for "how much can still be borrowed now".

### Frozen/Paused Reserves
Reserves with `isFrozen === true` or `isPaused === true` are still included in output but marked with `supplyDisabled: true`.

### Capacity Limits & Disabled State Handling
- `supplyApy` → `undefined` (omitted) when `supplyCap === 1`
- `supplyDisabled` → `true` (present only when disabled) when `isFrozen`, `isPaused`, or `supplyCap === 1`
- `supplyCapUsd` → always returns USD value of supply cap (if available)
- `borrowApy` → always returns real value (even when borrowing is disabled)
- `borrowDisabled` → `true` (present only when disabled) when `borrowCap === 1` or `borrowingState === "DISABLED"`
- `borrowCapUsd` → always returns USD value of borrow cap (if available), symmetric with `supplyCapUsd`

### Network Discovery
Uses `@bgd-labs/aave-address-book` to auto-discover AaveV3 networks. Excludes test networks (Sepolia, Fuji).

### Backend Cache Architecture
- **All endpoints use cron-write/API-read-only** pattern (API requests never trigger external fetches):
  - Markets (unified): cron every 1m refreshes `marketsSnapshot` with parallel Aave API + RPC deficit fetch
  - Merkl forecast: cron every 10m refreshes `snapshotCache`
  - CoinGecko categories/FDV: cron every 6h/5m refreshes cache
- **Startup warmup**: All caches are explicitly warmed in `server.ts` before `app.listen()`. Server only accepts requests after all data is ready.
- **Cache structure choice**: Use `Map<key, entry>` when items have different TTLs (e.g., `metricsCache` per-campaign with dynamic TTL 10m-6h); use single snapshot object when API returns all data together
- **metricsCache optimization**: Stores raw Merkl metrics with dynamic TTL (10m-6h based on data cadence). This is the key optimization - metrics API calls are expensive, forecast computation is fast. `forecastCache` was removed as redundant with cron-write pattern.
- See `docs/backend/data-freshness-mechanism.md` for detailed TTL tables and staleness thresholds
- See `docs/deploy/cloudflare-complete-guide.md` for API cache headers and Cloudflare rules

### PM2 Production Config
`ecosystem.config.cjs` at root defines PM2 settings:
- Memory limit: 500MB
- Auto-restart with max 10 restarts
- Logs: `backend/logs/pm2-*.log`
- Environment variables (production defaults)

## Testing & Validation

No formal test framework. Manual validation:
1. Start backend: `cd backend && npm run dev`
2. Test endpoints (API serves from memory after warmup):
   ```bash
   curl http://localhost:3001/health
   curl http://localhost:3001/api/markets | jq '.reserves | length'
   ```
3. Optional root fetcher: `npm run dev` at repo root → inspect `data/runtime/` if you need on-disk artifacts; check `tail -f logs/combined.log`

## Important Implementation Notes

### When Adding New Endpoints
Follow the same cache pattern as sibling endpoints: cron-warmed snapshot + read-only handler, or document explicit TTL if adding a new external source.

### When Modifying Update Logic
For markets, respect `refreshInProgress` in `marketsService` and avoid triggering `fetchMarketsPayload()` from request paths.

### When Changing Data Schema
Update both:
1. Root fetcher output format in `src/index.ts`
2. Backend type definitions in `backend/src/types/index.ts`
3. Keep existing reserve-level incentive fields unless explicitly removed by product/API contract decision.

### Environment Variable Priority
In production with Doppler:
1. System environment variables (highest)
2. `ecosystem.config.cjs` defaults
3. Doppler-fetched secrets (lowest, only if not already set)

Don't set secrets in `ecosystem.config.cjs`—they'll override Doppler.

## Learned User Preferences

- Keep documentation concise; remove outdated/superseded content rather than accumulating
- Prefer direct runtime/script verification over speculative root-cause explanations when debugging production behavior
- Question redundant boolean flags when data comes from the same source (e.g., if all rate-input fields exist, a separate flag adds no value)
- Prefer merging API endpoints when data is pre-fetched together with the same TTL/staleness; flatten nested objects when possible
- Verify changes appear in API response after implementation; rebuild `dist/` if backend imports from it
- When adding new reserve fields to fetcher output, also add them to `pruneReserveForRuntime()` or they will not appear in runtime/API; then rebuild root so backend sees updates
- For small pure helpers that shape API output (e.g. Merkl breakdown derivations), add focused `backend` unit tests when the module can be imported without live network calls
- Organize reusable patterns into `docs/reusable/` for cross-project portability
- When describing refresh cadence or cache freshness, name the subsystem (markets vs Merkl forecast vs Merkl metrics) and align statements with `backend/src/cacheTtl.ts` and `updateScheduler.ts` so labels like `realtimeFamily` are not applied to Merkl forecast paths
- Prefer schema convergence across incentive sources (especially Brevis↔Merkl field naming/types) and ask frontend cleanup to remove newly added fields that are not actually used

## Learned Workspace Facts

- Backend imports from `dist/index.js` — rebuild root (`npm run build`) after `src/index.ts` changes; new reserve-level fields must be listed in `pruneReserveForRuntime()` or they are dropped from runtime/API. On-chain `deficit` / `baseVariableBorrowRate` from `UiPoolDataProvider.getReservesHumanized()`; per-chain cache 30m TTL; each chain tries RPCs with 15s per attempt; only `deficit` needs on-chain RPC; other rate-input fields from Aave API. Markets cron :00, on-chain cron :10 each minute; markets merge reads on-chain cache at merge time
- Merit campaign metadata `endBlock` from upstream can diverge from chain-local block-height expectations (for example Celo campaigns carrying Ethereum-like block ranges); treat `endDate` as primary expiry signal and refresh stale metadata rounds instead of relying on `endBlock` priority
- `/api/rate-inputs` removed; all rate-input fields live in `/api/markets` reserves; frontend must fallback when `deficit` or `baseVariableBorrowRate` are absent
- RPC order in `packages/aave-shared-config`: public RPC first, private (Infura/Ankr/Alchemy) last. `totalVariableDebt` from Aave SDK replaces `totalScaledVariableDebt` + `variableBorrowIndex`; precision (raw token units, BPS, RAY) aligned with former on-chain source
- CORS `FRONTEND_URL` uses exact-origin matching only (no subdomains or wildcards); list each allowed origin comma-separated with full URL including protocol (e.g. `https://aaveapy.com,https://www.aaveapy.com`)
- Merkl forecast budget fields for non-PRETGE campaigns must be USD-only (no token-unit fallback): resolve price from snapshot/local sources first, then CoinGecko fallback; if price is still missing, warn and omit those budget fields from API output
- `merkl-opportunity-meta-lite.json` is written by the root fetcher from Merkl opportunities; forecast lite keys campaigns by `rewardsRecord.breakdowns[].campaignId`, and the forecast cron uses IDs from markets merkl breakdowns, not Merkl's full live catalog—keep markets runtime and lite snapshots refreshed together to avoid stale campaign ID mismatches
- `BACKEND_CACHE_TTL_MS.realtimeFamily` and markets cron cadence apply to `/api/markets` staleness only; Merkl forecast uses separate defaults (for example `merklForecastResultDefault` 10m, `merklForecastOpportunityMetaDefault` and `merklOpportunitiesDefault` 5m, plus dynamic metrics TTL)—do not conflate them when comparing intervals
- Raw Merkl payloads may include non-empty `params.whitelist` (surfaced as `whitelistOnly` on breakdowns); a given snapshot's observed distribution types may omit `FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE` even though normalization and forecast code support that type
- Merkl `rewardsRecord.breakdowns[].value` is the same upstream daily-scalar field across Aave and Tydro opportunities; `pointsPerThousandUsd` is attached only when `token.type === 'PRETGE'` (`merklBreakdownUsesPointsIntensityFields` in `src/merkl-api.ts`), using `value` and `tvl`. Optional overlap check: `scripts/merkl-pretge-points-overlap.mjs`; opportunities field mapping: `docs/merkl-merit-cache-architecture.md`
- Startup warmup in `backend/src/server.ts` runs Phase 1 `Promise.allSettled` (on-chain, markets, CoinGecko categories, FDV) then Phase 2 `warmCampaignForecastStatesCache()` so forecast can use the markets snapshot
- For Brevis rewards, treat `tvl` as USD; reward USD resolution should prefer backend snapshot prices, then CoinGecko fallback (`/asset_platforms` → `/simple/token_price/{platform}` → `/simple/price`) only when price is missing, and only pass contract address when it is confirmed to be a token address (not a pool address)

# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

Two-service TypeScript codebase that fetches and serves Aave V3 market data across 17+ chains, 20+ markets, and 229+ token reserves. Integrates incentive data from Merit, Merkl, and Brevis protocols.

**Architecture**: Data Fetcher (root `src/`) → JSON snapshots (`data/runtime` + `data/debug`) → Backend API (`backend/`) → REST clients

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

### Data Workflow
The backend requires runtime data files before serving requests:
1. Run data fetcher: `npm run dev` (root directory)
2. Verify output in `data/runtime/aave-formatted-data.json`
3. Start backend: `cd backend && npm run dev`

### Architecture Notes (Read Before Cache/Data-Flow Changes)
- `docs/merkl-merit-cache-architecture.md` — Merkl/Merit cache layers, file roles, fallback chains
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
- `services/marketsService.ts` - Internalized data fetcher; cron-write/API-read-only pattern; in-memory snapshot with `refreshMarketsSnapshot()` + `getMarketsSnapshot()`
- `services/updateScheduler.ts` - Cron scheduler (markets 1m, rate-inputs 1m, forecast 10m, FDV 5m, categories 6h)
- `services/merklForecastService.ts` - Merkl forecast data processor; metricsCache (dynamic TTL 10m-6h) + campaignOpportunityCache (5m)
- `services/rateInputsService.ts` - On-chain/API rate inputs; only `deficit` requires on-chain RPC

**Request Handlers**:
- `controllers/marketsController.ts` - Primary controller; implements `checkAndUpdateDataIfStale()` with concurrency control
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

#### 4. Update Concurrency Control Pattern
```typescript
// Global state machine prevents duplicate updates
let updateStatus: 'idle' | 'updating' | 'error';
let activeUpdatePromise: Promise<void> | null = null;
let updateGeneration: number = 0;  // Detects if newer update started

// In checkAndUpdateDataIfStale():
if (isStale && !activeUpdatePromise && status !== 'updating') {
  updateStatus = 'updating';
  activeUpdatePromise = performUpdate();  // Track promise
  // Callers wait via: if (activeUpdatePromise) await activeUpdatePromise;
}
```

#### 5. Metadata-Based Timestamps
Data files include `_metadata.timestamp` (written by fetcher). Backend prioritizes this over file mtime, ensuring accurate staleness detection even if file is copied/touched.

### API Endpoints

**共 8 个端点**（完整列表与详细说明见 `docs/api/api-documentation.md`）。`GET /api/markets` 使用 `markets-v2` 结构：根级 `snapshot + reserves`；价格主字段在 `reserves[].tokenPrice`。

```
GET /health                        # Health check with environment info
GET /api/health                    # Same handler as /health (API namespace)
GET /api/markets                   # markets-v2 snapshot + full reserves (no query params)
GET /api/coingecko-categories      # CoinGecko category data (stablecoins, ETH-related)
GET /api/coingecko-fdv             # CoinGecko FDV data (CMC primary, CG fallback)
GET /api/campaigns/forecast-states # Merkl campaign forecast states (optional ids=...)
GET /api/rate-inputs               # Reserve rate inputs (optional chainId, asset, marketName)
GET /api/meta/side-data            # Aggregated side data (categories + fdv + forecast)
```

**Markets 数据新鲜度**（仅以下端点会触发 `checkAndUpdateDataIfStale()`）:
- `GET /api/markets` — 响应含 `{ snapshot, reserves }`；若数据超过 1 分钟未更新会自动触发刷新并受并发控制。
- 其他端点（coingecko、campaigns、rate-inputs）使用各自缓存/TTL，不触发市场数据刷新。

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
runtime/aave-formatted-data.json          # Primary: market data + metadata (backend reads this)
runtime/merkl-opportunity-meta-lite.json  # Merkl forecast runtime-lite snapshot
runtime/merit-campaign-metadata-cache.json # Merit campaign metadata cache (time/message/link)
exports/aave-formatted-data.csv           # CSV export
debug/aave-all-markets-data.json          # Raw Aave SDK response
debug/aave-all-markets-error.json         # Error snapshot
debug/brevis-raw-data.json                # Brevis raw data with API responses
debug/merkl-raw-data.json                 # Merkl raw data (debug)
debug/merit-raw-data.json                 # Merit raw data (debug)
debug/merit-merkl-raw-data.json           # Merit↔Merkl round estimation debug
debug/rate-inputs-raw-data.json           # Rate-inputs raw subgraph/onchain responses (backend)
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
- `rate-inputs[].deficit` = **raw token units** from `pool.getReserveDeficit(asset)` (for simulation utilization denominator adjustment). **Not included** in `reserve.size`.
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
  - Markets: cron every 1m refreshes `marketsSnapshot`
  - Rate-inputs: cron every 1m refreshes snapshot
  - Merkl forecast: cron every 10m refreshes `snapshotCache`
  - CoinGecko categories/FDV: cron every 6h/5m refreshes cache
- **Startup warmup**: All caches are explicitly warmed in `server.ts` before `app.listen()`. Server only accepts requests after all data is ready.
- **Cache structure choice**: Use `Map<key, entry>` when items have different TTLs (e.g., `metricsCache` per-campaign with dynamic TTL 10m-6h); use single snapshot object when API returns all data together
- **metricsCache optimization**: Stores raw Merkl metrics with dynamic TTL (10m-6h based on data cadence). This is the key optimization - metrics API calls are expensive, forecast computation is fast. `forecastCache` was removed as redundant with cron-write pattern.
- See `docs/backend/data-freshness-mechanism.md` for detailed TTL tables and staleness thresholds
- See `docs/deploy/cloudflare-complete-guide.md` for API cache headers and Cloudflare rules

### Update Timeout Protection
Updates have timeout protection (configurable via `UPDATE_TIMEOUT_MS`). If update exceeds max time, lock is cleared to prevent permanent blocking, but original promise continues in background.

### PM2 Production Config
`ecosystem.config.cjs` at root defines PM2 settings:
- Memory limit: 500MB
- Auto-restart with max 10 restarts
- Logs: `backend/logs/pm2-*.log`
- Environment variables (production defaults)

## Testing & Validation

No formal test framework. Manual validation:
1. Run fetcher: `npm run dev` → check `data/aave-formatted-data.json`
2. Check logs: `tail -f logs/combined.log`
3. Start backend: `cd backend && npm run dev`
4. Test endpoints:
   ```bash
   curl http://localhost:3001/health
   curl http://localhost:3001/api/markets | jq '.data | length'
   ```

## Important Implementation Notes

### When Adding New Endpoints
Always call `checkAndUpdateDataIfStale()` at the start of controller handlers to maintain data freshness guarantee.

### When Modifying Update Logic
Be careful with the concurrency control mechanism. The `activeUpdatePromise` and `updateGeneration` work together to prevent race conditions. Never bypass the lock without understanding the flow.

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

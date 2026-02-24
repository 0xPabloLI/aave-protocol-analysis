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
- `docs/merkl-merit-cache-architecture.md` — current Merkl/Merit cache layers, file roles, fallback chains
- `docs/development-best-practices.md` — implementation patterns agreed during refactors (TTL/freshness, file layering, naming)

## Code Architecture

### Data Flow Pipeline

```
External APIs → Data Fetcher (src/index.ts) → JSON Snapshots (data/runtime + data/debug) → Backend API (backend/) → REST Clients
     ↓                                              ↓                         ↓
[Aave SDK, Merit,                    [runtime + debug snapshots,   [In-memory cache with
 Merkl, Brevis APIs]                  metadata timestamp]            auto-refresh mechanism]
```

**Key Architectural Concepts**:

1. **Separation of Concerns**: Data fetching and API serving are mostly decoupled. `/api/markets` reads runtime files, while Merkl forecast endpoints may call Merkl APIs as a fallback when runtime snapshots are missing/stale.

2. **Automatic Data Freshness**: Backend implements staleness detection (1-minute threshold) with automatic refresh and concurrency control. See `docs/backend/data-freshness-mechanism.md` for flow details.

3. **Concurrency Safety**: Uses `updateStatus` state machine (`idle` → `updating` → `idle`/`error`) with promise tracking (`activeUpdatePromise`) to prevent duplicate concurrent updates.

4. **Smart Waiting**: When update is in progress, requests wait 1 second instead of returning stale data, improving user experience.

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
- `services/dataService.ts` - In-memory cache manager; reads JSON file with metadata, tracks staleness (1-min threshold)
- `services/updateScheduler.ts` - Cron-based backup refresh (1-min interval); skips if data already fresh
- `services/merklForecastService.ts` - Merkl forecast data processor

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

### API Endpoints (All Auto-Check Freshness)

```
GET /health                    # Health check with environment info
GET /api/markets               # All market data (no query params)
GET /api/markets/list          # Market-chain combinations
GET /api/coingecko-categories  # CoinGecko category data
GET /api/coingecko-fdv         # CoinGecko FDV data
GET /api/campaigns             # Merkl forecast campaigns
```

**Response Format**: `{ data, lastUpdated, isStale, updateInProgress }`

Every endpoint calls `checkAndUpdateDataIfStale()` before responding. If data is stale, update is triggered automatically (with timeout protection and concurrency control).

## Configuration

### Environment Variables
Configure in **repo root `.env`** (single source of truth):
```bash
PORT=3001                          # Server port
NODE_ENV=development               # Environment mode
FRONTEND_URL=https://example.com   # CORS whitelist (production only, comma-separated)
ALLOWED_DEV_ORIGINS=...            # Dev CORS whitelist
DOPPLER_TOKEN=...                  # Doppler secrets (production)
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
runtime/merit-timeranges-cache.json       # Merit timeRanges/message cache
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

### Frozen/Paused Reserves
Automatically excluded: `isFrozen === true` or `isPaused === true`

### Capacity Limits & Null Handling
- `supplyApy` → `undefined` (omitted) when `supplyCap === 1`
- `borrowApy` → `undefined` when `borrowCap === 1` or `borrowingState === "DISABLED"`

### Network Discovery
Uses `@bgd-labs/aave-address-book` to auto-discover AaveV3 networks. Excludes test networks (Sepolia, Fuji).

### Backend Cache Architecture
- `/api/markets` reads from `data/runtime/aave-formatted-data.json` generated by root fetcher
- Merkl forecast endpoints prefer runtime-lite snapshots and can fall back to Merkl online APIs
- Cache loaded on startup; refreshed automatically when stale

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

### Environment Variable Priority
In production with Doppler:
1. System environment variables (highest)
2. `ecosystem.config.cjs` defaults
3. Doppler-fetched secrets (lowest, only if not already set)

Don't set secrets in `ecosystem.config.cjs`—they'll override Doppler.

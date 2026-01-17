# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

This is a two-service codebase that fetches and serves Aave V3 market data across multiple chains (17 chains, 20+ markets, 229+ token reserves), integrating incentive data from Merit, Merkl, and Brevis protocols.

**Architecture**: 
- **Data Fetcher** (`src/`): TypeScript service that fetches market data from Aave SDK and multiple incentive APIs, writes to JSON/CSV files
- **Backend API** (`backend/`): Express server that serves cached data via REST API with automatic data freshness checking

## Development Commands

### Root (Data Fetcher)
```bash
npm install              # Install dependencies
npm run dev              # Run data fetcher directly (writes to data/)
npm run build            # Compile TypeScript
npm start                # Run compiled data fetcher
```

### Backend API Server
```bash
cd backend
npm install              # Install backend dependencies
npm run dev              # Start dev server with tsx (http://localhost:3001)
npm run build            # Compile backend TypeScript
npm start                # Run compiled backend server (production mode)
./deploy.sh pm2          # Deploy with PM2 (production)
```

### Data Fetching Workflow
The data fetcher must run at least once before the backend server can serve data:
1. Run data fetcher: `npm run dev` (or `node dist/index.js` after build)
2. Start backend: `cd backend && npm run dev`

## Code Architecture

### Data Flow Pipeline

```
Aave SDK + External APIs → Data Fetcher (src/index.ts) → JSON/CSV (data/) → Backend API (backend/) → Clients
```

**Key Flow**:
1. **Fetch Phase**: `src/index.ts` orchestrates parallel data fetching from:
   - Aave SDK (`@aave/client`) - base market data
   - Merit API (`src/merit-api.ts`) - APR incentives
   - Merkl API (`src/merkl-api.ts`) - campaign opportunities
   - Brevis API (`src/brevis-api.ts`) - Linea Surge APRs

2. **Transform Phase**: Creates `FormattedReserveData` by matching incentives to base market data using chain-token indices

3. **Output Phase**: Writes to `data/aave-formatted-data.json` with metadata timestamp

4. **Serve Phase**: Backend API (`backend/src/server.ts`) serves cached data with automatic staleness detection (1-minute threshold)

### Data Freshness Architecture

The backend implements automatic data freshness checking (1-minute window):
- **Auto-refresh**: All API endpoints check data age before responding; triggers update if stale
- **Concurrency control**: `updateStatus` lock prevents duplicate updates (`idle|updating|error`)
- **Smart waiting**: If update in progress, wait 1s rather than returning stale data
- **Fallback cron**: `updateScheduler.ts` provides backup refresh (skips if already fresh)

See `backend/DATA-FRESHNESS-MECHANISM.md` for detailed flow.

### Module Responsibilities

**Data Fetcher** (`src/`):
- `index.ts` - Main orchestration: fetches all data, builds indices, merges incentives, writes output
- `merit-api.ts` - Fetches Merit APR data, groups by supply/borrow requirements
- `merkl-api.ts` - Fetches Merkl opportunities, processes campaign breakdowns
- `brevis-api.ts` - Fetches Brevis campaigns, builds chainId-tokenAddress index
- `logger.ts` - Winston logging (console + file rotation)

**Backend API** (`backend/src/`):
- `server.ts` - Express app initialization, loads data cache on startup
- `services/dataService.ts` - In-memory cache manager, staleness checker, file reader
- `services/updateScheduler.ts` - Cron-based backup refresh (1-minute interval)
- `controllers/marketsController.ts` - Request handlers with `checkAndUpdateDataIfStale()` logic
- `routes/markets.ts` - API route definitions
- `middleware/cors.ts` - CORS configuration
- `types/index.ts` - TypeScript interfaces

### Key TypeScript Patterns

**ES Modules**: Both services use `"type": "module"` - always use `.js` extensions in imports even for `.ts` files:
```typescript
import { logger } from './logger.js';  // Correct
```

**Optional Field Omission**: Backend uses custom JSON serialization to omit `undefined` values and empty arrays (not `null`). Fields like `supplyApy`, `meritSupplys`, etc. only appear in JSON if they have data.

**APR to APY Conversion**: `convertAprToApy()` uses monthly compounding formula: `(1 + APR/12)^12 - 1`

### API Endpoints

All endpoints automatically check data freshness (see `marketsController.ts`):
- `GET /health` - Health check
- `GET /api/markets` - All market data (sorting/filtering client-side)
- `GET /api/markets/stats` - Statistics (pool/chain/token counts)
- `GET /api/markets/chains` - Chain name list
- `GET /api/markets/list` - Market-chain combinations

Response format includes: `data`, `lastUpdated`, `isStale`, `updateInProgress`

## Configuration & Environment

### Environment Variables
Configure in `backend/.env` (copy from `backend/env.example`):
- `PORT` - Server port (default: 3001)
- `NODE_ENV` - Environment mode (development/production)
- `FRONTEND_URL` - CORS allowed origins (comma-separated, production only)

### TypeScript Configuration
- Root `tsconfig.json` - Compiles `src/` → `dist/` (excludes backend)
- Backend has separate `backend/tsconfig.json` - Compiles `backend/src/` → `backend/dist/`

### Data Output Files
Generated in `data/` (gitignored):
- `aave-formatted-data.json` - Primary data file with metadata (backend reads this)
- `aave-formatted-data.csv` - CSV export
- `aave-all-markets-data.json` - Raw Aave SDK response
- `brevis-raw-data.json` - Raw Brevis data with API responses
- `merkl-raw-data.json` - Raw Merkl data

### Logging
**Data Fetcher**: Winston logs to `logs/combined.log` + `logs/error.log` (root directory)
**Backend API**: Winston logs to `backend/logs/` (PM2 errors to `backend/logs/pm2-error.log`)

Both use 5MB file rotation, keep 5 files.

## Testing & Validation

No formal test framework configured. Validate manually:
- Run data fetcher and verify JSON output in `data/`
- Check logs in `logs/combined.log`
- Start backend and test endpoints:
  ```bash
  curl http://localhost:3001/health
  curl http://localhost:3001/api/markets
  ```

## Deployment

### PM2 Production Deployment
```bash
cd backend
./deploy.sh pm2          # Installs deps, builds, starts with PM2
pm2 status               # Check status
pm2 logs aave-backend    # View logs
pm2 restart aave-backend # Restart
```

PM2 config: `ecosystem.config.cjs` at root

### Remote Deployment
Root `deploy.sh [host]` - SSH-based remote deployment (see DEPLOY.md)

## Common Patterns & Gotchas

**Data Matching**: Merit/Merkl/Brevis data matched to base Aave data using:
- Merit: `chainId-tokenAddress` keys
- Merkl: Chain name + token symbol (case-insensitive)
- Brevis: `chainId-tokenAddress` index

**Frozen/Paused Reserves**: Automatically excluded (`isFrozen` or `isPaused` === true)

**Capacity Limits**: `supplyApy`/`borrowApy` set to `undefined` (omitted in JSON) when cap is 1 or borrowing disabled

**Network Discovery**: Uses `@bgd-labs/aave-address-book` to discover all AaveV3 networks automatically (excludes Sepolia, Fuji test networks)

**Import Extensions**: Always use `.js` extensions in TypeScript imports due to ES modules

**Backend Cache**: Backend never directly calls external APIs - only reads from data files generated by root fetcher

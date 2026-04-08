# Aave Markets Data Fetcher

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

This project provides a backend service that uses the Aave TypeScript SDK and @bgd-labs/aave-address-book to fetch market data from all supported networks, and integrates Merit, Merkl, and Brevis incentive data. The service includes both a data fetcher and a REST API server.

## 📋 Table of Contents

- [Features](#features)
- [Project Structure](#project-structure)
- [Quick Start](#quick-start)
- [Usage](#usage)
- [Output Files](#output-files)
- [Data Fields](#data-fields)
- [Tech Stack](#tech-stack)
- [API Data Sources](#api-data-sources)
- [Contributing](#contributing)
- [License](#license)

## Features

- 🌐 Automatically discovers all AaveV3 networks using @bgd-labs/aave-address-book
- 🔄 Fetches multi-chain market data using Aave SDK (17 chains, 20 markets)
- 💰 Integrates Merit APR incentive data
- 🎁 Integrates Merkl incentive campaign data
- 🌐 Integrates Brevis Network Linea Surge APR data
- 💾 Saves data to JSON and CSV files
- 📊 Displays detailed market distribution information in console
- ⚠️ Automatically identifies and skips unsupported networks
- ❌ Comprehensive error handling and logging

## Project Structure

\`\`\`
aave/
├── src/                  # Data fetcher service
│   ├── index.ts          # Main logic, integrates all data sources
│   ├── logger.ts         # Logging configuration module
│   ├── brevis-api.ts     # Brevis Network API client
│   ├── merit-api.ts      # Merit Protocol API client
│   └── merkl-api.ts      # Merkl API client
├── backend/              # REST API server
│   ├── src/
│   │   ├── server.ts     # Express API server
│   │   ├── controllers/  # API controllers
│   │   ├── services/     # Business logic services
│   │   ├── routes/       # API routes
│   │   └── middleware/   # Express middleware
│   └── package.json      # Backend dependencies
├── data/                 # Output data folder (git ignored); API markets come from backend memory, not these files
│   ├── runtime/          # Fetcher/runtime files (e.g. Merkl forecast lite)
│   ├── debug/            # Debug/troubleshoot snapshots
│   └── exports/          # CSV and export files
├── logs/                 # Log files folder (git ignored)
│   ├── combined.log      # All logs
│   └── error.log         # Error logs only
├── dist/                 # TypeScript compilation output (git ignored)
├── node_modules/         # Dependencies (git ignored)
├── package.json          # Root dependencies and scripts
├── package-lock.json     # Dependency lock file
├── tsconfig.json         # TypeScript configuration
├── LICENSE               # MIT License
└── README.md             # Project documentation
\`\`\`

## Quick Start

### Prerequisites

- Node.js 20 or higher
- npm or yarn package manager

### Install Dependencies

\`\`\`bash
npm install
\`\`\`

### Run the Data Fetcher

#### Development Mode (Recommended)
\`\`\`bash
npm run dev
\`\`\`

#### Build and Run
\`\`\`bash
npm run build
npm start
\`\`\`

After successful execution, data files will be saved under `data/runtime`, `data/debug`, and `data/exports`.

### Run the Backend API Server

#### Development Mode
\`\`\`bash
cd backend
npm run dev
\`\`\`

The API server will start on `http://localhost:3001` by default.

#### Production Mode
\`\`\`bash
cd backend
npm run build
npm start
\`\`\`

The server uses environment variables for configuration (see [AGENTS.md](AGENTS.md#configuration) for full list). Key settings:
- `PORT` - Server port (default: 3001)
- `NODE_ENV` - Environment (development/production)
- `FRONTEND_URL` - CORS allowed origins for production (comma-separated)
- `MERKL_FALLBACK_MAX_STALE_MS` - Max age for Merkl fallback snapshots before refusing stale reuse (default: 10m)
- `MERKL_FORECAST_OPPORTUNITY_META_FALLBACK_MAX_STALE_MS` - Max age for forecast opportunity-meta cache fallback (default: max(3x TTL, 30m))
- `MERKL_FORECAST_SNAPSHOT_FALLBACK_MAX_STALE_MS` - Max age for forecast snapshot fallback when refresh returns empty/error (default: max(3x TTL, 30m))
- `COINGECKO_CATEGORIES_FALLBACK_MAX_STALE_MS` - Max age for categories empty-result fallback (default: max(3x TTL, 30m))
- `COINGECKO_FDV_FALLBACK_MAX_STALE_MS` - Max age for FDV empty-result fallback (default: max(3x TTL, 30m))
- Configure in repo root `.env`; production may use Doppler or Railway for secrets.

### API Endpoints

The backend API server runs on `http://localhost:3001` by default. Public clients should rely on **4 URL paths / 3 logical endpoints**:

| Method & Path | Description |
|--------------|-------------|
| `GET /health` | Health check with environment info |
| `GET /api/health` | Same as `/health` (API namespace) |
| `GET /api/markets` | `markets-v2`: root `snapshot` + `reserves` (prices on `reserves[].tokenPrice`); cron-warmed memory snapshot, request does not trigger fetches; hard stale boundary enforced by `marketsServeHardStaleMax` |
| `GET /api/meta/side-data` | Aggregated side-data payload (`categories` + `fdv` + `forecast`) |

**Data freshness**: Public data endpoints use **cron-write / API-read-only**. `meta/side-data` still reads the same internal category/FDV/forecast caches, but the standalone public routes for those caches are no longer exposed. `markets` uses `staleTimeMs` (`marketsDataStaleThreshold`) plus a hard stale cap (`marketsServeHardStaleMax`, over which API returns `503`). See [docs/backend/data-freshness-mechanism.md](docs/backend/data-freshness-mechanism.md).

**Filter market derivation**: Clients should derive unique `{ marketName, chainName }` filter options from `GET /api/markets` response data. The backend no longer exposes a separate market-list endpoint for that UI concern.

**Full API reference** (request/response formats, status codes): [docs/api/api-documentation.md](docs/api/api-documentation.md).

### Merkl opportunities ingest note

Merkl opportunities are paginated upstream (default 20, max 100 per page). The service fetches paginated `LIVE` opportunities for `mainProtocolId=aave,tydro` when building campaign forecast mappings, to avoid missing campaigns beyond page 1.

## Output Files

When you run the **root** data fetcher (`npm run dev` / `npm start` at repo root), files are generated under `data/` subfolders. The **backend API** does not read `data/debug/aave-formatted-data.full.json`; it builds the same pipeline in memory via `fetchMarketsPayload()`.

- `data/debug/aave-formatted-data.full.json` - Full formatted output (debug artifact; not the API backing store)
- `data/runtime/merkl-opportunity-meta-lite.json` - Forecast runtime-lite snapshot (campaign meta; **read by backend** forecast path when present/fresh)
- `data/runtime/merit-campaign-metadata-cache.json` - Merit campaign metadata cache (time/message/link)
- `data/debug/aave-all-markets-data.json` - Complete raw market data for all supported networks
- `data/debug/brevis-raw-data.json` - Brevis Network raw activity/API debug snapshot
- `data/debug/merkl-raw-data.json` - Merkl incentive debug snapshot
- `data/debug/merit-raw-data.json` - Merit raw data
- `data/debug/merit-merkl-raw-data.json` - Merit↔Merkl round estimation debug
- `data/exports/aave-formatted-data.csv` - CSV export for spreadsheet use

## Data Fields

The formatted output data contains the following fields. For the full current schema (including all incentive structures and optional fields), see [docs/api/api-documentation.md](docs/api/api-documentation.md).

### Basic Fields
- `marketName` - Market name (e.g., AaveV3Ethereum)
- `chainName` - Chain name (e.g., ethereum)
- `chainId` - Chain ID
- `tokenName` - Token name
- `tokenSymbol` - Token symbol
- `tokenAddress` - Token contract address
- `supplyApy` - Supply APY (string | null, null when supplyCap is 1)
- `borrowApy` - Borrow APY (string | null, null when borrowCap is 1 or borrowing is disabled)

### Protocol Incentives
- `supplyIncentives` - Aave protocol supply incentives
- `borrowIncentives` - Aave protocol borrow incentives

### Merit Incentives
- `meritSupplyApr` - Merit supply APR
- `meritBorrowApr` - Merit borrow APR
- `meritSelfSupply` - Merit self supply APR
- `meritSelfBorrow` - Merit self borrow APR
- `meritBorrowWithSupplyRequirement` - Borrow APR that requires supply first
- `meritSupplyWithBorrowRequirement` - Supply APR that requires borrow first

### Merkl Incentives
- `merklSupplyApr` - Merkl supply APR (number)
- `merklBorrowApr` - Merkl borrow APR (number)
- `merklHoldApr` - Merkl hold APR (number)
- `merklSupplyAprBreakdowns` - Merkl supply campaign details
- `merklBorrowAprBreakdowns` - Merkl borrow campaign details
- `merklHoldAprBreakdowns` - Merkl hold campaign details

### Brevis Incentives
- `brevisSupplyApr` - Brevis Network Linea Surge supply APR
- `brevisBorrowApr` - Brevis Network Linea Surge borrow APR

### Total APY Fields
- `totalIncentiveSupplyApy` - Total incentive supply APY (all incentives converted to APY)
- `totalSupplyApy` - Total supply APY (native supplyApy + totalIncentiveSupplyApy)
- `totalIncentiveBorrowApy` - Total incentive borrow APY (all incentives converted to APY)
- `totalBorrowApy` - Total borrow APY (native borrowApy + totalIncentiveBorrowApy)

## Logging System

The project uses [winston](https://github.com/winstonjs/winston) logging library to manage log output.

### Log Files

All logs are automatically saved to the `logs/` folder:
- `logs/combined.log` - Contains all log levels (info, warn, error, debug)
- `logs/error.log` - Contains only error level logs

### Log Levels

- **info** - General information (default level)
- **warn** - Warning messages
- **error** - Error messages
- **debug** - Debug information (enabled in development environment)

### Log Configuration

- Log file size limit: 5MB
- Number of log files retained: 5 (automatic rotation)
- Console output: Colored format for easy viewing
- File output: JSON format with timestamps and metadata

Log files are created automatically, no manual configuration required.

## Supported Networks

The project automatically fetches market data from all AaveV3 networks. Based on runtime conditions, it typically fetches:

- **19 AaveV3 networks** across **17 different chains**
- **Approximately 20 markets**
- **Approximately 229 token reserves**

### Main Supported Networks

- **Ethereum** (Chain ID: 1) - 4 markets (AaveV3Ethereum, AaveV3EthereumEtherFi, AaveV3EthereumLido, AaveV3EthereumHorizon)
- **Arbitrum** (42161)
- **Avalanche** (43114)
- **BNB Chain** (56)
- **Base** (8453)
- **Optimism** (10)
- **Polygon** (137)
- **Gnosis** (100)
- **Linea** (59144)
- **Metis** (1088)
- **Scroll** (534352)
- **zkSync** (324)
- **Celo** (42220)
- **InkWhitelabel** (57073)
- **Plasma** (9745)
- **Soneium** (1868)
- **Sonic** (146)

The project automatically skips test networks (such as Sepolia, Fuji) and unsupported networks.

## Data Processing Rules

### APY Null Handling

The service applies special handling for tokens with extremely low capacity limits:

- **Supply APY**: When `supplyCap` is `1`, the `supplyApy` field is set to `null` because such low capacity limits make the APY meaningless for users.
- **Borrow APY**: When `borrowCap` is `1` or when borrowing is disabled (`borrowingState === "DISABLED"`), the `borrowApy` field is set to `null`.

This ensures that users only see meaningful APY values in the data. When an APY is `null`, it indicates that the operation (supply or borrow) is either disabled or has a capacity limit so low that it's not practical for users.

### Frozen/Paused Reserves

Reserves with `isFrozen === true` or `isPaused === true` are automatically excluded from the output data, as these reserves are not available for supply operations.

### Data Freshness

The backend API server automatically checks data freshness (1-minute window). If data is stale, it automatically triggers an update before returning results. This ensures users always receive up-to-date information.

## Tech Stack

### Data Fetcher
- **TypeScript**: Type-safe JavaScript
- **@aave/client**: Official Aave SDK
- **@bgd-labs/aave-address-book**: Aave address book containing all network configurations
- **winston**: Logging management library
- **node-fetch**: HTTP request library
- **Node.js**: JavaScript runtime environment

### Backend API
- **Express**: Web framework for Node.js
- **CORS**: Cross-origin resource sharing middleware
- **node-cron**: Task scheduler for automatic data updates

## API Data Sources

The project fetches incentive data from the following APIs:

- **Merit APR**: `https://apps.aavechan.com/api/merit/aprs`
- **Merkl Opportunities**: `https://api.merkl.xyz/v4/opportunities?name=aave`
- **Merkl Campaigns**: `https://api.merkl.xyz/v4/campaigns/{campaignId}`
- **Brevis Network**: `https://linea-surge-endpoint.brevis.network/LineaSurgeV2Provider/GetActivities`

## Usage

### Data Updates

The project automatically fetches the latest data from the following sources:
- Aave official SDK for market data
- Merit API for APR incentive data
- Merkl API for campaign incentive data
- Brevis Network API for Linea Surge APR data

### Viewing Logs

All log files are saved in the `logs/` directory:
- `combined.log` - All log levels
- `error.log` - Error logs only

### Data File Descriptions

When the root fetcher runs, data files are written under `data/` (paths relative to repo root). **`GET /api/markets` is served from the backend in-memory snapshot**, not from these files.
- `data/debug/aave-formatted-data.full.json` - Full formatted output from the root fetcher (optional artifact; not read by the API)
- `data/runtime/merkl-opportunity-meta-lite.json` - Forecast campaign meta (runtime-lite)
- `data/runtime/merit-campaign-metadata-cache.json` - Merit campaign metadata cache (time/message/link)
- `data/debug/aave-all-markets-data.json` - Raw Aave SDK market data
- `data/debug/brevis-raw-data.json` - Brevis raw activity data
- `data/debug/merkl-raw-data.json` - Merkl raw incentive data
- `data/debug/merit-raw-data.json` - Merit raw data
- `data/debug/merit-merkl-raw-data.json` - Merit↔Merkl round estimation debug
- `data/exports/aave-formatted-data.csv` - CSV export (for spreadsheet use)

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork this repository
2. Create a branch (`git checkout -b chore/my-change`)
3. Commit your changes (`git commit -m 'Describe your change'`)
4. Push the branch (`git push origin chore/my-change`)
5. Open a pull request against `main` or `railway` (CI runs on those targets)

### Development Guidelines

- Write code in TypeScript
- Follow existing code style
- Add appropriate comments and documentation
- Ensure code passes TypeScript compilation checks

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Related Links

- [Aave V3 Documentation](https://aave.com/docs/developers/aave-v3/markets/data#listing-available-markets)
- [Aave SDK](https://github.com/aave/aave-sdk)
- [Merit Protocol](https://apps.aavechan.com/)
- [Merkl](https://merkl.xyz/)
- [Brevis Network](https://brevis.network/)

## Author

For questions or suggestions, please submit an Issue or Pull Request.

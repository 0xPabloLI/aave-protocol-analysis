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
├── data/                 # Output data folder (git ignored)
│   ├── aave-all-markets-data.json      # Raw market data
│   ├── aave-formatted-data.json        # Formatted JSON data
│   ├── aave-formatted-data.csv         # CSV format data
│   ├── brevis-raw-activities.json      # Brevis raw activity data
│   └── merkl-raw-data.json             # Merkl raw data
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

After successful execution, data files will be saved in the `data/` directory.

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

The server uses environment variables for configuration (see `backend/env.example`). Key settings:
- `PORT` - Server port (default: 3001)
- `NODE_ENV` - Environment (development/production)
- `FRONTEND_URL` - CORS allowed origins for production (comma-separated)

### API Endpoints

The backend API server runs on `http://localhost:3001` by default. Available endpoints:

- `GET /health` - Health check endpoint
- `GET /api/markets` - Get all market data (no query parameters, all sorting and filtering handled client-side)
  - Response includes: `data`, `lastUpdated`, `isStale`, `updateInProgress`
- `GET /api/markets/stats` - Get statistics (total pools, chains, tokens)
- `GET /api/markets/chains` - Get list of supported chains
- `GET /api/markets/list` - Get list of markets

**Data Freshness Mechanism**: All endpoints automatically check data freshness (1-minute window). If data is stale, the system automatically triggers an update and waits for completion before returning results. This ensures users always receive up-to-date information without manual refresh.

For detailed information about the data freshness mechanism, see [backend/DATA-FRESHNESS-MECHANISM.md](backend/DATA-FRESHNESS-MECHANISM.md).

## Output Files

After successful execution, the following files will be generated in the `data/` folder:

- `aave-all-markets-data.json` - Complete market data for all supported networks
- `aave-formatted-data.json` - Formatted JSON data with all incentive information
- `aave-formatted-data.csv` - CSV format data for easy viewing in Excel
- `brevis-raw-activities.json` - Brevis Network Linea Surge raw activity data
- `merkl-raw-data.json` - Merkl incentive campaign raw data

## Data Fields

The formatted output data contains the following fields:

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

Generated data files are located in the `data/` directory:
- `aave-all-markets-data.json` - Raw market data (includes all network information)
- `aave-formatted-data.json` - Formatted complete data (includes all incentive information)
- `aave-formatted-data.csv` - CSV format data (for easy Excel analysis)
- `brevis-raw-activities.json` - Brevis raw activity data
- `merkl-raw-data.json` - Merkl raw incentive data

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork this repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

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

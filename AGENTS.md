# Repository Guidelines

## Project Structure & Module Organization

This repo contains a data-fetching service and a backend API server.

- `src/` holds the TypeScript data fetcher and API clients (Merit, Merkl, Brevis).
- `backend/` contains the Express API server (`backend/src/server.ts`).
- `data/`, `logs/`, and `dist/` are generated outputs (JSON/CSV, logs, build artifacts).

## Build, Test, and Development Commands

Run these from the repo root unless noted.

- `npm install` installs root dependencies.
- `npm run dev` runs the data fetcher directly (writes to `data/`).
- `npm run build` compiles the TypeScript fetcher; `npm start` runs it.
- `cd backend && npm run dev` starts the API server in development mode (uses tsx, no PM2) on `http://localhost:3001`.
- `cd backend && npm run build` compiles the backend TypeScript code.
- `cd backend && npm start` runs the compiled backend server (production mode).
- `cd backend && ./deploy.sh pm2` deploys with PM2 (production deployment).
- Root `./deploy.sh [host]` is for remote server deployment via SSH.

## Coding Style & Naming Conventions

- TypeScript is the primary language; the repo uses ES modules (`"type": "module"`).
- Follow existing 2-space indentation in `src/` and keep import extensions (e.g. `./logger.js`).

## Testing Guidelines

- No dedicated test framework is configured.
- Use the provided scripts for manual validation, e.g. `npm run test-api` or `npm run test-brevis-api`.
- Verify generated outputs in `data/` and logs in `logs/` when touching fetcher logic.

## Commit & Pull Request Guidelines

- No enforced commit convention found in the repo; keep messages short and imperative (e.g. `Add merit APR parsing`).
- Suggested branch pattern from README: `feature/<short-name>`.
- PRs should describe the change, include any new data outputs, and note any manual validation run.

## Configuration Tips

- The backend reads data from `data/aave-formatted-data.json`; keep generated files out of commits.

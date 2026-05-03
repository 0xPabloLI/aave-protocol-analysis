# AGENTS.md (Slim)

## Project Snapshot
- Two-service TypeScript repository:
  - Root data fetcher (`src/`) aggregates Aave + Merit + Merkl + Brevis.
  - Backend API (`backend/`) serves in-memory snapshots (cron-write / API-read-only).
- Backend imports from root `dist/index.js`; root rebuild is required after `src/` changes.

## Core Commands
### Root
- `npm run dev` — run fetcher
- `npm run build` — compile root to `dist/`
- `npm run ci:remote` — full CI-equivalent local gate

### Backend
- `npm --prefix backend run dev` — run backend
- `npm --prefix backend run build` — compile backend
- `npm --prefix backend run test` — backend tests

## Mandatory Session Workflow
1. **Bootstrap first** (every new session — BEFORE any other action):
   - **Codex**: `~/.codex/superpowers/.codex/superpowers-codex bootstrap && ~/.codex/superpowers/.codex/superpowers-codex use-skill brainstorming`
   - **CodeArts**: Use the `skill` tool to load `using-superpowers`, then load `brainstorming`. This is mandatory — do not skip even for simple questions.
2. **Hook policy**: do not bypass local hooks (`pre-commit`/`pre-push`), which enforce `ci:remote` and lockfile consistency.
3. **Git safety**: no stash/checkout operations without explicit user confirmation in current conversation.
4. **Remote merge policy**: prefer PR-based merge flow; do not locally merge topic branches into `main`.

## Architecture Rules
- ES modules only: local TS imports must use `.js` extension in source imports.
- API fields should omit `undefined` / empty arrays (keep payload lean).
- Keep cron-write/API-read-only pattern: request handlers should not trigger external fetches.
- When adding reserve fields, update both root shaping and backend types/serialization.

## Automated Checks (No Manual Checklist Needed)

### Reserve Field Addition
Adding new reserve fields is now type-safe:

1. **Type Safety**: `src/types/prune-type-helper.ts` enforces that `pruneReserveForRuntime` returns all `RuntimeReserveData` fields at compile time
2. **Runtime Test**: `tests/field-coverage.test.ts` validates all expected fields are present
3. **Field Registry**: `src/types/runtime-validation.ts` maintains `EXPECTED_RUNTIME_FIELDS` as source of truth

**Run tests to verify:**
```bash
npm run build && npm run test
```

## Required Coupled Changes
When touching one area, check its pair:
- `src/index.ts` (`pruneReserveForRuntime`) ↔ `backend/src/types/index.ts`
- Root output schema ↔ `backend/src/services/marketsApiSerialize.ts`
- `backend/src/cacheTtl.ts` ↔ `backend/src/services/updateScheduler.ts`
- Chain/platform mapping ↔ `src/generated/coingecko-platform-by-chain-id.ts`

## Validation Gate
- For code changes, run at minimum:
  - `npm run build`
  - `npm --prefix backend run build`
  - `npm --prefix backend run test`
- For release-level confidence, prefer `npm run ci:remote`.

## High-Risk Areas (Coordinate Carefully)
- Fetch orchestration: `src/index.ts`
- Incentive adapters: `src/merit-api.ts`, `src/merkl-api.ts`, `src/brevis-api.ts`
- Token pricing + chain mapping: `src/token-price-resolver.ts`, `src/generated/coingecko-platform-by-chain-id.ts`
- Backend freshness/caching: `backend/src/services/marketsService.ts`, `onchainDataService.ts`, `merklForecastService.ts`, `cacheTtl.ts`

## Key References
- `docs/merkl-merit-cache-architecture.md`
- `docs/backend/data-freshness-mechanism.md`
- `docs/development-best-practices.md`
- `docs/api/api-documentation.md`
- `docs/api/brevis-supplement.md`
- `docs/deploy/cloudflare-complete-guide.md`

## Learned Preferences (Condensed)
- Keep docs concise and remove superseded content.
- Prefer runtime verification/log evidence over speculative explanations.
- Keep schema convergence across incentive sources; avoid unused fields in public payload.
- Use exact-origin CORS settings; treat freshness TTL changes as explicit, documented decisions.

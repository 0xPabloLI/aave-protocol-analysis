# Workspace Boundaries & Coupled Changes

## Shared Package Boundaries (Non-Negotiable)

| Package | Contains | Must NOT contain |
|---|---|---|
| `@internal/aave-shared-contracts` | Types, field registry, validation | Runtime fetch logic, serialization |
| `@internal/aave-fetcher` | `fetchMarketsData`, SDK clients, adapters | Backend API types (`MarketWithSpread`) |
| `backend` | API server, serialization (`marketsApiSerialize.ts`) | `fetchMarketsData` definition (imports it) |

## Required Coupled Changes

When touching one area, check its pair:
- `packages/aave-shared-contracts/src/index.ts` (types) ↔ `backend/src/types/index.ts` (backend types)
- `packages/aave-fetcher/src/index.ts` (pruneReserveForRuntime) ↔ `backend/src/types/index.ts`
- Root output schema ↔ `backend/src/services/marketsApiSerialize.ts`
- `backend/src/cacheTtl.ts` ↔ `backend/src/services/updateScheduler.ts`
- Chain/platform mapping ↔ `packages/aave-fetcher/src/generated/coingecko-platform-by-chain-id.ts`

## Reserve Field Addition

Adding new reserve fields to the single `RuntimeReserveData` type requires:

1. **Type Sync**: Update `RuntimeReserveData` → `MarketWithSpread` (backend) → `marketsApiSerialize.ts` serialization
2. **Runtime Test**: `tests/field-coverage.test.ts` validates all expected fields are present
3. **Field Registry**: `packages/aave-shared-contracts/src/index.ts` maintains `EXPECTED_RUNTIME_FIELDS` as source of truth

**Run tests to verify:**
```bash
npm run build && npm run test -w aave-dashboard-backend
```

## Validation Scripts

- **Dist import check** (must be empty):
  ```bash
  rg "dist/index\.js|\.\.\/\.\.\/\.\.\/dist" backend/src tests
  ```
- **Bin path check** (must pass):
  ```bash
  npm run check:bin-paths
  ```
  (ensures workspace sub-project scripts use `npx`, not hardcoded `node_modules/.bin/` paths)

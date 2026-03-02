# Backend Hardcode and External Imports

## 1. Source of Truth

- Aave subgraph deployment snapshot:
  - `docs/api/aave-subgraph-deployments.snapshot.json`
  - refreshed by `npm run subgraphs:sync`
- Aave chain contract addresses:
  - npm package `@bgd-labs/aave-address-book`
- Aave on-chain reserve reads:
  - npm package `@aave/contract-helpers` (`UiPoolDataProvider`)
- Shared public RPC registry:
  - npm package `@internal/merkl-shared`
  - `getAavePublicRpcUrlsByChainName` / `getAavePublicRpcUrlsByChainId`
- RPC default references:
  - synchronized in shared registry (aligned with Aave interface `src/ui-config/networksConfig.ts`)

## 2. Current Backend Hardcoded Items (Rate Inputs)

- File: `backend/src/services/rateInputsService.ts`
- Hardcoded fallback map: `ONCHAIN_FALLBACK_CHAINS`
  - `1088` Metis: subgraph first (`metisapi.0xgraph.xyz`), fallback to on-chain on failure
  - `5000` Mantle: no deployment in current subgraph snapshot
  - `9745` Plasma: no deployment in current subgraph snapshot
  - `57073` Ink: subgraph indexer unavailable fallback path
  - `4326` MegaETH: subgraph indexer unavailable fallback path
- Default RPC values are provided only for fallback chains above.

## 3. Env Overrides

- Subgraph API key:
  - `THE_GRAPH_API_KEY`
- RPC overrides:
  - per chain: `RATE_INPUTS_RPC_URL_<chainId>`
  - map JSON: `RATE_INPUTS_RPC_URLS`

## 4. Update Rules (Do Not Skip)

1. Run `npm run subgraphs:sync` and check whether new chains appear/disappear.
   - GitHub Actions also runs this automatically: `.github/workflows/subgraph-sync.yml` (scheduled + manual dispatch).
2. If a chain is missing or schema-incompatible in subgraph, add/update `ONCHAIN_FALLBACK_CHAINS`.
3. Keep fallback chain RPC defaults aligned with interface network config.
4. Never add plaintext API keys in code.
5. If fallback chains change, update both:
   - `docs/api/native-apr-calculation.md`
   - this document
6. Keep `@bgd-labs/aave-address-book` updated on a regular cadence (or release-triggered), otherwise new chains/addresses can drift and fallback reads may break.
   - GitHub Dependabot weekly updates are enabled in `.github/dependabot.yml` (root + `backend` npm ecosystems).
7. RPC/provider logic is centralized in `backend/src/services/ethProviderService.ts`; any new RPC policy should be changed there instead of ad-hoc in feature services.
8. Shared RPC registry is in `packages/merkl-shared`; if Merit and rate-inputs need the same chain RPC update, update shared registry first.

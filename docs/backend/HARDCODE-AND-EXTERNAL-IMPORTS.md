# Backend Hardcode and External Imports

## 1. Source Of Truth

- Subgraph deployment snapshot:
  - `docs/api/aave-subgraph-deployments.snapshot.json`
  - refreshed by `npm run subgraphs:sync`
- On-chain protocol addresses:
  - npm package `@bgd-labs/aave-address-book`
- On-chain reserve reader:
  - npm package `@aave/contract-helpers` (`UiPoolDataProvider`)
- Shared RPC registry:
  - npm package `@internal/aave-shared-config`
  - path: `packages/aave-shared-config`
  - exports: `getAavePublicRpcUrlsByChainName`, `getAavePublicRpcUrlsByChainId`

## 2. Current Hardcoded/Derived Logic (Rate Inputs)

- File: `backend/src/services/rateInputsService.ts`
- Primary source: subgraph (with retry + timeout).
- Fallback source: on-chain `UiPoolDataProvider`.
- Fallback config is now **dynamic** (not manual chain list):
  - resolves by `chainId` from `@bgd-labs/aave-address-book` exported `AaveV3*` configs.
  - picks best config per chain with deterministic priority (prefer non-testnet/non-market-suffix variants).
  - uses shared RPC defaults from `@internal/aave-shared-config`.
- For fallback-capable chains, if subgraph returns partial token coverage, missing assets are filled from on-chain in the same refresh.

## 3. Env Overrides

- `THE_GRAPH_API_KEY`: required for gateway subgraph URLs.
- `RATE_INPUTS_RPC_URL_<chainId>`: per-chain RPC override.
- `RATE_INPUTS_RPC_URLS`: JSON map RPC override.

## 4. CI Automation Coverage Matrix

| Item | CI Status | Why | What To Do |
|---|---|---|---|
| Subgraph deployment snapshot sync | Automated | prevent stale deployment IDs/slugs | `.github/workflows/subgraph-sync.yml` (`npm run subgraphs:sync`) |
| Subgraph query compatibility / health probe | Automated | catch indexer/schema issues early | `.github/workflows/subgraph-rate-inputs-health.yml` (`npm run subgraphs:check-rate-inputs`) |
| NPM dependency drift (root + backend + actions) | Automated | keep address-book/tooling updated | `.github/dependabot.yml` |
| Dynamic fallback address resolution | Automated at runtime | avoid maintaining static fallback chain map | in `rateInputsService.ts`, no manual chain list required |
| Chain has no `AaveV3*` export in address-book (e.g. unsupported/retired chain) | Not fully automatable | SDK itself has no fallback metadata for that chain | keep graceful degradation + document chain status; only add manual special handling if business-critical |
| RPC quality (latency/quota/reliability) | Not fully automatable in code CI | runtime infra quality depends on provider SLAs | monitor production errors; override with `RATE_INPUTS_RPC_URL*` where needed |
| Secret rotation (`THE_GRAPH_API_KEY`) | Not automated by repo CI | org-level secret governance | rotate via secret manager / platform ops process |

## 5. N8N vs GitHub Actions

- For this repo’s hardcode sync/check tasks, GitHub Actions is sufficient; N8N is optional.
- N8N still has value when you need cross-system orchestration that Actions does not naturally own:
  - multi-repo workflows with centralized approvals/notifications.
  - non-GitHub systems integration (Slack/Notion/Jira/Sheets/DB) as first-class workflow steps.
  - business-time windows, escalation routing, and human-in-the-loop approval chains.

## 6. Update Rules (Do Not Skip)

1. Keep `subgraph-sync` and `subgraph-rate-inputs-health` workflows green.
2. Keep `@bgd-labs/aave-address-book` current; otherwise dynamic fallback metadata can drift.
3. Keep shared RPC registry (`packages/aave-shared-config`) aligned with actual chain support and quality.
4. Never commit plaintext API keys.
5. If fallback behavior changes materially, update:
   - `docs/api/native-apr-calculation.md`
   - this file
6. RPC/provider logic must stay centralized in `backend/src/services/ethProviderService.ts`.

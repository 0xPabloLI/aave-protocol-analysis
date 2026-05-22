# AGENTS.md (Slim)

## Project Snapshot
- Monorepo (npm workspaces) with three packages + backend:
  - `packages/aave-shared-contracts` — shared type definitions (`RuntimeReserveData`, `MarketsPayload`), field registry, validation
  - `packages/aave-fetcher` — data aggregation (`fetchMarketsData`): Aave SDK + Merit + Merkl + Brevis
  - `packages/aave-shared-config` — static config constants
  - `backend/` — API server, in-memory snapshots (cron-write / API-read-only), DB is pure archive (0 SELECT)
- Dependency direction: shared-contracts ← aave-fetcher ← root/backend (one-way)
- Root `src/` = CLI entry (`cli.ts`) + package re-export (`index.ts`); backend imports from `@internal/*` packages, NOT from root dist.

## Core Commands
### Root (workspace-aware)
- `npm run dev` — run fetcher CLI
- `npm run build` — build shared-contracts → fetcher → root (ordered)
- `npm run ci:remote` — full CI-equivalent local gate

### Packages
- `npm run build -w @internal/aave-shared-contracts` — build shared types
- `npm run build -w @internal/aave-fetcher` — build fetcher
- `npm run test -w @internal/aave-shared-contracts` — shared contracts tests
- `npm run test -w @internal/aave-fetcher` — fetcher tests

### Backend
- `npm run dev -w aave-dashboard-backend` — run backend
- `npm run build -w aave-dashboard-backend` — compile backend
- `npm run test -w aave-dashboard-backend` — backend tests

## Deployment (Hard Safety Gate)

### ⛔ Before ANY deploy command, you MUST run `railway status` and verify:
- The **linked service** is the one you intend to deploy to
- If deploying the app → linked service MUST be `aave-protocol-analysis`
- If the linked service is `Postgres-mDWG` → **STOP. Do NOT deploy.**

### Two-service topology

| Service | Type | Builder | Deploy method |
|---|---|---|---|
| `aave-protocol-analysis` | App (Node.js) | Dockerfile | `railway up` |
| `Postgres-mDWG` | Database (PostgreSQL) | Template image | `railway redeploy --from-source` |

### App deploy
```bash
railway up --detach --service aave-protocol-analysis -m "commit message"
```

### DB redeploy (only when needed, e.g., after config change)
```bash
railway redeploy --service Postgres-mDWG --from-source -y
```
Do NOT use `railway up` for the database — it will push the app's Dockerfile build
to the DB service, replacing PostgreSQL with a Node.js container.

### ⚠️ Consequences of deploying app code to Postgres-mDWG
1. **Service outage**: DB replaced by Node.js container → healthcheck fails at `/health` → 0/1 replicas → app loses DB connection
2. **Data is NOT lost** — persists on the volume (`postgres-volume-4Ftf`), but inaccessible until correct template is restored
3. **Recovery** requires `railway redeploy --service Postgres-mDWG --from-source -y` to pull the original template image
4. **Root cause**: `railway up` + `railway redeploy` both pick up the project-level `railway.json` (DOCKERFILE builder), which corrupts the DB service manifest

### Post-deploy verification
- App healthcheck needs ~3min to warm up (oracle prices + market data fetch)
- Verify: `railway status` → app should show `● Online`, DB should show `● Online`
- Verify: `curl https://staging-api.aaveapy.com/health` → `{"status":"ok"}`

## Mandatory Session Workflow
1. **Bootstrap first** (every new session — BEFORE any other action):
   - **Codex**: `~/.codex/superpowers/.codex/superpowers-codex bootstrap && ~/.codex/superpowers/.codex/superpowers-codex use-skill brainstorming`
   - **CodeArts**: Use the `skill` tool to load `using-superpowers`, then load `brainstorming`. This is mandatory — do not skip even for simple questions.
2. **Hook policy**: do not bypass local hooks (`pre-commit`/`pre-push`), which enforce `ci:remote` and lockfile consistency.
3. **Git safety**: no stash/checkout operations without explicit user confirmation in current conversation.
4. **Remote merge policy**: prefer PR-based merge flow; do not locally merge topic branches into `main`.
5. **Branch discipline**: all development commits go directly on `railway` branch. Do NOT create feature branches or worktrees unless explicitly asked by the user. If a stray branch exists, merge it into `railway` and delete it promptly.

## Architecture Rules
- ES modules only: local TS imports must use `.js` extension in source imports.
- API fields should omit `undefined` / empty arrays (keep payload lean).
- Keep cron-write/API-read-only pattern: request handlers should not trigger external fetches.
- **Workspace boundary**: `packages/aave-shared-contracts` (types only) ← `packages/aave-fetcher` (runtime) ← root/backend.
- **No root dist imports**: backend MUST NOT import from `../../../dist/index.js`. Use `@internal/aave-shared-contracts` for types, `@internal/aave-fetcher` for runtime.
- **No hardcoded bin paths in sub-project scripts**: workspace sub-projects (`backend/scripts/`, `packages/*/scripts/`) MUST NOT hardcode `./node_modules/.bin/<tool>` paths. npm workspaces hoist all deps to root `node_modules/`. Use `npx --no-install <tool>` instead — it resolves the hoisted binary correctly.
- **Serialization stays in backend**: `marketsApiSerialize.ts` produces `MarketWithSpread` in backend only.
- When adding reserve fields, update `RuntimeReserveData` in `@internal/aave-shared-contracts`, then backend types/serialization.

## Automated Checks (No Manual Checklist Needed)

### Reserve Field Addition
Adding new reserve fields to the single `RuntimeReserveData` type requires:

1. **Type Sync**: Update `RuntimeReserveData` → `MarketWithSpread` (backend) → `marketsApiSerialize.ts` serialization
2. **Runtime Test**: `tests/field-coverage.test.ts` validates all expected fields are present
3. **Field Registry**: `packages/aave-shared-contracts/src/index.ts` maintains `EXPECTED_RUNTIME_FIELDS` as source of truth

**Run tests to verify:**
```bash
npm run build && npm run test -w aave-dashboard-backend
```

## Required Coupled Changes
When touching one area, check its pair:
- `packages/aave-shared-contracts/src/index.ts` (types) ↔ `backend/src/types/index.ts` (backend types)
- `packages/aave-fetcher/src/index.ts` (pruneReserveForRuntime) ↔ `backend/src/types/index.ts`
- Root output schema ↔ `backend/src/services/marketsApiSerialize.ts`
- `backend/src/cacheTtl.ts` ↔ `backend/src/services/updateScheduler.ts`
- Chain/platform mapping ↔ `packages/aave-fetcher/src/generated/coingecko-platform-by-chain-id.ts`
- `scripts/sync-oracle-pool-configs.ts` ↔ `backend/src/generated/oracle-pool-configs.ts`

### Shared Package Boundaries (Non-Negotiable)
| Package | Contains | Must NOT contain |
|---|---|---|
| `@internal/aave-shared-contracts` | Types, field registry, validation | Runtime fetch logic, serialization |
| `@internal/aave-fetcher` | `fetchMarketsData`, SDK clients, adapters | Backend API types (`MarketWithSpread`) |
| `backend` | API server, serialization (`marketsApiSerialize.ts`) | `fetchMarketsData` definition (imports it) |

## Validation Gate
- For code changes, run at minimum:
  - `npm run build`
  - `npm run build -w aave-dashboard-backend`
  - `npm run test -w aave-dashboard-backend`
- For release-level confidence, prefer `npm run ci:remote`.
- **Dist import check** (must be empty):
  ```bash
  rg "dist/index\.js|\.\.\/\.\.\/\.\.\/dist" backend/src tests
  ```
- **Bin path check** (must pass):
  ```bash
  npm run check:bin-paths
  ```
  (ensures workspace sub-project scripts use `npx`, not hardcoded `node_modules/.bin/` paths)

## High-Risk Areas (Coordinate Carefully)
- Fetch orchestration: `packages/aave-fetcher/src/index.ts`
- Incentive adapters: `packages/aave-fetcher/src/merit-api.ts`, `merkl-api.ts`, `brevis-api.ts`
- Token pricing + chain mapping: `packages/aave-fetcher/src/token-price-resolver.ts`, `generated/coingecko-platform-by-chain-id.ts`
- Backend freshness/caching: `backend/src/services/marketsService.ts`, `onchainDataService.ts`, `merklForecastService.ts`, `cacheTtl.ts`
- Shared contracts: `packages/aave-shared-contracts/src/index.ts` (source of truth for `RuntimeReserveData` and `EXPECTED_RUNTIME_FIELDS`)

## Documentation Placement Rule

### `aaveapy-doc/` (symlink → `../aaveapy-doc`) — 跨前后端 + 协议知识
`aaveapy-doc/` is a **symlink** to the sibling `../aaveapy-doc` repo (not a git submodule). The `.gitmodules` entry is a stale remnant and should be ignored. Changes are committed and pushed directly in the symlinked repo. The main repo does not track `aaveapy-doc/` content or ref — only the symlink itself.
This directory is the canonical source for knowledge that spans frontend AND backend, or concerns Aave protocol fundamentals. It must be kept current.

**Protocol knowledge (合约/费率/状态语义):**
- `aaveapy-doc/frozen-paused-semantics.md` — isFrozen/isPaused/borrowable 合约层语义
- `aaveapy-doc/aave-supply-borrow-rate-formula.md` — 利率计算公式
- `aaveapy-doc/AaveOracle-Price-Fetch.md` — 价格预言机取数机制

**跨前后端 API/SDK/字段映射:**
- `aaveapy-doc/field-glossary.md` — API 字段 → 前端展示概念映射表
- `aaveapy-doc/v3-v4-sdk-field-mapping.md` — V3 vs V4 SDK 字段来源/处理差异
- `aaveapy-doc/v3-v4-incentive-matching.md` — Merit/Merkl/Brevis 激励匹配机制

**前端异常状态适配方案:**
- `aaveapy-doc/AaveAPY 精确协议标记与前端异常状态适配方案（精简版）.md`
- `aaveapy-doc/AaveAPY 精确协议标记与前端异常状态适配方案（精确实现版）.md`
- `aaveapy-doc/AaveAPY 精确协议标记与前端异常状态适配方案（修订版）.md`

### `docs/` — 本项目工程文档
- `docs/api/api-documentation.md` — API 接口文档
- `docs/api/brevis-supplement.md` — Brevis 补充说明
- `docs/backend/data-freshness-mechanism.md` — 数据新鲜度机制
- `docs/development-best-practices.md` — 开发最佳实践
- `docs/merkl-merit-cache-architecture.md` — 缓存架构
- `docs/deploy/cloudflare-complete-guide.md` — 部署指南
- `docs/plans/README.md` — Plan 目录规范（活跃在 `plans/`，完成后移入 `plans/executed/`）

### Agent 查询优先级
当被问到跨前后端或协议相关问题时，Agent 必须**优先搜索 `aaveapy-doc/` 子模块**寻找答案，`docs/` 仅作为本项目工程实现细节的补充。

## Learned Preferences (Condensed)
- Keep docs concise and remove superseded content.
- Prefer runtime verification/log evidence over speculative explanations.
- Keep schema convergence across incentive sources; avoid unused fields in public payload.
- Use exact-origin CORS settings; treat freshness TTL changes as explicit, documented decisions.

## Lessons Learned
- **中间态产物在使命完成后必须立即清理**：迁移安全路径中的临时中间态（如兼容函数、桥接列、过渡视图），一旦最终步骤执行完成且验证通过，必须立即删除，不要留到"下次清理"。
- **设计选项 ≠ 必经步骤**：文档中提出的可选方案需先验证是否有实际消费者，无消费者则直接跳过，不要机械写入任务清单并执行。

## Agent skills

### Issue tracker

Issues tracked in **Linear** via MCP tools. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles with default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

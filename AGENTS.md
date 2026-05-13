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

## Architecture Rules
- ES modules only: local TS imports must use `.js` extension in source imports.
- API fields should omit `undefined` / empty arrays (keep payload lean).
- Keep cron-write/API-read-only pattern: request handlers should not trigger external fetches.
- When adding reserve fields, update both root shaping and backend types/serialization.

## Automated Checks (No Manual Checklist Needed)

### Reserve Field Addition
Adding new reserve fields to the single `RuntimeReserveData` type requires:

1. **Type Sync**: Update `RuntimeReserveData` → `MarketWithSpread` (backend) → `marketsApiSerialize.ts` serialization
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
- `scripts/sync-oracle-pool-configs.ts` ↔ `backend/src/generated/oracle-pool-configs.ts`

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

## Documentation Placement Rule

### `aaveapy-doc/` (git submodule) — 跨前后端 + 协议知识
The submodule is the canonical source for knowledge that spans frontend AND backend, or concerns Aave protocol fundamentals. It must be kept current.

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

### Agent 查询优先级
当被问到跨前后端或协议相关问题时，Agent 必须**优先搜索 `aaveapy-doc/` 子模块**寻找答案，`docs/` 仅作为本项目工程实现细节的补充。

## Learned Preferences (Condensed)
- Keep docs concise and remove superseded content.
- Prefer runtime verification/log evidence over speculative explanations.
- Keep schema convergence across incentive sources; avoid unused fields in public payload.
- Use exact-origin CORS settings; treat freshness TTL changes as explicit, documented decisions.

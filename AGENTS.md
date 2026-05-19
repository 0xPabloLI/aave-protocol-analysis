# AGENTS.md (Slim)

## Project Snapshot
- Monorepo (npm workspaces): `packages/aave-shared-contracts` (types) ← `packages/aave-fetcher` (runtime) ← root/backend
- `packages/aave-shared-config` — static config constants
- `backend/` — API server, in-memory snapshots (cron-write / API-read-only), DB is pure archive (0 SELECT)
- Root `src/` is a thin re-export layer; backend imports from `@internal/*` packages, NOT from root dist.

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

## Architecture Rules
- ES modules only: local TS imports must use `.js` extension in source imports.
- API fields should omit `undefined` / empty arrays (keep payload lean).
- Keep cron-write/API-read-only pattern: request handlers should not trigger external fetches.
- **Workspace boundary**: `packages/aave-shared-contracts` (types only) ← `packages/aave-fetcher` (runtime) ← root/backend.
- Details: see `docs/architecture/workspace-boundaries.md`

## Validation Gate
- For code changes, run at minimum:
  - `npm run build`
  - `npm run build -w aave-dashboard-backend`
  - `npm run test -w aave-dashboard-backend`
- For release-level confidence, prefer `npm run ci:remote`.

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
- `docs/architecture/workspace-boundaries.md` — workspace 包边界、耦合变更、字段添加流程
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

## Lessons Learned

### Code Review 对接纪律
- **逐项验证再实现**：对每个 review 项先独立验证（能否复现？是否真影响生产？是否对本 codebase 正确？），不默认同意
- **逐项实现+逐项测试**：不要批量修复后一次 commit，应逐项实现、逐项测试、逐项验证
- **Minor 项先 YAGNI 判断**：如冗余拷贝（<0.01ms 影响），考虑是否值得改
- **Push back 是正当的**：如果 reviewer 缺乏完整上下文或建议与现有架构冲突，用技术推理 push back

### V4 Onchain Match 机制
- V3 onchain key = `${chainId}:${poolAddress}:${tokenAddr}` — 直接匹配 reserveId
- V4 onchain key = `${chainId}:${spokeAddress}:${tokenAddr}:${hubName}` — address-based，直接匹配 reserveId，无 fallback
- 修改 V4 onchain key 格式时，**同步更新测试用例**（曾出现测试 3 段 vs 实现 4 段不一致）

### 删除映射表前检查 DB 依赖
- `SPOKE_NAME_MAP` 看似仅用于日志/显示，实则被 `persistenceService` 用作 DB key（`v4|spokeName`）
- 删除前必须 grep 所有消费方，确认无 DB/persistence 依赖
- onchainDataService 的 `V4_SPOKE_NAME_MAP` 无 DB 依赖（仅日志），可安全删除

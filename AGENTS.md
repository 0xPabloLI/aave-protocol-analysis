# AGENTS.md (Slim)

## Project Snapshot
- Monorepo (npm workspaces) with four packages + backend:
  - `packages/aave-shared-contracts` — shared type definitions (`RuntimeReserveData`, `MarketsPayload`, `NetPositionConstraint`), field registry, validation
  - `packages/aave-fetcher` — data aggregation (`fetchMarketsData`): Aave SDK + Merit + Merkl + Brevis
  - `packages/aave-shared-config` — static config constants
  - `packages/aave-rpc-infra` — RPC infrastructure (ProviderPool, Multicall3, V4 reserve fetch)
  - `backend/` — API server, in-memory snapshots (cron-write / API-read-only), DB is pure archive (0 SELECT)
- Dependency direction: shared-config ← shared-contracts ← aave-fetcher ← root/backend; shared-contracts ← aave-rpc-infra ← backend (one-way)
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
- Log files: `backend/logs/error.log` (errors only), `backend/logs/combined.log` (all levels), rotated with suffixes (`error1.log`, `combined1.log`, etc.)

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
Service outage (DB replaced by Node.js container), recoverable via `railway redeploy --service Postgres-mDWG --from-source -y`. Data persists on the volume.

### Post-deploy verification
- App healthcheck needs ~3min to warm up (oracle prices + market data fetch)
- Verify: `railway status` → app should show `● Online`, DB should show `● Online`
- Verify: `curl https://staging-api.aaveapy.com/health` → `{"status":"ok"}`

## Session Workflow
1. **Bootstrap when needed**: For substantial implementation, debugging, or design sessions, load `using-superpowers` via skill tool. Load `brainstorming` only for feature design, behavior changes, or solution exploration — skip for lightweight inspection, explanation, and routine work.
2. **Hook policy**: Husky hooks have auto-fix capability. `pre-commit` → build + `test:typecheck` + auto-fix (bin-paths, globstar) + Prettier (lint-staged). `pre-push` → `scripts/hook-autofix.sh pre-push` which runs `ci` (build+test, non-fixable) then auto-fixable checks (bin-paths, globstar, audit). If auto-fix changes files in pre-push, the commit is amended and you must push again. Do not bypass with `--no-verify` unless the user explicitly confirms. CI auto-reverts direct pushes that fail CI.
3. **Git safety**: no stash/checkout operations without explicit user confirmation in current conversation.
4. **Remote merge policy**: prefer PR-based merge flow; do not locally merge topic branches into `main`.
5. **Branch discipline**: all development commits go directly on `railway` branch. Do NOT create feature branches or worktrees unless explicitly asked by the user. If a stray branch exists, merge it into `railway` and delete it promptly.
6. **Cross-session boundary**: before committing, inspect `git diff` and `git diff --staged` for changes not made in the current session. If unrelated unstaged/unstaged changes exist (from another session or prior work), **STOP** and confirm with the user whether to include, exclude, or stash them. Never silently bundle foreign changes into your commit.

## Architecture Rules
- ES modules only: local TS imports must use `.js` extension in source imports.
- API fields should omit `undefined` / empty arrays (keep payload lean).
- Keep cron-write/API-read-only pattern: request handlers should not trigger external fetches.
- **Workspace boundary**: `packages/aave-shared-contracts` (types only) ← `packages/aave-fetcher` (runtime) ← root/backend.
- **No root dist imports**: backend MUST NOT import from `../../../dist/index.js`. Use `@internal/aave-shared-contracts` for types, `@internal/aave-fetcher` for runtime.
- **No hardcoded bin paths in sub-project scripts**: workspace sub-projects (`backend/scripts/`, `packages/*/scripts/`) MUST NOT hardcode `./node_modules/.bin/<tool>` paths. npm workspaces hoist all deps to root `node_modules/`. Use `npx --no-install <tool>` instead — it resolves the hoisted binary correctly.
- **No `**/` glob in test scripts**: `tests/**/*.test.ts` won't expand in CI's `sh -c` (bash without globstar). Use `tests/*.test.ts` instead. Enforced by `npm run check:no-globstar` in `ci:remote`.
- **Serialization stays in backend**: `marketsApiSerialize.ts` produces `MarketWithSpread` in backend only.
- When adding reserve fields, update `RuntimeReserveData` in `@internal/aave-shared-contracts`, then backend types/serialization.

### Memory Safety Rule
Adding/modifying in-memory caches, Maps, Sets, long-lived closures, or external resource handles — consult `docs/memory-leak-checklist.md`.
- **Cache audit must use the exhaustive inventory** in that doc (38 entries). When asked to "review all caches" or "check memory safety", you MUST cross-reference the inventory table, not scan ad-hoc. New caches must be added to the table with full 3-layer defense assessment (Domain/TTL/Max/Shrink).

### Data Validity Rule (Critical)
**When proposing ANY code change involving blockchain numerical values, you MUST cross-check against actual data files before making the recommendation.**

1. **`raw` vs `value` are NOT interchangeable**:
   - `amount.raw` = on-chain base units (includes decimals, e.g. `"7000000000000000000000000"` for 7M tokens with 18dp)
   - `amount.value` = human-readable units (decimal-applied, e.g. `"7000000"`)
   - Checking `raw === "1"` means "1 wei" (10^-18), NOT "1 token"
   - Checking `value === 1` means "1 whole token"

2. **Always verify assumptions against `data/debug/` files** before suggesting:
   - Unit conversions between raw/value/usd
   - Arithmetic operations (subtraction, comparison, clamping)
   - Condition checks on token amounts (e.g. "is supplyCap disabled?")

3. **If you're unsure about decimal semantics, read the actual debug data first.**

### Unit & Precision Safety Rule (Critical)

**All numeric unit conversions MUST go through `packages/aave-shared-contracts/src/units.ts`.** Never define local `rayToPercent` / `rayToRatio` / etc. functions in other packages.

#### Single Source of Truth
- **`FIELD_UNITS`** (`units.ts`): declares the in-memory unit of every field in `RuntimeReserveData` (`'ratio'` | `'percent'` | `'number'` | `'string'` | `'boolean'` | `'campaignArray'`).
- **`SERIALIZER_RULES`** (derived from `FIELD_UNITS`): `'multiply100'` for ratio fields, `'passthrough'` for everything else.
- **`RATIO_FIELDS` / `PERCENT_FIELDS`**: convenience sets for testing.

#### Unit Conventions
| Layer | `supplyApy`/`borrowApy`/`campaignApr` | `utilizationPct`/`slopes`/`baseBorrowRate`/`protocolFee` |
|---|---|---|
| **In-memory** (`RuntimeReserveData`) | ratio (0.04) | percent (4.0) |
| **API output** (`MarketWithSpread`) | percent (4.0) | percent (4.0) |
| **Serializer action** | ×100 | passthrough |

#### Conversion Functions (from `units.ts`)
| Function | Input → Output | When to use |
|---|---|---|
| `rayToRatio(rayStr)` | RAY string → ratio (0.04) | On-chain RAY → ratio field (e.g. `borrowApy` in V4 RPC fallback) |
| `rayToPercent(rayStr)` | RAY string → percent (4.0) | On-chain RAY → percent field (e.g. `baseBorrowRate` in on-chain service) |
| `ratioToPercent(ratio)` | 0.04 → 4.0 | Manual conversion |
| `percentToRatio(percent)` | 4.0 → 0.04 | Manual conversion |

#### Adding a New Numeric Field
1. Add to `RuntimeReserveData` in `shared-contracts/src/index.ts`.
2. Add to `EXPECTED_RUNTIME_FIELDS` in the same file.
3. Add to `FIELD_UNITS` in `shared-contracts/src/units.ts` with the correct unit.
4. Update `marketsApiSerialize.ts` — check `SERIALIZER_RULES` matches actual serializer behavior.
5. The invariant test (`tests/units.test.ts`) will fail if you forget step 3.
6. The backend consistency test (`backend/tests/unitsConsistency.test.ts`) will fail if serializer behavior doesn't match `SERIALIZER_RULES`.

## Automated Checks (No Manual Checklist Needed)

### Reserve Field Addition
Adding new reserve fields to the single `RuntimeReserveData` type requires:

1. **Type Sync**: Update `RuntimeReserveData` → `MarketWithSpread` (backend) → `marketsApiSerialize.ts` serialization
2. **Runtime Test**: `tests/field-coverage.test.ts` validates all expected fields are present
3. **Field Registry**: `packages/aave-shared-contracts/src/index.ts` maintains `EXPECTED_RUNTIME_FIELDS` as source of truth

## Required Coupled Changes
When touching one area, check its pair:
- `packages/aave-shared-contracts/src/index.ts` (types) ↔ `backend/src/types/index.ts` (backend types)
- `packages/aave-fetcher/src/index.ts` (pruneReserveForRuntime) ↔ `backend/src/types/index.ts`
- Root output schema ↔ `backend/src/services/marketsApiSerialize.ts`
- `backend/src/cacheTtl.ts` ↔ `backend/src/services/updateScheduler.ts`
- Chain/platform mapping ↔ `packages/aave-fetcher/src/generated/coingecko-platform-by-chain-id.ts`
- `scripts/sync-oracle-pool-configs.ts` ↔ `backend/src/generated/oracle-pool-configs.ts`
- `packages/aave-shared-contracts/src/units.ts` (FIELD_UNITS) ↔ `backend/src/services/marketsApiSerialize.ts` (serializer behavior)

### Shared Package Boundaries (Non-Negotiable)
| Package | Contains | Must NOT contain |
|---|---|---|
| `@internal/aave-shared-contracts` | Types, field registry, validation | Runtime fetch logic, serialization |
| `@internal/aave-fetcher` | `fetchMarketsData`, SDK clients, adapters | Backend API types (`MarketWithSpread`) |
| `backend` | API server, serialization (`marketsApiSerialize.ts`) | `fetchMarketsData` definition (imports it) |

## Validation Gate
- Quality is enforced by Husky hooks with auto-fix: `pre-commit` → build + `test:typecheck` + auto-fix (bin-paths, globstar) + Prettier (lint-staged); `pre-push` → `scripts/hook-autofix.sh pre-push` (ci build+test + auto-fix bin-paths/globstar/audit). CI auto-reverts direct pushes that fail.
- Auto-fixable checks: bin-paths (`./node_modules/.bin/X` → `npx --no-install X`), globstar (`tests/**/*.test.ts` → `tests/*.test.ts`), audit (`npm audit fix --omit=dev`), Prettier (lint-staged).
- Non-auto-fixable checks: build, test:typecheck, test, prune, workspace-coverage — these require manual fixes.
- **Dist import check** (debug-only, also covered by `ci:remote`):
  ```bash
  rg "dist/index\.js|\.\.\/\.\.\/\.\.\/dist" backend/src tests
  ```
- **Bin path check** (debug-only, also covered by `ci:remote`):
  ```bash
  npm run check:bin-paths
  ```
- **Globstar check** (debug-only, also covered by `ci:remote`):
  ```bash
  npm run check:no-globstar
  ```

## High-Risk Areas (Coordinate Carefully)
- Fetch orchestration: `packages/aave-fetcher/src/index.ts`
- Incentive adapters: `packages/aave-fetcher/src/merit-api.ts`, `merkl-api.ts`, `brevis-api.ts`, `brevis-distributed-so-far.ts`
- Merit dynamic info fallback chain: Render (CDP) → Worker → Playwright (local) → null
  - `RENDER_SERVICE_URL` env var enables Render browserless fallback (free tier: ~90s cold start, 750h/month)
  - `MERIT_ALLOW_LOCAL_PLAYWRIGHT` — default `true`; set to `"false"` in production to prevent Chromium OOM on Railway
  - Shared helpers: `extractCampaignInfoFromPage()`, `extractSelfAuthFromPage()`, `createMeritPage()`
  - Source type: `'worker' | 'render' | 'playwright'`
- Token pricing + chain mapping: `packages/aave-fetcher/src/token-price-resolver.ts`, `generated/coingecko-platform-by-chain-id.ts`
- Backend freshness/caching: `backend/src/services/marketsService.ts`, `onchainDataService.ts`, `merklForecastService.ts`, `cacheTtl.ts`
- Shared contracts: `packages/aave-shared-contracts/src/index.ts` (source of truth for `RuntimeReserveData` and `EXPECTED_RUNTIME_FIELDS`)
- Unit conversions: `packages/aave-shared-contracts/src/units.ts` (source of truth for `FIELD_UNITS`, `rayToRatio`, `rayToPercent`)

## Documentation Placement Rule

### `aaveapy-doc/` (symlink → `../aaveapy-doc`) — 跨前后端 + 协议知识
Canonical source for knowledge spanning frontend AND backend, or Aave protocol fundamentals. Not a git submodule; changes committed directly in the symlinked repo.

### `docs/` — 本项目工程文档
- API docs, backend architecture, deployment guides, development best practices.
- `docs/plans/` — 活跃在 `plans/`，完成后移入 `plans/executed/`。

### Agent 查询优先级
当被问到跨前后端或协议相关问题时，Agent 必须**优先搜索 `aaveapy-doc/` 子模块**寻找答案，`docs/` 仅作为本项目工程实现细节的补充。

## Learned Preferences (Condensed)
- Keep docs concise and remove superseded content.
- Prefer runtime verification/log evidence over speculative explanations.
- Keep schema convergence across incentive sources; avoid unused fields in public payload.
- Use exact-origin CORS settings; treat freshness TTL changes as explicit, documented decisions.

## Lessons Learned
- **中间态产物在使命完成后必须立即清理**：迁移安全路径中的临时中间态，一旦最终步骤执行完成且验证通过，必须立即删除，不要留到"下次清理"。
- **设计选项 ≠ 必经步骤**：文档中提出的可选方案需先验证是否有实际消费者，无消费者则直接跳过，不要机械写入任务清单并执行。
- **"组件存在" ≠ "数据流接通"**：验证实现完成度时，不能只 grep 类名/函数名/字段名是否存在。必须按 issue acceptance criteria 逐条验证 import 链路和运行时可达性。例：`fetchV4ReservesViaRpc` 函数存在 + 有测试，但 fetcher 从未 import 它，Layer 2 fallback 是死代码。
- **不信 Linear sub_issues 聚合状态**：`get_issue(sub_issues: true)` 返回的状态可能是缓存/快照，与单条 `get_issue(id)` 结果不一致。必须逐条单查确认。
- **ADR 状态必须与代码实际对标**：不能因为"子 issue 全 Done"就标 ADR 为 Implemented。必须跑一遍 ADR Decision 中每个关键代码点的 import 链路 + 运行时可达性验证。存在 Partial 状态时应标注哪层已实现、哪层未接通。
- **本地 CI ≠ Docker 构建环境**：`ci:remote` 不跑 Docker build，本地残留目录会掩盖 ENOENT。build script 中 `writeFileSync` 的目标目录必须在 script 自身（`mkdirSync`）和 Dockerfile（`RUN mkdir -p`）至少一方保证存在。`buildScriptWriteSafety.test.ts` 做静态检查防回归。
- **涉及外部依赖的测试必须用真实数据**：调用链上合约、第三方 API（Merkl/Brevis/CoinGecko）的测试不能用 mock，必须用真实 URL/合约地址验证。单元测试可覆盖内部逻辑，但集成测试必须对真实外部端点执行，确保数据格式、字段存在性、数值范围与实际一致。改了 API contract 后必须在 dev/staging 验证实际返回。
- **Map key 必须用 shared 工具函数生成**：跨模块通过 Map 传递数据时，key 的生成方式必须统一。禁止在消费方重新实现 key 构造函数（即使逻辑"看起来一样"），必须 import 生产方的同一个函数。例：`brevis-distributed-so-far.ts` 本地 `chainTokenKey` 用 `-` 分隔，而 shared-contracts 用 `:` 分隔，导致 tokenPrice 查找永远 miss，distributedSoFar 全部 undefined，forecast 无 Brevis items。
- **Handoff 文档必须在代码完成后反向验证**：handoff 文档记录了"要做什么"和"待修复项"，完成代码改动后必须回过头逐一检查文档中每个"待修复/需修正/错误"描述，将已完成的标记为"已完成"并删除过时内容。禁止只更新 ADR 而忽略 handoff 文档。例：TARGET_TOTAL_APR P1 完成后只更新了 ADR-0024，handoff 文档仍写着"TARGET_TOTAL_APR 当前硬编码为 mode: 'max'"和"5 个断路点待修复"，导致前端误以为未完成。
- **诊断代码本身可能成为 OOM 源**：`v8.writeHeapSnapshot()` 在 1GB 容器中瞬间分配 ~2x heap 大小的内存（序列化堆），加上 `readFile` + `JSON.parse` 又分配等量内存。诊断代码必须标注**最低容器要求**（如"需 2GB 容器"），且在容器降配时必须同步禁用。`--heapsnapshot-near-heap-limit=1` 同理——V8 OOM 前自动写 snapshot 也会瞬间分配大量内存。1GB 容器中必须移除此参数。
- **http/https globalAgent 是防御性安全网**：node-fetch 已移除 (AAV-1064)，所有出站 HTTP 走 undici 单通道。`server.ts` 中的 `maxSockets=10`/`maxFreeSockets=2` 保留为防御性代码——任何 transitive dependency 可能仍通过 `http`/`https` 模块发出请求。
- **maxSockets ≠ maxFreeSockets，必须都设**：`maxSockets` 限制**同时活跃**连接数，`maxFreeSockets` 限制**keep-alive 池中空闲**连接数。设了 `maxSockets=10` 只保证不会同时有 10 个以上并发请求，但 `maxFreeSockets` 默认 256，允许每 host 缓存 256 个空闲 socket。请求频率低时这些 socket 永远不被复用，持有 TLSSocket/ClientRequest/ReadableState/stream 闭包等全部关联对象，永远不被 GC。**修连接池时必须同时设 maxFreeSockets**。
- **"修了大的，露出小的" ≠ "修出新问题"**：连接池问题从一开始就存在。之前因为更大的泄漏占主导，小泄漏的贡献被淹没。修掉大泄漏后，小泄漏才变得可见。这不意味着修复引入了新问题，而是暴露了被掩盖的旧问题。
- **RSS 垂直飙升 ≠ 渐进泄漏**：RSS 从正常值瞬间飙到 1GB 是一次性大量分配的特征（如 heap snapshot 序列化），不是渐进泄漏（如连接池累积）。两者诊断方向完全不同。渐进泄漏看趋势斜率，垂直飙升看飙升时刻点的代码路径。
- **SDK 内部状态泄漏不只看 queryRegistry**：V3 AaveClient 不继承 GqlClient（无 queryRegistry），之前注释说"safe as singleton"。但 urql 的 fetchExchange 和 Client 内部也保留 Operation/Response 引用。`.toPromise()` 不触发 urql teardown，导致 Response 对象链无法 GC。**任何使用 urql 的 SDK 在长期运行进程中都应 per-fetch 创建 client**，而非依赖"不继承 GqlClient"的假设。
- **V3/V4 SDK 修复必须同步**：V4 AaveClient 已在 Session 4 修复为 per-fetch 创建，但 V3 AaveClient 的单例泄漏被 V4 的更大泄漏掩盖。修完 V4 后，V3 的泄漏才变得可见。**修复 SDK 类泄漏时，必须检查同一依赖的所有入口**。
- **单位转换必须走统一入口**：`rayToPercent`/`rayToRatio` 等转换函数散落在多个包中（onchainDataService 本地定义、aave-rpc-infra 本地定义），导致 V4 RPC fallback 用 `rayToPercent` 给 ratio 字段 `borrowApy` 赋值，序列化器再 ×100 → 400%。**所有转换函数必须 import 自 `@internal/aave-shared-contracts/units.ts`**，新增字段必须注册到 `FIELD_UNITS`，invariant 测试会自动验证注册表完整性。

## Agent skills

### Issue tracker

Issues tracked in **Linear** via MCP tools. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles with default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

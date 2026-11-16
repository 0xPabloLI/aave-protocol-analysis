# Session Coordination Board

本文件是多 agent session 的**并行协调看板**。每个 session 启动时**必须**读取本文件、注册自己、检查冲突；结束时**必须**注销。

---

## 协议（每个 session 必须遵守）

### 1. 启动时：注册 + 冲突检测

1. **读取**本文件，查看 `## Active Sessions` 中所有 `status: active` 的条目。
2. **新增一行**到 Active Sessions 表，填写自己的信息（见下方表格格式）。
3. **冲突检测**：将自己的 `touch-files`（计划修改的文件/目录）与所有 `status: active` 条目的 `touch-files` 做交集。
   - **无交集** → `status: active`，正常执行。
   - **有交集** → `status: blocked`，**只做 plan / 分析 / 只读操作，不要写入任何冲突文件**。在 `notes` 列注明被谁阻塞。
4. 如果判断不准（比如不确定自己会改哪些文件），先用 `status: planning`，弄清楚范围后再更新。

### 2. 执行中：保持更新

- 如果 scope 变了（新增或减少要改的文件），**立即更新** `touch-files`。
- 如果发现新的冲突，将自己降级为 `blocked`。
- 定期检查：被阻塞时，可以重新读取本文件，如果阻塞方已注销，将自己升级为 `active`。

### 3. 结束时：注销

- 任务完成（commit 或放弃）后，**删除自己的行**或将 `status` 改为 `done`。
- 这样其他被你阻塞的 session 就知道可以继续了。

### 4. 异常处理

- 如果看到一个 `active` 条目的 `registered` 时间超过 **48 小时**且无更新，可以视为僵尸 session，在 `notes` 标注 `stale?` 并继续工作（但谨慎操作对应文件）。
- 如果你是人类用户，可以随时清理僵尸条目。

---

## Active Sessions

<!-- 格式说明：每个 session 一行，用 | 分隔 -->
<!-- session-id: 简短唯一标识（如 droid-0408a, cursor-0408b） -->
<!-- agent: 使用的工具（Droid / Cursor / Codex / Claude Code 等） -->
<!-- task: 简述要做什么 -->
<!-- touch-files: 计划修改的文件或目录，逗号分隔；越精确越好 -->
<!-- status: active / planning / blocked / done -->
<!-- registered: ISO 时间戳 -->
<!-- notes: 冲突说明、阻塞原因等 -->

| session-id | agent | task | touch-files | status | registered | notes |
|------------|-------|------|-------------|--------|------------|-------|
| codex-0409a | Codex | 优化 Merkl 数据流文档 | docs/merkl-merit-cache-architecture.md, docs/backend/data-freshness-mechanism.md, docs/api/api-documentation.md | done | 2026-04-09T00:00:00 | 已优化术语与数据流表 |
| codex-0409b | Codex | 收敛重复文档内容 | docs/api/api-documentation.md, docs/reusable/caching-data-freshness-patterns.md | done | 2026-04-09T00:00:00 | 已去掉重复展开，保留引用 |
| codex-0409c | Codex | 写入 runtime 文件分类 | docs/merkl-merit-cache-architecture.md | done | 2026-04-09T00:00:00 | 已补分类规则 |
| codex-0409d | Codex | 收敛 freshness 命名 | backend/src/cacheTtl.ts, backend/src/controllers/coingeckoController.ts, backend/src/services/merklForecastService.ts, backend/src/controllers/merklForecastController.ts, docs/backend/data-freshness-mechanism.md, docs/reusable/caching-data-freshness-patterns.md, README.md, docs/deploy/deploy.md, src/merkl-api.ts | done | 2026-04-09T00:00:00 | 已完成命名收敛与验证 |
| codex-0409d | Codex | 补充 token price 数据流图 | docs/api/api-documentation.md, docs/merkl-merit-cache-architecture.md | done | 2026-04-09T00:00:00 | 已补主图与架构索引 |
| codex-0409e | Codex | 统一 API freshness 术语 | docs/api/api-documentation.md, docs/api/native-apr-calculation.md, docs/backend/data-freshness-mechanism.md, docs/reusable/caching-data-freshness-patterns.md | done | 2026-04-09T00:00:00 | 已完成术语统一与标准化 |
| codex-0409f | Codex | 压缩 freshness 文档 | docs/backend/data-freshness-mechanism.md, docs/api/api-documentation.md | done | 2026-04-09T00:00:00 | 已完成压缩与协议收敛 |
| codex-0409g | Codex | 再压缩 backend freshness 文档 | docs/backend/data-freshness-mechanism.md | done | 2026-04-09T00:00:00 | 已统一术语并压缩描述段落 |
| codex-0504a | CodeArts | 分析 v4 reserve 冻结/暂停与 supply/borrow 标志的关系 | (只读分析，无写入) | done | 2026-05-04T00:00:00 | |
| workbuddy-0916a | WorkBuddy | AAV-1289 下线 Merit 全链路 + AAV-1290 readiness 补齐 | workers/, packages/aave-fetcher/src/{merit-api,cloudflare-browser,incentive-prune,index,cli,config}.ts, packages/aave-shared-contracts/src/{index,units}.ts, backend/src/{types,server}.ts, backend/src/services/{persistenceService,marketsApiSerialize}.ts, .github/workflows/{ci,uptime-alert,test-canary}.yml, package.json, knip.json, .devcontainer/, docs/ | active | 2026-09-16T05:45:00 | 与 4 月遗留条目（均已 done / 视为 stale）无实际冲突 |
| droid-1112a | Droid | AAV-1365 Brevis position cap 刮取加固（句式候选表 + 锚点候选表 + 语义上下文 + MetaMask 归属门 + 失败上报） | packages/aave-fetcher/src/brevis-api.ts, packages/aave-fetcher/tests/brevisPositionCapCopy.test.ts | done | 2026-11-12T15:50:00 | commit `0baacf6`；未 push 前已合 origin/railway（`d9610a7`）。同一 session 在 frontend 仓库完成 AAV-1350 发布与利率文档重写（见 aaveapy `SESSION-BOARD.md` 的 `droid-1112a`）。本行**补登记**：开工时未读本看板即改动 fetcher，已补 ↩ |
| wb-1115a | WorkBuddy | AAV-1371 钉死所有 `npm ci` 工作流的 npm 版本（test-canary / coingecko-platform-sync / security-moderate-report）+ 静态守卫 + AGENTS.md 口径 | .github/workflows/test-canary.yml, .github/workflows/coingecko-platform-sync.yml, .github/workflows/security-moderate-report.yml, backend/tests/workflowNpmPins.test.ts, AGENTS.md, docs/plans/executed/aav-1371-npm-version-pins-spec.md, SESSION-BOARD.md | done | 2026-11-15T15:30:00+08:00 | 已推送 `railway`（`a4209eb`）；canary run `43694747017` 证明 pin 与根 `npm ci` 通过，随后因测试早于 build 的既有缺陷红 ⇒ 已开 AAV-1376。`workbuddy-0916a`（2026-09-16）为 `stale?` |
| wb-1115b | WorkBuddy | AAV-1376 canary 改为「先 build 再跑套件」+ 顺序静态守卫 + shared-contracts 自身测试改 import `src` | .github/workflows/test-canary.yml, backend/tests/testCanaryOrder.test.ts, packages/aave-shared-contracts/tests/{validation,crossAssetPairing,netPositionConstraint}.test.ts, AGENTS.md, docs/plans/aav-1376-canary-build-before-suites-spec.md, SESSION-BOARD.md | done | 2026-11-15T18:30:00+08:00 | 已推 `railway`（`8b9ed03` + `4bddf72`）。canary `43703832449` 整 run 绿 ⇒ 验收第 1 条（五套件全真跑）成立；先前 `43698501475` 已证明 `Build (timed)` 首次成功。`workbuddy-0916a`（2026-09-16 起无更新）按协议 §4 视为 stale |
| wb-1115c | WorkBuddy | AAV-1378 API fields 断言改写（版本读常量、90% 覆盖率换成语义断言、canary 目标按 ref 对齐、修 `run_suite` 失败吞没） | backend/tests/apiFieldsVerification.test.ts, backend/tests/marketsVersionBump.test.ts, backend/tests/testCanaryOrder.test.ts, backend/src/types/index.ts, backend/src/controllers/marketsController.ts, .github/workflows/test-canary.yml, docs/plans/executed/aav-1378-api-fields-assertions-spec.md, SESSION-BOARD.md | done | 2026-11-15T18:30:00+08:00 | canary `43703832449`（`a40b44b`）全绿：1287 pass / 0 fail，五个套件全部真跑。附带发现并修掉 `run_suite` 失败吞没（无 `set -e`，只有最后一个套件决定 step 成败）——同 AAV-1294/1349 的假绿灯形状。`protocolFee` 定性为「缺席 = 0」契约（AAV-1350），未改序列化 |
| wb-1115d | WorkBuddy | 收尾三笔遗留：① 给 pre-commit 的失败传播加行为守卫（判明它不是「吞掉失败」，而是此前误读）② 忽略整个 `.trae/` ③ 把 `borrowInfo` 只判 `null` 的健壮性缺口立票 | tests/preCommitHook.test.ts, .gitignore, AGENTS.md, SESSION-BOARD.md | done | 2026-11-15T20:35:00+08:00 | 守卫用**真** `.husky/pre-commit` + stub `npm/npx/bash` 跑在 `sh -e` 下：删掉 build 行的 `|| exit 1` 会让 6 例里 3 例变红（已实测）。`protocolFee` 未动（AAV-1350 契约）。新票 AAV-1379（Low） |
| wb-1115e | WorkBuddy | AAV-1292 railway → main 正式晋升（用户授权后执行，PR #247） | SESSION-BOARD.md（合并操作本身无文件改动） | done | 2026-11-15T21:10:00+08:00 | main `192c3dc` → `4ab7243`（39 提交 / 35 文件）。production 部署 success、烟测 `43717274540` success、main 上 canary dispatch `43717305808` **success**（1243 tests / 1215 pass / 28 skip / **0 fail**，默认分支历史首绿）。剩 `11-16 14:57Z` 周跑为最后判据 |
| wb-1116c | WorkBuddy | AAV-1380 定性：`/markets` 的 `ltv=0` 是 base LTV 真实值（非映射缺陷），收口证据 + 契约口径 + 自有 `ltv=0` 保留守卫 + eMode 后续方案 | packages/aave-fetcher/tests/ltvZeroPreserved.test.ts, packages/aave-shared-contracts/src/index.ts, backend/tests/ltvSemantics.test.ts, docs/api/api-documentation.md, docs/plans/executed/aav-1380-ltv-zero-semantics.md, SESSION-BOARD.md | done | 2026-11-16T20:40:00+08:00 | 冲突检测：板上无 active 条目（workbuddy-0916a 自 2026-09-16 起无更新，协议 §4 视为 stale；droid-0408c 为 04-08 示例行）⇒ 无交集；开工时 `git status --short` 为空。**验证**：fetcher 守卫 3/3（mutation：真值判定打红 S1、`?? 0` 打红 S2，各只红一条）；backend 序列化守卫 3/3（mutation 真值判定打红 S1）；`apiFieldsVerification` 对 staging 真 payload 9/9（新增 `ltv ≤ lt`、V4 `ltv === lt` 两条不变量）；`openapiAutoGen` 9/9；生成物两处 `ltv` 描述含零语义。全量 `ci` 各步绿；本机 npmmirror 缺 `@aave/types@1.1.0` 与 audit 接口 ⇒ `npm ci` / `npm run audit` 需 `--registry=https://registry.npmjs.org/` |
| droid-1116a | Droid | AAV-1295 回滚路径首次执行：4 次 `deploymentRollback` 取证 + 改用 `deploymentRedeploy` + staging 演练全绿 + production 只读 plan + 闸门默认关闭 | .github/workflows/deployment-smoke-test.yml, .github/scripts/deployment-smoke-test-helpers.mjs, .github/scripts/wait-for-commit-sha.sh, tests/deploymentSmokeTest.test.ts, tests/deploymentSmokeTestWorkflow.test.ts, docs/ci-security-automation.md, docs/runbooks/app-deploy-failure.md, docs/plans/executed/aav-1295-rollback-drill-spec.md, AGENTS.md, SESSION-BOARD.md | done | 2026-11-16T17:05:00+08:00 | commits `0fc068e`/`61879da`/`12c6c16`/`10cda0e`/`65f2089`/`802a951`/`97d941f`/`f5341fb`。`deploymentRollback` 4 次均返回 true，serving 时间为 10m43s / 21m17s / >30m / >30m；自动路径改 `deploymentRedeploy`，手动实验留在 runbook。演练 `43831007873`（71s/61s）与 `43835257174`（92s/71s）全绿；production plan `43831671017` gate=false(production-gated)，最终 plan `43837166209` 同。**收口（owner 授权后）**：production 变量 `RAILWAY_PRODUCTION_ROLLBACK_ENABLED=true` 已于 09:20:17Z 设置，复验 plan `43840148408` 读出 `gate=true(production-enabled)`（execute/wait/restore 全 skipped，零 mutation）；Linear AAV-1295 → Done + 交付评论；roadmap 第十六轮 inventory 与 Done 行（aaveapy `571328c4`）；平台侧 `deploymentRollback` 缺陷另开 AAV-1388 |

---

## 冲突判断参考

以下是常见的高冲突区域，两个 session 同时改这些区域**几乎必然冲突**：

| 区域 | 典型文件 |
|------|----------|
| 数据获取主流程 | `src/index.ts` |
| Merkl 集成 | `src/merkl-api.ts` |
| Brevis 集成 | `src/brevis-api.ts` |
| 代币价格解析 | `src/token-price-resolver.ts`, `src/generated/coingecko-platform-by-chain-id.ts` |
| 环境变量 / 配置 | `src/env.ts`, `src/config.ts`, `.env`, `ecosystem.config.cjs` |
| 后端服务层 | `backend/src/services/marketsService.ts`, `backend/src/services/onchainDataService.ts` |
| Merkl 预测服务 | `backend/src/services/merklForecastService.ts`, `backend/src/services/merklForecastModel.ts`, `backend/src/services/merklOpportunityClient.ts` |
| 后端序列化 | `backend/src/services/marketsApiSerialize.ts` |
| 缓存 TTL 配置 | `backend/src/cacheTtl.ts` |
| 定时任务调度 | `backend/src/services/updateScheduler.ts` |
| 后端启动 / 路由 | `backend/src/server.ts`, `backend/src/startup.ts`, `backend/src/routes/` |
| 后端类型定义 | `backend/src/types/index.ts` |
| CORS / 中间件 | `backend/src/middleware/cors.ts`, `backend/src/middleware/cacheHeaders.ts` |
| CI / GitHub Actions | `.github/workflows/`, `.github/scripts/` |
| 部署配置 | `deploy.sh`, `railway.json` |
| 共享包配置 | `packages/aave-shared-config/` |
| 测试 | `backend/tests/` |

如果两个 session 的 `touch-files` 落在**同一区域**，即使不是完全相同的文件，也建议视为冲突（因为经常有隐式依赖）。

**特别注意**：
- `src/index.ts` 修改后需 `npm run build` 才能被 root CLI 使用——但 `backend/` 通过 `@internal/*` workspace 包名导入（不依赖 root dist），涉及 `packages/` 和 `backend/services/marketsService.ts` 的 session 无需协调 root build。
- `pruneReserveForRuntime()` 在 `src/index.ts` 中，新增 reserve 字段必须同时更新此函数和 `backend/src/types/index.ts`。
- `backend/src/cacheTtl.ts` 与 `backend/src/services/updateScheduler.ts` 紧密耦合，修改 TTL 时两个文件通常需要一起改。

---

## 示例

```
| session-id   | agent  | task                           | touch-files                                                  | status  | registered          | notes              |
|--------------|--------|--------------------------------|--------------------------------------------------------------|---------|---------------------|--------------------|
| droid-0408a  | Droid  | 添加新链 RPC 支持              | packages/aave-shared-config/, backend/src/services/onchainDataService.ts | active  | 2026-04-08T10:30:00 |                    |
| cursor-0408b | Cursor | 重构 Merkl forecast 缓存策略   | backend/src/services/merklForecastService.ts, backend/src/cacheTtl.ts    | active  | 2026-04-08T10:45:00 |                    |
| droid-0408c  | Droid  | 修改 markets 序列化添加新字段  | src/index.ts, backend/src/types/index.ts, backend/src/services/marketsApiSerialize.ts | blocked | 2026-04-08T11:00:00 | 被 cursor-0408b 阻塞（marketsService 间接依赖 forecast 缓存） |
```

当 `cursor-0408b` 完成并注销后，`droid-0408c` 重新读取本文件，发现无冲突，即可将自己改为 `active` 并开始执行。

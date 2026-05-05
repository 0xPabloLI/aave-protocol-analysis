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
| codex-0504a | CodeArts | 分析 v4 reserve 冻结/暂停与 supply/borrow 标志的关系 | (只读分析，无写入) | active | 2026-05-04T00:00:00 | |
| codex-0504b | CodeArts | 检查 dead code | (只读分析，无写入) | active | 2026-05-04T00:00:00 | |

---

## 冲突判断参考

以下是常见的高冲突区域，两个 session 同时改这些区域**几乎必然冲突**：

| 区域 | 典型文件 |
|------|----------|
| 数据获取主流程 | `src/index.ts` |
| Merit 集成 | `src/merit-api.ts` |
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
| 部署配置 | `deploy.sh`, `railway.json`, `workers/` |
| 共享包配置 | `packages/aave-shared-config/` |
| 测试 | `backend/tests/` |

如果两个 session 的 `touch-files` 落在**同一区域**，即使不是完全相同的文件，也建议视为冲突（因为经常有隐式依赖）。

**特别注意**：
- `src/index.ts` 修改后需 `npm run build` 才能被 `backend/` 使用（backend imports from `dist/index.js`）——涉及 `src/` 和 `backend/services/marketsService.ts` 的 session 请特别协调。
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

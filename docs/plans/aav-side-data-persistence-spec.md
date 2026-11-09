# Spec: Side-Data Persistence to PostgreSQL

## Problem Statement

Railway 服务重启后，`/api/meta/side-data` 的三个子源（categories、FDV、forecast）的内存缓存全部丢失。重启到 cron 首次预热之间有一个窗口期，期间 side-data 请求要么 TTFB 极高（categories 需 5 个串行 CoinGecko 请求 + 4 个 sleep(2.5s) = ~12.5s），要么返回 500（forecast 依赖 markets snapshot 先就绪）。

## Solution

将三个子源的内存缓存持久化到 PostgreSQL `side_data_snapshots` 表。服务重启时从 DB 加载最新数据填充内存缓存：若数据在 soft TTL 内则直接使用，若过期则作为 stale fallback 并异步刷新。

## User Stories

1. 作为 API 消费者，我希望服务重启后 `/api/meta/side-data` 端点能在 <100ms 内返回数据，这样前端不会因后端重启而出现长时间加载。
2. 作为 API 消费者，我希望重启后 side-data 返回的数据与重启前一致（来自 DB 的最新快照），而不是空数据或 500 错误。
3. 作为运维人员，我希望 side-data 持久化不影响现有 markets/oracle 持久化的正常运行。
4. 作为运维人员，我希望 side-data 表不会无限增长，定期清理旧数据。
5. 作为开发者，我希望持久化逻辑独立于 markets/oracle 持久化逻辑，降低耦合。
6. 作为开发者，我希望 DB 不可用时持久化静默失败，不影响内存缓存的正常读写。
7. 作为开发者，我希望启动加载失败时服务仍能正常启动并从外部 API warmup。

## Implementation Decisions

### 数据库 Schema

新建 `side_data_snapshots` 表（新 migration `002_side_data_snapshots.sql`）：

- `source TEXT NOT NULL` — `'categories' | 'fdv' | 'forecast'`
- `data JSONB NOT NULL` — 序列化的缓存数据
- `fetched_at TIMESTAMPTZ NOT NULL` — 原始缓存的时间戳
- `content_hash TEXT` — SHA-256 of data，用于变化检测
- 索引：`(source, created_at DESC)` 用于按 source 查最新

### 持久化服务

新建 `sideDataPersistenceService.ts`，包含：

- `persistSideData(source, data, fetchedAt)` — content-hash 变化检测后写入 DB（fire-and-forget，不阻塞调用方）
- `warmSideDataFromDb()` — 启动时从 DB 加载最新数据，返回各 source 的 `{ data, fetchedAt } | null`
- `cleanupOldSideDataSnapshots()` — 保留每个 source 最新 3 份
- `computeHash` 复用 `persistenceService.ts` 的导出函数

### 持久化时机

在每个子源的内存缓存赋值后调用 `persistSideData()`：

- `coingeckoController.ts` — `cachedResponse` 赋值后（categories）
- `coingeckoController.ts` — `cachedFdvResponse` 赋值后（FDV）
- `merklForecastController.ts` — `snapshotCache` 赋值后（forecast）

使用 `void` 前缀 fire-and-forget，不 `await`，不影响 API 响应延迟。

### 启动加载时机

在 `server.ts` 的 `runMigrationWithWarmup()` 中，`warmConfigHashes()` 之后添加 `warmSideDataFromDb()`。在 Phase 1 warmup 之前执行，使 warmup 可能直接命中缓存避免外部 API 调用。

### 各 source 的数据格式契约

| Source     | 内存缓存变量        | 持久化的 JSONB                                          | fetched_at 来源                        | 还原时写入                                                                                        |
| ---------- | ------------------- | ------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| categories | `cachedResponse`    | `{ uniqueSymbolsStablecoins, uniqueSymbolsEth }`        | `cachedResponse.fetchedAt` (number)    | `cachedResponse = { data, fetchedAt }`                                                            |
| fdv        | `cachedFdvResponse` | `{ items, fetchedAt }` (items 不含 source 字段时需包含) | `cachedFdvResponse.fetchedAt` (number) | `cachedFdvResponse = { data, fetchedAt }`                                                         |
| forecast   | `snapshotCache`     | `{ items, errors }` (不含 staleTimeMs)                  | `snapshotCache.generatedAt` (number)   | `snapshotCache = { snapshot: { items, errors, staleTimeMs: FORECAST_SOFT_TTL_MS }, generatedAt }` |

### 清理策略

在 `archiveService.ts` 的 `cleanupPostgres()` 中，将 `side_data_snapshots` 加入清理列表。但由于 side-data 数据量小（<100KB），也可以在每次 `persistSideData` 时顺便清理同 source 的旧数据（保留 3 份）。

选择：**每次持久化时清理同 source 旧数据**（保留 3 份），不依赖 archiveService 的时间窗口清理。archiveService 的 7 天清理也加入 `side_data_snapshots` 作为兜底。

### Cron 注册

不需要单独 cron。持久化在每个子源的缓存更新时同步触发。清理在持久化时顺便执行。

## Testing Decisions

### 测试 Module

- `sideDataPersistenceService.ts` — content-hash 变化检测、DB 写入、DB 读取、清理逻辑
- 现有 `coingeckoController.ts` / `merklForecastController.ts` — 验证持久化调用被正确触发

### 测试 Prior Art

- `persistenceService.test.ts` — content-hash 变化检测、hash map 管理的测试模式
- `archiveService.test.ts` — 环境变量解析和结构守卫的测试模式

### 测试 Seam

在 `sideDataPersistenceService.ts` 的导出函数层面测试（单元测试），不测试 DB 交互（需真实 DB 连接，与现有 `persistenceService.test.ts` 一致——只测试纯逻辑部分）。

## Scenario & Risk Verification Matrix

| #   | 场景                                    | 输入状态                | DB 写入                             | DB 读取                         | 必须一致的原因                           | 风险维度   |
| --- | --------------------------------------- | ----------------------- | ----------------------------------- | ------------------------------- | ---------------------------------------- | ---------- |
| 1   | DB 为空（首次启动）                     | 无数据                  | skip (无缓存)                       | 返回 null                       | warmup 从外部 API 拉取                   | Null/Empty |
| 2   | DB 有数据，soft TTL 内                  | fetchedAt 在 TTL 内     | skip (hash 不变)                    | 填充内存缓存                    | warmup 命中缓存，跳过 API 调用           | 状态转换   |
| 3   | DB 有数据，超 soft TTL 但在 hard TTL 内 | fetchedAt 超 soft TTL   | —                                   | 填充内存缓存 + 异步刷新         | stale fallback，不阻塞启动               | 状态转换   |
| 4   | DB 有数据，超 hard TTL                  | fetchedAt 超 hard TTL   | —                                   | 不填充，等 warmup               | 避免使用过旧数据                         | 状态转换   |
| 5   | DB 有数据，JSON 解析失败                | JSONB 损坏              | —                                   | 跳过该 source，log warning      | 不影响其他 source 加载                   | 失败/降级  |
| 6   | 内存缓存为 null 时收到持久化请求        | 缓存未初始化            | skip                                | —                               | 不写入 null 数据                         | Null/Empty |
| 7   | DB 写入失败                             | DB 不可用               | log warning，不 throw               | —                               | 不影响内存缓存正常工作                   | 失败/降级  |
| 8   | DB 读取失败（启动加载）                 | DB 不可用               | —                                   | log warning，fallback 到 warmup | 不阻塞服务启动                           | 失败/降级  |
| 9   | 三个 source 中部分成功部分失败          | categories OK, fdv fail | 各自独立                            | 逐 source 独立加载              | 不因一个失败影响其他                     | 失败/降级  |
| 10  | content-hash 未变化                     | 数据相同                | skip (hash 匹配)                    | —                               | 避免重复写入                             | 并发/竞态  |
| 11  | 启动加载 + warmup 并发                  | DB 有数据               | —                                   | 先填充内存，warmup 检查命中     | warmup 检查 hasReusableCache() 返回 true | 并发/竞态  |
| 12  | forecast snapshot 含 staleTimeMs        | 持久化时                | 只存 items+errors，不存 staleTimeMs | 加载时重新计算 staleTimeMs      | staleTimeMs 是运行时常量                 | 跨Step契约 |
| 13  | source 字段值一致性                     | 写入 'categories'       | 读取时匹配 'categories'             | 常量定义，不硬编码              | 跨系统键匹配                             |
| 14  | 清理保留最新 3 份                       | source 有 5 条          | 写入后删除旧的                      | —                               | 表不无限增长                             | —          |
| 15  | DATABASE_URL 未设置                     | 持久化禁用              | skip                                | skip                            | 与 markets 持久化一致                    | CI/CD      |

## Out of Scope

- 前端改动（不需要修改前端代码）
- side-data API 响应格式变更
- 新增 cron 定时器
- markets/oracle 持久化逻辑变更

## Further Notes

- 数据量估算：3 个 source × ~20KB = ~60KB/次写入，每天约 200 条记录，总量 < 15MB。保留 3 份 < 100KB。
- 验证标准：服务重启后 `/api/meta/side-data` TTFB < 100ms（从 DB 读取而非外部 API）。
- 后端分支：在 `railway` 分支上开发，走 railway → staging → production 上线流程。

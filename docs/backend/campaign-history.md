# Campaign 历史保留方案

Last updated: 2026-05-19

## 背景

后端 API 只返回活跃 campaign：过期 campaign 在 root fetcher 层被过滤，前端无法展示历史激励数据。本方案在后端层保留 campaign 历史，不改动 root fetcher。

## DB Schema

```sql
CREATE TABLE campaign_history (
  id              BIGSERIAL     PRIMARY KEY,
  reserve_id      TEXT          NOT NULL,
  source          TEXT          NOT NULL,       -- 'merit' | 'merkl' | 'brevis'
  side            TEXT          NOT NULL,       -- 'supply' | 'borrow' | 'hold'
  campaign_key    TEXT          NOT NULL,       -- dedupe key
  campaign_data   JSONB         NOT NULL,       -- 完整 campaign 快照（比例值），含 start/end
  first_seen_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  expired_at      TIMESTAMPTZ                    -- NULL = 当前仍在活跃快照中
);

CREATE UNIQUE INDEX idx_campaign_history_dedup
  ON campaign_history (reserve_id, source, side, campaign_key);

CREATE INDEX idx_campaign_history_status_window
  ON campaign_history (expired_at, last_seen_at DESC);

CREATE INDEX idx_campaign_history_reserve_source_seen
  ON campaign_history (reserve_id, source, side, last_seen_at DESC);

-- APR 时间序列（append-only）。完整快照在 campaign_history 中，此处只存变化点和 hash。
CREATE TABLE campaign_apr_observations (
  id              BIGSERIAL     PRIMARY KEY,
  observed_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  reserve_id      TEXT          NOT NULL,
  source          TEXT          NOT NULL,
  side            TEXT          NOT NULL,
  campaign_key    TEXT          NOT NULL,
  apr             DOUBLE PRECISION NOT NULL,    -- 比例值，不是百分值
  apr_data_hash   TEXT          NOT NULL        -- APR 相关字段 hash，用于变化检测
);

CREATE INDEX idx_campaign_apr_observations_series
  ON campaign_apr_observations (reserve_id, source, side, campaign_key, observed_at);

CREATE INDEX idx_campaign_apr_observations_latest_hash
  ON campaign_apr_observations (reserve_id, source, side, campaign_key, observed_at DESC);
```

### `expired_at` 和 `endDate` 不是同一件事

- `endDate` / `campaignEndedAt`：campaign 自己声明的业务结束时间，前端展示用
- `expired_at`：后端检测到 campaign 不再出现在活跃快照的时间，API 状态过滤用
- 两者通常接近但不保证相等（上游可能提前取消、延期、短暂漏报）

### 两表职责

| 表 | 模式 | 职责 |
|----|------|------|
| `campaign_history` | UPSERT 去重，每个 key 一行 | 当前状态 + 生命周期（`first_seen_at` / `expired_at`）+ 完整快照 |
| `campaign_apr_observations` | append-only，APR 变化时追加 | APR 时间序列，绘制变化曲线 |

完整快照只在 `campaign_history` 中存一份，`campaign_apr_observations` 不存 `campaign_data`，需快照时 JOIN 即可。

## 去重键 campaign_key 规则

| source | campaign_key | 来源 |
|--------|-------------|------|
| `merit` | `link::endDate` | Merit 无 campaignId，link + endDate 唯一 |
| `merkl` | `campaignId` | breakdown 中的 campaignId（必填） |
| `brevis` | `campaignId` 优先，无则 `hash(link,campaignStartedAt,campaignEndedAt)` | Brevis campaignId 可选 |

## Cron 写入流程

persist cron（每分钟 :20）执行：

1. **UPSERT campaign_history**：遍历内存快照 7 个 campaign 数组，`ON CONFLICT DO UPDATE SET campaign_data = EXCLUDED.campaign_data, last_seen_at = NOW(), expired_at = NULL`
2. **标记过期**：`UPDATE SET expired_at = NOW() WHERE expired_at IS NULL AND last_seen_at < NOW() - 2min`
3. **APR observation append**：APR hash 变化时追加一行到 `campaign_apr_observations`

## campaign_data JSONB 结构

存内存快照原始形状（比例值），API 响应时走 `x100` 序列化。

### Merit

```json
{ "apr": 0.0235, "selfApr": 0.01, "link": "https://...", "name": "Merit Round 42", "message": [], "startDate": "2025-05-01T00:00:00Z", "endDate": "2025-05-15T23:59:59Z" }
```

### Merkl / Brevis（单 breakdown 拆组）

```json
{ "link": "https://...", "name": "Merkl Campaign", "breakdowns": [{ "campaignApr": 0.018, "campaignId": "0xabc...", "campaignStartedAt": "...", "campaignEndedAt": "..." }] }
```

Merkl/Brevis 多 breakdown 的 CampaignGroup 按单 breakdown 拆组存储，每个 breakdown 独立一行，group 的 `link` / `name` / `message` 携带在 JSONB 内。

## Phase 1 已完成 ✅

| # | 任务 | 状态 |
|---|------|------|
| 1 | DB migration (`008_campaign_history.sql`) | ✅ |
| 2 | `persistCampaignHistory()` UPSERT 写入 | ✅ |
| 3 | `markExpiredCampaigns()` 过期标记 | ✅ |
| 4 | `appendAprObservations()` APR 观测写入 | ✅ |
| 5 | cron 集成 (`updateScheduler.ts`) | ✅ |
| 6 | `campaign_apr_observations` 去冗余 `campaign_data` (`010_drop_campaign_data_from_observations.sql`) | ✅ |
| 7 | 单元测试 (`persistenceService.test.ts`) | ✅ |

**现状**：`campaign_history` 和 `campaign_apr_observations` 通过 cron 每分钟写入，但**没有任何 API 读取**。数据只写不读，是纯归档状态。

---

## Phase 2：Recently Ended Campaign + APR 曲线（待实现）

### 前端设计参考

前端已有设计方案：`aaveapy/docs/plans/2026-05-15-recently-ended-campaigns-design.md`

核心设计：在 IncentiveTooltip 底部追加可折叠「Recently Ended」区块，展示 7 天内结束的过期 campaign，灰显样式，不计入 APY 总和。前端从 `/api/markets` 全量数据中本地过滤。

### 关键决策

| 决策 | 结论 | 理由 |
|------|------|------|
| 过期 campaign 数据源 | **合并进 `/api/markets` 响应** | 与前端设计文档一致，前端一个请求拿到全部，本地 `isRecentlyEnded()` 过滤 |
| 实现方式 | **内存缓存**（方案 B） | cron tick 时从 DB 读 7 天内过期 campaign → 内存 map → API 序列化时合并，零额外查询 |
| 过期窗口 | 默认 **7 天** | 与前端 `isRecentlyEnded()` 一致 |
| APR 曲线 | **独立 endpoint** | 按需请求，不在 `/api/markets` 中返回时序数据 |

### 方案 B 架构

```text
[cron tick :20]
  ├─ 现有：refreshMarketsSnapshot() → 内存活跃快照
  ├─ 现有：persistCampaignHistory() + markExpiredCampaigns()
  └─ 新增：refreshRecentlyExpiredMap()
       SELECT FROM campaign_history
       WHERE expired_at IS NOT NULL
         AND expired_at > NOW() - INTERVAL '7 days'
       → 写入内存 Map<reserveId, CampaignHistoryRow[]>

[GET /api/markets]
  ├─ 现有：serializeReserveForApi(reserve) → 活跃 campaign
  └─ 新增：从 recentlyExpiredMap 取该 reserve 的过期 campaign
       → 序列化到 reserve.meritSupplys / merklSupplys / ... 中
       → 标记 _isExpired: true（前端识别用）
```

**内存开销**：7 天内过期 campaign 通常 ≤ 10 条，每条 JSONB ~1KB，总量 < 10KB。

### 后端任务

#### 2A：Recently Ended 合并进 /api/markets

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 1 | 查询 + 内存缓存 | `recentlyExpiredService.ts` | `refreshRecentlyExpiredMap()` — cron tick 时查 DB 7 天窗口，写入 `Map<reserveId, CampaignHistoryRow[]>` |
| 2 | 类型扩展 | `@internal/aave-shared-contracts` | `RuntimeReserveData` 中 campaign 条目加 `_isExpired?: true` 可选字段 |
| 3 | 序列化合并 | `marketsApiSerialize.ts` | 序列化 reserve 时从内存 map 追加过期 campaign，复用 x100 逻辑 |
| 4 | cron 集成 | `updateScheduler.ts` | persist cron 中调用 `refreshRecentlyExpiredMap()` |
| 5 | 测试 | `tests/` | 查询逻辑 + 内存缓存 + 序列化合并 |

#### 2B：APR Series API（独立 endpoint）

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 6 | 查询函数 | `persistenceService.ts` | `getAprObservations({ reserveId, source, side, campaignKey, from?, to? })` |
| 7 | API route | `routes/campaignHistoryRouter.ts` | `GET /api/campaigns/apr-series?reserveId=xxx&campaignKey=yyy` |
| 8 | 响应结构 | — | `{ observations: [{ observedAt, apr }], campaign: { campaignData, expiredAt, ... } }` (JOIN `campaign_history` 取快照) |
| 9 | 采样策略 | — | 超过 500 点时按小时聚合：`date_trunc('hour', observed_at)` + `avg(apr)` |
| 10 | server 集成 | `server.ts` | 挂载 route |
| 11 | 测试 | `tests/` | 查询 + API |

### 前端任务（参考 aaveapy 仓库）

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| F1 | Recently Ended 展示 | `IncentiveTooltip.tsx` | 折叠区块，从 `/api/markets` 返回的数据中筛 `_isExpired === true` |
| F2 | 纯函数 | `lib/recentlyEndedCampaigns.ts` | `isRecentlyEnded()` / `collectRecentlyEndedCampaigns()` |
| F3 | 类型扩展 | `types/aave.ts` | `MeritIncentive` / `MerklCampaignBreakdown` / `BrevisCampaignBreakdown` 加 `_isExpired?: true` |
| F4 | Zod schema | `shared/market-contract/schemas.ts` | 对应 schema 扩展 |
| F5 | APR 曲线组件 | 新增 `CampaignAprChart.tsx` | 调 `/api/campaigns/apr-series`，绘图（recharts / visx） |
| F6 | APR 数据获取 | `hooks/useAprSeries.ts` | `fetchAprSeries(reserveId, campaignKey)` → react-query |
| F7 | 测试 | `recentlyEndedCampaigns.test.ts` + `IncentiveTooltip.test.tsx` | 边界条件 + 折叠交互 |

### 数据流（Phase 2 完成后）

```text
[cron :20]
  refreshMarketsSnapshot()          → 内存活跃快照
  persistCampaignHistory()          → DB campaign_history
  markExpiredCampaigns()            → DB campaign_history.expired_at
  refreshRecentlyExpiredMap()       → 内存 recentlyExpiredMap (7天窗口)

[GET /api/markets]
  serializeReserveForApi(reserve)
    ├─ 活跃 campaign ← 内存快照（现有）
    └─ 过期 campaign ← recentlyExpiredMap（新增，_isExpired: true）

[前端 IncentiveTooltip]
  ├─ 活跃 campaign → 正常渲染
  └─ _isExpired === true → Recently Ended 折叠区块，灰显，不计入 APY

[APR 曲线图]
  └─ GET /api/campaigns/apr-series?reserveId=xxx&campaignKey=yyy
       ↓
  前端绘图
```

### 不改动

- root `src/` 下任何文件
- fetcher 过滤逻辑（活跃 campaign 仍由 fetcher 层过滤）
- 前端 `formatters.ts` APY 计算逻辑（只算活跃的，即 `_isExpired !== true`）

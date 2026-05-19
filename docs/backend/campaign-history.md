# Campaign 历史保留方案

Last updated: 2026-05-19

> **已被替代**：本方案的核心内容已合并到 `docs/backend/change-detection-and-incentive-normalization.md`。新设计中 `campaign_history` 和 `campaign_apr_observations` 表删除，per-campaign APR 信息内联在 `market_snapshots.incentive_details` JSONB 中，通过 change-detection 写入。

> **关联文档**：
> - `docs/backend/change-detection-and-incentive-normalization.md` — 新的统一设计（替代本文档）
> - `docs/backend/reserve-snapshots.md` — `market_snapshots` API

## 背景

后端 API 只返回活跃 campaign：过期 campaign 在 fetcher 层被 `filterExpiredCampaigns()` / `isMeritCampaignExpired()` / Brevis status+endTime 过滤掉。前端无法展示历史激励数据。

上游实际返回近期过期 campaign（Merkl `status=LIVE` opportunity 内可含已过期 breakdown；Merit/Brevis 同理），只是项目本地过滤掉了。

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
```

### 表定位：长期归档

`campaign_history` 是**长期归档表**——存上游不再返回的历史 campaign。近期过期 campaign 的数据源优先从上游获取（数量可控，无需窗口过滤），DB 仅在重启后上游已不返回时兜底。

### `campaign_apr_observations` 已移除

APR 时间序列信息已由 `market_snapshots.incentive_details` JSONB 覆盖（每分钟写入全量快照，含 per-campaign APR）。单 campaign APR 曲线从 `market_snapshots` 查询，`incentive_details` 需加厚到 per-campaign 级别（加 `campaignId`）。未变化期间用上一条记录推导（`LAG()` 或前端本地填充）。

> **关联**：`reserve-snapshots.md` 中 `incentive_details` 当前只存聚合级 APR（`{ side, aprs[] }`），需扩展为 per-campaign 级别（`{ side, campaigns: [{ campaignId, campaignApr, campaignEndedAt }] }`），与本文档 `campaign_data` JSONB 结构对齐。

### `expired_at` 和 `endDate` 不是同一件事

- `endDate` / `campaignEndedAt`：campaign 自己声明的业务结束时间，前端展示用
- `expired_at`：后端检测到 campaign 不再出现在活跃快照的时间，DB 归档用
- 两者通常接近但不保证相等（上游可能提前取消、延期、短暂漏报）

## 去重键 campaign_key 规则

| source | campaign_key | 来源 |
|--------|-------------|------|
| `merit` | `link::endDate` | Merit 无 campaignId，link + endDate 唯一 |
| `merkl` | `campaignId` | breakdown 中的 campaignId（必填） |
| `brevis` | `campaignId` 优先，无则 `hash(link,campaignStartedAt,campaignEndedAt)` | Brevis campaignId 可选 |

## Cron 写入流程

persist cron（每分钟 :20）执行：

1. **UPSERT campaign_history**：遍历内存快照 7 个 campaign 数组
2. **标记过期**：`UPDATE SET expired_at = NOW() WHERE expired_at IS NULL AND last_seen_at < NOW() - 2min`

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
| 4 | cron 集成 (`updateScheduler.ts`) | ✅ |
| 5 | 单元测试 (`persistenceService.test.ts`) | ✅ |
| 6 | `campaign_apr_observations` 去冗余 `campaign_data` (`010_drop_campaign_data_from_observations.sql`) | ✅ |

---

## Phase 2：Recently Ended Campaign + APR 曲线（待实现）

### 前端设计参考

前端已有设计方案：`aaveapy/docs/plans/2026-05-15-recently-ended-campaigns-design.md`

核心设计：在 IncentiveTooltip 底部追加可折叠「Recently Ended」区块，灰显展示过期 campaign，不计入 APY 总和。

### 关键决策

| 决策 | 结论 | 理由 |
|------|------|------|
| Recently ended 数据源 | **从上游直接获取** | 上游（Merkl/Merit/Brevis）返回近期过期 campaign，数量可控（LIVE opportunity 内刚过期的 breakdown），无需窗口过滤 |
| 合并进 `/api/markets` | **是** | fetcher 不过滤近期过期 campaign → 内存快照自然包含 → 序列化时标记 `_isExpired: true` |
| APR 曲线数据源 | **从 `market_snapshots.incentive_details` 查询** | 已有每分钟全量快照，加厚 `incentive_details` 到 per-campaign 级别即可提取单个 campaign APR 曲线 |
| `campaign_history` 的角色 | **长期归档兜底** | 重启后若上游已不返回某过期 campaign，从 DB 兜底；近期过期优先走上游 |

### 架构

```text
[fetcher — 不再过滤近期过期 campaign]
  上游响应 → 保留 campaignEndedAt < now 但仍在 LIVE opportunity 中的 breakdown
           → 内存快照包含 active + recently ended
           → each campaign 附带 _isExpired: (endDate < now)

[GET /api/markets]
  serializeReserveForApi(reserve)
    ├─ active campaign (_isExpired !== true) → 正常渲染
    └─ recently ended (_isExpired === true) → 灰显，不计入 APY

[APR 曲线]
  GET /api/campaigns/apr-series?reserveId=xxx&campaignKey=yyy
    → SELECT FROM market_snapshots, jsonb 提取特定 campaign APR
    → 不变期间用 LAG() 填充或前端本地 step-fill

[campaign_history 归档]
  cron 仍 UPSERT + markExpired — 用于长期历史查询
  重启兜底：若上游已不返回某过期 campaign，从 DB SELECT 填充 recentlyExpiredMap
```

### 后端任务

#### 2A：Recently Ended 合并进 /api/markets

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 1 | fetcher 改动 | `merkl-api.ts` / `merit-api.ts` / `brevis-api.ts` | `filterExpiredCampaigns()` / `isMeritCampaignExpired()` / Brevis 过滤 — 改为只过滤"很久以前过期的"，保留近期过期的（或全部不过滤，由序列化层标记） |
| 2 | 类型扩展 | `@internal/aave-shared-contracts` | `RuntimeReserveData` 中 campaign 条目加 `_isExpired?: true` 可选字段 |
| 3 | 序列化标记 | `marketsApiSerialize.ts` | 序列化时检查 endDate < now → 标记 `_isExpired: true`；APY 计算排除 `_isExpired` 条目 |
| 4 | 重启兜底 | `recentlyExpiredService.ts` | `refreshRecentlyExpiredMap()` — 从 `campaign_history` DB 读上游已不返回的过期 campaign，合并到内存快照 |
| 5 | 测试 | `tests/` | fetcher 过滤 + 序列化标记 + 兜底逻辑 |

#### 2B：APR 曲线（从 market_snapshots 查询）

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 6 | 加厚 `incentive_details` | `persistenceService.ts` | `buildIncentiveDetails()` 改为 per-campaign 级别：加 `campaignId` / `campaignApr` / `campaignEndedAt` |
| 7 | migration | `011_incentive_details_per_campaign.sql` | 无需 ALTER TABLE（JSONB 结构变更），但记录 schema 变化 |
| 8 | 查询函数 | `persistenceService.ts` | `getCampaignAprSeries(reserveId, campaignKey, from, to)` — 从 `market_snapshots.incentive_details` JSONB 提取 |
| 9 | API route | `routes/campaignHistoryRouter.ts` | `GET /api/campaigns/apr-series?reserveId=xxx&campaignKey=yyy` |
| 10 | 采样策略 | — | 超过 500 点时按小时聚合 |
| 11 | server 集成 | `server.ts` | 挂载 route |
| 12 | 测试 | `tests/` | JSONB 提取 + API |

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

### 不改动

- root `src/` 下任何文件（fetcher 在 `packages/aave-fetcher/src/` 中改动）
- `campaign_history` 表结构（保留长期归档）
- 前端 `formatters.ts` APY 计算逻辑（只算 `_isExpired !== true` 的）

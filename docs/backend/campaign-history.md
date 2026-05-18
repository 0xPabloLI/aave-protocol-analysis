# Campaign 历史保留方案

Last updated: 2026-05-17

## 背景

当前后端 API 只返回活跃 campaign：过期 campaign 在 root fetcher 层被过滤，不会到达内存快照，前端无法展示近期历史激励数据。本方案在不改动 root fetcher 的前提下，在后端层从上线后开始保留 campaign 历史。

Phase 1 目标：

1. **历史展示基础**：存储活跃 + 近期消失的 campaign，供后续统一历史数据 API 返回
2. **图表数据库基础**：预留 APR 观测表，但不在 Phase 1 设计图表页面或图表 API

## 核心策略

- **存所有进入活跃快照的 campaign**，UPSERT 去重，不 diff
- **只存不删**，数据永久保留；查询窗口由 API 层控制
- **逻辑完全在后端**，不改动 root fetcher（`src/` 下零改动）
- **显式状态列**：`expired_at` 表示后端检测到 campaign 不再出现在活跃快照的时间
- **上线后增量历史**：数据库只能从功能上线后开始积累；首次出现时必须仍在活跃快照中
- **为何不需要侵入 root fetcher**：root fetcher 继续负责过滤过期 campaign；后端持久化层只观察活跃快照成员关系。campaign 首次出现时 UPSERT 到 DB；消失后内存快照不再包含 -> cron 用 `last_seen_at` 标记 `expired_at`

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

-- 真实 APR 曲线基础。只追加观测点，不覆盖。
CREATE TABLE campaign_apr_observations (
  id              BIGSERIAL     PRIMARY KEY,
  observed_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  reserve_id      TEXT          NOT NULL,
  source          TEXT          NOT NULL,
  side            TEXT          NOT NULL,
  campaign_key    TEXT          NOT NULL,
  apr             DOUBLE PRECISION NOT NULL,    -- 比例值，不是百分值
  apr_data_hash   TEXT          NOT NULL,       -- APR 相关字段 hash，用于变化检测
  campaign_data   JSONB         NOT NULL
);

CREATE INDEX idx_campaign_apr_observations_series
  ON campaign_apr_observations (reserve_id, source, side, campaign_key, observed_at);

CREATE INDEX idx_campaign_apr_observations_latest_hash
  ON campaign_apr_observations (reserve_id, source, side, campaign_key, observed_at DESC);
```

### 列设计说明

| 列 | 用途 | 为何是外层列 |
|----|------|-------------|
| `reserve_id` | 关联 reserve，去重索引 | DB 查询过滤需要 |
| `source` | 激励源，去重索引 | DB 查询过滤需要 |
| `side` | supply / borrow / hold，去重索引 | DB 查询过滤需要 |
| `campaign_key` | 去重唯一键 | UPSERT ON CONFLICT 需要 |
| `campaign_data` | 完整快照（比例值），`JSON.stringify()` 直接存入 | 读-only，前端消费，放 JSONB |
| `first_seen_at` | 首次被后端看到的时间 | 历史展示和排障 |
| `last_seen_at` | 最后一次在活跃快照中出现 | 过期检测 + 排序 |
| `expired_at` | 后端检测到它不再出现在活跃快照中的时间 | API 状态过滤，避免只靠 JSONB 时间字段 |

> `campaign_data` 内的 `startDate` / `endDate` / `campaignStartedAt` / `campaignEndedAt` 等字段全部在 JSONB 中，前端自行读取展示，不需要外层冗余列。

### `expired_at` 和 `endDate` 不是同一件事

- `endDate` / `campaignEndedAt`：campaign 自己声明的业务结束时间，适合前端展示“活动原计划何时结束”
- `expired_at`：后端系统状态，表示“这个 campaign 已经不再出现在当前活跃快照中”
- root fetcher 通常会根据 `endDate` / `campaignEndedAt`、Merit 区块范围、上游状态等规则过滤；后端持久化层不重复实现这些业务规则，只看 campaign 是否仍在 root 产出的活跃快照里
- 正常情况下 `expired_at` 会接近 `endDate`，但不保证相等：上游可能提前取消、延期、短暂漏报，或 root 匹配规则变化导致 campaign 从活跃快照消失
- API 判断“当前快照是否仍活跃”应看 `expired_at IS NULL` 或当前内存快照 key 集合；展示活动原计划时间再看 `endDate`

## 内存快照中 7 个 campaign 数组 -> DB 映射

`persistCampaignHistory()` 遍历 `RuntimeReserveData` 的 campaign 数组，按固定映射写入：

| # | 数组字段 | source | side |
|---|---------|--------|------|
| 1 | `meritSupplys` | merit | supply |
| 2 | `meritBorrows` | merit | borrow |
| 3 | `merklSupplys` | merkl | supply |
| 4 | `merklBorrows` | merkl | borrow |
| 5 | `merklHolds` | merkl | hold |
| 6 | `brevisSupplys` | brevis | supply |
| 7 | `brevisBorrows` | brevis | borrow |

## campaign_data JSONB 结构

存内存快照中的原始形状（比例值），`JSON.stringify()` 直接存入 JSONB。API 响应时再走 `x100` 序列化，与 active campaign 完全一致。

### Merit

对应 `MeritAprEntry` 类型，直接序列化：

```json
{
  "apr": 0.0235,
  "selfApr": 0.01,
  "link": "https://...",
  "name": "Merit Round 42",
  "message": [],
  "startDate": "2025-05-01T00:00:00Z",
  "endDate": "2025-05-15T23:59:59Z",
  "lastRoundRewardUsd": 1500
}
```

### Merkl（单 breakdown 拆组的 CampaignGroup）

对应 `MerklCampaignBreakdown` 类型。从 `CampaignGroup` 中拆出单个 breakdown，保留所属 group 的 `link` / `name` / `message`：

```json
{
  "link": "https://...",
  "name": "Merkl Campaign",
  "message": "...",
  "breakdowns": [{
    "campaignApr": 0.018,
    "campaignStartedAt": "2025-05-01T00:00:00Z",
    "campaignEndedAt": "2025-05-20T00:00:00Z",
    "campaignId": "0xabc...",
    "campaignType": "DUTCH_AUCTION",
    "totalBudget": 50000,
    "aprCap": 0.05,
    "latestTvl": 1200000,
    "plannedDaily": 150
  }]
}
```

### Brevis（单 breakdown 拆组的 CampaignGroup）

对应 `BrevisCampaignBreakdown` 类型。与 Merkl 相同拆组逻辑，字段不同（无 `aprCap` / `plannedDaily` / `campaignType`）：

```json
{
  "link": "https://...",
  "name": "Brevis Campaign",
  "message": "...",
  "breakdowns": [{
    "campaignApr": 0.012,
    "campaignStartedAt": "2025-05-01T00:00:00Z",
    "campaignEndedAt": "2025-05-15T00:00:00Z",
    "campaignId": "0xdef...",
    "totalBudget": 30000,
    "latestTvl": 800000,
    "perUserRewardCapUsd": 500
  }]
}
```

> Merkl/Brevis 的 CampaignGroup 如果包含多个 breakdown，按单 breakdown 拆组存储：每个 breakdown 独立一行。`campaign_key` 取 breakdown 级别的标识，group 的 `link` / `name` / `message` 携带在 JSONB 内供前端渲染。

## 去重键 campaign_key 规则

| source | campaign_key | 来源 |
|--------|-------------|------|
| `merit` | `link::endDate` | Merit 无 campaignId，link + endDate 唯一 |
| `merkl` | `campaignId` | breakdown 中的 campaignId（必填） |
| `brevis` | `campaignId` 优先，无则 `hash(link,campaignStartedAt,campaignEndedAt)` | Brevis campaignId 可选 |

说明：
- 如果上游延期导致 `endDate` / `campaignEndedAt` 变化，fallback key 可能变化并产生新 row
- 有 `campaignId` 的来源优先用稳定 ID，减少延期或文案变化带来的重复

## Cron 操作流程

在现有 persist cron（每分钟 :20）中追加，保持“不删除历史”：

```text
persist cron tick
  1. 现有 market_snapshots + market_configs 写入

  2. campaign_history UPSERT
     - 遍历内存快照中所有 reserve 的 7 个 campaign 数组
     - INSERT ... ON CONFLICT (reserve_id, source, side, campaign_key)
       DO UPDATE SET
         campaign_data = EXCLUDED.campaign_data,
         last_seen_at = now(),
         expired_at = NULL

  3. 标记过期
     UPDATE campaign_history
     SET expired_at = now()
     WHERE expired_at IS NULL
       AND last_seen_at < now() - interval '2 min'

  4. APR observation append
     APR 相关字段变化时追加一行到 campaign_apr_observations
```

关键细节：
- 2 分钟阈值对齐 1 分钟 cron，给单次刷新失败留容错
- UPSERT 时复位 `expired_at = NULL`，campaign 延期或短暂漏报恢复后可重新变活跃
- `campaign_apr_observations` 不按每分钟无脑写入；只在 APR 或 APR 相关 `campaign_data` 变化时追加，避免长期数据量失控

## 数据流

```text
[root fetcher]                  [backend cron]
  过滤已过期 campaign              refreshMarketsSnapshot()
  现有逻辑不变                     -> 内存快照含活跃 campaign
        |                                  |
        v                                  v
  [内存快照 active only] -----> UPSERT campaign_history
                                SET campaign_data + last_seen_at + expired_at=NULL
                                      |
                                      v
                               markExpiredCampaigns()
                               2min 未出现 -> expired_at=now()
                                      |
                                      v
                              [campaign_history]
                              active + historical rows
                                      |
                         +------------+-------------+
                         |                          |
                 unified history API         campaign_apr_observations
                 route/shape TBD             future chart source
```

## API 查询窗口（展示策略，非存储策略）

推荐后续并入统一历史数据 API。具体 route/shape 等整体历史架构确定后再定，不在本方案中锁死为 campaign 专属 endpoint。

查询逻辑：

```sql
SELECT *
FROM campaign_history
WHERE (expired_at IS NULL OR expired_at > now() - interval '7 days')
  AND ($1::text IS NULL OR reserve_id = $1)
ORDER BY reserve_id, source, side, last_seen_at DESC;
```

- 活跃 campaign：`expired_at IS NULL`，始终返回
- 近期过期 campaign：`expired_at` 在窗口内，返回并带状态字段
- 窗口可按需调整为 30 天，纯查询参数变化
- 前端展示活动原始时间仍读 `campaign_data.endDate` / `campaignEndedAt`
- 不建议把 DB 查询耦合进 `/api/markets` 热路径；`/api/markets` 保持内存快照只读

## 代码改动范围

| 改动点 | 文件 | 变更 |
|--------|------|------|
| DB migration | `backend/migrations/` | 新增 `campaign_history` + `campaign_apr_observations` 表和索引 |
| UPSERT 写入 | `persistenceService.ts` | 新增 `persistCampaignHistory()`，UPSERT active campaigns |
| 过期标记 | `persistenceService.ts` | 新增 `markExpiredCampaigns()`，2 分钟阈值 |
| APR 观测 | `persistenceService.ts` | APR 相关字段变化时追加 `campaign_apr_observations` |
| cron 调度 | `updateScheduler.ts` | persist cron 中调用 history 写入 + 过期标记 + APR 观测 |
| 统一历史 API（后续） | 待整体历史架构确定 | 查询 DB 返回历史 campaign，不改 `/api/markets` 热路径 |

不改动：root `src/` 下任何文件、`RuntimeReserveData` 类型、fetcher 过滤逻辑。

## APY 图表预留

Phase 1 不实现 APY 图表页面，也不承诺图表 API contract。

如果目标只是展示 campaign 存续区间，`campaign_history.first_seen_at` / `last_seen_at` / `expired_at` 已足够。

如果目标是绘制 APR 变化曲线，必须读取 `campaign_apr_observations`，因为 `campaign_history` 是 UPSERT 最新状态表，会覆盖旧 APR，不能单独还原时间序列。

观测表写入策略：

- 每个 active campaign 提取 canonical APR：Merit 用 `apr`；Merkl/Brevis 用单 breakdown 的 `campaignApr`
- 对同一 `(reserve_id, source, side, campaign_key)` 计算 APR 相关 hash
- 与最新一条 observation 的 `apr_data_hash` 相同则不写；变化时追加一行，`observed_at = now()`
- 后续图表 endpoint 再根据页面设计决定采样、聚合、窗口和返回结构

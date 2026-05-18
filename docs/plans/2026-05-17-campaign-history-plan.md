# Campaign 历史保留方案

Last updated: 2026-05-17

## 背景

当前后端 API 只返回活跃 campaign——过期 campaign 在 root fetcher 层被过滤，不会到达内存快照，前端无法展示历史激励数据。本方案在不改动 root fetcher 的前提下，在后端层保留所有 campaign 历史，支持：

1. **API 展示**：合并活跃 + 过期 campaign，前端按 `campaign_data.endDate` 自行区分渲染
2. **APY 图表**：按 reserve + source 拉时间序列，绘制激励 APR 变化曲线

## 核心策略

- **存所有 campaign**，UPSERT 去重，不 diff
- **只存不删**，数据永久保留；查询窗口（7 天 / 30 天）由 API 层控制
- **逻辑完全在后端**，不改动 root fetcher（`src/` 下零改动）
- 过期检测：`last_seen_at` 超过 2 分钟未更新 → 设 `expired_at`（活跃时 `expired_at = NULL`）
- **为何不需要侵入 root fetcher**：campaign 首次出现时是活跃的 → UPSERT 到 DB；消失后内存快照不再包含 → cron 检测到 `last_seen_at` 变陈旧 → 标记过期。数据始终在 DB 中保留，无需在过滤前拦截

## DB Schema

```sql
CREATE TABLE campaign_history (
  id              BIGSERIAL     PRIMARY KEY,
  reserve_id      TEXT          NOT NULL,
  source          TEXT          NOT NULL,       -- 'merit' | 'merkl' | 'brevis'
  side            TEXT          NOT NULL,       -- 'supply' | 'borrow' | 'hold'
  campaign_key    TEXT          NOT NULL,       -- 去重键
  campaign_data   JSONB         NOT NULL,       -- 完整 campaign 快照（比例值，非百分值）
  first_seen_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  expired_at      TIMESTAMPTZ                   -- NULL = 活跃，有值 = 过期 & 检测时间
);

-- 去重：同一 reserve + source + side + campaign_key 只一行
CREATE UNIQUE INDEX idx_campaign_history_dedup
  ON campaign_history (reserve_id, source, side, campaign_key);

-- 过期查询：API 窗口过滤 + 活跃 campaign 始终返回
CREATE INDEX idx_campaign_history_expired_at
  ON campaign_history (expired_at);

-- APY 图表查询：按 reserve + source 拉时间序列
CREATE INDEX idx_campaign_history_reserve_source
  ON campaign_history (reserve_id, source, last_seen_at);
```

### 列设计说明

| 列 | 用途 | 说明 |
|----|------|------|
| `reserve_id` | 关联 reserve | — |
| `source` | 激励源，合并 API 响应时直接推入对应数组 | 可从 data 推导，保留列便于索引和查询 |
| `side` | supply / borrow / hold | 同上 |
| `campaign_key` | 去重唯一键 | — |
| `campaign_data` | 完整快照（比例值），`JSON.stringify()` 直接存入 | API 响应时走 `×100` 序列化 |
| `first_seen_at` | campaign 首次出现时间，图表用 | — |
| `last_seen_at` | 最后一次在活跃快照中出现，过期检测依据 | — |
| `expired_at` | `NULL` = 活跃；有值 = DB 层检测到过期的时间 | 查询窗口过滤用，B-tree 索引避免 JSONB 提取 |

> **`expired_at` 与 `campaign_data.endDate` 的区别**：`endDate` 是 campaign 声明的结束时间（前端展示用），`expired_at` 是 cron 实际检测到不再出现在活跃快照的时间（DB 查询窗口用）。两者相差约 2 分钟。

## 内存快照中 7 个 campaign 数组 → DB 映射

`persistCampaignHistory()` 遍历 `RuntimeReserveData` 的所有 campaign 数组，按固定映射写入：

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

存内存快照中的原始形状（**比例值**），`JSON.stringify()` 直接存入 JSONB。API 响应时走 `×100` 序列化，与 active campaign 完全一致。

### Merit

对应 `MeritAprEntry` 类型，直接序列化：

```json
{
  "apr": 0.0235,
  "selfApr": 0.01,
  "link": "https://...",
  "name": "Merit Round 42",
  "message": [...],
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

对应 `BrevisCampaignBreakdown` 类型。与 Merkl 相同拆组逻辑，但字段不同（无 `aprCap` / `plannedDaily` / `campaignType`）：

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

> Merkl/Brevis 的 CampaignGroup 如果包含多个 breakdown，按**单 breakdown 拆组**存储——每个 breakdown 独立一行。`campaign_key` 取 breakdown 级别的标识，group 的 `link` / `name` / `message` 携带在 JSONB 内供前端渲染。

## 去重键 campaign_key 规则

| source | campaign_key | 来源 |
|--------|-------------|------|
| `merit` | `link::endDate` | Merit 无 campaignId，link + endDate 唯一 |
| `merkl` | `campaignId` | breakdown 中的 campaignId（必填） |
| `brevis` | `campaignId` 优先，无则 `hash(link,startDate,endDate)` | Brevis campaignId 可选 |

## Cron 操作流程

在现有 persist cron（每分钟 :20）中追加两步，**不做删除**：

```
┌─ persist cron tick ────────────────────────────────┐
│                                                     │
│  [现有] market_snapshots + market_configs 写入      │
│                                                     │
│  [新增] campaign_history 维护：                      │
│                                                     │
│  Step 1: UPSERT 活跃 campaign                       │
│    遍历内存快照中所有 reserve 的 7 个 campaign 数组  │
│    INSERT ... ON CONFLICT (reserve_id, source,       │
│      side, campaign_key)                            │
│    DO UPDATE SET                                     │
│      campaign_data = EXCLUDED.campaign_data,         │
│      last_seen_at   = now(),                         │
│      expired_at     = NULL                           │
│                                                     │
│  Step 2: 标记过期                                    │
│    UPDATE campaign_history                           │
│    SET expired_at = now()                            │
│    WHERE expired_at IS NULL                          │
│      AND last_seen_at < now() - interval '2 min'     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**关键细节：**
- **2 分钟阈值**：对齐 cron 1 分钟频率，给单次失败留容错
- **UPSERT 复位 `expired_at = NULL`**：若 campaign 重新出现在活跃快照中（如 Merkl campaign 延长了 `campaignEndedAt`，或 persist cron 故障恢复后），自动恢复为活跃状态
- **调用顺序**：Step 1（UPSERT）→ Step 2（标记过期），确保本周期所有活跃 campaign 的 `last_seen_at` 先被刷新，再检测过期

## 数据流

```
[root fetcher]                    [backend cron]
     │                                │
     │ 过滤已过期 campaign              │ refreshMarketsSnapshot()
     │ (现有逻辑不变)                   │ → 内存快照含活跃 campaign
     ▼                                ▼
[内存快照] ──────────────────────►  Step 1: UPSERT 活跃 → DB
  (active only)                  (campaign_data + last_seen_at + expired_at=NULL)
                                        │
                                   Step 2: 标记过期
                                   (2min 未出现 → expired_at=now())
                                        │
                                        ▼
                                 [campaign_history 表]
                                  active + expired 共存
                                  永久保留，不清理
                                        │
                           ┌────────────┴────────────┐
                           │                         │
                      API 响应合并               APY 图表数据源
               (expired_at=NULL→活跃,          (时间序列查询)
                frontend用endDate渲染)
```

## API 查询窗口（展示策略，非存储策略）

```sql
SELECT * FROM campaign_history
WHERE expired_at IS NULL                          -- 活跃 campaign，始终返回
   OR expired_at > now() - interval '7 days';     -- 7 天内过期
```

- 活跃 campaign（`expired_at IS NULL`）无窗口限制
- 过期 campaign 默认返回 7 天内，可按需调整为 30 天
- 前端通过 `campaign_data.endDate` / `campaignEndedAt` 判断是否已过期，自行渲染「已结束」标识

## 实现任务清单

### Phase 1：DB + 写入（后端层）

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 1 | DB migration | `backend/migrations/` | 新增 `campaign_history` 表 + 索引 |
| 2 | UPSERT 写入 | `persistenceService.ts` | 新增 `persistCampaignHistory()`，遍历 7 个 campaign 数组 |
| 3 | 过期标记 | `persistenceService.ts` | 新增 `markExpiredCampaigns()`，2 分钟阈值 |
| 4 | cron 集成 | `updateScheduler.ts` | persist cron 中调用 Step 1 + Step 2 |
| 5 | 测试 | `tests/` | 验证 UPSERT 去重、过期标记、续期复位 |

### Phase 2：API 合并（后续）

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 6 | 查询过期 campaign | `persistenceService.ts` | 新增 `getExpiredCampaigns(reserveId, windowDays)` |
| 7 | 合并到 API 响应 | `marketsApiSerialize.ts` | 活跃 + 窗口内过期，加 `expiredAt` 字段 |
| 8 | 类型扩展 | `backend/src/types/` | campaign 类型加 `expiredAt?: string` |
| 9 | API 测试 | `tests/` | 验证合并逻辑、窗口过滤 |

**不改动**：root `src/` 下任何文件、`RuntimeReserveData` 类型、fetcher 过滤逻辑。

## APY 图表预留

- `idx_campaign_history_reserve_source` → 按 reserve 拉某 source 的历史 APR 序列
- `first_seen_at` + `last_seen_at` → campaign 存活区间，可绘制阶梯图
- `campaign_data` 中的 `campaignApr` → 直接取值
- Merkl Dutch auction 衰减：同一 `campaign_key` 的 `campaign_data` 被 UPSERT 更新，每次 cron tick 记录当时 APR
- 若需细粒度衰减曲线（每分钟一个数据点），后续可加 `campaign_apr_snapshots` 表，当前方案不含

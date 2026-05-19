# Change-Detection + Incentive 归一化设计

Last updated: 2026-05-19

> **关联文档**：
> - `docs/backend/campaign-history.md` — campaign 归档方案（本设计替代其部分内容）
> - `docs/backend/reserve-snapshots.md` — `/api/markets/history` API（受本设计影响，需同步更新）

## 1. 动机

当前 `market_snapshots` 每 1 分钟无条件写入 354 reserves 的所有列，即使值未变化。1.7M 行占 379MB，`oracle_prices` 2.4M 行占 266MB。两张表合计 645MB，其中大部分是重复数据。

同时 `campaign_history` 和 `campaign_apr_observations` 与 `market_snapshots.incentive_details` 存在数据重叠，且 Phase 2 需要 per-campaign APR 信息，当前 `incentive_details` 只有聚合级。

## 2. 设计决策

| 决策 | 结论 | 理由 |
|------|------|------|
| change-detection 模式 | `market_snapshots` 行级 + `incentive_details` 列级 NULL | 行级简单省 50-70%；incentive 变化频率远低于 price/apy，列级 NULL 避免重写 JSONB |
| per-campaign APR 存放 | 内联在 `incentive_details` JSONB | 同一 tick 同一 reserve 的数据，不分表；减少 JOIN |
| 聚合 incentive APR 列 | 删除 `supply_incentives_apr` / `borrow_incentives_apr` | 冗余，可 `SUM(per-campaign apr)` 推导 |
| `campaign_history` | 删除 | 信息可从 `incentive_details` 时间序列推导 |
| `campaign_apr_observations` | 删除 | 被 `incentive_details` 时间序列替代 |
| Recently ended campaign 来源 | 上游 LIVE opportunities 不过滤近期过期 | Merkl LIVE opp 内含刚过期 breakdown；需按 (opportunity, campaignType) 去重只保留最近一条过期 |

## 3. 表变更

### 3.1 `market_snapshots` — 改动

| 变更 | 说明 |
|------|------|
| 删除 `supply_incentives_apr` | 冗余，前端/后端从 `incentive_details` SUM 推导 |
| 删除 `borrow_incentives_apr` | 同上 |
| `incentive_details` 结构加厚 | 从聚合级 → per-campaign 级（见 §3.1.1） |
| `incentive_details` 列级 change-detection | 不变时写 NULL，变时写完整 JSONB |
| 行级 change-detection | 所有其他列：任何变 → 写整行；全不变 → 跳过 INSERT |

#### 3.1.1 `incentive_details` JSONB 新结构

```json
{
  "meritSupply": [
    { "key": "link::endDate", "apr": 2.35, "name": "Merit Round 42", "endDate": "2026-05-07", "link": "https://..." }
  ],
  "meritBorrow": [
    { "key": "link::endDate", "apr": 1.2, "name": "Merit Round 42", "endDate": "2026-05-07", "link": "https://..." }
  ],
  "merklSupply": [
    { "key": "0xabc...", "apr": 1.8, "type": "DUTCH_AUCTION", "endDate": "2026-05-01", "link": "https://...", "name": "..." }
  ],
  "merklBorrow": [...],
  "merklHold": [...],
  "brevisSupply": [
    { "key": "0xdef...", "apr": 1.2, "startDate": "2025-08-13", "endDate": "2026-08-08", "link": "https://..." }
  ],
  "brevisBorrow": [...]
}
```

每个数组条目含：
- `key`：campaign 去重键（同 `campaign_key` 规则：merit=`link::endDate`，merkl=`campaignId`，brevis=`campaignId` 或 hash）
- `apr`：百分值（已 ×100）
- `endDate` / `startDate`：campaign 声明的时间
- `link` / `name` / `message`：展示用元数据
- `_isExpired`：可选，`true` 表示近期过期（endDate < now 但仍在上游响应中）

#### 3.1.2 写入逻辑

```
[cron tick :20]
  for each reserve:
    hash_full = hash(price, apy, util, liquidity, borrowed, supplied, deficit)
    hash_incentive = hash(incentive_details)
    
    if hash_full == lastFullHash AND hash_incentive == lastIncentiveHash:
      continue  // 全不变，跳过
    
    INSERT INTO market_snapshots (
      snapshot_ts, reserve_id,
      token_price       = hash_full 变了 ? price : NULL,
      supply_apy        = hash_full 变了 ? apy : NULL,
      borrow_apy        = hash_full 变了 ? apy : NULL,
      utilization_pct   = hash_full 变了 ? util : NULL,
      liquidity         = hash_full 变了 ? val : NULL,
      borrowed          = hash_full 变了 ? val : NULL,
      supplied          = hash_full 变了 ? val : NULL,
      deficit           = hash_full 变了 ? val : NULL,
      incentive_details = hash_incentive 变了 ? details : NULL
    )
```

#### 3.1.3 查询逻辑（null-fill）

```sql
-- 查 reserve APY + incentive 趋势
SELECT
  snapshot_ts,
  COALESCE(supply_apy,  LAG(supply_apy)  IGNORE NULLS OVER w)  AS supply_apy,
  COALESCE(borrow_apy, LAG(borrow_apy) IGNORE NULLS OVER w) AS borrow_apy,
  COALESCE(token_price, LAG(token_price) IGNORE NULLS OVER w) AS token_price,
  COALESCE(incentive_details, LAG(incentive_details) IGNORE NULLS OVER w) AS incentive_details
FROM market_snapshots
WHERE reserve_id = $1 AND snapshot_ts BETWEEN $2 AND $3
WINDOW w AS (PARTITION BY reserve_id ORDER BY snapshot_ts ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
ORDER BY snapshot_ts;
```

```sql
-- 查单 campaign APR 曲线（从 incentive_details JSONB 提取）
SELECT
  snapshot_ts,
  (campaign->>'apr')::numeric AS apr
FROM (
  SELECT snapshot_ts,
    COALESCE(incentive_details, LAG(incentive_details) IGNORE NULLS OVER w) AS details
  FROM market_snapshots
  WHERE reserve_id = $1 AND snapshot_ts BETWEEN $2 AND $3
  WINDOW w AS (PARTITION BY reserve_id ORDER BY snapshot_ts ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
) sub, jsonb_array_elements(details->'merklSupply') campaign
WHERE campaign->>'key' = $2
ORDER BY snapshot_ts;
```

```sql
-- 查某时刻 supply 总 incentive APR
SELECT SUM((campaign->>'apr')::numeric) AS supply_incentives_apr
FROM (
  SELECT COALESCE(incentive_details, LAG(incentive_details) IGNORE NULLS OVER w) AS details
  FROM market_snapshots
  WHERE reserve_id = $1
  WINDOW w AS (PARTITION BY reserve_id ORDER BY snapshot_ts DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
  LIMIT 1
) sub, jsonb_array_elements(details->'merklSupply') campaign;
```

### 3.2 `market_configs` — 行级 change-detection

配置极少变（rate model、reserve factor），行级 change-detection 省 95%+。写入逻辑同上（hash 比较，全不变跳过）。

### 3.3 `oracle_prices` — 行级 change-detection

大部分 tick 价格不变。行级 change-detection 省 50-70%。

### 3.4 删除的表

| 表 | 行数 | 大小 | 替代 |
|----|------|------|------|
| `campaign_history` | 29 | 120KB | `incentive_details` 时间序列可推导所有信息（campaign_key、快照、首次/末次出现时间） |
| `campaign_apr_observations` | 1.3K | 1MB | 同上 |

Migration：
```sql
DROP TABLE IF EXISTS campaign_apr_observations;
DROP TABLE IF EXISTS campaign_history;
```

### 3.5 不变的表

| 表 | 理由 |
|----|------|
| `oracle_source_configs` | 几乎不变，UPSERT 去重已足够 |
| `gsc_daily` | 极低频 SEO 数据，每天一行 |
| `semrush_snapshots` | 极低频 |
| `schema_migrations` | DDL 追踪，每次 migration 一行 |

## 4. Recently Ended Campaign 实现

### 数据源

Merkl LIVE opportunities 中包含已过期 campaign（实测 26 个 LIVE opp 含 121 条过期 breakdown）。但不能全量返回——大部分是周期性 Dutch auction 历史，APR=0，无展示价值。

### 过滤策略

对每个 (opportunity, campaignType)，只保留**最近一条过期的** campaign：

```ts
function filterRecentExpired(breakdowns: MerklCampaignBreakdown[]): MerklCampaignBreakdown[] {
  const now = new Date();
  const active = breakdowns.filter(b => !b.campaignEndedAt || new Date(b.campaignEndedAt) >= now);
  const expired = breakdowns.filter(b => b.campaignEndedAt && new Date(b.campaignEndedAt) < now);
  
  // 按 campaignType 分组，每组只保留 endDate 最大的
  const byType = new Map<string, MerklCampaignBreakdown>();
  for (const b of expired) {
    const type = b.campaignType ?? 'UNKNOWN';
    const existing = byType.get(type);
    if (!existing || new Date(b.campaignEndedAt) > new Date(existing.campaignEndedAt)) {
      byType.set(type, b);
    }
  }
  
  return [...active, ...byType.values()];
}
```

121 条 → ~25 条（每个有过期 campaign 的 opportunity 保留 1 条/类型）。

### fetcher 改动

| 文件 | 改动 |
|------|------|
| `merkl-api.ts` | `filterExpiredCampaigns()` → `filterRecentExpiredCampaigns()`，保留最近一条过期 |
| `merit-api.ts` | `isMeritCampaignExpired()` → 改为保留最近一条过期的 merit round |
| `brevis-api.ts` | Brevis 过滤 → 同理保留最近一条过期 |

### 序列化

`serializeReserveForApi()` 中：endDate < now 的 campaign 标记 `_isExpired: true`，APY 计算排除 `_isExpired` 条目。

## 5. 空间节省估算

| 表 | 现有 | 优化后 | 节省 |
|----|------|--------|------|
| `market_snapshots` | 379MB | ~100MB | 74% |
| `market_configs` | 53MB | ~2MB | 96% |
| `oracle_prices` | 266MB | ~80MB | 70% |
| `campaign_history` | 120KB | 0 | 100% |
| `campaign_apr_observations` | 1MB | 0 | 100% |
| **总计** | **~700MB** | **~182MB** | **74%** |

## 6. 实施步骤

| # | 任务 | 文件 |
|---|------|------|
| 1 | `incentive_details` 结构加厚 | `persistenceService.ts` `buildIncentiveDetails()` |
| 2 | 删除 `supply_incentives_apr` / `borrow_incentives_apr` 写入 | `persistenceService.ts` |
| 3 | 行级 change-detection 写入 | `persistenceService.ts` `buildSnapshotRow()` + 写入逻辑 |
| 4 | `incentive_details` 列级 NULL | 同上 |
| 5 | Migration: DROP 两表 + DROP 两列 | `011_*.sql` |
| 6 | fetcher: `filterRecentExpiredCampaigns()` | `merkl-api.ts` / `merit-api.ts` / `brevis-api.ts` |
| 7 | 序列化: `_isExpired` 标记 | `marketsApiSerialize.ts` |
| 8 | API 查询: null-fill + APR 曲线 | `persistenceService.ts` + route |
| 9 | 测试 | `tests/` |
| 10 | `market_configs` / `oracle_prices` change-detection | 同理 |

## 7. 不改动

- `/api/markets` 热路径的响应结构（只是 `incentive_details` 内容更丰富）
- 前端 `formatters.ts` APY 计算逻辑（排除 `_isExpired` 条目）
- root `src/` 下任何文件

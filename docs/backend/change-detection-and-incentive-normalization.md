# Change-Detection + Incentive 归一化设计

Last updated: 2026-05-19

> **关联文档**：
> - `docs/backend/campaign-history.md` — campaign 归档方案（本设计替代其部分内容）
> - `docs/backend/reserve-snapshots.md` — `/api/markets/history` API（受本设计影响，需同步更新）

> **现状说明**：本文档同时描述了**已实施**与**待实施**部分。文末 §6 标注每个任务的当前状态。

## 1. 动机

> 数字快照截至 2026-05-19，DB 实际占用以 `pg_total_relation_size` 为准。
>
> 复核命令：
> ```sql
> SELECT relname,
>        pg_size_pretty(pg_total_relation_size(relid)) AS total,
>        n_live_tup AS rows
> FROM pg_stat_user_tables
> ORDER BY pg_total_relation_size(relid) DESC;
> ```

当前快照（5 min cron 周期 × 354 reserves）：

| 表 | 大小 | 行数 | 备注 |
|----|------|------|------|
| `market_snapshots` | ~379 MB | ~1.7 M | 行级 hash dedup **已在跑**（[persistenceService.ts L229-258](file:///Users/pabloli/Documents/code/aave-protocol-analysis/backend/src/services/persistenceService.ts#L229-L258)）。incentive_details 每次写完整 JSONB |
| `oracle_prices` | ~266 MB | ~2.4 M | 行级 hash dedup **已在跑**（[L494-538](file:///Users/pabloli/Documents/code/aave-protocol-analysis/backend/src/services/persistenceService.ts#L494-L538)） |
| `market_configs` | ~53 MB | ? | 行级 hash dedup **已在跑**（[L273-302](file:///Users/pabloli/Documents/code/aave-protocol-analysis/backend/src/services/persistenceService.ts#L273-L302)） |
| `campaign_history` | ~120 KB | 29 | UPSERT, 仅 last_seen_at 滚动更新 |
| `campaign_apr_observations` | ~1 MB | 1.3 K | APR change-point 时序 |

剩余冗余的主要来源：
- `market_snapshots.incentive_details` 仍是聚合级（per-side），无法读出 per-campaign APR 曲线 → Phase 2 前端需要的 campaign 详情查不到，必须保留独立的 `campaign_apr_observations` 表。
- `supply_incentives_apr` / `borrow_incentives_apr` 两列与 `incentive_details` 内容重叠（可由 SUM 推导）。
- `campaign_history` / `campaign_apr_observations` 与一份富化后的 `incentive_details` 时间序列功能等价。

## 2. 设计决策

| 决策 | 结论 | 理由 |
|------|------|------|
| `market_snapshots` 行级 change-detection | **已实施**（保留） | 内存 hash map 跨 tick 比较；命中率 90%+ |
| `market_configs` / `oracle_prices` 行级 change-detection | **已实施**（保留） | 同上 |
| `incentive_details` 列级 change-detection | **待评估**，不默认采用 | per-campaign APR 在 Merkl Dutch auction 下每 tick 都会变，列级 NULL 命中率低；建议先测真实命中率再决定（见 §7） |
| per-campaign APR 存放 | 内联在 `incentive_details` JSONB | 同一 tick 同一 reserve 的数据；减少跨表 JOIN |
| 聚合 incentive APR 列 | 删除 `supply_incentives_apr` / `borrow_incentives_apr` | 冗余，可由新 JSONB SUM 推导 |
| `campaign_history` | 删除 | first/last_seen_at 可由 `incentive_details` 时间序列推导（见 §3.4） |
| `campaign_apr_observations` | 删除 | APR 时间序列由 `incentive_details` JSONB 提取（见 §3.4） |
| `_isExpired` 标志 | 序列化时动态计算，**不写 JSONB** | endDate 是固定值，过期判定取决于当前时间；写入时冻结会导致回放错误 |
| Recently ended campaign 来源 | 上游 LIVE opportunities 不过滤近期过期 | Merkl LIVE opp 内含刚过期 breakdown；按 (opportunity, campaignType) 去重只保留最近一条过期 |

## 3. 表变更

### 3.1 `market_snapshots`

#### 3.1.1 列变更

| 变更 | 说明 | 状态 |
|------|------|------|
| 删除 `supply_incentives_apr` | 冗余，前端/后端从 `incentive_details` SUM 推导 | 待实施 |
| 删除 `borrow_incentives_apr` | 同上 | 待实施 |
| `incentive_details` 结构加厚 | 从聚合级 → per-campaign 级（见 §3.1.2） | 待实施 |
| 行级 change-detection | 任何列变 → 写整行；全不变 → 跳过 | **已实施** |
| `incentive_details` 列级 NULL | 仅 incentive 变时写整行其余 NULL；非 incentive 变时写整行 incentive NULL | **待决策**（见 §7） |

#### 3.1.2 `incentive_details` JSONB 新结构

字段命名**与 `RuntimeReserveData` 保持一致**（带 s），便于上下游对齐：

```json
{
  "legacySupply": [0.012, 0.003],
  "legacyBorrow": [],
  "meritSupplys": [
    {
      "key": "https://app.merit.fi/...::2026-05-07",
      "apr": 0.0235,
      "name": "Merit Round 42",
      "endDate": "2026-05-07",
      "link": "https://..."
    }
  ],
  "meritBorrows": [],
  "merklSupplys": [
    {
      "groupId": "merkl-opp-0xabc",
      "link": "https://merkl.angle.money/...",
      "name": "Merkl Dutch Auction",
      "message": null,
      "breakdowns": [
        {
          "key": "0xabc...campaignId",
          "apr": 0.018,
          "type": "DUTCH_AUCTION",
          "endDate": "2026-05-01",
          "startDate": "2026-04-01"
        }
      ]
    }
  ],
  "merklBorrows": [],
  "merklHolds": [],
  "brevisSupplys": [
    {
      "groupId": "brevis-...",
      "link": "https://brevis.network/...",
      "breakdowns": [
        {
          "key": "0xdef...",
          "apr": 0.012,
          "startDate": "2025-08-13",
          "endDate": "2026-08-08"
        }
      ]
    }
  ],
  "brevisBorrows": []
}
```

字段语义：
- `key`：去重键。规则与 [`computeCampaignKey`](file:///Users/pabloli/Documents/code/aave-protocol-analysis/backend/src/services/persistenceService.ts#L49-L69) 相同（merit=`link::endDate`，merkl=`campaignId`，brevis=`campaignId` 或 hash）。
- `groupId`：merkl/brevis 同一 reserve 下多个 opportunity 的隔离键（来自上游 group 标识；若上游无显式 id，用 `hash(link)` 兜底）。
- `apr`：**比例值**（0.0235 = 2.35%），与 `RuntimeReserveData.meritSupplys[].apr` 单位一致。前端展示时再 ×100。
- `endDate` / `startDate`：campaign 声明的时间（ISO 8601）。
- `link` / `name` / `message`：group 级展示元数据。
- `_isExpired`：**不持久化**；序列化时按 `now() > endDate` 动态计算（见 §4）。

> **保留 legacy 字段的原因**：[aggregateIncentivesApr](file:///Users/pabloli/Documents/code/aave-protocol-analysis/backend/src/services/persistenceService.ts#L604-L640) 当前同时累加 `legacy + merit + merkl + brevis`，若新 JSONB 不留 legacy 入口，DROP 聚合列后 legacy APR 会从 SUM 中消失。

#### 3.1.3 写入逻辑

行级 change-detection（已实现，保留）：

```ts
// 当前 persistenceService.ts L229-258 的行为
for each reserve:
  rowFullHash = sha256(JSON.stringify([price, apy, util, liquidity, ..., incentive_details_json]))
  if marketRowHashes.get(reserveId) === rowFullHash: continue
  // 否则整行写入，更新 hash map
```

**可选** 列级 NULL（待决策，仅在 §7 命中率测试通过后采用）：

```ts
for each reserve:
  hashFull = sha256(JSON.stringify([price, apy, util, liquidity, borrowed, supplied, deficit]))
  hashIncentive = sha256(JSON.stringify(incentive_details))
  
  prevFull = marketRowFullHashes.get(reserveId)
  prevIncentive = marketRowIncentiveHashes.get(reserveId)
  
  if hashFull === prevFull && hashIncentive === prevIncentive: continue  // 全不变，跳过
  
  INSERT INTO market_snapshots (
    snapshot_ts, reserve_id,
    token_price       = hashFull !== prevFull ? price : NULL,
    supply_apy        = hashFull !== prevFull ? apy : NULL,
    borrow_apy        = hashFull !== prevFull ? apy : NULL,
    utilization_pct   = hashFull !== prevFull ? util : NULL,
    liquidity         = hashFull !== prevFull ? val : NULL,
    borrowed          = hashFull !== prevFull ? val : NULL,
    supplied          = hashFull !== prevFull ? val : NULL,
    deficit           = hashFull !== prevFull ? val : NULL,
    incentive_details = hashIncentive !== prevIncentive ? details : NULL
  )
```

> **语义对齐**：行级 dedup 只在 `hashFull == prev && hashIncentive == prev` 时整体跳过；任意一组变化都会写一行，未变的列写 NULL。这与 §2 的"行级跳过 + 列级 NULL"一致。

#### 3.1.4 查询逻辑（PostgreSQL 兼容的 LOCF）

> **重要**：PostgreSQL（截至 17）**不支持 `LAG(... ) IGNORE NULLS`**，只有 Oracle / SQL Server / DuckDB 支持。下面的 SQL 模式均使用 PG 原生方案。

**模式 A：`array_agg(... FILTER ... )` + 末位提取**（适合一次性区间查询，无需扩展）：

```sql
-- 查 reserve APY + incentive 趋势，对 NULL 用上一个非 NULL 填充
WITH base AS (
  SELECT snapshot_ts, reserve_id,
         supply_apy, borrow_apy, token_price, incentive_details
  FROM market_snapshots
  WHERE reserve_id = $1
    AND snapshot_ts BETWEEN $2 AND $3
),
filled AS (
  SELECT snapshot_ts,
         (array_agg(supply_apy)        FILTER (WHERE supply_apy        IS NOT NULL) OVER w) AS supply_arr,
         (array_agg(borrow_apy)        FILTER (WHERE borrow_apy        IS NOT NULL) OVER w) AS borrow_arr,
         (array_agg(token_price)       FILTER (WHERE token_price       IS NOT NULL) OVER w) AS price_arr,
         (array_agg(incentive_details) FILTER (WHERE incentive_details IS NOT NULL) OVER w) AS det_arr
  FROM base
  WINDOW w AS (
    PARTITION BY reserve_id
    ORDER BY snapshot_ts
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  )
)
SELECT snapshot_ts,
       supply_arr[array_length(supply_arr, 1)]  AS supply_apy,
       borrow_arr[array_length(borrow_arr, 1)]  AS borrow_apy,
       price_arr[array_length(price_arr, 1)]    AS token_price,
       det_arr[array_length(det_arr, 1)]        AS incentive_details
FROM filled
ORDER BY snapshot_ts;
```

**模式 B：相关子查询 LATERAL**（适合点查询）：

```sql
-- 查指定时刻的有效快照（含已 LOCF 的列）
SELECT
  ms.snapshot_ts, ms.reserve_id,
  COALESCE(ms.supply_apy, (
    SELECT supply_apy FROM market_snapshots
    WHERE reserve_id = ms.reserve_id
      AND snapshot_ts <= ms.snapshot_ts
      AND supply_apy IS NOT NULL
    ORDER BY snapshot_ts DESC LIMIT 1
  )) AS supply_apy,
  COALESCE(ms.incentive_details, (
    SELECT incentive_details FROM market_snapshots
    WHERE reserve_id = ms.reserve_id
      AND snapshot_ts <= ms.snapshot_ts
      AND incentive_details IS NOT NULL
    ORDER BY snapshot_ts DESC LIMIT 1
  )) AS incentive_details
FROM market_snapshots ms
WHERE ms.reserve_id = $1 AND ms.snapshot_ts = $2;
```

**模式 C：plpgsql LOCF 函数 / 物化视图**（适合高频热查询）。

**查单 campaign APR 曲线**（基于模式 A 之上）：

```sql
WITH filled AS (
  -- 同模式 A：得到 (snapshot_ts, incentive_details) 已 LOCF
  ...
)
SELECT snapshot_ts,
       (campaign->>'apr')::numeric AS apr
FROM filled,
     jsonb_array_elements(incentive_details->'merklSupplys')  AS grp,
     jsonb_array_elements(grp->'breakdowns')                  AS campaign
WHERE campaign->>'key' = $4   -- $1=reserve_id, $2/$3=ts range, $4=campaign key
ORDER BY snapshot_ts;
```

**最近一次某 side 总 incentive APR**（聚合列删除后的等价 SUM）：

```sql
WITH latest AS (
  SELECT incentive_details
  FROM market_snapshots
  WHERE reserve_id = $1 AND incentive_details IS NOT NULL
  ORDER BY snapshot_ts DESC
  LIMIT 1
)
SELECT
  COALESCE((SELECT SUM(v::numeric) FROM jsonb_array_elements_text(incentive_details->'legacySupply') v), 0) * 100
  + COALESCE((SELECT SUM((m->>'apr')::numeric) FROM jsonb_array_elements(incentive_details->'meritSupplys') m), 0) * 100
  + COALESCE((SELECT SUM((c->>'apr')::numeric)
              FROM jsonb_array_elements(incentive_details->'merklSupplys') g,
                   jsonb_array_elements(g->'breakdowns') c), 0) * 100
  + COALESCE((SELECT SUM((c->>'apr')::numeric)
              FROM jsonb_array_elements(incentive_details->'brevisSupplys') g,
                   jsonb_array_elements(g->'breakdowns') c), 0) * 100
  AS supply_incentives_apr_pct
FROM latest;
```

> **性能注意**：删除 `supply_incentives_apr` 列后，`/api/markets` 热路径每次都要做上面这种 SUM 展开。建议在内存中缓存（marketsService 已有 in-memory snapshot），不要在请求路径做 JSONB 展开。

### 3.2 `market_configs` — 行级 change-detection

**已实施**。配置变更极少（rate model、reserve factor），行级命中率接近 100%。

### 3.3 `oracle_prices` — 行级 change-detection

**已实施**（[L494-538](file:///Users/pabloli/Documents/code/aave-protocol-analysis/backend/src/services/persistenceService.ts#L494-L538)）。

### 3.4 删除的表

| 表 | 行数 | 大小 | 替代方案 |
|----|------|------|---------|
| `campaign_history` | 29 | 120KB | 由 `incentive_details` 时间序列推导 first_seen / last_seen / 快照（见下方 SQL） |
| `campaign_apr_observations` | 1.3K | 1MB | 由 `incentive_details` 时间序列直接提取 APR change points |

> **删表动机不是节省空间**（合计 ~1MB），而是消除与 `incentive_details` 的功能重叠、减少 cron 写路径分支。

**`campaign_history` 等价 SQL**（按 reserve × source × side × campaign_key 聚合 first/last 出现时间）：

```sql
CREATE OR REPLACE VIEW v_campaign_history AS
WITH expanded AS (
  SELECT ms.reserve_id, ms.snapshot_ts,
         src.source, src.side,
         (entry->>'key')        AS campaign_key,
         entry                   AS campaign_data
  FROM market_snapshots ms
  CROSS JOIN LATERAL (
    VALUES
      ('merit', 'supply',  ms.incentive_details->'meritSupplys'),
      ('merit', 'borrow',  ms.incentive_details->'meritBorrows'),
      ('merkl', 'supply',  ms.incentive_details->'merklSupplys'),
      ('merkl', 'borrow',  ms.incentive_details->'merklBorrows'),
      ('merkl', 'hold',    ms.incentive_details->'merklHolds'),
      ('brevis','supply',  ms.incentive_details->'brevisSupplys'),
      ('brevis','borrow',  ms.incentive_details->'brevisBorrows')
  ) AS src(source, side, group_arr)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(group_arr, '[]'::jsonb)) AS grp
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN src.source = 'merit'
         THEN jsonb_build_array(grp)
         ELSE COALESCE(grp->'breakdowns', '[]'::jsonb)
    END
  ) AS entry
  WHERE ms.incentive_details IS NOT NULL
)
SELECT reserve_id, source, side, campaign_key,
       MIN(snapshot_ts) AS first_seen_at,
       MAX(snapshot_ts) AS last_seen_at,
       (array_agg(campaign_data ORDER BY snapshot_ts DESC))[1] AS latest_data
FROM expanded
GROUP BY reserve_id, source, side, campaign_key;
```

**`campaign_apr_observations` 等价 SQL**（APR change-point 序列）：

```sql
CREATE OR REPLACE VIEW v_campaign_apr_observations AS
SELECT reserve_id, source, side, campaign_key, snapshot_ts AS observed_at,
       (campaign_data->>'apr')::numeric AS apr
FROM (
  -- 同上 expanded CTE
  ...
) e
ORDER BY reserve_id, source, side, campaign_key, snapshot_ts;
```

> **回退路径**：DROP TABLE 前先 CREATE VIEW，在 staging 验证业务功能（campaign 详情、APR 曲线）不退化，再 DROP。

**Migration 顺序**（必须严格按序）：
1. 部署新 `incentive_details` JSONB schema 的写入代码（向后兼容：可同时写老列）。
2. 跑至少 1 个 cron tick（5min），验证新 JSONB 写入正常。
3. 部署读路径切到 `incentive_details`（前端 + `/api/markets`）。
4. 停写 `supply_incentives_apr` / `borrow_incentives_apr` / `campaign_history` / `campaign_apr_observations`。
5. Apply migration `011_*.sql`（DROP COLUMN + DROP TABLE）。
6. 监控 24h，无回退则结案。

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

对每个 (opportunity, campaignType)，只保留**最近一条过期**的 campaign：

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

### 序列化（`_isExpired` 在此动态计算）

```ts
// marketsApiSerialize.ts
function decorateExpired(details: IncentiveDetails, now: Date): SerializedIncentiveDetails {
  const isExpired = (endDate?: string) =>
    endDate ? new Date(endDate) < now : false;

  return {
    meritSupplys: details.meritSupplys?.map(m => ({ ...m, _isExpired: isExpired(m.endDate) })),
    // ... merkl / brevis 同理，遍历 breakdowns 标记
  };
}
```

APY 累加路径排除 `_isExpired === true` 的条目；前端展示路径用 `_isExpired` 决定 UI 状态。

> **关键约束**：`_isExpired` 是请求时计算的派生值，**永远不进入 DB**。回放历史快照时直接对历史时间点重算即可。

## 5. 空间节省估算

> 当前估算基于"行级 dedup 已上线后"的实际占用。复核命令见 §1。

| 表 | 现状 | 待优化项 | 主要驱动 |
|----|------|---------|---------|
| `market_snapshots` | ~379 MB | 删 2 列 + (可选)列级 NULL | 主要是 incentive_details JSONB 写入频次；删 2 列约省 5-10%，列级 NULL 收益依赖 §7 测试 |
| `market_configs` | ~53 MB | 无改动 | 行级 dedup 已是 96%+ 命中率 |
| `oracle_prices` | ~266 MB | 无改动 | 行级 dedup 已上线 |
| `campaign_history` | 120 KB | DROP | 1MB 级别，不是节省主因 |
| `campaign_apr_observations` | 1 MB | DROP | 同上 |

**预期总节省**：约 20–40 MB（删 2 列 + 删 2 表），相对总量影响很小。**本次设计的真正价值**是：
- per-campaign APR 入主表，消除独立 campaign 表；
- 读路径统一到 `incentive_details`，前端/后端不再维护双写一致性；
- 为未来 Phase 2 per-campaign 趋势 API 提供单一数据源。

## 6. 实施步骤

| # | 任务 | 文件 | 状态 |
|---|------|------|------|
| 0 | `market_snapshots` 行级 change-detection | `persistenceService.ts` L229-258 | ✅ 已实施 |
| 0 | `market_configs` 行级 change-detection | `persistenceService.ts` L273-302 | ✅ 已实施 |
| 0 | `oracle_prices` 行级 change-detection | `persistenceService.ts` L494-538 | ✅ 已实施 |
| 1 | `buildIncentiveDetails()` 改为 per-campaign 结构 | `persistenceService.ts` L637 | ✅ 已实施 (2026-05-20) |
| 2 | 停止写入 `supply_incentives_apr` / `borrow_incentives_apr` 两列（`MARKET_COLUMNS` 已移除） | `persistenceService.ts` L183-188 | ✅ 已实施 (2026-05-20) |
| 3 | `/api/markets` 改为从 `incentive_details` SUM 推导聚合 APR（`sumIncentiveAprFromDetails`） | `persistenceService.ts` L720-764 | ✅ 已实施 (2026-05-20) |
| 4 | 序列化时按 `now()` 计算 `_isExpired` 标志 | `marketsApiSerialize.ts` L13-19 | ✅ 已实施 (2026-05-20) |
| 5 | fetcher: `filterRecentExpiredCampaigns()` | `merkl-api.ts` / `merit-api.ts` / `brevis-api.ts` | ✅ 已实施 (2026-05-20) |
| 6 | 建 view: `v_campaign_history` / `v_campaign_apr_observations` | `migrations/011_*.sql` | 🟡 待实施 |
| 7 | Staging 验证 view 业务等价 | — | 🟡 待实施 |
| 8 | Migration: DROP 两列 + DROP 两表 | `migrations/012_*.sql` | ✅ 已实施 (migration 已存在) |
| 9 | API 查询: LOCF（PG 原生方案，见 §3.1.4） | `persistenceService.ts` + route | 🟡 待实施 |
| 10 | 单测 + e2e 测试 | `tests/` | ✅ 已实施 (2026-05-20) |
| 11 | （可选）`incentive_details` 列级 NULL | 同 §3.1.3 写入 | 🟡 待 §7 命中率测试 |

> **执行记录 (2026-05-20)**：
> - 任务 1-5：`buildIncentiveDetails()` 已产出 `PerCampaignIncentiveDetails` 结构；`MARKET_COLUMNS` 不再含 `supply_incentives_apr` / `borrow_incentives_apr`；`sumIncentiveAprFromDetails()` 实现内存 SUM 推导；`computeIsExpired()` 在序列化层动态计算；fetcher 已实现 recent-expired 过滤。
> - 任务 8：migration `012_drop_incentive_columns_and_campaign_tables.sql` 已存在。
> - 任务 10：集成测试（`buildSnapshotRow` 输出验证、`sumIncentiveAprFromDetails` 等价性、`computeIsExpired` 边界、`_isExpired` 不在 DB 输出）+ 性能测试（`buildIncentiveDetails < 1ms`、`sumIncentiveAprFromDetails < 0.5ms`、hash 正确性）已补充至现有测试文件。

## 7. 列级 NULL 命中率测试（决策点）

`incentive_details` 列级 NULL 模式的收益取决于"两次 tick 之间 incentive 真的没变"的频率。**Merkl Dutch auction APR 每 5min 都会变**，可能使命中率为 0。

**先测后做**：
```sql
-- 抓取最近 24h 内同 reserve 相邻两条 incentive_details 是否相同
WITH ranked AS (
  SELECT reserve_id, snapshot_ts, incentive_details,
         LAG(incentive_details) OVER (PARTITION BY reserve_id ORDER BY snapshot_ts) AS prev
  FROM market_snapshots
  WHERE snapshot_ts > NOW() - INTERVAL '24 hours'
    AND incentive_details IS NOT NULL
)
SELECT
  COUNT(*) FILTER (WHERE incentive_details = prev)::float / NULLIF(COUNT(*), 0) AS unchanged_ratio
FROM ranked
WHERE prev IS NOT NULL;
```

判定：
- `unchanged_ratio > 0.5` → 列级 NULL 有意义，实施。
- `unchanged_ratio < 0.2` → 列级 NULL 收益不抵增加的复杂度，**不实施**，仅保留行级 dedup。
- 介于之间 → 评估读路径复杂度（LOCF 成本）与省下的 JSONB 大小，再决定。

## 8. 不改动

- `/api/markets` 热路径的响应结构（仅 `incentive_details` 内容更丰富，新增 per-campaign 字段）
- 前端 `formatters.ts` APY 计算逻辑（排除 `_isExpired === true` 条目，已是现状）
- root `src/` 下任何文件
- `oracle_source_configs` / `gsc_daily` / `semrush_snapshots` / `schema_migrations`

## 9. 改动摘要 vs 原文档

| 原文档 | 修正 |
|--------|------|
| 用 `LAG(...) IGNORE NULLS`（PG 不支持） | 改为 `array_agg FILTER` / 相关子查询 / 物化视图三种 PG 原生方案 |
| 把行级 change-detection 列为"待办" | 标注为"已实施"，重新核算待办收益 |
| `_isExpired` 写入 JSONB | 改为序列化时动态计算 |
| JSONB 字段名 `meritSupply / merklSupply ...`（无 s） | 对齐 `RuntimeReserveData.meritSupplys / merklSupplys ...`（带 s） |
| 新 JSONB 丢失 legacy incentives | 显式保留 `legacySupply / legacyBorrow` |
| 单 placeholder `$2` 在 SQL 中重复使用 | 修正占位符编号 |
| 列级 NULL 默认采用 | 标为"待决策"，先做 §7 命中率测试 |
| 估算 74% 节省（基于已 dedup 之前的数据） | 修正为 20–40 MB 增量节省，明确"真正价值是读路径统一" |
| 缺 migration 顺序 | §3.4 给出 6 步顺序与停写→建 view→DROP 的安全路径 |
| 删表声明 100% 节省（误导） | 改为强调"删表是消除功能重叠，不是为节省空间" |

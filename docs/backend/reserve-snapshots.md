# AAV-344 后端：Reserve Snapshots 历史 API

> **关联文档**：
> - `docs/backend/change-detection-and-incentive-normalization.md` — change-detection + incentive 归一化设计，影响本表 schema（删除 `supply_incentives_apr` / `borrow_incentives_apr` 列，`incentive_details` 加厚到 per-campaign 级别）
> - `docs/backend/campaign-history.md` — 已被替代，参考新设计文档

## 1. 目标
为前端历史趋势展示暴露查询 API。**不需要新建表**——直接复用已有 `market_snapshots` 表（每次 cron 已写入全量快照，含预聚合 incentive APR）。

## 2. 数据源：已有 `market_snapshots` 表

### 2.1 当前 schema（经 migration 007 重命名后）

```sql
-- 关键列（完整列见 001_init_persistence.sql + 007_rename_reserve_columns.sql）
market_snapshots (
  id                      BIGSERIAL PRIMARY KEY,
  snapshot_ts             TIMESTAMPTZ NOT NULL,
  reserve_id              TEXT        NOT NULL,
  chain_id                INTEGER     NOT NULL,
  chain_name              TEXT        NOT NULL,
  market_name             TEXT        NOT NULL,
  token_symbol            TEXT        NOT NULL,
  token_name              TEXT        NOT NULL,
  token_address           TEXT        NOT NULL,
  decimals                INTEGER,
  token_price             NUMERIC(24, 8),
  supply_apy              NUMERIC(12, 6),
  borrow_apy              NUMERIC(12, 6),
  utilization_pct         NUMERIC(8, 4),
  liquidity               NUMERIC(40, 0),      -- 原 available_liquidity
  borrowed                 NUMERIC(40, 0),      -- 原 total_variable_debt
  supplied                 NUMERIC(40, 0),      -- 原 reserve_size
  deficit                 NUMERIC(40, 0),
  supply_incentives_apr   NUMERIC(12, 6),      -- 预聚合：所有 supply incentive APR 之和
  borrow_incentives_apr   NUMERIC(12, 6),      -- 预聚合：所有 borrow incentive APR 之和
  incentive_details       JSONB,               -- 完整 breakdown（merit/merkl/brevis）
  aave_pro_reserve_id     TEXT,
  UNIQUE (snapshot_ts, reserve_id)
)
```

### 2.2 关键：预聚合 incentive APR 已存在

后端 `persistenceService.ts` 的 `buildSnapshotRow()` 在每次快照时已经将激励数据写入 `incentive_details` JSONB 列，包含 per-campaign 级别的 merit/merkl/brevis 细分数据。

### 2.3 命名约定
- 列名 snake_case（Postgres），API 层 camelCase（对齐 `ReserveWithSpread`）
- `reserve_id` 为 canonical key
- **禁止 `*Usd` 字段**（前端通过 `nativeToUsd()` 推导）
- `incentive_details` JSONB 内部结构对齐 `MeritIncentive` / `MerklOpportunityGroup` / `BrevisIncentive`

## 3. API

### `GET /api/markets/history`

**查询参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `reserveId` | string | 否 | 筛选特定 reserve |
| `marketName` | string | 否 | 筛选特定市场 |
| `from` | ISO string | 是 | 起始时间 |
| `to` | ISO string | 是 | 截止时间（上限 90 天） |
| `limit` | integer | 否 | 分页大小，默认 100，上限 1000 |

**返回格式**（对齐 `MarketsResponse` wrapper 模式）：

```typescript
interface ReserveSnapshotsResponse {
  snapshot: {
    from: string;
    to: string;
    totalSnapshots: number;
  };
  snapshots: ReserveSnapshotItem[];
}

interface ReserveSnapshotItem {
  snapshotAt: string;            // ISO timestamp
  reserveId: string;
  marketName: string;
  chainName: string;
  chainId: number;
  tokenSymbol: string;
  supplyApy?: number;            // 协议基础 supply APY
  borrowApy?: number;            // 协议基础 borrow APY
  tokenPrice?: number;
  utilizationPct?: number;
  supplied?: string;             // bigint string
  borrowed?: string;
  liquidity?: string;
  deficit?: string;
}
```

**注意**：
- API 只返回图表需要的标量字段，**不返回 `incentive_details` JSONB**（减少传输量，前端趋势图用不到完整 breakdown）
- 时间范围上限 90 天（防大范围查询拖垮 DB）

### 3.1 实现位置

| 文件 | 内容 |
|------|------|
| `backend/src/routes/marketsHistory.ts` | 路由定义 |
| `backend/src/controllers/marketsHistoryController.ts` | 查询逻辑 + 90 天校验 |
| `backend/src/services/persistenceService.ts` | 新增 `queryReserveSnapshots()` 方法 |

### 3.2 SQL 查询

```sql
SELECT snapshot_ts, reserve_id, market_name, chain_name, chain_id, token_symbol,
       supply_apy, borrow_apy, token_price, utilization_pct, supplied, borrowed, liquidity, deficit
FROM market_snapshots
WHERE reserve_id = $1
  AND snapshot_ts >= $2
  AND snapshot_ts <= $3
ORDER BY snapshot_ts ASC
LIMIT $4;
```

## 4. 验收标准
- API 正确返回 `market_snapshots` 数据，字段对齐 `ReserveSnapshotItem`
- 不返回 `incentive_details` JSONB
- 时间范围上限 90 天限制生效
- 单元测试 + 集成测试通过

## 5. 依赖
- `market_snapshots` 表已有 cron 写入（无需改动）
- `aggregateSupplyIncentivesApr` / `aggregateBorrowIncentivesApr` 已有
- AAV-301 性能优化（定时任务稳定性）

## 6. 关联文档
- 前端实现方案：[`aaveapy/docs/plans/linear-issues/aav_344_plan.md`](https://github.com/0xPabloLI/aaveapy/blob/main/docs/plans/linear-issues/aav_344_plan.md)（hook、组件、集成方式、移动端适配）
- 已有 DB schema：`backend/migrations/001_init_persistence.sql` + `007_rename_reserve_columns.sql`
- 已有预聚合逻辑：`backend/src/services/persistenceService.ts` L585-L638

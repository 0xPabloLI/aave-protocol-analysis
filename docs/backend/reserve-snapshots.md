# AAV-344 后端：Reserve Snapshots 采集、存储与 API

## 1. 目标
为前端历史趋势展示提供数据基础：定时快照 reserve 全量指标，暴露查询 API。

## 2. 数据库设计

### 2.1 `reserve_snapshots` 表

```sql
CREATE TABLE IF NOT EXISTS reserve_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  snapshot_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  reserve_id      TEXT         NOT NULL,       -- ReserveWithSpread.reserveId
  market_name     TEXT         NOT NULL,       -- ReserveWithSpread.marketName
  chain_name      TEXT         NOT NULL,       -- ReserveWithSpread.chainName
  chain_id        INTEGER      NOT NULL,       -- ReserveWithSpread.chainId
  token_symbol    TEXT         NOT NULL,       -- ReserveWithSpread.tokenSymbol

  -- 核心指标（原始链上值，string/bigint；禁止 *Usd 预计算字段）
  supply_apy      NUMERIC(10,6),              -- ReserveWithSpread.supplyApy
  borrow_apy      NUMERIC(10,6),              -- ReserveWithSpread.borrowApy
  token_price     NUMERIC(24,8),              -- ReserveWithSpread.tokenPrice
  utilization_pct NUMERIC(8,4),              -- ReserveWithSpread.utilizationPct
  supplied        TEXT,                       -- ReserveWithSpread.supplied (bigint string)
  borrowed        TEXT,                       -- ReserveWithSpread.borrowed
  liquidity       TEXT,                       -- ReserveWithSpread.liquidity
  supply_cap      TEXT,                       -- ReserveWithSpread.supplyCap
  borrow_cap      TEXT,                       -- ReserveWithSpread.borrowCap

  -- 利率模型
  base_borrow_rate     NUMERIC(10,6),         -- ReserveWithSpread.baseBorrowRate
  slope_below_optimal  NUMERIC(10,6),         -- ReserveWithSpread.slopeBelowOptimal
  slope_above_optimal  NUMERIC(10,6),         -- ReserveWithSpread.slopeAboveOptimal
  optimal_utilization  NUMERIC(8,4),          -- ReserveWithSpread.optimalUtilization
  deficit              TEXT,                  -- ReserveWithSpread.deficit

  -- 激励数据（JSONB 存储完整 breakdown 结构）
  merit_supplys   JSONB,                      -- ReserveWithSpread.meritSupplys
  merit_borrows   JSONB,                      -- ReserveWithSpread.meritBorrows
  merkl_supplys   JSONB,                      -- ReserveWithSpread.merklSupplys
  merkl_borrows   JSONB,                      -- ReserveWithSpread.merklBorrows
  merkl_holds     JSONB,                      -- ReserveWithSpread.merklHolds
  brevis_supplys  JSONB,                      -- ReserveWithSpread.brevisSupplys
  brevis_borrows  JSONB,                      -- ReserveWithSpread.brevisBorrows

  UNIQUE (snapshot_at, reserve_id)
);
CREATE INDEX IF NOT EXISTS idx_reserve_snapshots_at       ON reserve_snapshots (snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_reserve_snapshots_reserve   ON reserve_snapshots (reserve_id);
CREATE INDEX IF NOT EXISTS idx_reserve_snapshots_market    ON reserve_snapshots (market_name, chain_name);
```

### 2.2 命名约定
- 列名 snake_case（Postgres），API 层 camelCase（对齐 `ReserveWithSpread`）
- `reserve_id` 为 canonical key（禁止 composite-key fallback）
- **禁止存储 `*Usd` 预计算字段**，前端通过 `nativeToUsd()` 推导
- 激励 JSONB 内部结构对齐 `MeritIncentive` / `MerklOpportunityGroup` / `BrevisIncentive`

## 3. 数据采集与存储

| 项 | 方案 |
|----|------|
| 入口 | `backend/src/services/updateScheduler.ts` 新增 cron 任务 |
| 持久化 | `persistenceService.ts` 新增 `writeReserveSnapshots()` 批量写入 |
| 数据源 | 复用 `src/index.ts` fetcher 已拿到的 `/api/markets` 全量 reserve |
| 频率 | 每小时（可配置） |
| 幂等 | UNIQUE `(snapshot_at, reserve_id)` 防重复 |
| 架构 | cron-write / API-read-only，历史数据只写入不修改 |
| 迁移 | `backend/migrations/` 新增 SQL 脚本 |

## 4. API

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
  snapshotAt: string;
  reserveId: string;
  marketName: string;
  chainName: string;
  tokenSymbol: string;
  supplyApy?: number;
  borrowApy?: number;
  tokenPrice?: number;
  utilizationPct?: number;
  supplied?: string;
  borrowed?: string;
  liquidity?: string;
  supplyCap?: string;
  borrowCap?: string;
  baseBorrowRate?: number;
  slopeBelowOptimal?: number;
  slopeAboveOptimal?: number;
  optimalUtilization?: number;
  deficit?: string;
  meritSupplys?: MeritIncentive[];
  meritBorrows?: MeritIncentive[];
  merklSupplys?: MerklOpportunityGroup[];
  merklBorrows?: MerklOpportunityGroup[];
  merklHolds?: MerklOpportunityGroup[];
  brevisSupplys?: BrevisIncentive[];
  brevisBorrows?: BrevisIncentive[];
}
```

**安全**：时间范围上限 90 天，防大范围查询拖垮 DB。

## 5. 验收标准
- `reserve_snapshots` 表创建成功，UNIQUE 约束生效
- cron 每小时写入，无错误，幂等不重复
- API 正确返回数据，字段对齐 `ReserveWithSpread`，不含 `*Usd`
- 时间范围上限 90 天限制生效
- 单元测试 + 集成测试通过

## 6. 依赖
- 数据库环境支持新增表
- AAV-139 campaign-history 设计（`docs/backend/campaign-history.md` 需先创建）
- AAV-301 性能优化（定时任务稳定性）

## 7. 关联文档
- 前端实现方案：[`aaveapy/docs/plans/linear-issues/aav_344_plan.md`](https://github.com/0xPabloLI/aaveapy/blob/main/docs/plans/linear-issues/aav_344_plan.md)（hook、组件、集成方式、移动端适配）

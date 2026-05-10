# Database Persistence + Cloudflare R2 Backup — Design Doc

**Date:** 2026-05-07
**Status:** Implemented (see `feat/db-persistence-r2-backup`). The original draft below reflects the brainstormed design; revisions applied during implementation are summarised at the bottom of the file.
**Author:** AI-assisted design session

---

## 1. 目标

将后端关键时序数据持久化到数据库，支持历史趋势分析（APY 变化、utilization 趋势、价格历史等），同时通过 Cloudflare R2 做离线容灾备份。

## 2. 技术选型

| 组件 | 选型 | 月费 |
|------|------|------|
| 主存储 | Railway PostgreSQL | ~$5/月 (Hobby 计划) |
| 写入层 | 新增 `persistenceService.ts`，每 5 分钟批量 INSERT | $0 |
| 离线备份 | Cloudflare R2，每天 dump + 上传 | $0 |
| **合计** | | **~$5/月** |

### 为什么选 Railway PG 而非外部 VPS

- Railway 内部网络延迟 <1ms，外部 VPS 需 10-100ms + 公网暴露风险
- 运维零成本：自动备份、自动扩容、环境变量自动注入
- 差价极小（$5 vs $3-5），不值得多出运维时间
- 数据规模小（~15 MB/天），PG 完全胜任

## 3. 整体架构

```
┌──────────────────────────────────────────────────────────┐
│                     现有架构 (不变)                        │
│  ┌──────────┐  cron每1min  ┌──────────────────────────┐  │
│  │ Aave API │──────────────▶│ marketsService (内存快照) │  │
│  └──────────┘              └──────────────────────────┘  │
│                                                           │
│  ┌──────────┐  cron每1min  ┌──────────────────────────┐  │
│  │ RPC 链上  │──────────────▶│ onchainDataService (内存) │  │
│  └──────────┘              └──────────────────────────┘  │
│                                                           │
│  ┌──────────┐  cron每60s   ┌──────────────────────────┐  │
│  │ Oracle   │──────────────▶│ oracleService (内存)      │  │
│  └──────────┘              └──────────────────────────┘  │
│                                                           │
│  各 cron 刷新完成后,新增持久化步骤 (每5分钟节流一次)           │
└─────────────────────────┬────────────────────────────────┘
                          │ 每5分钟批量 INSERT
                          ▼
┌──────────────────────────────────────────────────────────┐
│                  Railway PostgreSQL                       │
│  ┌─────────────────────┐  ┌──────────────────────────┐   │
│  │ market_snapshots    │  │ oracle_prices             │   │
│  └─────────────────────┘  └──────────────────────────┘   │
└─────────────────────────┬────────────────────────────────┘
                          │ 每天凌晨: pg_dump → .sql.gz
                          ▼
┌──────────────────────────────────────────────────────────┐
│               Cloudflare R2 (离线备份)                    │
│          保留最近 30 天的 dump 文件                        │
└──────────────────────────────────────────────────────────┘
```

## 4. 数据库 Schema

### 4.1 `market_snapshots` — 市场快照（高频数据）

每次刷新后所有 reserve 的核心指标。一张宽表，查询简单。

```sql
CREATE TABLE market_snapshots (
    id              BIGSERIAL PRIMARY KEY,
    snapshot_ts     TIMESTAMPTZ NOT NULL,          -- 快照时间
    reserve_id      TEXT NOT NULL,                 -- "marketName:chainId:tokenAddress"
    chain_id        INTEGER NOT NULL,
    chain_name      TEXT NOT NULL,
    market_name     TEXT NOT NULL,
    token_symbol    TEXT NOT NULL,
    token_name      TEXT NOT NULL,
    token_address   TEXT NOT NULL,
    decimals        INTEGER,
    token_price     NUMERIC(24, 8),               -- USD 价格
    supply_apy      NUMERIC(12, 6),               -- supply APY (百分比)
    borrow_apy      NUMERIC(12, 6),               -- borrow APY (百分比)
    utilization_pct NUMERIC(8, 4),                -- 利用率 (百分比)
    available_liquidity NUMERIC(40, 0),           -- 可用流动性 (raw wei)
    total_variable_debt  NUMERIC(40, 0),          -- 总负债 (raw wei)
    reserve_size    NUMERIC(40, 0),               -- 总存款 (raw wei)
    deficit         NUMERIC(40, 0),               -- 坏账 (raw wei)
    supply_incentives_apr NUMERIC(12, 6),         -- 所有 supply 激励加总
    borrow_incentives_apr NUMERIC(12, 6),         -- 所有 borrow 激励加总
    incentive_details JSONB,                      -- 激励明细 (JSON)
    aave_pro_reserve_id TEXT,                     -- Aave Pro reference
    CONSTRAINT market_snapshots_unique UNIQUE (snapshot_ts, reserve_id)
);

CREATE INDEX idx_market_snapshots_ts      ON market_snapshots (snapshot_ts DESC);
CREATE INDEX idx_market_snapshots_reserve ON market_snapshots (reserve_id, snapshot_ts DESC);
CREATE INDEX idx_market_snapshots_symbol  ON market_snapshots (token_symbol, snapshot_ts DESC);
CREATE INDEX idx_market_snapshots_chain   ON market_snapshots (chain_id, snapshot_ts DESC);
```

### 4.1b `market_configs` — 市场配置（低频数据，2026-05-10 拆分新增）

从 `market_snapshots` 中拆出的低频字段，仅在治理投票后变更时才写入新行。保留历史版本可追溯利率模型变更轨迹。

```sql
CREATE TABLE market_configs (
    id                          BIGSERIAL PRIMARY KEY,
    snapshot_ts                 TIMESTAMPTZ NOT NULL,
    reserve_id                  TEXT        NOT NULL,
    a_token_address             TEXT,
    v_token_address             TEXT,
    supply_cap                  NUMERIC(40, 0),
    borrow_cap                  NUMERIC(40, 0),
    base_variable_borrow_rate   NUMERIC(8, 4),
    reserve_factor              NUMERIC(8, 4),
    variable_rate_slope1        NUMERIC(8, 4),
    variable_rate_slope2        NUMERIC(8, 4),
    optimal_usage_rate          NUMERIC(8, 4),
    supply_disabled             BOOLEAN,
    borrow_disabled             BOOLEAN,
    is_frozen                   BOOLEAN,
    is_paused                   BOOLEAN,
    hub_id                      TEXT,
    hub_name                    TEXT,
    hub_address                 TEXT,
    spoke_id                    TEXT,
    spoke_name                  TEXT,
    spoke_address               TEXT,
    CONSTRAINT market_configs_unique UNIQUE (snapshot_ts, reserve_id)
);

CREATE INDEX idx_market_configs_reserve_ts ON market_configs (reserve_id, snapshot_ts DESC);
CREATE INDEX idx_market_configs_ts         ON market_configs (snapshot_ts DESC);
```

**拆分逻辑**：
- `market_snapshots`（21 列）：价格、APY、利用率、流动性 — 每 5 分钟写入
- `market_configs`（22 列）：利率策略、额度限制、状态标志、合约地址 — 仅当内容 hash 变化时才写入

**容量影响**：~50% 存储减少。Config 表写入从 288 次/天降为 ~1-5 次/天。
```

### 4.2 `oracle_prices` — 预言机价格（已通过 oracle_source_configs 规范化）

```sql
CREATE TABLE oracle_prices (
    id            BIGSERIAL PRIMARY KEY,
    snapshot_ts   TIMESTAMPTZ NOT NULL,
    chain_id      INTEGER NOT NULL,
    token_address TEXT NOT NULL,                  -- lowercase
    price_usd     NUMERIC(24, 8) NOT NULL,        -- USD price (oracle raw / 1e8)
    config_id     INTEGER NOT NULL REFERENCES oracle_source_configs(id)
    -- source ('v3'|'v4') 已移除：通过 config_id → oracle_source_configs.source 推导
);

CREATE UNIQUE INDEX oracle_prices_unique
    ON oracle_prices (snapshot_ts, chain_id, token_address, config_id);

CREATE INDEX idx_oracle_prices_ts    ON oracle_prices (snapshot_ts DESC);
CREATE INDEX idx_oracle_prices_token ON oracle_prices (chain_id, token_address, snapshot_ts DESC);
CREATE INDEX idx_oracle_prices_config_ts ON oracle_prices (config_id, snapshot_ts DESC);
```

### 4.3 数据量估算

| 表 | 每次行数 | 频率 | 每日 | 每月 | 约存储 |
|----|---------|------|------|------|--------|
| market_snapshots | ~550 | 每5min | ~16万行 | ~480万行 | ~450 MB/月 |
| oracle_prices | ~300 | 每5min | ~8.6万行 | ~260万行 | |
| **合计** | | | | | **~450 MB/月** |

Railway Hobby 计划 5 GB 容量够存 ~10 个月数据。

## 5. 写入逻辑

### 5.1 写入时机：节流策略

不每次 cron（1分钟）都写，每 5 分钟写入一次。

```
cron 每1分钟触发 refreshMarketsSnapshot()
    │
    ▼
markets 数据刷新完毕
    │
    └── 检查距离上次 persist 是否 ≥ 5分钟
            ├── 否 → 跳过
            └── 是 → persistSnapshot()
```

### 5.2 核心实现

新增文件: `backend/src/services/persistenceService.ts`

```typescript
import { getPool, sql } from './dbPool.js';
import { logger } from '../logger.js';
import type { MarketsPayload } from '../../../dist/index.js';
import type { OraclePricesSnapshot } from './oracleService.js';

let lastPersistTs = 0;
const PERSIST_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟

export function getPersistenceStatus() {
  return {
    lastPersistTs: lastPersistTs || null,
    persistIntervalMs: PERSIST_INTERVAL_MS,
    secondsSinceLastPersist: lastPersistTs
      ? Math.round((Date.now() - lastPersistTs) / 1000)
      : null,
  };
}

export async function persistSnapshotIfNeeded(
  payload: MarketsPayload,
  oracleSnapshot: OraclePricesSnapshot | null
): Promise<{ marketsPersisted: boolean; oraclePersisted: boolean }> {
  const now = Date.now();
  if (now - lastPersistTs < PERSIST_INTERVAL_MS) {
    return { marketsPersisted: false, oraclePersisted: false };
  }

  const result = { marketsPersisted: false, oraclePersisted: false };

  try {
    await persistMarketSnapshot(payload);
    result.marketsPersisted = true;
  } catch (error) {
    logger.warn('⚠️ Failed to persist market snapshot:', error);
  }

  if (oracleSnapshot) {
    try {
      await persistOraclePrices(oracleSnapshot);
      result.oraclePersisted = true;
    } catch (error) {
      logger.warn('⚠️ Failed to persist oracle prices:', error);
    }
  }

  lastPersistTs = now;
  return result;
}

async function persistMarketSnapshot(payload: MarketsPayload): Promise<void> {
  const pool = getPool();
  const now = new Date();
  const snapshotTs = now.toISOString();

  const rows = payload.data.map((reserve) => ({
    snapshotTs,
    reserveId: reserve.reserveId,
    chainId: reserve.chainId,
    chainName: reserve.chainName,
    marketName: reserve.marketName,
    tokenSymbol: reserve.tokenSymbol,
    tokenName: reserve.tokenName,
    tokenAddress: reserve.tokenAddress,
    tokenPrice: reserve.tokenPrice ?? null,
    supplyApy: reserve.supplyApy ?? null,
    borrowApy: reserve.borrowApy ?? null,
    utilizationPct: reserve.utilizationPct ?? null,
    availableLiquidity: (reserve as any).availableLiquidity ?? null,
    totalVariableDebt: (reserve as any).totalVariableDebt ?? null,
    reserveSize: (reserve as any).reserveSize ?? null,
    supplyCap: reserve.supplyCap ?? null,
    borrowCap: reserve.borrowCap ?? null,
    deficit: (reserve as any).deficit ?? null,
    baseVariableBorrowRate: (reserve as any).baseVariableBorrowRate ?? null,
    reserveFactor: reserve.reserveFactor ?? null,
    variableRateSlope1: reserve.variableRateSlope1 ?? null,
    variableRateSlope2: reserve.variableRateSlope2 ?? null,
    optimalUsageRate: reserve.optimalUsageRate ?? null,
    supplyDisabled: reserve.supplyDisabled ?? false,
    borrowDisabled: reserve.borrowDisabled ?? false,
    isFrozen: reserve.isFrozen ?? false,
    isPaused: reserve.isPaused ?? false,
    supplyIncentivesApr: aggregateIncentivesApr(reserve.supplyIncentives ?? []),
    borrowIncentivesApr: aggregateIncentivesApr(reserve.borrowIncentives ?? []),
    incentiveDetails: JSON.stringify(buildIncentiveDetails(reserve)),
    decimals: reserve.decimals ?? null,
    hubName: (reserve as any).hubName ?? null,
    spokeName: (reserve as any).spokeName ?? null,
  }));

  if (rows.length === 0) return;

  const columns = [
    'snapshot_ts', 'reserve_id', 'chain_id', 'chain_name', 'market_name',
    'token_symbol', 'token_name', 'token_address', 'token_price',
    'supply_apy', 'borrow_apy', 'utilization_pct',
    'available_liquidity', 'total_variable_debt', 'reserve_size',
    'supply_cap', 'borrow_cap', 'deficit',
    'base_variable_borrow_rate', 'reserve_factor',
    'variable_rate_slope1', 'variable_rate_slope2', 'optimal_usage_rate',
    'supply_disabled', 'borrow_disabled', 'is_frozen', 'is_paused',
    'supply_incentives_apr', 'borrow_incentives_apr', 'incentive_details',
    'decimals', 'hub_name', 'spoke_name',
  ];

  const values = rows.map((r) =>
    `(${columns.map((col) => formatPgValue(r[toCamel(col)]))}).join(', ')`
  );

  const sql = `INSERT INTO market_snapshots (${columns.join(', ')}) VALUES ${values.join(', ')}`;
  await pool.query(sql);

  logger.info(`📊 Persisted ${rows.length} market snapshots to PostgreSQL`);
}

// 辅助函数略，完整实现在代码中
```

### 5.3 集成点

在 `marketsService.ts` 的 `refreshMarketsSnapshot()` 末尾调用：

```typescript
// 在 snapshot 更新后
import { persistSnapshotIfNeeded } from './persistenceService.js';
import { getOraclePricesFromCache } from './oracleService.js';

// ...snapshot = newSnapshot 之后...
void persistSnapshotIfNeeded(newSnapshot.payload, getOraclePricesFromCache())
  .then((r) => { if (r.marketsPersisted) logger.debug('Snapshot persisted'); });
```

**注意：** `void` 延迟执行，不阻塞 markets refresh 主流程。失败只打日志，不影响 API 服务。

## 6. Cloudflare R2 离线备份

### 6.1 策略

| 项目 | 配置 |
|------|------|
| 触发 | 每天凌晨 03:00 UTC |
| 内容 | `pg_dump --format=custom --compress=9` |
| 保留 | 无限期（R2 免费额度 10GB，每日 dump ~5MB，1 年仅 ~1.8GB） |
| 执行方式 | GitHub Actions |
| 存储 | Cloudflare R2, bucket: `aave-db-backups` |

### 6.2 实现：GitHub Actions（推荐）

```yaml
# .github/workflows/db-backup.yml
name: Database Backup to R2

on:
  schedule:
    - cron: '0 3 * * *'  # 每天 03:00 UTC
  workflow_dispatch:       # 手动触发

jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - name: Install Railway CLI
        run: npm install -g @railway/cli

      - name: Connect to Railway PG
        env:
          RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}
        run: |
          # 获取 DATABASE_URL 并通过 SSH 转发
          railway link  # 需要项目 ID

      - name: Dump database
        run: |
          pg_dump $DATABASE_URL --format=custom --compress=9 \
            --file=backup-$(date +%Y-%m-%d).dump.gz

      - name: Upload to Cloudflare R2
        uses: actions/upload-artifact@v4
        # 或用 aws CLI (S3 兼容):
        run: |
          aws s3 cp backup-*.dump.gz s3://aave-db-backups/ \
            --endpoint-url ${{ secrets.R2_ENDPOINT }} \
            --region auto
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}

      - name: Cleanup old backups (>30 days)
        run: |
          aws s3 ls s3://aave-db-backups/ \
            --endpoint-url ${{ secrets.R2_ENDPOINT }} \
            --region auto \
          | awk -v cutoff=$(date -d '30 days ago' +%Y-%m-%d) \
            '$1 < cutoff {print $4}' \
          | while read f; do
              aws s3 rm "s3://aave-db-backups/$f" \
                --endpoint-url ${{ secrets.R2_ENDPOINT }}
            done
```

**GitHub Secrets 需配置：**

| Secret | 说明 |
|--------|------|
| `RAILWAY_TOKEN` | Railway CLI 认证 token |
| `R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` | R2 S3 兼容 Access Key |
| `R2_SECRET_ACCESS_KEY` | R2 S3 兼容 Secret Key |

### 6.3 R2 一次性配置

```bash
# 1. Cloudflare Dashboard → R2 → Create Bucket
#    Bucket: aave-db-backups

# 2. Manage R2 API Tokens → Create API Token
#    Permissions: Object Read & Write
#    Generate: Access Key ID + Secret Access Key

# 3. 测试上传
aws s3 cp test.txt s3://aave-db-backups/ \
  --endpoint-url https://<account-id>.r2.cloudflarestorage.com \
  --region auto
```

### 6.4 费用

| 项目 | 估值 | R2 免费额度 | 费用 |
|------|------|------------|------|
| 单日 dump (压缩) | ~5 MB | — | — |
| 30 天保留 | ~150 MB | 10 GB | $0 |
| 操作请求 | Class A/B 极少 | 大量免费 | $0 |
| **总计** | | | **$0/月** |

## 7. 连接池管理

新增文件: `backend/src/services/dbPool.ts`

使用 `pg` (node-postgres) 连接池：

```typescript
import { Pool } from 'pg';
import { logger } from '../logger.js';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is required for database persistence');
    }

    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,                // 最多 5 个连接
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      logger.error('Unexpected database pool error:', err);
    });
  }

  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
```

## 8. 查询示例

### 某个 token 的 APY 历史趋势

```sql
SELECT snapshot_ts, supply_apy, borrow_apy, utilization_pct
FROM market_snapshots
WHERE token_symbol = 'USDC'
  AND chain_name = 'Ethereum'
  AND snapshot_ts > NOW() - INTERVAL '30 days'
ORDER BY snapshot_ts;
```

### 所有链的 TVL 趋势（按 snapshot）

```sql
SELECT snapshot_ts,
       SUM(reserve_size * token_price / 10^decimals) AS tvl_usd
FROM market_snapshots
WHERE snapshot_ts > NOW() - INTERVAL '7 days'
GROUP BY snapshot_ts
ORDER BY snapshot_ts;
```

### 价格变化

```sql
SELECT snapshot_ts, price_usd
FROM oracle_prices
WHERE token_address = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  AND chain_id = 1
ORDER BY snapshot_ts DESC
LIMIT 100;
```

## 9. 数据保留策略（建议）

| 时间范围 | 粒度 | 说明 |
|----------|------|------|
| 0-7 天 | 5 分钟级原始快照 | 精确分析 |
| 8-90 天 | 1 小时聚合 | 降采样 |
| 90+ 天 | 1 天聚合 | 长期趋势 |

降采样可通过一个额外的 cron job 执行聚合 `INSERT INTO ... SELECT ... GROUP BY`。

## 10. 实施步骤

1. **Railway 配置** — Dashboard 添加 PostgreSQL 插件，获取 `DATABASE_URL`
2. **创建表** — 在 PG 里执行 schema DDL
3. **新增 `dbPool.ts`** — 连接池管理
4. **新增 `persistenceService.ts`** — 批量写入逻辑
5. **集成到 `marketsService.ts`** — refresh 末尾调用 persist
6. **测试验证** — 本地跑 `npm --prefix backend run dev`，确认数据写入 PG
7. **Cloudflare R2 配置** — 创建 bucket + API token
8. **GitHub Actions** — 添加 `.github/workflows/db-backup.yml`，配置 Secrets
9. **文档更新** — 更新 `docs/api/api-documentation.md` 补充 DB 查询说明

## 11. 风险与应对

| 风险 | 应对 |
|------|------|
| PG 写入失败 | 不影响 API 主流程，只打 warn 日志；R2 备份可兜底 |
| DATABASE_URL 缺失 | `getPool()` 抛错，persist 跳过；环境不完整时不强制 |
| 数据膨胀 | 保留策略 + 降采样；Hobby 5GB 够用至少 10 个月 |
| Railway PG 不可用 | R2 每天备份可恢复；PG 挂了 API 照常服务（内存快照独立） |
| 备份恢复耗时 | 每日 dump ~5MB，恢复 < 1 分钟 |

## 12. 未来扩展（不做，仅记录）

- **TimescaleDB 迁移** — 数据量超过百万行/天后，启用 hypertable 自动分区
- **只读副本** — 分析查询走副本，不影响写入性能
- **Grafana 看板** — 直接连 PG 做实时可视化

---

## 13. 实施期修订（2026-05-07）

落地实现与第 4–7 章草稿存在以下差异，以代码为准：

1. **SQL 拼接 → 参数化批量 INSERT**：`buildBulkInsert()` 生成 `$1,$2,...` 占位符，所有值通过 `pool.query(text, values)` 走参数化通道；草稿里的字符串拼接版本是 broken 的伪代码（`.join()` 写在了模板字符串内部），未采用。
2. **幂等约束**：`market_snapshots` 加 `UNIQUE(snapshot_ts, reserve_id)`；`oracle_prices` 加 `UNIQUE(snapshot_ts, chain_id, token_address, config_id)`（`config_id` 引用 `oracle_source_configs.id`，已通过 migration 003 移除冗余 `source` 列）。所有 INSERT 走 `ON CONFLICT DO NOTHING`，进程重启或快照重复触发都不会产生重复行。
3. **Schema 字段补齐**：补 `a_token_address / v_token_address / aave_pro_reserve_id / hub_id / hub_address / spoke_id / spoke_address`，去掉所有 `as any` 强转。
4. **激励聚合修正**：草稿里 `aggregateIncentivesApr(reserve.supplyIncentives ?? [])` 只读了 legacy 的 `number[]`，丢失 merit/merkl/brevis；实现里改为对四类来源（legacy `supplyIncentives` 数组 + `meritSupplys.apr` + `merklSupplys.breakdowns[].campaignApr` + `brevisSupplys.breakdowns[].campaignApr`）求和，统一换算成百分比。注意 merkl/brevis 的字段是 `campaignApr`（来自 `BaseCampaignBreakdown`），不是 `apr`。
5. **集成点改为独立 cron**：放弃在 `marketsService.refreshMarketsSnapshot` 末尾 `void` 触发，改在 [updateScheduler.ts](file:///Users/pabloli/Documents/code/aave-protocol-analysis/backend/src/services/updateScheduler.ts) 新增 `persistenceFlushEveryFiveMinutesAtSecond30`（每 5 分钟在 :30s 执行），统一拉取 markets/oracle 当前快照后写入，避免不同源刷新时间错位。
6. **`DATABASE_URL` 缺失行为**：`isPersistenceEnabled()` 在 `persistSnapshotIfNeeded` 入口就 short-circuit 返回 `{ skipped: 'disabled' }`，启动时打一次 INFO，不再每次 cron warn。
7. **新增 `/api/persistence-status` 监控端点**：暴露 `lastSuccessTs / secondsSinceLastSuccess / totalMarketsRowsWritten / totalOracleRowsWritten / lastError`，用于尽早发现静默失败。
8. **graceful shutdown**：`server.ts` 注册 `SIGTERM/SIGINT` 处理器，先 `server.close()` 再 `closePool()`，10s 超时强退；解决 Railway 重启时 in-flight 写入被强杀的问题。
9. **R2 备份 workflow 修正**：
   - 不用 `railway link`（GH Actions 无法交互登录），改为直接 `pg_dump $DATABASE_URL_PUBLIC`，使用 Railway「Public Networking」公网连接串作为 GH Secret。
   - 显式安装 `postgresql-client-17`（ubuntu-latest 自带的 16 和 Railway 的 17 不兼容会报 server version mismatch）。
   - `aws s3 cp backup-*.dump.gz` 不支持 glob → 改用 `BACKUP_FILE` 环境变量传递明确文件名；同时去掉误导性的 `.gz` 后缀（`-Fc -Z9` 是 custom 格式自压缩，不是 gzip）。
   - 30 天 retention 改为 R2 bucket 自带的 lifecycle rule，workflow 不再写删除逻辑（更可靠，跳过运行也不会撑爆 bucket）。
10. **容量重新核算**：~28 列宽表 × 550 行 × 288 次/天 ≈ 60 MB/天 ≈ 1.8 GB/月（不是草稿里的 450 MB/月）。Railway Hobby 5 GB 实际只够 2.5–3 个月，落地后必须尽早实施第 9 章的降采样或考虑 TimescaleDB（草稿第 12 章）。
11. **内容哈希去重（2026-05-10）**：persistMarketSnapshot / writeOracleChunk 新增跨批次内容哈希去重。每次写入前对每行数据的业务字段计算 SHA256，与上一次成功写入的哈希对比——数据未变化则跳过该行（跳过写入）。进程重启后哈希表为空，首次写入全量（低频，可接受）。效果：Aave 利率稳定时（多数 5 分钟周期），数据库写入量从全量 550+ 行降为 0 行，大幅减少 PG 写入压力和存储消耗。
12. **移除 oracle_prices.source 冗余列（2026-05-10）**：`oracle_prices.source` 可通过 `config_id → oracle_source_configs.source` 推导，属于非规范化冗余。migration 003 移除该列并从 UNIQUE 约束中删除 `source`，`persistenceService.ts` 中 `OracleRow` 接口及写入逻辑同步清理。

参数化 INSERT 的并发上限、错误日志、SIGTERM 处理见 [persistenceService.ts](file:///Users/pabloli/Documents/code/aave-protocol-analysis/backend/src/services/persistenceService.ts) / [dbPool.ts](file:///Users/pabloli/Documents/code/aave-protocol-analysis/backend/src/services/dbPool.ts) / [server.ts](file:///Users/pabloli/Documents/code/aave-protocol-analysis/backend/src/server.ts)。

## 14. 部署进度（2026-05-07）

| 步骤 | 状态 | 备注 |
|------|------|------|
| 1. Railway 添加 PostgreSQL 插件 | ✅ 已完成 | 部署到 aaveapy production 环境 |
| 2. 创建表 (migration) | ✅ 已完成 | `market_snapshots` + `oracle_prices` + 索引 已建 |
| 3. `dbPool.ts` 连接池 | ✅ 已实现 | 优雅降级，无 DATABASE_URL 时自动跳过 |
| 4. `persistenceService.ts` 写入 | ✅ 已实现 | 每 5 分钟 cron 触发，参数化批量 INSERT |
| 5. 集成到 `updateScheduler.ts` | ✅ 已实现 | 独立 cron `persistenceFlush` |
| 6. 测试验证 (本地) | ✅ 已完成 | root build + backend build + 53 tests pass |
| 7. Cloudflare R2 配置 | ✅ 已完成 | bucket `aave-db-backups` + 无限期保留 |
| 8. GitHub Actions 备份 | ⏳ 待手动 | workflow 已就绪，需配置 GH Secrets |
| 9. 文档更新 | ✅ 本文即文档 | — |

### 当前 changes 说明

- `.trae/mcp.json` 已加入 `.gitignore`（IDE 工具配置，不应提交）
- workflow `permissions: {}` 安全加固
- oracle_prices UNIQUE 约束拆为两个 partial index（修复 PostgreSQL NULL 处理）
- persistenceService V3/V4 分开 batch INSERT 匹配新约束
- 其余为测试路径调整等旁系修改，均在方案预期内

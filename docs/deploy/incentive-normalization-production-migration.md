# Incentive Normalization — Production Migration 执行文档

> 变更范围：per-campaign JSONB + DROP 冗余列/表
> Staging 验证日期：2026-05-20
> Production 执行日期：待定

## 1. 前置条件

| 条件 | 验证方法 |
|------|----------|
| Staging 已全量验证通过 | `curl https://staging-api.aaveapy.com/health` → `{"status":"ok"}` |
| 最新代码已推送到 main | `git log --oneline -1` 确认包含 Dockerfile 修复和 code review fixes |
| Railway CLI 已登录 | `railway status` |
| Production DB 可连接 | `psql "$DATABASE_URL" -c "SELECT 1"` |

## 2. 执行步骤

### Step 1: 部署新代码到 Production

```bash
# 确认链接的是 production 环境
railway status

# 部署（Dockerfile 含 COPY backend/scripts/ 修复）
railway up --detach --service aave-protocol-analysis -m "incentive normalization: per-campaign JSONB, SUM derivation"
```

**等待**：build (~3min) + healthcheck (~3min) + 首次 cron tick (~30s)

### Step 2: 验证新代码运行正常

```bash
# Healthcheck
curl -s https://api.aaveapy.com/health | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'status={d[\"status\"]} commitSha={d[\"commitSha\"]}')
"

# 验证 per-campaign 结构
curl -s https://api.aaveapy.com/api/markets | python3 -c "
import sys, json
data = json.load(sys.stdin)
reserves = data.get('reserves', [])
print(f'Total reserves: {len(reserves)}')
has_legacy = sum(1 for r in reserves if 'supplyIncentives' in r or 'borrowIncentives' in r)
print(f'reserves with legacy fields: {has_legacy} (should be 0)')
"
```

**预期输出**：
- `status=ok`
- `Total reserves: ~354+`
- `reserves with legacy fields: 0`

**回退点**：如果 healthcheck 失败或 API 返回异常 → `railway rollback`

### Step 3: 等待至少 1 个完整 cron tick

新代码部署后，cron 会以新逻辑写入 `incentive_details`（per-campaign 结构），同时 `supply_incentives_apr`/`borrow_incentives_apr` 写 NULL。

等待约 1 分钟后，验证 DB 中最新行的 `incentive_details` 结构：

```bash
psql "$DATABASE_URL" -c "
SELECT reserve_id,
       jsonb_object_keys(incentive_details) as field_key
FROM market_snapshots
WHERE incentive_details IS NOT NULL
ORDER BY snapshot_ts DESC
LIMIT 50;
"
```

**预期**：`field_key` 包含 `meritSupplys`、`merklSupplys`、`brevisSupplys` 等 9 个字段键，不包含 `_isExpired`。

### Step 4: Production DB 备份

```bash
# 创建快照备份（Railway volume-based，或 pg_dump）
pg_dump "$DATABASE_URL" \
  --format=custom \
  --file=backup_before_migration_$(date +%Y%m%d%H%M).dump

# 验证备份可读
pg_restore --list backup_before_migration_*.dump | head -20
```

**回退点**：如果备份失败 → **不执行后续 migration**

### Step 5: 执行 Migration 012 — DROP 列/表

> **⚠️ 此步不可逆**。确认 Step 1-4 全部通过后再执行。

```bash
psql "$DATABASE_URL" \
  -f backend/migrations/012_drop_incentive_columns_and_campaign_tables.sql
```

**验证**：

```bash
psql "$DATABASE_URL" -c "
-- 确认列已删除
SELECT column_name FROM information_schema.columns
WHERE table_name='market_snapshots'
  AND column_name IN ('supply_incentives_apr', 'borrow_incentives_apr');
-- 预期：0 rows

-- 确认表已删除
SELECT tablename FROM pg_tables
WHERE tablename IN ('campaign_history', 'campaign_apr_observations');
-- 预期：0 rows
"
```

### Step 6: 最终验证

```bash
# API health
curl -s https://api.aaveapy.com/health

# API 数据完整性
curl -s https://api.aaveapy.com/api/markets | python3 -c "
import sys, json
data = json.load(sys.stdin)
reserves = data.get('reserves', [])
print(f'Reserves: {len(reserves)}')
print(f'With meritSupplys: {sum(1 for r in reserves if r.get(\"meritSupplys\"))}')
print(f'With merklSupplys: {sum(1 for r in reserves if r.get(\"merklSupplys\"))}')
print(f'With brevisSupplys: {sum(1 for r in reserves if r.get(\"brevisSupplys\"))}')
"
```

## 3. 回退方案

| 场景 | 回退方法 |
|------|----------|
| Step 1-2: 新代码异常 | `railway rollback` 回退到上一版本 |
| Step 5: DROP 后需回退 | **只能从备份恢复**：`pg_restore --clean --dbname="$DATABASE_URL" backup_before_migration_*.dump`，然后 `railway rollback` 回退代码 |
| Step 6: API 异常 | 检查日志：`railway logs --service aave-protocol-analysis` |

## 4. 监控清单（24h）

| 指标 | 检查方法 | 告警阈值 |
|------|----------|----------|
| API health | `curl /health` | 非 200 |
| Reserve count | `curl /api/markets` → `len(reserves)` | < 300 |
| Cron tick 频率 | Railway deploy logs | 间隔 > 5min |
| DB disk usage | Railway metrics | > 80% |
| SUM 推导 APR 正确 | 对比前端展示 vs 手动 SUM | 偏差 > 0.01% |

## 5. 关键注意事项

1. **`_isExpired` 不入库**：仅在 API 序列化时计算。历史数据回放时会重算。
2. **`supplyIncentivesApr`/`borrowIncentivesApr`**：不再从 DB 列读取，改为内存 SUM 推导。API 响应中这两个字段仍存在，但值来自 `sumIncentiveAprFromDetails()`。
3. **`merklHolds` 不参与聚合 APR**：hold 侧仅展示，不加入 supply/borrow 总 incentive APR。
4. **Schema fingerprint 已变更**：前端需同步更新 `schema-fingerprint.ts`。

## 6. Staging 执行记录（2026-05-20）

| Step | 结果 | 备注 |
|------|------|------|
| 1 部署 | ✅ | Dockerfile 修复 `COPY backend/scripts/` |
| 2 验证 | ✅ | 354 reserves |
| 3 cron tick | ✅ | 自动执行 |
| 4 备份 | — | Staging 未做备份（可接受） |
| 5 Migration 012 | ✅ | 列/表已 DROP |
| 6 验证 | ✅ | /health ok, 354 reserves, legacy 字段不存在 |

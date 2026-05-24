# PRD: Database Bloat Fix + Archive-Clean Pipeline

## Problem Statement

Railway PostgreSQL 数据库在 12 天内从正常体积膨胀至近 5GB。根因是 `oracle_source_configs` 唯一约束中包含 NULL 列，导致 ON CONFLICT 永远不命中，每次 UPSERT 变成 INSERT，产生 8539x 重复行。连带 `oracle_prices` 也因 `config_id` 不同而膨胀 76x。同时 `market_snapshots` 无任何 TTL 机制，无限增长。

此外，数据库缺乏"备份后清理"的安全管道——旧数据只能无限堆积，无法在确保可恢复的前提下清理历史数据。

## Solution

三阶段修复：

1. **止血**：修复 NULL bug（`null` → `''`），使唯一约束正常工作
2. **清创**：Migration 014 清理重复行 + 重建唯一约束，将 PG 从 5GB 降至 ~0.5GB
3. **长效守护**：归档-清理管道（R2 永久归档 + PG 7天 TTL），自动在 DB 超过 3GB 时触发备份→清理

## User Stories

1. As a 运维人员, I want 数据库体积不再因 NULL bug 无限膨胀, so that PG 存储成本可控
2. As a 运维人员, I want 已有的重复数据被一次性清理, so that 数据库回到正常体积
3. As a 运维人员, I want 数据库超过 3GB 时自动触发归档备份, so that 清理前有可恢复的快照
4. As a 运维人员, I want 归档备份存储在 R2 的 archive/ 区并永久保留, so that 历史数据可追溯
5. As a 运维人员, I want 日常容灾备份存储在 R2 的 daily/ 区, so that 最近的意外数据丢失可恢复
6. As a 运维人员, I want 触发归档备份时自动清空 daily/ 区, so that R2 存储不重复浪费
7. As a 运维人员, I want 归档备份成功后才执行 PG 清理, so that 清理失败时数据不丢失
8. As a 运维人员, I want PG 清理保留最近 7 天的数据, so that API 返回的数据有足够历史深度
9. As a 运维人员, I want 清理失败时产生告警日志, so that 我能及时介入处理
10. As a 运维人员, I want backup workflow 支持 daily 和 archive 两种模式, so that 同一 workflow 服务于两种场景
11. As a 开发人员, I want `oracle_source_configs` 的唯一约束使用空字符串替代 NULL, so that ON CONFLICT 正确匹配
12. As a 开发人员, I want `oracle_prices` 的唯一约束使用空字符串替代 NULL, so that 同一 token 同一时刻的 price 只保留一行
13. As a 开发人员, I want 归档触发通过 GitHub API workflow_dispatch 实现, so that Backend 无需直接操作 R2
14. As a 开发人员, I want 归档状态验证通过 GitHub API 检查 workflow run 状态, so that 只需一个凭证（GITHUB_ACTIONS_TOKEN）
15. As a 开发人员, I want 归档-清理流程不依赖内存 flag 持久化, so that backend 重启后仍能正确恢复流程

## Implementation Decisions

### 模块划分

1. **NULL Bug 修复模块**
   - 修改 `persistenceService.ts` 中 `ensureOracleSourceConfigs()` 函数
   - V3 行: `spokeAddress: null` → `spokeAddress: ''`
   - V4 行: `poolAddress: null` → `poolAddress: ''`
   - 接口不变，内部值替换

2. **Migration 014 模块**
   - 清理 `oracle_source_configs` 重复行（保留每组唯一组合的最早一行）
   - 清理 `oracle_prices` 重复行（保留每组唯一组合的最早一行）
   - 删除旧唯一约束
   - 重建唯一约束（与 002 相同定义，但数据已无 NULL）
   - VACUUM 相关表回收空间

3. **Backup Workflow 模式扩展模块**
   - `db-backup.yml` 增加 `inputs.mode` 参数（`daily` / `archive`，默认 `daily`）
   - daily 模式：写入 R2 `daily/` 前缀（与当前行为一致）
   - archive 模式：写入 R2 `archive/` 前缀，成功后清空 R2 `daily/` 前缀所有文件
   - 文件名格式：`{mode}/{environment}-aave-pg-{timestamp}.dump`
   - 去掉 R2 lifecycle rule（由运维在 Cloudflare dashboard 手动关闭）

4. **归档触发 Cron 模块**
   - 新增 `archiveScheduler.ts` 服务
   - 每小时执行一次：`SELECT pg_database_size(current_database())`
   - 阈值: 3GB 绝对值
   - 超阈值时：调用 GitHub API `POST /repos/{owner}/{repo}/actions/workflows/db-backup.yml/dispatches` 触发 `mode=archive`
   - 需要 `GITHUB_ACTIONS_TOKEN` 环境变量（fine-grained PAT，scope: `actions:write`，限定本 repo）

5. **归档状态验证 + PG 清理模块**
   - 新增 `pgCleaner.ts` 服务
   - 验证：调用 GitHub API `GET /repos/{owner}/{repo}/actions/runs?per_page=1` 检查最近 workflow run
   - 状态机：
     - `idle`: 无待处理归档
     - `archive_pending`: 已触发 workflow，等待完成
     - `cleaning`: 归档成功，正在清理 PG
   - 状态通过 PG `archive_jobs` 表持久化（非内存 flag），backend 重启后可恢复
   - 清理逻辑：逐表 DELETE + VACUUM，不在大事务内
     - `DELETE FROM market_snapshots WHERE snapshot_ts < now() - interval '7 days'`
     - `DELETE FROM oracle_prices WHERE fetched_at < now() - interval '7 days'`
     - `DELETE FROM oracle_source_configs WHERE created_at < now() - interval '7 days'`
   - 失败时：写 error log（`backend/logs/error.log`），不执行后续清理

### `archive_jobs` 表设计

```sql
CREATE TABLE archive_jobs (
  id SERIAL PRIMARY KEY,
  triggered_at TIMESTAMPTZ NOT NULL,
  workflow_run_id BIGINT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | succeeded | failed
  pg_size_bytes BIGINT NOT NULL,
  cleaned_at TIMESTAMPTZ,
  error_message TEXT
);
```

### GitHub API 交互

- 触发: `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`
  - Body: `{"ref": "railway", "inputs": {"mode": "archive"}}`
- 验证: `GET /repos/{owner}/{repo}/actions/runs?event=workflow_dispatch&per_page=1`
  - 检查 `status == "completed" && conclusion == "success"`

### R2 路径约定

- 日常: `daily/{environment}-aave-pg-{timestamp}.dump`
- 归档: `archive/{environment}-aave-pg-{timestamp}.dump`
- 日常区在归档成功后整体清空

## Testing Decisions

- **NULL Bug 修复**: 测试 UPSERT 幂等性——相同数据第二次调用应返回相同 id，不产生新行
- **Migration 014**: 测试清理后行数符合预期（oracle_source_configs ~43行，oracle_prices ~5万行）
- **归档触发**: 测试阈值检测逻辑（mock pg_database_size 返回值）
- **GitHub API 交互**: 测试 workflow_dispatch 触发和 run 状态验证（mock GitHub API）
- **PG 清理**: 测试 7 天保留逻辑（用固定时间戳验证 DELETE WHERE 条件）
- **状态持久化**: 测试 archive_jobs 表的 CRUD 和状态机转换

测试外部行为，不测试实现细节。所有 mock 集中在外部依赖（PG、GitHub API、R2）。

## Out of Scope

- R2 lifecycle rule 的关闭（运维在 Cloudflare dashboard 手动操作）
- Fine-grained PAT 的创建（用户手动在 GitHub 创建）
- Production 数据库的首次清理（修复后 staging 验证通过再对 production 执行）
- market_configs 表的清理（仅 2 万行 19MB，增长缓慢，无需清理）
- 降采样/分区策略（7天保留已足够，更复杂的优化不在本次范围）

## Further Notes

- 修复 NULL bug 后短期内 PG 不会触发 3GB 阈值（预计降到 ~0.5GB），归档-清理管道是长期守护
- `archive_jobs` 表的状态持久化确保 backend 重启后流程不丢失
- R2 日常区清空后的容灾空窗期可接受——归档区本身就是最新完整快照
- 同一天两次归档触发产生两个时间戳不同的文件，都有独立归档价值

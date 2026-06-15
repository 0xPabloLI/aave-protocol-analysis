# Handoff: Railway OOM 诊断与修复

**日期**: 2026-06-15
**来源 Session**: Railway OOM/SIGTERM 根因诊断 → Fix A/B/D 实施 + 部署验证
**状态**: Fix A/B/D 已完成并验证；Fix E（pg pool DB-unreachable 防护）待实施

---

## 当前稳态（Fix A/B/D 部署后）

| 指标 | 修复前 | 修复后 | 改善 |
|---|---|---|---|
| Heap | 113MB | **57MB** | -50% |
| RSS | 222MB | **165MB** | -26% |
| External | 20MB | 4MB | -80% |

Railway 1GB 内存限制，当前余量 **835MB**。

---

## 术语说明

- **Heap** = Node.js V8 引擎管理的 JS 对象内存（字符串、数组、对象、闭包）。由 GC 回收。
- **RSS** (Resident Set Size) = 容器总物理内存 = heap + code + stack + TCP socket buffer + C++ native 分配。**Railway 按 RSS 判断 OOM**。
- **关键**：heap 小 ≠ RSS 小。TCP socket、SSL buffer 等 native 分配算在 RSS 里但不在 heap 里。

---

## 已完成修复

### Fix A: Brevis chain call 复用 ProviderPool ✅
- Commit: `663f3c1`
- Linear: AAV-889
- `brevis-distributed-so-far.ts` 改为接收 `providerPool?` 参数，不再自己 `new JsonRpcProvider`
- 复用 ProviderPool 的 failover + 淘汰机制

### Fix B: Merkl AMOUNT variant price resolve 批量去重 ✅
- Commit: `663f3c1`
- Linear: AAV-890
- 预扫描所有 AMOUNT variant → 收集去重 token → 串行 resolve → Map 查表
- 防御性措施，当前 AMOUNT campaign 少，实际影响小

### Fix D: googleapis 子路径导入 ✅
- Commit: `4457fc5`
- Linear: AAV-893
- `import { google } from 'googleapis'` → `import { webmasters_v3 } from 'googleapis/build/src/apis/webmasters/v3.js'` + `import { JWT } from 'google-auth-library/build/src/auth/jwtclient.js'`
- 模块加载: 69MB → 5MB（节省 ~64MB heap）
- 4 个 TDD 测试

### 其他已完成
- `archiveService.ts` column 名修正: `captured_at` → `snapshot_ts` (commit `0b5405d`)
- Postgres volume 清空重建（WAL 堆积导致 DB 无法启动）
- 诊断文档更新 (commit `7d6995b`)

---

## 待实施修复

### Fix E: pg.Pool DB-unreachable 防护（高优先级）

**问题**：当 Postgres 不可达时，`pg.Pool` 每次调用 `pool.query()` 都会尝试创建新 TCP 连接。连接超时（5 秒）后失败，但 **TCP socket + SSL buffer 已在内核层分配**（每个 ~5-10MB RSS）。cron 每分钟触发 `persistSnapshotIfNeeded` → 每分钟累积 5-10MB native 内存 → 1 小时后 RSS 暴涨 300-600MB。

**这是之前 RSS 从 222MB 暴涨到 632MB 的直接原因**（Postgres volume 满 → 无法启动 → 每分钟重试 → native 内存累积）。

**修复方向**：在 `dbPool.ts` 中加入 DB 可达性检查：

```typescript
// dbPool.ts 中增加
let lastPoolErrorTime = 0;
const POOL_BACKOFF_MS = 60_000; // 连续失败后 1 分钟内不再尝试

export function isPoolHealthy(): boolean {
  if (!pool || poolClosed) return false;
  if (Date.now() - lastPoolErrorTime < POOL_BACKOFF_MS) return false;
  return true;
}

// pool.on('error') 中记录错误时间
pool.on('error', (err) => {
  lastPoolErrorTime = Date.now();
  logger.error('Unexpected database pool error:', err);
});
```

然后在 `updateScheduler.ts` 和 `persistenceService.ts` 的 persist 调用前检查：

```typescript
if (isPersistenceEnabled() && isPoolHealthy()) {
  await persistSnapshotIfNeeded(...);
}
```

**效果**：DB 不可达时，每分钟只有 1 次连接尝试（首次），后续 60 秒内跳过所有 query。不再累积 TCP socket。

**替代方案**：
- 方案 B：在 `pool.query()` 的 catch 中调用 `pool.end()` 销毁整个 pool，下次 query 时重建。更激进但更干净。
- 方案 C：用 `pg.Pool` 的 `allowExitOnIdle: true` 让空闲连接自动退出（但只影响 idle 连接，不影响正在创建的连接）。

### Fix C: Puppeteer 替代方案（低优先级）

- Linear: AAV-888
- 当前 Cloudflare Browser 正常工作，Puppeteer 只在 Cloudflare 429 时触发
- 稳态 165MB RSS + Puppeteer 70-130MB = 235-295MB，不会 OOM
- 但如果同时有 DB 连接泄漏 + Puppeteer，叠加可能逼近 1GB
- 替代方案：Cloudflare Browser → Regex 兜底（不启动 Chromium）

---

## Postgres Volume 管理

### 当前状态
- Volume: 5GB（`postgres-volume-G11c`）
- 已清空重建，当前使用 ~8MB
- `archive_mode=on`，WAL 归档到 R2 bucket（`postgres-pitr-p4hxxdwohk2`）
- PITR 归档**不占 volume 空间**，占 R2 存储

### Volume 满的根因
1. WAL 归档配置写入 R2 但归档失败时，WAL 文件会堆积在 volume 上
2. `archiveService.ts` 之前用了错误 column 名 `captured_at`（应为 `snapshot_ts`），导致 cleanup SQL 失败 → 旧数据无法清理
3. column 名已修复（commit `0b5405d`），但需要确认 cleanup 是否能追上数据增长

### 建议
1. 在 Railway Dashboard 监控 volume 使用率
2. 考虑关闭 `archive_mode`（如果不需 PITR 恢复）来减少 WAL I/O
3. 或扩容 volume 到 10GB+

---

## Railway MCP Token 配置

Railway MCP server 需要 API token：
1. 登录 https://railway.com
2. 右上角头像 → **Settings** → **API Tokens** → **Create Token**
3. 配置到 MCP server 环境变量 `RAILWAY_API_TOKEN`

---

## 已知问题与风险

| 风险 | 严重度 | 说明 |
|---|---|---|
| pg.Pool DB-unreachable 导致 RSS 暴涨 | **高** | Fix E 待实施，当前 DB 正常所以不会触发，但下次 DB 异常会重现 |
| Postgres volume 再次填满 | **中** | archiveService cleanup 已修复，但 WAL 归档失败仍可能导致堆积 |
| Puppeteer fallback 触发 | **低** | 仅在 Cloudflare Browser 429 时触发，当前正常 |

---

## 相关文件

### 已修改（已 commit）
- `packages/aave-fetcher/src/brevis-distributed-so-far.ts` — Fix A
- `packages/aave-fetcher/src/index.ts` — Fix A
- `packages/aave-fetcher/src/merkl-api.ts` — Fix B
- `backend/src/services/gscService.ts` — Fix D
- `backend/src/services/archiveService.ts` — column 名修正
- `backend/src/server.ts` — heap snapshot 端点 + migration 诊断日志
- `docs/plans/diagnosis-railway-oom-2026-06.md` — 完整诊断文档

### 待修改（Fix E）
- `backend/src/services/dbPool.ts` — 加入 `isPoolHealthy()` + backoff
- `backend/src/services/updateScheduler.ts` — persist 前检查 pool 健康
- `backend/src/services/persistenceService.ts` — 可能也需要检查

### 测试文件
- `packages/aave-fetcher/tests/fetchBrevisDistributedSoFar.test.ts` — Fix A
- `packages/aave-fetcher/tests/merklAmountVariantBatchDedup.test.ts` — Fix B
- `backend/tests/gscSubpathImport.test.ts` — Fix D
- Fix E 需要: `backend/tests/dbPoolHealth.test.ts`

---

## 相关 Linear Issues

| Issue | 标题 | 状态 |
|---|---|---|
| AAV-889 | Brevis chain call 复用 ProviderPool | Done |
| AAV-890 | Merkl AMOUNT variant batch dedup | Done |
| AAV-893 | Replace googleapis full import with sub-path import | Done |
| AAV-888 | Replace Puppeteer fallback | Open |
| Fix E | pg.Pool DB-unreachable 防护 | **待创建** |

---

## 诊断文档

完整诊断过程和数据见：`docs/plans/diagnosis-railway-oom-2026-06.md`

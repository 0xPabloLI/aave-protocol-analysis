# Handoff: Railway OOM 诊断与修复

**日期**: 2026-06-15（最后更新 2026-06-21）
**来源 Session**: Railway OOM/SIGTERM 根因诊断 → Fix A/B/D/E 实施 + 部署验证
**状态**: Fix A/B/D/E 已完成并验证；Fix C（Puppeteer→Playwright 迁移）已完成

---

## 当前稳态（所有 Fix 部署后）

| 指标 | 修复前 (6月10日) | 修复后 (6月20日) | 改善 |
|---|---|---|---|
| Heap | 269-325MB | **105-176MB** | -45% |
| RSS | 466-517MB | **232-331MB** | -36% |
| External | 20MB | 4MB | -80% |

Railway 1GB 内存限制，当前余量 **~670MB**。

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

### Fix E: pg.Pool DB-unreachable 防护 ✅
- Linear: AAV-899
- `dbPool.ts` 加入 `isPoolHealthy()` + backoff
- `updateScheduler.ts` persist 前检查 pool 健康
- DB 不可达时 persistence cron 跳过写入，不触发连接重试风暴

### Fix C: Puppeteer → Playwright 迁移 ✅
- Commit: `ca635b7`（Playwright 迁移）, `834bced`（移除 puppeteer 依赖）
- Linear: AAV-888
- Puppeteer fallback 替换为 Playwright
- 移除 `puppeteer` + `@types/puppeteer` 死依赖（代码中无 import）
- 添加 `undici: ^7.28.0` override 修复 cheerio 传递的 8 个 high 漏洞

### Fix F: 非阻塞 migration ✅
- Commit: `60dc29b`
- `server.ts` migration 失败时不再 `process.exit(1)`，改为后台每 60s 重试
- App 在 DB 不可达时继续运行，从内存缓存服务 API 请求
- 最大重试 1440 次（24h），防止无限重试

### Fix G: Postgres volume 清理策略 ✅
- Railway env: `ARCHIVE_RETAIN_DAYS=3`（从默认 7 天降到 3 天）
- 根因：7 天保留期 × ~720MB/天增长 = ~5GB，刚好填满 5GB volume
- 3 天保留期将稳态 PG size 控制在 ~2.2GB

### 其他已完成
- `archiveService.ts` column 名修正: `captured_at` → `snapshot_ts` (commit `0b5405d`)
- Postgres volume 清空重建（2026-06-15 volume 满导致 DB 无法启动）
- 诊断文档更新 (commit `7d6995b`)

---

## Postgres Volume 管理

### 当前状态
- Volume: 5GB（`postgres-15fr-volume`）
- 当前使用 ~0.7GB（2026-06-20 重建后）
- `ARCHIVE_RETAIN_DAYS=3`，cleanup 在 PG > 3GB 时触发
- `archive_mode=on`，WAL 归档到 R2 bucket（`postgres-pitr-p4hxxdwohk2`）
- PITR 归档**不占 volume 空间**，占 R2 存储

### Volume 满的根因（2026-06-15 事件）
1. **7 天保留期太长**：数据增长 ~720MB/天（market_snapshots + oracle_prices 每分钟写入），7 天 = ~5GB，刚好填满 5GB volume
2. archiveService cleanup 在 PG > 3GB 时触发，但前 7 天没有 7 天以前的数据可删
3. PG 持续增长到 4.9GB → Postgres 无法写入 WAL → `FATAL: No space left on device` → 崩溃
4. Railway 多次重启失败 → 用空 volume 重建容器 → 数据丢失

### 已修复
- `ARCHIVE_RETAIN_DAYS=3`：3 天数据 ~2.2GB，远低于 5GB volume 限制
- 非阻塞 migration：DB 不可达时 App 不会 crash loop

---

## 已知问题与风险

| 风险 | 严重度 | 说明 |
|---|---|---|
| Postgres volume 再次填满 | **低** | `ARCHIVE_RETAIN_DAYS=3` 已设置，稳态 ~2.2GB |
| DB 不可达导致 crash loop | **已解决** | 非阻塞 migration（Fix F）已部署 |
| Puppeteer fallback 触发 | **已解决** | 已迁移到 Playwright（Fix C） |

---

## 相关文件

### 已修改（已 commit）
- `packages/aave-fetcher/src/brevis-distributed-so-far.ts` — Fix A
- `packages/aave-fetcher/src/index.ts` — Fix A
- `packages/aave-fetcher/src/merkl-api.ts` — Fix B
- `backend/src/services/gscService.ts` — Fix D
- `backend/src/services/archiveService.ts` — column 名修正
- `backend/src/server.ts` — 非阻塞 migration（Fix F）+ heap snapshot 端点（已移除）
- `backend/src/services/dbPool.ts` — Fix E
- `backend/src/services/updateScheduler.ts` — Fix E
- `package.json` — Fix C（移除 puppeteer + undici override）
- `docs/plans/diagnosis-railway-oom-2026-06.md` — 完整诊断文档

### 测试文件
- `packages/aave-fetcher/tests/fetchBrevisDistributedSoFar.test.ts` — Fix A
- `packages/aave-fetcher/tests/merklAmountVariantBatchDedup.test.ts` — Fix B
- `backend/tests/gscSubpathImport.test.ts` — Fix D

---

## 相关 Linear Issues

| Issue | 标题 | 状态 |
|---|---|---|
| AAV-889 | Brevis chain call 复用 ProviderPool | Done |
| AAV-890 | Merkl AMOUNT variant batch dedup | Done |
| AAV-893 | Replace googleapis full import with sub-path import | Done |
| AAV-888 | Replace Puppeteer fallback | Done (Playwright 迁移) |
| AAV-899 | pg.Pool DB-unreachable 防护 | Done |

---

## 诊断文档

完整诊断过程和数据见：`docs/plans/diagnosis-railway-oom-2026-06.md`

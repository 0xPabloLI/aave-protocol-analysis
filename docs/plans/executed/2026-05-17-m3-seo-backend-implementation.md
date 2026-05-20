# M3 SEO Analytics 后端实施计划（Review 修订版）

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在现有 Railway 后端新增 GSC 自动采集 + Semrush 批量种子 + 5 个 REST 接口（+ 1 个诊断接口），为前端 `/admin/seo` Dashboard 提供数据。

**Architecture:** 复用 `pg` 连接池 + `node-cron` 内嵌调度。SEO 路由 **admin 直查 DB**（突破 0-SELECT 归档原则，数据量小、QPS 极低，见 Task 11）。**鉴权：** Railway 仅存 `SEO_ADMIN_TOKEN`；浏览器 **不得** 直连 Railway 带 token——M4 通过 **Vercel BFF**（Route Handler）代发请求并注入 `X-Admin-Token`；curl/CI/灌库脚本可直连 Railway。CORS 复用 `FRONTEND_URL` + `SEO_ALLOWED_ORIGINS` 精确白名单。Semrush 经 Lovable 工具一次性 batch POST，UPSERT 幂等。

**Tech Stack:** Express 5, pg 8, node-cron 4, googleapis, dayjs

**API Base URL（按环境，勿混用）：**

| 环境 | Base URL | 用途 |
|---|---|---|
| production | `https://api.aaveapy.com/api` | 生产灌库、M4 生产 BFF 上游 |
| staging | `https://staging-api.aaveapy.com/api` | 联调、验收、staging 灌库 |

**依赖文档：**
- `docs/plans/m3-railway-backend-spec.md` — 规格（与本计划同步修订）
- `docs/plans/semrush-seed-2026-05-18.json` — Semrush 种子（33 条 / 6 国）
- `backend/src/services/autoMigrate.ts` — 启动时自动跑 migration
- `backend/src/middleware/cors.ts`, `updateScheduler.ts`, `cacheTtl.ts`, `server.ts`, `dbPool.ts`

---

## 实施约束（实施前必读）

1. **鉴权：** `seoAuthMiddleware` 只校验 `X-Admin-Token`；token 比较用 `crypto.timingSafeEqual`（长度须一致）。Dashboard 走 Vercel BFF，**禁止** `VITE_*` 把 token 打进浏览器 bundle。
2. **国家码：** GSC 存 **ISO 3166-1 alpha-3**（`bra`,`fra`,…）；Semrush 种子存 **2 字母**（`br`,`fr`,…）。查询接口各自按表内原值过滤；M4 用共享映射表展示（见下文）。
3. **GSC 写入：** 禁止逐行 UPSERT 循环；必须分页拉取 + 批量 `INSERT … ON CONFLICT`（单事务或分批 500 行）。
4. **`groupBy`：** 仅白名单列；空 `groupBy` = 明细行（无聚合）；非空 = 固定聚合 SQL 模板（见 Task 7）。
5. **查询防护：** `GET /gsc` 日期跨度默认 ≤ 90 天（`SEO_GSC_MAX_DATE_SPAN_DAYS`）；`LIMIT 10000` 保留。
6. **Migration：** 以 **`runMigrations()` 启动自动应用** 为主；`psql -f` 仅本地/应急。
7. **监控：** GSC cron 失败须 `logger.error` + 更新内存诊断状态；`GET /api/seo/status` 供运维查看（见 Task 6b）。

---

## 国家码映射（GSC ↔ Semrush，供 M4 / 文档）

| 市场 | GSC `country` | Semrush `country` |
|---|---|---|
| Brazil | `bra` | `br` |
| France | `fra` | `fr` |
| Turkey | `tur` | `tr` |
| United States | `usa` | `us` |
| Germany | `deu` | `de` |
| India | `ind` | `in` |

实现：`backend/src/utils/seoCountryCodes.ts` 导出 `GSC_TO_SEMRUSH` / `SEMRUSH_TO_GSC`（单向 Map），**不在 DB 层强行统一**，避免破坏 GSC API 原始值。

---

## 原方案修正摘要

| # | 原方案 | 修正 |
|---|---|---|
| 1 | `*.lovable.app` CORS 通配 | `SEO_ALLOWED_ORIGINS` 精确域名 |
| 2 | `VITE_SEO_ADMIN_TOKEN` | `SEO_ADMIN_TOKEN` + **Vercel BFF**（非浏览器直连） |
| 3 | `groupBy` SQL 拼接错误 | 白名单 + 两套固定 SQL（明细 / 聚合） |
| 4 | GSC 不拉 query | 默认 `country,page,query` |
| 5 | 逐行 UPSERT | 分页 + 批量 UPSERT |
| 6 | 无 GSC 分页 | `startRow` 循环至无数据 |
| 7 | migration 仅 psql | **autoMigrate** + `schema_migrations` 校验 |
| 8 | 测试 placeholder | supertest / mock 真实断言 |
| 9 | 无监控 | `gscFetchState` + `GET /api/seo/status` |
| 10 | 国家码混用未说明 | 映射表 + `seoCountryCodes.ts` |
| 11 | batch 无事务 | 单事务批量 UPSERT |
| 12 | `@types/jsonwebtoken` | 删除（未使用） |

## CORS 白名单

| 环境 | 域名 | 配置来源 |
|---|---|---|
| production | `https://aaveapy.com` | `FRONTEND_URL` |
| staging | `https://staging.aaveapy.com` | `FRONTEND_URL` 或 `SEO_ALLOWED_ORIGINS` |
| lovable preview | `https://aaveapy.lovable.app` | `SEO_ALLOWED_ORIGINS`（精确） |
| local dev | `http://localhost:5173`, `http://localhost:8080` | `ALLOWED_DEV_ORIGINS` |

`allowedHeaders`: `Content-Type`, `Authorization`, `X-Admin-Token`  
`methods`: `GET`, `POST`, `DELETE`, `OPTIONS`

---

## Semrush 数据流

```
Lovable semrush--keyword_compare → JSON → POST /api/seo/semrush/batch → Dashboard GET
```

| 接口 | 用途 |
|---|---|
| `GET /api/seo/gsc` | GSC 聚合查询 |
| `GET /api/seo/semrush` | Semrush 种子查询 |
| `POST /api/seo/semrush` | 单条 UPSERT |
| `POST /api/seo/semrush/batch` | 批量灌库（≤5000，单事务） |
| `DELETE /api/seo/semrush/:id` | 删除 |
| `GET /api/seo/status` | GSC cron 诊断（可选鉴权：同 SEO token） |

---

## Task 1: 数据库 Migration

**Files:**
- Create: `backend/migrations/009_gsc_daily_semrush_snapshots.sql`

**Step 1: 编写 migration SQL**

```sql
BEGIN;

CREATE TABLE IF NOT EXISTS gsc_daily (
  id            BIGSERIAL PRIMARY KEY,
  date          DATE         NOT NULL,
  country       TEXT         NOT NULL,  -- GSC API: ISO 3166-1 alpha-3 (bra, fra, ...)
  page          TEXT         NOT NULL,
  query         TEXT         NOT NULL DEFAULT '',
  clicks        INTEGER      NOT NULL DEFAULT 0,
  impressions   INTEGER      NOT NULL DEFAULT 0,
  ctr           NUMERIC(8,5) NOT NULL DEFAULT 0,
  position      NUMERIC(7,2) NOT NULL DEFAULT 0,
  fetched_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (date, country, page, query)
);
CREATE INDEX IF NOT EXISTS idx_gsc_daily_date           ON gsc_daily (date DESC);
CREATE INDEX IF NOT EXISTS idx_gsc_daily_country        ON gsc_daily (country);
CREATE INDEX IF NOT EXISTS idx_gsc_daily_page           ON gsc_daily (page);
CREATE INDEX IF NOT EXISTS idx_gsc_daily_date_country   ON gsc_daily (date DESC, country);

CREATE TABLE IF NOT EXISTS semrush_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  snapshot_date DATE         NOT NULL,
  country       TEXT         NOT NULL,  -- 2-letter: br, fr, tr, us, de, in
  keyword       TEXT         NOT NULL,
  volume        INTEGER      NULL,
  position      NUMERIC(6,2) NULL,
  cpc_usd       NUMERIC(8,2) NULL,
  difficulty    NUMERIC(5,2) NULL,
  notes         TEXT         NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (snapshot_date, country, keyword)
);
CREATE INDEX IF NOT EXISTS idx_semrush_country ON semrush_snapshots (country);
CREATE INDEX IF NOT EXISTS idx_semrush_date    ON semrush_snapshots (snapshot_date DESC);

COMMIT;
```

**Step 2: 本地验证（可选 `psql`）**

```bash
psql "$DATABASE_URL" -f backend/migrations/009_gsc_daily_semrush_snapshots.sql
```

**Step 3: 验证 autoMigrate（推荐路径）**

```bash
npm run dev -w aave-dashboard-backend
# 日志应出现: Running migration: 009_gsc_daily_semrush_snapshots.sql
psql "$DATABASE_URL" -c "SELECT filename FROM schema_migrations WHERE filename LIKE '009%';"
psql "$DATABASE_URL" -c "\d gsc_daily; \d semrush_snapshots;"
```

Expected: migration 记录在 `schema_migrations`；两表存在。

**Step 4: Commit**

```bash
git add backend/migrations/009_gsc_daily_semrush_snapshots.sql
git commit -m "feat(seo): add gsc_daily and semrush_snapshots migration"
```

---

## Task 2: 安装新依赖

**Files:** `backend/package.json`

**Step 1:**

```bash
cd backend && npm install googleapis dayjs
```

不安装 `@types/jsonwebtoken`（本功能不使用 JWT）。

`googleapis` 体积较大；仅 Search Console 只读场景可接受。若后续要瘦身，可改为 `google-auth-library` + REST（非本迭代范围）。

**Step 2:** `node -e "import('googleapis'); import('dayjs'); console.log('ok')"` → `ok`

**Step 3: Commit**

```bash
git add backend/package.json backend/package-lock.json
git commit -m "feat(seo): add googleapis and dayjs dependencies"
```

---

## Task 3: 国家码映射工具

**Files:**
- Create: `backend/src/utils/seoCountryCodes.ts`
- Test: `backend/tests/seoCountryCodes.test.ts`

**Step 1: 实现 Map（6 国完整双向）**

```ts
export const GSC_TO_SEMRUSH: Readonly<Record<string, string>> = {
  bra: 'br', fra: 'fr', tur: 'tr', usa: 'us', deu: 'de', ind: 'in',
};
export const SEMRUSH_TO_GSC: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(GSC_TO_SEMRUSH).map(([g, s]) => [s, g])
) as Record<string, string>;
```

**Step 2:** 测试 `bra→br`、`br→bra`、未知键返回 `undefined`。

**Step 3: Commit**

```bash
git add backend/src/utils/seoCountryCodes.ts backend/tests/seoCountryCodes.test.ts
git commit -m "feat(seo): add GSC/Semrush country code mapping"
```

---

## Task 4: SEO Admin 鉴权中间件

**Files:**
- Create: `backend/src/middleware/seoAuth.ts`
- Test: `backend/tests/seoAuth.test.ts`

**要点:**
- `SEO_ADMIN_TOKEN` 未配置 → **503**
- 缺/错 token → **401**
- 使用 `timingSafeEqual`（token 须为固定长度 hex，如 32 字节 = 64 hex 字符）

```ts
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function seoAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.SEO_ADMIN_TOKEN;
  if (!expected) {
    res.status(503).json({ error: 'SEO admin auth not configured' });
    return;
  }
  const provided = req.headers['x-admin-token'];
  const token = typeof provided === 'string' ? provided : '';
  if (!safeEqual(token, expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
```

**M4 约定（写进 `docs/api/seo-api-documentation.md`）：** Vercel Route Handler 读取 `SEO_ADMIN_TOKEN`（Server-only env），转发至 Railway 时设置 `X-Admin-Token`。

**Commit:** `feat(seo): add timing-safe SEO admin auth middleware`

---

## Task 5: CORS 扩展

**Files:**
- Modify: `backend/src/middleware/cors.ts`
- Create: `backend/src/middleware/corsOrigin.ts`（导出 `normalizeOrigin`, `isOriginAllowed` 供测试）
- Test: `backend/tests/corsSeo.test.ts`

**改动:**
1. 将 `normalizeOrigin` / `isOriginAllowed` 抽到 `corsOrigin.ts`，`cors.ts` 复用。
2. 在 `FRONTEND_URL` / `ALLOWED_DEV_ORIGINS` 之后检查 `SEO_ALLOWED_ORIGINS`（逗号分隔，精确匹配）。
3. `allowedHeaders` 增加 `X-Admin-Token`；`methods` 增加 `DELETE`。

**测试（真实断言，非 placeholder）:**

```ts
test('SEO_ALLOWED_ORIGINS allows exact lovable preview origin', () => {
  process.env.SEO_ALLOWED_ORIGINS = 'https://aaveapy.lovable.app';
  assert.equal(isOriginAllowed('https://aaveapy.lovable.app', parseSeoOrigins()), true);
  assert.equal(isOriginAllowed('https://evil.lovable.app', parseSeoOrigins()), false);
});
```

**Commit:** `feat(seo): extend CORS for SEO origins and X-Admin-Token`

---

## Task 6: GSC 数据采集 Service

**Files:**
- Create: `backend/src/services/gscService.ts`
- Create: `backend/src/services/gscFetchState.ts`（内存诊断状态）
- Test: `backend/tests/gscService.test.ts`

**要点:**
- 维度：`['country','page','query']`
- 日期：`dayjs().subtract(3,'day')`（GSC 延迟）
- **分页：** `rowLimit: 25000`，`startRow` 递增直到返回 0 行
- **重试：** 429/5xx，最多 3 次指数退避
- **写入：** `upsertGscRows(pool, targetDate, rows)` — 每批最多 500 行，`INSERT … SELECT FROM unnest($1::date[], …) ON CONFLICT DO UPDATE`，**单批单事务**
- 导出 `getGscFetchState()` / `setGscFetchSuccess` / `setGscFetchFailure`

**分页拉取伪代码:**

```ts
const allRows: GscRow[] = [];
let startRow = 0;
const rowLimit = 25000;
for (;;) {
  const res = await webmasters.searchanalytics.query({
    siteUrl: process.env.GSC_SITE_URL!,
    requestBody: { startDate, endDate, dimensions, rowLimit, startRow, dataState: 'final' },
  });
  const batch = res.data.rows ?? [];
  allRows.push(...batch);
  if (batch.length < rowLimit) break;
  startRow += rowLimit;
}
```

**批量 UPSERT（核心，禁止 for-loop 单条 query）:**

```sql
INSERT INTO gsc_daily (date, country, page, query, clicks, impressions, ctr, position)
SELECT * FROM UNNEST($1::date[], $2::text[], $3::text[], $4::text[], $5::int[], $6::int[], $7::numeric[], $8::numeric[])
ON CONFLICT (date, country, page, query) DO UPDATE SET
  clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions,
  ctr = EXCLUDED.ctr, position = EXCLUDED.position, fetched_at = now();
```

**可选：首次部署 backfill** — 环境变量 `GSC_BACKFILL_DAYS=28` 时，启动后一次性拉最近 N 天（仍用 `today-3` 逻辑逐日）；默认不启用。

**Commit:** `feat(seo): GSC fetch with pagination and batch upsert`

---

## Task 6b: GSC Cron + 监控诊断

**Files:**
- Modify: `backend/src/cacheTtl.ts` — `gscDailyFetchAtSixAmUtc: '0 0 6 * * *'`
- Modify: `backend/src/services/updateScheduler.ts`
- Modify: `backend/src/controllers/seoController.ts` — `getSeoStatus`
- Modify: `backend/src/routes/seo.ts` — `GET /status`

**Cron:**

```ts
schedule(BACKEND_SCHEDULE_CRON.gscDailyFetchAtSixAmUtc, async () => {
  if (!process.env.GSC_SA_EMAIL) return;
  try {
    const result = await fetchAndPersistGscDaily();
    setGscFetchSuccess(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    setGscFetchFailure(msg);
    logger.error(`GSC daily fetch failed: ${msg}`);  // 升级 warn → error，便于日志告警
  }
});
```

**`GET /api/seo/status` 响应示例:**

```json
{
  "gsc": {
    "lastSuccessAt": "2026-05-18T06:01:12.000Z",
    "lastTargetDate": "2026-05-15",
    "lastRowsUpserted": 1240,
    "lastError": null
  }
}
```

无 Sentry 时依赖 Railway 日志告警规则匹配 `GSC daily fetch failed`。

**Commit:** `feat(seo): GSC cron at 06:00 UTC and /api/seo/status diagnostic`

---

## Task 7: SEO Controller + Routes

**Files:**
- Create: `backend/src/controllers/seoController.ts`
- Create: `backend/src/routes/seo.ts`
- Create: `backend/src/utils/escapeIlike.ts` — 转义 `%` `_`
- Modify: `backend/src/server.ts` — `app.use('/api/seo', seoRouter)`
- Test: `backend/tests/seoRoutes.test.ts`, `backend/tests/seoController.test.ts`

### `buildGscQuery(groups)` — 正确实现

```ts
const VALID_GROUP_BY = ['date', 'country', 'page', 'query'] as const;
type GroupBy = (typeof VALID_GROUP_BY)[number];

const METRIC_SELECT = `
  SUM(clicks)::int AS clicks,
  SUM(impressions)::int AS impressions,
  CASE WHEN SUM(impressions) > 0 THEN (SUM(clicks)::numeric / SUM(impressions))::numeric(8,5) ELSE 0 END AS ctr,
  CASE WHEN SUM(impressions) > 0 THEN (SUM(position * impressions) / SUM(impressions))::numeric(7,2) ELSE 0 END AS position
`;

function buildGscQuery(groups: GroupBy[]): { sql: string; hasGroupBy: boolean } {
  if (groups.length === 0) {
    return {
      sql: `SELECT date, country, page, query, clicks, impressions, ctr, position`,
      hasGroupBy: false,
    };
  }
  const cols = groups.join(', ');
  return {
    sql: `SELECT ${cols}, ${METRIC_SELECT}`,
    hasGroupBy: true,
  };
}
```

`getGscData` 中：
- `hasGroupBy === false` → **无 `GROUP BY`**（明细）
- `hasGroupBy === true` → `GROUP BY ${cols}` + `ORDER BY` 首列 DESC
- 日期跨度：`daysBetween(from, to) > maxSpan` → 400（默认 `SEO_GSC_MAX_DATE_SPAN_DAYS=90`）
- `country` 逗号分隔，最多 20；`page` 精确匹配

### Semrush

- `keyword` ILIKE：先 `escapeIlike(keyword)` 再包 `%`
- `batchUpsertSemrushSnapshots`：**`BEGIN` → 校验数组 → `unnest` 批量 UPSERT → `COMMIT`**；任一校验失败整批 400；DB 错误 `ROLLBACK` → 500
- 简单 rate limit（内存）：同一 token 每分钟 batch 请求 ≤ 5（防 token 泄露滥用）

### Router

```ts
router.use(seoAuthMiddleware);
router.get('/status', getSeoStatus);
router.get('/gsc', getGscData);
router.get('/semrush', getSemrushSnapshots);
router.post('/semrush', upsertSemrushSnapshot);
router.post('/semrush/batch', batchUpsertSemrushSnapshots);
router.delete('/semrush/:id', deleteSemrushSnapshot);
```

**Commit:** `feat(seo): SEO routes with safe groupBy and transactional batch upsert`

---

## Task 8: 集成测试（supertest）

**Files:** `backend/tests/seoIntegration.test.ts`

**依赖:** 测试库可用现有 Express app 工厂，或 `supertest` + 内存 mock pool（推荐 mock `getPool`）。

**必覆盖:**
| 场景 | 期望 |
|---|---|
| 无 `X-Admin-Token` | 401 |
| 错误 token | 401 |
| `GET /gsc` 缺 from | 400 |
| `GET /gsc` from > to | 400 |
| `GET /gsc` 跨度 > 90 天 | 400 |
| `GET /gsc?groupBy=country` | 200，行字段含 `country,clicks,…` |
| `POST /semrush/batch` 空数组 | 400 |
| CORS preflight `OPTIONS` + `X-Admin-Token` | 204/200 |

**Commit:** `test(seo): add supertest integration tests`

---

## Task 9: GSC Service 单元测试（mock googleapis）

**Files:** `backend/tests/gscService.test.ts`

使用 `node:test` + 手动 stub（或 `mock.module`）：

1. 空 rows → `{ rowsUpserted: 0 }`，`lastError` 不变
2. 单页 < 25000 → 只调一次 API
3. 25000 + 100 行 → `startRow` 0 和 25000 各一次
4. 429 两次后成功 → 共 3 次调用
5. `upsertGscRows` 被调用且参数行数正确（mock pool.query）

**禁止** `assert.ok(true, 'placeholder')`。

**Commit:** `test(seo): GSC service pagination and retry tests`

---

## Task 10: API 文档 + Spec 同步

**Files:**
- Create: `docs/api/seo-api-documentation.md`
- Modify: `docs/plans/m3-railway-backend-spec.md`（对齐本修订：BFF、国家码、分页、status 端点、API base URL）

文档须含：6 个接口、错误格式、环境变量、CORS、国家码表、BFF 模式、staging/production base URL、回滚步骤。

**Commit:** `docs(seo): API documentation and spec alignment`

---

## Task 11: 连接池注释 + 全量验证

**Files:** `backend/src/services/dbPool.ts`

```ts
// Pool max=5: persistence cron (~1 conn/min) + SEO admin直查 (QPS<1) + GSC batch write (brief).
// GSC cron 使用批量 UPSERT，避免长时间占满连接。
```

```bash
npm run build && npm run build -w aave-dashboard-backend && npm run test -w aave-dashboard-backend
rg "dist/index\.js|\.\.\/\.\.\/\.\.\/dist" backend/src tests  # 须为空
```

**Commit:** `docs(seo): connection pool note for SEO direct-query`

---

## Task 12: Semrush 种子灌库（按环境）

**前置:** Task 1–7、4（token）、staging/production `SEO_ADMIN_TOKEN` 已配置。

### Staging（联调推荐）

```bash
TOKEN="<STAGING_SEO_ADMIN_TOKEN>"
BASE="https://staging-api.aaveapy.com/api"

jq -c '{ snapshots: .rows }' docs/plans/semrush-seed-2026-05-18.json | \
  curl -sS -X POST "$BASE/seo/semrush/batch" \
    -H "X-Admin-Token: $TOKEN" \
    -H "Content-Type: application/json" \
    -d @- | jq .
```

Expected: `{"upserted":33,"total":33}`

### Production（验收通过后）

```bash
BASE="https://api.aaveapy.com/api"
# 同上，使用 production token
```

**验证:**

```bash
psql "$DATABASE_URL" -c "SELECT count(*), count(DISTINCT country) FROM semrush_snapshots;"
# count=33, countries=6 (br,fr,tr,us,de,in)
```

重复灌库 → count 仍为 33（幂等）。

**Commit（仅种子文件未入库时）:** `feat(seo): add Semrush seed data JSON`

---

## 环境变量清单

| 变量 | 位置 | 说明 |
|---|---|---|
| `SEO_ADMIN_TOKEN` | Railway + Vercel (**Server only**) | 64 hex chars；BFF 注入 header |
| `SEO_ALLOWED_ORIGINS` | Railway | 例：`https://aaveapy.lovable.app` |
| `SEO_GSC_MAX_DATE_SPAN_DAYS` | Railway | 默认 `90` |
| `GSC_SA_EMAIL` | Railway | Service account |
| `GSC_SA_PRIVATE_KEY` | Railway secret | RSA key，`\n` 转义 |
| `GSC_SITE_URL` | Railway | 如 `https://aaveapy.com/` |
| `GSC_BACKFILL_DAYS` | Railway | 可选；首次 `28`，日常 cron 忽略 |

**Vercel（M4，非本迭代实现但须预留）:**
- `SEO_ADMIN_TOKEN` — **仅** Route Handler，`runtime: 'nodejs'`，不出现在 client bundle

---

## 回滚方案

| 步骤 | 操作 |
|---|---|
| 1 | 移除 `server.ts` 中 `/api/seo` |
| 2 | 移除 `updateScheduler` GSC cron + `gscFetchState` |
| 3 | `DROP TABLE IF EXISTS gsc_daily, semrush_snapshots;` |
| 4 | 删除 `schema_migrations` 中 `009_...` 行（若需重跑 migration） |
| 5 | 移除 SEO/GSC 环境变量 |
| 6 | `npm uninstall googleapis dayjs`（在 backend workspace） |

---

## 错误响应格式

```json
{ "error": "描述", "details": "可选" }
```

5xx: `{ "error": "Internal server error" }`（不泄漏 SQL/堆栈）

---

## 任务顺序与预估

| 顺序 | Task | 预估 |
|---|---|---|
| 1 | Task 1 Migration | 0.25d |
| 2 | Task 2 依赖 | 0.1d |
| 3 | Task 3 国家码 | 0.1d |
| 4 | Task 4 鉴权 | 0.25d |
| 5 | Task 5 CORS | 0.25d |
| 6 | Task 6 + 6b GSC + cron + status | 0.5d |
| 7 | Task 7 Routes | 0.5d |
| 8 | Task 8–9 测试 | 0.35d |
| 9 | Task 10 文档 | 0.15d |
| 10 | Task 11 验证 | 0.1d |
| 11 | Task 12 灌库 | 0.1d |
| **合计** | | **~2.2 人日** |

---

## M4 交接清单（后端完成后）

1. Migration `009` 已在目标环境 `schema_migrations` 中
2. `GET /api/seo/status` → `lastSuccessAt` 非空（GSC cron ≥1 次成功）
3. Staging 上 5+1 接口 curl 通过；Semrush count ≈ 33
4. 安全渠道提供 **staging** `SEO_ADMIN_TOKEN`；production token 待 go-live
5. 确认 M4 实现 **Vercel BFF**，不直连 Railway

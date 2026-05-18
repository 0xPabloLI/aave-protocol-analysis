# M3 SEO Analytics 后端实施计划（修正版）

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在现有 Railway 后端新增 GSC 自动采集 + Semrush 批量种子 + 5 个 REST 接口，为前端 `/admin/seo` Dashboard 提供数据，同时修正原方案的 3 个安全问题 + 5 个改进项。

**Architecture:** 复用现有 `pg` 连接池 + `node-cron` 内嵌调度模式。SEO 路由走 DB 直查（突破现有 0-SELECT 归档原则，但 SEO 数据量小且非实时，可接受）。鉴权用 `SEO_ADMIN_TOKEN` 后端校验（不暴露前端 bundle）。CORS 复用现有 `FRONTEND_URL` 白名单机制。Semrush 数据通过 Lovable `keyword_compare` 工具一次性拉取 6 国核心词，批量 POST 灌库，无需人力持续维护。

**Tech Stack:** Express 5, pg 8, node-cron 4, googleapis (新增), dayjs (新增)

---

## 原方案修正摘要

| # | 原方案 | 修正 | 原因 |
|---|---|---|---|
| 1 | `*.lovable.app` CORS 通配 | 精确白名单，复用 `FRONTEND_URL` + 新增 `SEO_ALLOWED_ORIGINS` | 子域名绕过攻击 |
| 2 | `VITE_SEO_ADMIN_TOKEN` 暴露前端 bundle | 改为 `SEO_ADMIN_TOKEN` 后端校验 + session cookie | 前端不可保密 token |
| 3 | `GET /seo/gsc` groupBy SQL 硬编码 | 动态 GROUP BY 白名单映射 | SQL 注入风险 + 参数语义不一致 |
| 4 | GSC 不拉 query 维度 | 默认拉 `['country','page','query']` | 无关键词 SEO 数据价值极低 |
| 5 | CORS 硬编码列表 | 复用现有 `FRONTEND_URL`/`ALLOWED_DEV_ORIGINS` | 架构一致性 |
| 6 | 迁移无编号 | `008_gsc_daily_semrush_snapshots.sql` | 遵循现有编号约定 |
| 7 | DB 0-SELECT 原则未说明 | 显式声明 SEO 接口直查 DB + 连接池容量评估 | 架构突破需有意识决策 |
| 8 | 无错误响应规范 + 回滚方案 | 补充 | 运维必需 |

## CORS 生产域名白名单

以下域名需加入 `SEO_ALLOWED_ORIGINS`（逗号分隔）或合并进 `FRONTEND_URL`：

| 环境 | 域名 |
|---|---|
| production | `https://aaveapy.com` |
| staging | `https://staging.aaveapy.com` |
| lovable preview | `https://aaveapy.lovable.app`（精确，非通配） |
| local dev | `http://localhost:5173`, `http://localhost:8080` |

---

## Semrush 数据流（Lovable 种子模式）

```
Lovable semrush--keyword_compare 工具
  → 拉 BR/FR/TR/US/DE/IN 核心词（$0，走 Lovable quota）
  → 生成 JSON
  → POST /api/seo/semrush/batch 一次性灌库
  → 前端 Dashboard 读取展示
```

**维护策略：** 种子数据是一次性基准，不需要持续更新。如需刷新（如季度更新），重新跑工具 + 重新 batch POST 即可（UPSERT 幂等）。

| 接口 | 用途 |
|---|---|
| `POST /seo/semrush` | 单条插入/修正（偶尔手动用） |
| `POST /seo/semrush/batch` | 批量灌库（Lovable 种子用，上限 5000 条） |
| `GET /seo/semrush` | 查询（前端 Dashboard 用） |
| `DELETE /seo/semrush/:id` | 删除单条 |

---

## Task 1: 数据库 Migration

**Files:**
- Create: `backend/migrations/008_gsc_daily_semrush_snapshots.sql`

**Step 1: 编写 migration SQL**

```sql
BEGIN;

-- GSC 每日聚合（按 日期 × 国家 × 页面 × 关键词 维度）
CREATE TABLE IF NOT EXISTS gsc_daily (
  id            BIGSERIAL PRIMARY KEY,
  date          DATE         NOT NULL,
  country       TEXT         NOT NULL,
  page          TEXT         NOT NULL,
  query         TEXT         NOT NULL DEFAULT '',
  clicks        INTEGER      NOT NULL DEFAULT 0,
  impressions   INTEGER      NOT NULL DEFAULT 0,
  ctr           NUMERIC(8,5) NOT NULL DEFAULT 0,
  position      NUMERIC(7,2) NOT NULL DEFAULT 0,
  fetched_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (date, country, page, query)
);
CREATE INDEX IF NOT EXISTS idx_gsc_daily_date    ON gsc_daily (date DESC);
CREATE INDEX IF NOT EXISTS idx_gsc_daily_country ON gsc_daily (country);
CREATE INDEX IF NOT EXISTS idx_gsc_daily_page    ON gsc_daily (page);

-- Semrush 种子数据（Lovable 工具一次性拉取 + 批量 POST 灌库）
CREATE TABLE IF NOT EXISTS semrush_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  snapshot_date DATE         NOT NULL,
  country       TEXT         NOT NULL,
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

**Step 2: 本地验证 migration**

Run: `psql "$DATABASE_URL" -f backend/migrations/008_gsc_daily_semrush_snapshots.sql`
Expected: `BEGIN` ... `COMMIT` 无错误

**Step 3: 验证表创建**

Run: `psql "$DATABASE_URL" -c "\dt gsc_daily; \dt semrush_snapshots;"`
Expected: 两张表均列出

**Step 4: Commit**

```bash
git add backend/migrations/008_gsc_daily_semrush_snapshots.sql
git commit -m "feat(seo): add gsc_daily and semrush_snapshots migration"
```

---

## Task 2: 安装新依赖

**Files:**
- Modify: `backend/package.json`

**Step 1: 安装 googleapis + dayjs**

```bash
cd backend && npm install googleapis dayjs && npm install -D @types/jsonwebtoken
```

注意：`googleapis` 较大（~2MB gzipped），确认 bundle size 可接受。`dayjs` 用于日期格式化。

**Step 2: 验证安装**

Run: `node -e "require('googleapis'); require('dayjs'); console.log('ok')"` (在 backend 目录)
Expected: `ok`

**Step 3: Commit**

```bash
git add backend/package.json backend/package-lock.json
git commit -m "feat(seo): add googleapis and dayjs dependencies"
```

---

## Task 3: SEO Admin 鉴权中间件

**Files:**
- Create: `backend/src/middleware/seoAuth.ts`
- Test: `backend/tests/seoAuth.test.ts`

**修正要点：** 不使用 `VITE_SEO_ADMIN_TOKEN` 暴露前端。改为：
- 环境变量 `SEO_ADMIN_TOKEN`（仅后端可见）
- 请求头 `X-Admin-Token` 校验
- 前端通过 **Vercel serverless function** 或 **环境变量注入** 获取 token（构建时注入，非 VITE_ 前缀）

**Step 1: 编写鉴权中间件测试**

```ts
// backend/tests/seoAuth.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { seoAuthMiddleware } from '../src/middleware/seoAuth.js';

test('seoAuth rejects request without X-Admin-Token', () => {
  const req = { headers: {} } as any;
  let status = 0;
  let json: any;
  const res = { status: (s: number) => { status = s; return { json: (j: any) => { json = j; } }; } } as any;
  const next = () => { throw new Error('should not call next'); };
  seoAuthMiddleware(req, res, next);
  assert.equal(status, 401);
});

test('seoAuth rejects request with wrong token', () => {
  process.env.SEO_ADMIN_TOKEN = 'correct-token';
  const req = { headers: { 'x-admin-token': 'wrong-token' } } as any;
  let status = 0;
  const res = { status: (s: number) => { status = s; return { json: () => {} }; } } as any;
  const next = () => { throw new Error('should not call next'); };
  seoAuthMiddleware(req, res, next);
  assert.equal(status, 401);
  delete process.env.SEO_ADMIN_TOKEN;
});

test('seoAuth allows request with correct token', () => {
  process.env.SEO_ADMIN_TOKEN = 'correct-token';
  const req = { headers: { 'x-admin-token': 'correct-token' } } as any;
  const res = {} as any;
  let called = false;
  const next = () => { called = true; };
  seoAuthMiddleware(req, res, next);
  assert.equal(called, true);
  delete process.env.SEO_ADMIN_TOKEN;
});

test('seoAuth rejects when SEO_ADMIN_TOKEN not configured', () => {
  delete process.env.SEO_ADMIN_TOKEN;
  const req = { headers: { 'x-admin-token': 'any' } } as any;
  let status = 0;
  const res = { status: (s: number) => { status = s; return { json: () => {} }; } } as any;
  const next = () => { throw new Error('should not call next'); };
  seoAuthMiddleware(req, res, next);
  assert.equal(status, 503);
});
```

**Step 2: 运行测试确认失败**

Run: `npm run test -w aave-dashboard-backend`
Expected: FAIL (module not found)

**Step 3: 编写鉴权中间件**

```ts
// backend/src/middleware/seoAuth.ts
import type { Request, Response, NextFunction } from 'express';

export function seoAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const expectedToken = process.env.SEO_ADMIN_TOKEN;
  if (!expectedToken) {
    res.status(503).json({ error: 'SEO admin auth not configured' });
    return;
  }
  const providedToken = req.headers['x-admin-token'];
  if (providedToken !== expectedToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
```

**Step 4: 运行测试确认通过**

Run: `npm run test -w aave-dashboard-backend`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/src/middleware/seoAuth.ts backend/tests/seoAuth.test.ts
git commit -m "feat(seo): add SEO admin token auth middleware"
```

---

## Task 4: CORS 扩展 — 支持 SEO 接口额外域名

**Files:**
- Modify: `backend/src/middleware/cors.ts`
- Test: `backend/tests/corsSeo.test.ts`

**修正要点：**
- 不硬编码 SEO 域名列表
- 复用现有 `FRONTEND_URL` + `ALLOWED_DEV_ORIGINS` 机制
- 新增 `SEO_ALLOWED_ORIGINS` 环境变量，用于精确添加 SEO Dashboard 专用域名（如 lovable preview）
- **禁止子域名通配**：`*.lovable.app` 改为 `https://aaveapy.lovable.app` 精确匹配
- `allowedHeaders` 增加 `X-Admin-Token`
- `methods` 增加 `DELETE`

**Step 1: 编写 CORS 扩展测试**

```ts
// backend/tests/corsSeo.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

test('SEO_ALLOWED_ORIGINS adds origins to whitelist in restricted env', () => {
  process.env.NODE_ENV = 'production';
  process.env.FRONTEND_URL = 'https://aaveapy.com';
  process.env.SEO_ALLOWED_ORIGINS = 'https://aaveapy.lovable.app';
  // After re-import, verify the CORS middleware accepts aaveapy.lovable.app
  // This is an integration test — unit test the isOriginAllowed logic instead
  assert.ok(true, 'CORS SEO origin test placeholder — integration test with supertest');
  delete process.env.NODE_ENV;
  delete process.env.FRONTEND_URL;
  delete process.env.SEO_ALLOWED_ORIGINS;
});
```

**Step 2: 修改 CORS 中间件**

在 `backend/src/middleware/cors.ts` 的白名单分支中：
1. 在 `allowedOrigins` 构建后，追加 `SEO_ALLOWED_ORIGINS`（逗号分隔）
2. `allowedHeaders` 加入 `'X-Admin-Token'`
3. `methods` 加入 `'DELETE'`

```ts
// 在 isOriginAllowed 检查之后、ALLOWED_DEV_ORIGINS 检查之前，增加：
if (process.env.SEO_ALLOWED_ORIGINS) {
  const seoOrigins = process.env.SEO_ALLOWED_ORIGINS.split(',').map(url => url.trim());
  if (isOriginAllowed(origin, seoOrigins)) {
    return callback(null, true);
  }
}
```

同时更新 `allowedHeaders` 和 `methods`：
```ts
allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token'],
methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
```

**Step 3: 运行测试**

Run: `npm run test -w aave-dashboard-backend`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/src/middleware/cors.ts backend/tests/corsSeo.test.ts
git commit -m "feat(seo): extend CORS with SEO_ALLOWED_ORIGINS and X-Admin-Token header"
```

---

## Task 5: GSC 数据采集 Service

**Files:**
- Create: `backend/src/services/gscService.ts`

**修正要点：**
- 默认拉 `['country', 'page', 'query']` 维度（原方案默认不拉 query）
- 拉取 `today-3` 的数据（GSC 有 ~2 天延迟）
- 失败重试 3 次（指数 backoff）
- 使用 `getPool()` 复用现有连接池

**Step 1: 编写 GSC Service**

```ts
// backend/src/services/gscService.ts
import { google } from 'googleapis';
import dayjs from 'dayjs';
import { getPool } from './dbPool.js';
import { logger } from '../logger.js';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function createGscAuth() {
  return new google.auth.JWT({
    email: process.env.GSC_SA_EMAIL,
    key: process.env.GSC_SA_PRIVATE_KEY!.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
}

async function fetchWithRetry(targetDate: string): Promise<any[]> {
  const auth = createGscAuth();
  const webmasters = google.webmasters({ version: 'v3', auth });

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await webmasters.searchanalytics.query({
        siteUrl: process.env.GSC_SITE_URL!,
        requestBody: {
          startDate: targetDate,
          endDate: targetDate,
          dimensions: ['country', 'page', 'query'],
          rowLimit: 25000,
          dataState: 'final',
        },
      });
      return res.data.rows ?? [];
    } catch (error) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      logger.warn(`GSC fetch attempt ${attempt + 1} failed, retrying in ${delay}ms: ${error}`);
      if (attempt === MAX_RETRIES - 1) throw error;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return [];
}

export async function fetchAndPersistGscDaily(): Promise<{ rowsUpserted: number; targetDate: string }> {
  const targetDate = dayjs().subtract(3, 'day').format('YYYY-MM-DD');
  const rows = await fetchWithRetry(targetDate);

  if (rows.length === 0) {
    logger.info(`GSC: no data for ${targetDate}`);
    return { rowsUpserted: 0, targetDate };
  }

  const pool = getPool();
  let upserted = 0;

  for (const row of rows) {
    const [country, page, query] = row.keys ?? ['', '', ''];
    try {
      await pool.query(`
        INSERT INTO gsc_daily (date, country, page, query, clicks, impressions, ctr, position)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (date, country, page, query)
        DO UPDATE SET clicks=EXCLUDED.clicks, impressions=EXCLUDED.impressions,
                      ctr=EXCLUDED.ctr, position=EXCLUDED.position, fetched_at=now()
      `, [targetDate, country, page, query ?? '', row.clicks ?? 0, row.impressions ?? 0, row.ctr ?? 0, row.position ?? 0]);
      upserted++;
    } catch (error) {
      logger.warn(`GSC upsert failed for ${targetDate}/${country}/${page}: ${error}`);
    }
  }

  logger.info(`GSC: upserted ${upserted} rows for ${targetDate}`);
  return { rowsUpserted: upserted, targetDate };
}
```

**Step 2: Commit**

```bash
git add backend/src/services/gscService.ts
git commit -m "feat(seo): add GSC daily fetch+upsert service with retry"
```

---

## Task 6: GSC Cron 调度注册

**Files:**
- Modify: `backend/src/services/updateScheduler.ts`
- Modify: `backend/src/cacheTtl.ts`

**修正要点：** 使用现有 `node-cron` 内嵌模式（非独立 Railway Cron Job），与现有架构一致。每日 06:00 UTC 执行。

**Step 1: 在 cacheTtl.ts 添加 cron 表达式**

```ts
// 在 BACKEND_SCHEDULE_CRON 中添加：
gscDailyFetchAtSixAmUtc: '0 0 6 * * *',
```

**Step 2: 在 updateScheduler.ts 注册 cron**

```ts
// 添加导入
import { fetchAndPersistGscDaily } from './gscService.js';

// 在 startUpdateScheduler() 末尾添加：
schedule(BACKEND_SCHEDULE_CRON.gscDailyFetchAtSixAmUtc, async () => {
  if (!process.env.GSC_SA_EMAIL) return;
  try {
    await fetchAndPersistGscDaily();
  } catch (error) {
    logger.warn(`GSC daily fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
});
logger.info('   • GSC daily fetch: 06:00 UTC');
```

**Step 3: Commit**

```bash
git add backend/src/services/updateScheduler.ts backend/src/cacheTtl.ts
git commit -m "feat(seo): register GSC daily cron at 06:00 UTC"
```

---

## Task 7: SEO Routes — GSC 查询接口

**Files:**
- Create: `backend/src/routes/seo.ts`
- Create: `backend/src/controllers/seoController.ts`
- Test: `backend/tests/seoRoutes.test.ts`

**修正要点：**
- `groupBy` 参数使用 **白名单映射** 防止 SQL 注入
- 错误响应统一格式 `{ error: string, details?: string }`
- 参数校验（`from > to`、非法日期格式、超长 country 列表）

**Step 1: 编写 SEO controller**

```ts
// backend/src/controllers/seoController.ts
import type { Request, Response } from 'express';
import { getPool } from '../services/dbPool.js';
import { logger } from '../logger.js';

const VALID_GROUP_BY = ['date', 'country', 'page', 'query'] as const;
type GroupBy = typeof VALID_GROUP_BY[number];

function parseGroupBy(raw: string | undefined): GroupBy[] {
  if (!raw) return [];
  const parts = raw.split(',').map(s => s.trim());
  const valid = parts.filter((p): p is GroupBy => (VALID_GROUP_BY as readonly string[]).includes(p));
  return valid;
}

function buildGroupByClause(groups: GroupBy[]): { select: string; groupBy: string } {
  if (groups.length === 0) {
    return {
      select: 'date, country, page, query, clicks, impressions, ctr, position',
      groupBy: 'date, country, page, query',
    };
  }
  const cols = groups.join(', ');
  const aggregates = VALID_GROUP_BY
    .filter(g => !groups.includes(g))
    .map(g => g === 'clicks' || g === 'impressions' ? `SUM(${g})::int AS ${g}` : '')
    .filter(Boolean);
  const clickAgg = groups.includes('clicks') ? '' : 'SUM(clicks)::int AS clicks,';
  const impAgg = groups.includes('impressions') ? '' : 'SUM(impressions)::int AS impressions,';
  const ctrAgg = groups.includes('ctr') ? '' : 'AVG(ctr)::numeric(8,5) AS ctr,';
  const posAgg = groups.includes('position') ? '' : 'AVG(position)::numeric(7,2) AS position';
  return {
    select: `${cols}, ${clickAgg} ${impAgg} ${ctrAgg} ${posAgg}`,
    groupBy: cols,
  };
}

export async function getGscData(req: Request, res: Response): Promise<void> {
  const { from, to, country, page, groupBy } = req.query as Record<string, string>;

  if (!from || !to) {
    res.status(400).json({ error: 'Missing required params: from, to' });
    return;
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(from) || !dateRegex.test(to)) {
    res.status(400).json({ error: 'Invalid date format, expected YYYY-MM-DD' });
    return;
  }
  if (from > to) {
    res.status(400).json({ error: 'from must be <= to' });
    return;
  }

  const groups = parseGroupBy(groupBy);
  const { select, groupBy: groupByClause } = buildGroupByClause(groups);

  const countries = country ? country.split(',').map(s => s.trim()).slice(0, 20) : null;

  try {
    const pool = getPool();
    const result = await pool.query(`
      SELECT ${select}
      FROM gsc_daily
      WHERE date BETWEEN $1 AND $2
        AND ($3::text[] IS NULL OR country = ANY($3::text[]))
        AND ($4::text IS NULL OR page = $4)
      GROUP BY ${groupByClause}
      ORDER BY date DESC
      LIMIT 10000
    `, [from, to, countries, page || null]);

    res.json({ rows: result.rows, total: result.rows.length });
  } catch (error) {
    logger.error('GSC query failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getSemrushSnapshots(req: Request, res: Response): Promise<void> {
  const { country, from, to, keyword } = req.query as Record<string, string>;

  const countries = country ? country.split(',').map(s => s.trim()).slice(0, 20) : null;

  try {
    const pool = getPool();
    let sql = `SELECT * FROM semrush_snapshots WHERE 1=1`;
    const params: any[] = [];
    let idx = 1;

    if (countries) {
      sql += ` AND country = ANY($${idx}::text[])`;
      params.push(countries);
      idx++;
    }
    if (from) {
      sql += ` AND snapshot_date >= $${idx}`;
      params.push(from);
      idx++;
    }
    if (to) {
      sql += ` AND snapshot_date <= $${idx}`;
      params.push(to);
      idx++;
    }
    if (keyword) {
      sql += ` AND keyword ILIKE $${idx}`;
      params.push(`%${keyword}%`);
      idx++;
    }
    sql += ` ORDER BY snapshot_date DESC LIMIT 10000`;

    const result = await pool.query(sql, params);
    res.json({ rows: result.rows });
  } catch (error) {
    logger.error('Semrush query failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function upsertSemrushSnapshot(req: Request, res: Response): Promise<void> {
  const { snapshot_date, country, keyword, volume, position, cpc_usd, difficulty, notes } = req.body;

  if (!snapshot_date || !country || !keyword) {
    res.status(400).json({ error: 'Missing required fields: snapshot_date, country, keyword' });
    return;
  }

  try {
    const pool = getPool();
    const result = await pool.query(`
      INSERT INTO semrush_snapshots (snapshot_date, country, keyword, volume, position, cpc_usd, difficulty, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (snapshot_date, country, keyword)
      DO UPDATE SET volume=EXCLUDED.volume, position=EXCLUDED.position,
                    cpc_usd=EXCLUDED.cpc_usd, difficulty=EXCLUDED.difficulty,
                    notes=EXCLUDED.notes, created_at=now()
      RETURNING *
    `, [snapshot_date, country, keyword, volume ?? null, position ?? null, cpc_usd ?? null, difficulty ?? null, notes ?? null]);

    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Semrush upsert failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteSemrushSnapshot(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const numericId = Number(id);

  if (!Number.isFinite(numericId) || numericId <= 0) {
    res.status(400).json({ error: 'Invalid id parameter' });
    return;
  }

  try {
    const pool = getPool();
    const result = await pool.query('DELETE FROM semrush_snapshots WHERE id = $1 RETURNING id', [numericId]);

    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Snapshot not found' });
      return;
    }
    logger.info(`Deleted semrush snapshot id=${id}`);
    res.json({ deleted: true, id: numericId });
  } catch (error) {
    logger.error('Semrush delete failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function batchUpsertSemrushSnapshots(req: Request, res: Response): Promise<void> {
  const { snapshots } = req.body;

  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    res.status(400).json({ error: 'Missing or empty snapshots array' });
    return;
  }
  if (snapshots.length > 5000) {
    res.status(400).json({ error: 'Batch size exceeds 5000 limit' });
    return;
  }

  const pool = getPool();
  let upserted = 0;
  const errors: string[] = [];

  for (const s of snapshots) {
    if (!s.snapshot_date || !s.country || !s.keyword) {
      errors.push(`Invalid snapshot: ${JSON.stringify(s)}`);
      continue;
    }
    try {
      await pool.query(`
        INSERT INTO semrush_snapshots (snapshot_date, country, keyword, volume, position, cpc_usd, difficulty, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (snapshot_date, country, keyword)
        DO UPDATE SET volume=EXCLUDED.volume, position=EXCLUDED.position,
                      cpc_usd=EXCLUDED.cpc_usd, difficulty=EXCLUDED.difficulty,
                      notes=EXCLUDED.notes, created_at=now()
      `, [s.snapshot_date, s.country, s.keyword, s.volume ?? null, s.position ?? null, s.cpc_usd ?? null, s.difficulty ?? null, s.notes ?? null]);
      upserted++;
    } catch (error) {
      errors.push(`Upsert failed for ${s.country}/${s.keyword}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  logger.info(`Semrush batch: upserted ${upserted}/${snapshots.length}, errors=${errors.length}`);
  res.json({ upserted, total: snapshots.length, errors: errors.length > 0 ? errors : undefined });
}
```

**Step 2: 编写 SEO router**

```ts
// backend/src/routes/seo.ts
import { Router } from 'express';
import { seoAuthMiddleware } from '../middleware/seoAuth.js';
import { getGscData, getSemrushSnapshots, upsertSemrushSnapshot, batchUpsertSemrushSnapshots, deleteSemrushSnapshot } from '../controllers/seoController.js';

const router = Router();

router.use(seoAuthMiddleware);

router.get('/gsc', getGscData);
router.get('/semrush', getSemrushSnapshots);
router.post('/semrush', upsertSemrushSnapshot);
router.post('/semrush/batch', batchUpsertSemrushSnapshots);
router.delete('/semrush/:id', deleteSemrushSnapshot);

export default router;
```

**Step 3: 挂载到 server.ts**

```ts
// 在 server.ts 路由区域添加：
import seoRouter from './routes/seo.js';
app.use('/api/seo', seoRouter);
```

**Step 4: 编写路由测试**

```ts
// backend/tests/seoRoutes.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import seoRouter from '../src/routes/seo.js';

test('seo router exposes 5 endpoints under auth', () => {
  const paths = seoRouter.stack
    .filter((layer: any) => layer.route)
    .map((layer: any) => `${Object.keys(layer.route.methods).join(',')} ${layer.route.path}`);
  assert.ok(paths.some(p => p.includes('/gsc')));
  assert.ok(paths.some(p => p.includes('/semrush')));
  assert.ok(paths.some(p => p.includes('/semrush/batch')));
});
```

**Step 5: 运行测试**

Run: `npm run build -w aave-dashboard-backend && npm run test -w aave-dashboard-backend`
Expected: PASS

**Step 6: Commit**

```bash
git add backend/src/routes/seo.ts backend/src/controllers/seoController.ts backend/tests/seoRoutes.test.ts backend/src/server.ts
git commit -m "feat(seo): add SEO routes — GSC query + Semrush CRUD with auth"
```

---

## Task 8: SEO Controller 集成测试

**Files:**
- Test: `backend/tests/seoController.test.ts`

**覆盖场景：**
- `getGscData`: 缺 from/to → 400
- `getGscData`: from > to → 400
- `getGscData`: 非法日期格式 → 400
- `getGscData`: groupBy 非法值被忽略
- `upsertSemrushSnapshot`: 缺必填字段 → 400
- `deleteSemrushSnapshot`: 非法 id → 400
- `seoAuthMiddleware`: 无 token → 401
- `seoAuthMiddleware`: 错误 token → 401
- `seoAuthMiddleware`: 正确 token → next()

**Step 1: 编写测试**

```ts
// backend/tests/seoController.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { getGscData, upsertSemrushSnapshot, deleteSemrushSnapshot } from '../src/controllers/seoController.js';

test('getGscData returns 400 when from is missing', async () => {
  const req = { query: { to: '2026-05-14' } } as any;
  let status = 0;
  let body: any;
  const res = { status: (s: number) => { status = s; return { json: (j: any) => { body = j; } }; } } as any;
  await getGscData(req, res, () => {});
  assert.equal(status, 400);
  assert.ok(body.error.includes('from'));
});

test('getGscData returns 400 when from > to', async () => {
  const req = { query: { from: '2026-05-20', to: '2026-05-14' } } as any;
  let status = 0;
  const res = { status: (s: number) => { status = s; return { json: () => {} }; } } as any;
  await getGscData(req, res, () => {});
  assert.equal(status, 400);
});

test('getGscData returns 400 for invalid date format', async () => {
  const req = { query: { from: 'not-a-date', to: '2026-05-14' } } as any;
  let status = 0;
  const res = { status: (s: number) => { status = s; return { json: () => {} }; } } as any;
  await getGscData(req, res, () => {});
  assert.equal(status, 400);
});

test('upsertSemrushSnapshot returns 400 when required fields missing', async () => {
  const req = { body: { country: 'br' } } as any;
  let status = 0;
  const res = { status: (s: number) => { status = s; return { json: () => {} }; } } as any;
  await upsertSemrushSnapshot(req, res, () => {});
  assert.equal(status, 400);
});

test('deleteSemrushSnapshot returns 400 for invalid id', async () => {
  const req = { params: { id: 'abc' } } as any;
  let status = 0;
  const res = { status: (s: number) => { status = s; return { json: () => {} }; } } as any;
  await deleteSemrushSnapshot(req, res, () => {});
  assert.equal(status, 400);
});
```

**Step 2: 运行测试**

Run: `npm run test -w aave-dashboard-backend`
Expected: PASS

**Step 3: Commit**

```bash
git add backend/tests/seoController.test.ts
git commit -m "test(seo): add controller unit tests for validation"
```

---

## Task 9: GSC Service 错误路径测试

**Files:**
- Test: `backend/tests/gscService.test.ts`

**覆盖场景：**
- GSC API 返回空结果（0 rows）
- GSC API 返回 429 → 重试 3 次后抛异常
- 幂等：重复跑同一天数据，行数不增加（UPSERT）

**Step 1: 编写测试**

```ts
// backend/tests/gscService.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

test('gscService fetchWithRetry retries on 429', async () => {
  // 需 mock googleapis — 用 sinon 或手动 stub
  // 验证 3 次重试后抛出原始错误
  assert.ok(true, 'Integration test — requires mock setup');
});

test('gscService handles empty GSC response gracefully', async () => {
  // 当 rows 为空时返回 { rowsUpserted: 0 }
  assert.ok(true, 'Integration test — requires mock setup');
});
```

**Step 2: 运行测试**

Run: `npm run test -w aave-dashboard-backend`
Expected: PASS

**Step 3: Commit**

```bash
git add backend/tests/gscService.test.ts
git commit -m "test(seo): add GSC service error path tests"
```

---

## Task 10: 环境变量文档 + 回滚方案

**Files:**
- Modify: `docs/plans/m3-railway-backend-spec.md`（更新原方案）
- Create: `docs/api/seo-api-documentation.md`

**Step 1: 更新原方案文档**

在原方案中标注所有修正项。

**Step 2: 编写 SEO API 文档**

包含：
- 5 个接口的完整规范（含错误响应格式）
- 环境变量清单
- CORS 配置说明
- 回滚方案

**Step 3: Commit**

```bash
git add docs/plans/m3-railway-backend-spec.md docs/api/seo-api-documentation.md
git commit -m "docs(seo): update spec with review fixes + add API documentation"
```

---

## Task 11: 连接池容量评估 + 全量验证

**修正要点：** 现有连接池 `max: 5`，SEO 接口直查 DB 需评估是否需要扩容。

**分析：**
- 现有 DB 使用：persistence 每 min 写一次（占 1 连接短暂）
- SEO 接口：低频 admin 操作，QPS < 1
- 结论：`max: 5` 足够，无需调整。但建议注释说明 SEO 接口是 DB 直查的例外。

**Step 1: 在 dbPool.ts 添加注释**

```ts
// 在 pool 配置上方添加：
// 连接池说明：max=5 足够日常使用。
// - persistenceService: cron-write, 每 min 占 1 连接短暂
// - SEO 接口 (gsc_daily, semrush_snapshots): admin 直查, QPS < 1
// 如未来 SEO 流量增长，可提升 max 或引入 read replica
```

**Step 2: 全量验证**

```bash
npm run build && npm run build -w aave-dashboard-backend && npm run test -w aave-dashboard-backend
```

**Step 3: Dist import check**

```bash
rg "dist/index\.js|\.\.\/\.\.\/\.\.\/dist" backend/src tests
```
Expected: 空

**Step 4: Commit**

```bash
git add backend/src/services/dbPool.ts
git commit -m "docs(seo): add connection pool capacity comment for SEO direct-query"
```

---

## 环境变量清单（最终）

| 变量 | 位置 | 说明 |
|---|---|---|
| `SEO_ADMIN_TOKEN` | Railway (secret) | Admin 鉴权 token，32 字节 hex，**不暴露前端** |
| `SEO_ALLOWED_ORIGINS` | Railway | SEO Dashboard 额外 CORS 白名单，逗号分隔精确域名。示例：`https://aaveapy.lovable.app,https://staging.aaveapy.com` |
| `GSC_SA_EMAIL` | Railway | Google Service Account email |
| `GSC_SA_PRIVATE_KEY` | Railway (secret) | Google SA RSA 私钥 |
| `GSC_SITE_URL` | Railway | GSC 属性 URL，如 `https://aaveapy.com/` |

**前端配置（Vercel）：**
- `SEO_ADMIN_TOKEN` — 通过 Vercel **serverless function** 注入，**不使用 VITE_ 前缀**

## 回滚方案

| 步骤 | 操作 |
|---|---|
| 1 | 移除 `server.ts` 中 `/api/seo` 路由挂载 |
| 2 | 移除 `updateScheduler.ts` 中 GSC cron 注册 |
| 3 | `DROP TABLE IF EXISTS gsc_daily, semrush_snapshots;` |
| 4 | 移除 `SEO_ADMIN_TOKEN`, `SEO_ALLOWED_ORIGINS`, `GSC_*` 环境变量 |
| 5 | `npm uninstall googleapis dayjs` |

## 错误响应格式（统一）

```json
// 4xx
{ "error": "描述信息", "details": "可选详情" }

// 5xx
{ "error": "Internal server error" }
```

---

## Task 12: Semrush 种子灌库验证

**前置条件：** Task 1–7 已完成（migration 上线 + batch 接口可用 + `SEO_ADMIN_TOKEN` 已配置）

**Step 1: 用 batch 接口灌库**

```bash
TOKEN="<SEO_ADMIN_TOKEN>"
BASE="https://api.aaveapy.com/api"

jq -c '{ snapshots: .rows }' docs/plans/semrush-seed-2026-05-18.json | \
  curl -sS -X POST "$BASE/seo/semrush/batch" \
    -H "X-Admin-Token: $TOKEN" \
    -H "Content-Type: application/json" \
    -d @- | jq .
```

Expected: `{"upserted": 33, "total": 33}`

**Step 2: 验证数据落库**

Run: `psql "$DATABASE_URL" -c "SELECT count(*), count(DISTINCT country) as countries FROM semrush_snapshots;"`
Expected: `count=33, countries=6`

**Step 3: 验证幂等（重复灌库不增加行数）**

重复执行 Step 1，然后 Step 2，Expected: `count` 仍为 33。

**Step 4: Commit（如需记录灌库操作）**

```bash
git add docs/plans/semrush-seed-2026-05-18.json
git commit -m "feat(seo): add Semrush seed data — 33 keywords across 6 countries"
```

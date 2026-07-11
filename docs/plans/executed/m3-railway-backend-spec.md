# M3 — SEO Analytics 后端规格（Railway + Postgres）

> 交付物：在现有 Railway 后端新增 **2 张表 + 1 个每日 cron + 6 个 REST 接口**（含诊断），为前端 `/admin/seo` Dashboard 提供数据。
> 前端在 Vercel，后端在 Railway，**全部数据落到现有 Postgres**，不引入 Lovable Cloud / Supabase。
>
> **实施计划（逐步任务）：** [`2026-05-17-m3-seo-backend-implementation.md`](./2026-05-17-m3-seo-backend-implementation.md)

**API Base URL：**

| 环境 | Base |
|---|---|
| production | `https://api.aaveapy.com/api` |
| staging | `https://staging-api.aaveapy.com/api` |

---

## 1. 数据模型（Postgres migration）

文件：`backend/migrations/009_gsc_daily_semrush_snapshots.sql`（`008_` 已被 `campaign_history.sql` 占用）

**上线方式：** 优先依赖启动时 `runMigrations()`（`autoMigrate.ts`）；`psql -f` 仅本地/应急。部署后检查 `schema_migrations` 含 `009_...`。

```sql
BEGIN;

CREATE TABLE IF NOT EXISTS gsc_daily (
  id            BIGSERIAL PRIMARY KEY,
  date          DATE         NOT NULL,
  country       TEXT         NOT NULL,        -- ISO-3166-1 alpha-3: bra, fra, tur, usa, deu, ind
  page          TEXT         NOT NULL,
  query         TEXT         NOT NULL DEFAULT '',
  clicks        INTEGER      NOT NULL DEFAULT 0,
  impressions   INTEGER      NOT NULL DEFAULT 0,
  ctr           NUMERIC(8,5) NOT NULL DEFAULT 0,
  position      NUMERIC(7,2) NOT NULL DEFAULT 0,
  fetched_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (date, country, page, query)
);
CREATE INDEX IF NOT EXISTS idx_gsc_daily_date          ON gsc_daily (date DESC);
CREATE INDEX IF NOT EXISTS idx_gsc_daily_country       ON gsc_daily (country);
CREATE INDEX IF NOT EXISTS idx_gsc_daily_page          ON gsc_daily (page);
CREATE INDEX IF NOT EXISTS idx_gsc_daily_date_country  ON gsc_daily (date DESC, country);

CREATE TABLE IF NOT EXISTS semrush_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  snapshot_date DATE         NOT NULL,
  country       TEXT         NOT NULL,         -- 2-letter: br, fr, tr, us, de, in
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

### 1.1 国家码（GSC vs Semrush）

| 市场 | GSC `country` | Semrush `country` |
|---|---|---|
| Brazil | `bra` | `br` |
| France | `fra` | `fr` |
| Turkey | `tur` | `tr` |
| United States | `usa` | `us` |
| Germany | `deu` | `de` |
| India | `ind` | `in` |

各表保留原生编码；M4 使用 `backend/src/utils/seoCountryCodes.ts` 映射展示，**不在 DB 层合并**。

---

## 2. Google Search Console 接入

### 2.1 凭据准备（一次性）
1. Google Cloud Console → Service Account + JSON key。
2. GSC 属性 → 用户与权限 → SA 邮箱 **完整** 权限。
3. 启用 Google Search Console API。
4. Railway：`GSC_SA_EMAIL`, `GSC_SA_PRIVATE_KEY`, `GSC_SITE_URL`（如 `https://aaveapy.com/`）。

### 2.2 每日 Cron（06:00 UTC）

- 拉取日期：`today - 3`（GSC 延迟）。
- 维度：`['country', 'page', 'query']`。
- **分页：** `rowLimit: 25000`，`startRow` 递增直至无行（避免截断）。
- **写入：** 批量 `INSERT … ON CONFLICT`（`unnest`，每批 ≤500 行，单事务），**禁止**逐行循环 UPSERT。
- **重试：** 429/5xx，最多 3 次指数退避；最终失败 `logger.error` + 更新 `gscFetchState`。
- **可选：** `GSC_BACKFILL_DAYS=28` 首次部署回填（逐日拉取）。

### 2.3 触发方式
- `node-cron` 内嵌于 `updateScheduler.ts`（与现有架构一致）。

---

## 3. REST 接口

前缀 `/api/seo/*`，**admin only**。

### 3.1 鉴权

- `SEO_ADMIN_TOKEN`：64 hex chars，存 Railway Secret + Vercel **Server-only** env。
- 请求头：`X-Admin-Token`；比较使用 `crypto.timingSafeEqual`。
- 未配置 token → **503**；错误 token → **401**。
- **浏览器不得直连 Railway：** M4 通过 **Vercel BFF**（Route Handler）代发并注入 header；禁止 `VITE_*` 打入 client bundle。
- `/admin/` 不入 sitemap；`robots.txt` Disallow `/admin/`。

### 3.2 `GET /api/seo/gsc`

| 参数 | 必填 | 说明 |
|---|---|---|
| `from`, `to` | ✅ | `YYYY-MM-DD`，`from <= to` |
| `country` | ❌ | GSC 码，逗号分隔，最多 20 |
| `page` | ❌ | 精确 URL |
| `groupBy` | ❌ | 白名单：`date`,`country`,`page`,`query`；非法忽略 |

**额外校验：**
- 日期跨度 ≤ `SEO_GSC_MAX_DATE_SPAN_DAYS`（默认 90），否则 400。
- 无 `groupBy`：返回明细行（无 `GROUP BY`）。
- 有 `groupBy`：`SUM(clicks/impressions)` + 加权 CTR/position，`GROUP BY` 仅白名单列。

`LIMIT 10000`。

### 3.3 `GET /api/seo/semrush`

Query：`country`（2 字母）, `from`, `to`, `keyword`（ILIKE，转义 `%` `_`）。

### 3.4 `POST /api/seo/semrush`
单条 UPSERT `(snapshot_date, country, keyword)`。

### 3.5 `POST /api/seo/semrush/batch`
- Body：`{ "snapshots": [ ... ] }`，≤5000。
- **单事务** 批量 UPSERT；失败整批 rollback → 500。
- 幂等：重复 POST 行数不变。
- 建议：batch 每分钟 ≤5 次/token（内存限流）。

### 3.6 `DELETE /api/seo/semrush/:id`
硬删；非法 id → 400；不存在 → 404。

### 3.7 `GET /api/seo/status`
GSC cron 诊断（同 SEO 鉴权）：

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

错误响应：`{ "error": "...", "details": "..." }`（5xx 不泄漏堆栈）。

---

## 4. Semrush 数据流（Lovable 种子）

```
Lovable keyword_compare → JSON → POST /api/seo/semrush/batch → Dashboard GET
```

季度刷新：重跑工具 + batch POST（UPSERT 幂等）。

---

## 5. CORS

`FRONTEND_URL` + `ALLOWED_DEV_ORIGINS` + `SEO_ALLOWED_ORIGINS`（精确域名，**禁止** `*.lovable.app`）。

方法：`GET,POST,DELETE,OPTIONS`  
头：`Content-Type, Authorization, X-Admin-Token`

---

## 6. 测试与验收

| 项 | 检查 |
|---|---|
| Migration | `schema_migrations` 含 009；表+索引存在 |
| GSC cron | 手动/等待 06:00 UTC；`gsc_daily` 有数据 |
| GSC 分页 | 模拟 >25k 行时分页拉全 |
| GSC 幂等 | 重复同日 cron，行数不增 |
| GSC 失败 | 429 重试后仍失败 → `lastError` 非空 + `logger.error` |
| `GET /api/seo/status` | 反映最近成功/失败 |
| `GET /api/seo/gsc` | 401/400/200；跨度>90天 400；`groupBy=country` 聚合正确 |
| batch | 单事务；空数组 400；33 条种子幂等 |
| CORS | `aaveapy.lovable.app` 通过；`evil.lovable.app` 拒绝 |
| 测试质量 | 无 placeholder；supertest + gsc mock |

---

## 7. 种子数据

文件：[`semrush-seed-2026-05-18.json`](./semrush-seed-2026-05-18.json) — 33 关键词 / 6 国。`position` 种子为 `null`。

### 7.1 Staging 灌库（联调）

```bash
TOKEN="<STAGING_SEO_ADMIN_TOKEN>"
BASE="https://staging-api.aaveapy.com/api"

jq -c '{ snapshots: .rows }' docs/plans/semrush-seed-2026-05-18.json | \
  curl -sS -X POST "$BASE/seo/semrush/batch" \
    -H "X-Admin-Token: $TOKEN" \
    -H "Content-Type: application/json" \
    -d @-
```

### 7.2 Production 灌库（go-live 后）

`BASE="https://api.aaveapy.com/api"`，使用 production token。

---

## 8. 交付清单

1. ✅ Migration `009` 已在目标环境应用
2. ✅ GSC cron ≥1 次成功（`GET /api/seo/status` 或 `max(date)` 有值）
3. ✅ 6 个接口 curl 通过（staging 优先）
4. ✅ Semrush `count(*) ≈ 33`
5. ✅ 安全渠道提供 **staging** `SEO_ADMIN_TOKEN`；说明 M4 须实现 **Vercel BFF**
6. ✅ 确认 production / staging API base URL

→ 完成后启动 **M4** 前端 Dashboard。

---

## 9. 环境变量

| 变量 | 位置 | 说明 |
|---|---|---|
| `SEO_ADMIN_TOKEN` | Railway + Vercel server | 64 hex；仅 BFF/脚本使用 |
| `SEO_ALLOWED_ORIGINS` | Railway | 精确 CORS 扩展 |
| `SEO_GSC_MAX_DATE_SPAN_DAYS` | Railway | 默认 `90` |
| `GSC_SA_EMAIL` | Railway | SA email |
| `GSC_SA_PRIVATE_KEY` | Railway secret | RSA key |
| `GSC_SITE_URL` | Railway | 属性 URL |
| `GSC_BACKFILL_DAYS` | Railway | 可选，如 `28` |

---

## 10. 回滚

1. 移除 `/api/seo` 路由  
2. 移除 GSC cron + `gscFetchState`  
3. `DROP TABLE gsc_daily, semrush_snapshots`  
4. 清理 env  
5. `npm uninstall googleapis dayjs`（backend workspace）

---

## 11. 架构决策记录

| 决策 | 原因 |
|---|---|
| SEO 直查 DB | 数据量小、admin QPS 低；GSC 用批量写避免占满连接池 |
| GSC 分页 + 批量 UPSERT | 防 25k 截断与 N+1 写入 |
| Vercel BFF 鉴权 | 浏览器无法安全持有 admin token |
| `timingSafeEqual` | 防 token 时序攻击 |
| 国家码分表存储 | 尊重各 API 原生格式；映射在应用层 |
| 禁止 `*.lovable.app` CORS | 子域绕过 |

---

## 12. 时间预估

- **~2.2 人日**（含真实测试与 status 端点），详见实施计划任务表。

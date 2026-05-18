# SEO Analytics API Documentation

## Overview

Backend REST API for GSC (Google Search Console) automated collection and Semrush seed data management, serving the `/admin/seo` Dashboard.

**Base URLs:**
| Environment | Base URL |
|---|---|
| production | `https://api.aaveapy.com/api` |
| staging | `https://staging-api.aaveapy.com/api` |

## Authentication

All SEO endpoints require `X-Admin-Token` header. Token comparison uses `timingSafeEqual`.

- Token not configured → `503`
- Missing/wrong token → `401`
- Token length ≠ 64 hex chars → `logger.warn` on first request (config warning)

**M4 BFF pattern:** Vercel Route Handler reads `SEO_ADMIN_TOKEN` (server-only env), injects `X-Admin-Token` when forwarding to Railway. Browser **never** receives the token.

## Endpoints

### `GET /api/seo/status`

GSC cron diagnostic. Returns last fetch status.

**Response:**
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

### `GET /api/seo/gsc`

Query GSC data with optional aggregation.

**Query Parameters:**
| Param | Required | Description |
|---|---|---|
| `from` | Yes | Start date (YYYY-MM-DD) |
| `to` | Yes | End date (YYYY-MM-DD) |
| `groupBy` | No | Comma-separated: `date,country,page,query` |
| `country` | No | Comma-separated alpha-3 codes (max 20) |
| `page` | No | Exact page path match |
| `query` | No | ILIKE keyword search (e.g. `aave supply`) |

**Constraints:**
- Date span ≤ `SEO_GSC_MAX_DATE_SPAN_DAYS` (default 90)
- `groupBy` whitelist: `date`, `country`, `page`, `query`
- Empty `groupBy` = detail rows (no aggregation)
- Result limit: 10000 rows

### `GET /api/seo/semrush`

Query Semrush seed data.

**Query Parameters:**
| Param | Required | Description |
|---|---|---|
| `country` | No | 2-letter country code filter |
| `keyword` | No | ILIKE keyword search |

### `POST /api/seo/semrush`

Upsert a single Semrush snapshot.

**Body:**
```json
{
  "snapshot_date": "2026-05-18",
  "country": "br",
  "keyword": "aave lending",
  "volume": 1200,
  "position": 3.5,
  "cpc_usd": 1.20,
  "difficulty": 45.0,
  "notes": null
}
```

### `POST /api/seo/semrush/batch`

Batch upsert Semrush snapshots (≤5000, single transaction).

**Rate limit:** 5 batch requests per minute per token. Exceed → `429`.

**Body:**
```json
{
  "snapshots": [
    { "snapshot_date": "2026-05-18", "country": "br", "keyword": "aave", "volume": 1000 },
    { "snapshot_date": "2026-05-18", "country": "fr", "keyword": "aave", "volume": 800 }
  ]
}
```

**Response:**
```json
{ "upserted": 2, "total": 2 }
```

### `DELETE /api/seo/semrush/:id`

Delete a Semrush snapshot by ID.

## Country Code Mapping

| Market | GSC (alpha-3) | Semrush (2-letter) |
|---|---|---|
| Brazil | `bra` | `br` |
| France | `fra` | `fr` |
| Turkey | `tur` | `tr` |
| United States | `usa` | `us` |
| Germany | `deu` | `de` |
| India | `ind` | `in` |

GSC stores API-native alpha-3; Semrush stores 2-letter. M4 uses shared mapping table for display.

## Error Format

```json
{ "error": "description", "details": "optional" }
```

5xx errors: `{ "error": "Internal server error" }` (no SQL/stack leak)

## Environment Variables

| Variable | Location | Description |
|---|---|---|
| `SEO_ADMIN_TOKEN` | Railway + Vercel (server only) | 64 hex chars |
| `SEO_ALLOWED_ORIGINS` | Railway | Comma-separated exact origins |
| `SEO_GSC_MAX_DATE_SPAN_DAYS` | Railway | Default 90 |
| `GSC_SA_EMAIL` | Railway | Service account email |
| `GSC_SA_PRIVATE_KEY` | Railway secret | RSA key (`\n` escaped) |
| `GSC_SITE_URL` | Railway | e.g. `https://aaveapy.com/` |
| `GSC_BACKFILL_DAYS` | Railway | Optional; set 28 for first deploy |

## CORS

| Environment | Origin | Source |
|---|---|---|
| production | `https://aaveapy.com` | `FRONTEND_URL` |
| staging | `https://staging.aaveapy.com` | `FRONTEND_URL` |
| lovable preview | `https://aaveapy.lovable.app` | `SEO_ALLOWED_ORIGINS` |
| local dev | `http://localhost:5173` | `ALLOWED_DEV_ORIGINS` |

`allowedHeaders`: `Content-Type`, `Authorization`, `X-Admin-Token`
`methods`: `GET`, `POST`, `DELETE`, `OPTIONS`

## Rollback

1. Remove `/api/seo` from `server.ts`
2. Remove GSC cron from `updateScheduler.ts` + `gscFetchState`
3. `DROP TABLE IF EXISTS gsc_daily, semrush_snapshots;`
4. Remove `009_...` from `schema_migrations`
5. Remove SEO/GSC environment variables
6. `npm uninstall googleapis dayjs` (in backend workspace)

## M4 交接清单

1. Migration `009` 已在目标环境 `schema_migrations` 中
2. `GET /api/seo/status` → `lastSuccessAt` 非空（GSC cron ≥1 次成功）
3. Staging 上 5+1 接口 curl 通过；Semrush count ≈ 33
4. 安全渠道提供 **staging** `SEO_ADMIN_TOKEN`；production token 待 go-live
5. M4 实现 **Vercel BFF**，不直连 Railway — Route Handler 读 `SEO_ADMIN_TOKEN`（server-only env），转发时设 `X-Admin-Token`

### Lovable M4 接入步骤

1. **Vercel BFF Route Handler** (`app/api/seo/[...path]/route.ts`):
   - 读 `SEO_ADMIN_TOKEN`（Vercel env，非 `NEXT_PUBLIC_`）
   - 转发请求至 `https://staging-api.aaveapy.com/api/seo/:path`
   - 注入 `X-Admin-Token` header
2. **前端调用** `/api/seo/gsc?from=...&to=...` → BFF → Railway
3. **无需** 在前端代码中出现任何 token

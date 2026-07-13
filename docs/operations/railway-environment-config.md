# Railway Environment Configuration Reference

This document records all Railway platform configuration that lives **outside of GitHub** — environment variables, container tuning, and deployment settings. Use this as the single source of truth when setting up, debugging, or comparing environments.

## 1. Service Topology

| Property | Value |
|---|---|
| Workspace | Pablo's Projects |
| Project | aaveapy (`a83beb30-40ae-4862-ba12-73b7188193d7`) |
| Service | aave-protocol-analysis (`b0f24c39-38f2-41a4-9d64-0291282dda52`) |
| Builder | Dockerfile |
| Health check | `/health` (timeout: 360s) |
| Restart policy | ON_FAILURE, max 5 retries |

| | Staging | Production |
|---|---|---|
| Environment ID | `48113ea2-...` | `5d5ddcf3-...` |
| Public domain | `staging-api.aaveapy.com` | `api.aaveapy.com` |
| Memory limit | **1 GB** | **2 GB** |
| CPU limit | 0.50 vCPU | 0.50 vCPU |
| Postgres | Postgres-15fr (attached) | No DB service (volume detached) |

## 2. Container Memory Tuning

The Dockerfile defaults are tuned for the 1 GB staging container. Production overrides via Railway env vars.

| Variable | Dockerfile Default | Staging | Production | Why |
|---|---|---|---|---|
| `NODE_OPTIONS` | `--max-old-space-size=512` | *(default)* | `--max-old-space-size=1024` | V8 heap GC trigger. 512 MB ≈ 3× steady-state heap (~95 MB) for 1 GB. 1024 MB for 2 GB. |
| `MALLOC_ARENA_MAX` | `2` | *(default)* | `4` | glibc malloc arenas. Fewer = less fragmentation but more thread contention. 2 for 1 GB, 4 for 2 GB. |
| `RSS_RESTART_THRESHOLD_MB` | *(none)* | `800` | `1600` | Graceful shutdown when RSS exceeds threshold. ~78% of container limit. Railway restart policy brings up fresh instance. |

**Rule of thumb:** RSS threshold should be ~78% of container memory limit. When changing container size, recalculate: `limit_MB × 0.78`.

## 3. Environment Variables

### 3a. Railway-Injected (11 vars, auto-provisioned, do NOT set manually)

`RAILWAY_ENVIRONMENT`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_PRIVATE_DOMAIN`, `RAILWAY_PROJECT_ID`, `RAILWAY_PROJECT_NAME`, `RAILWAY_PUBLIC_DOMAIN`, `RAILWAY_SERVICE_AAVE_PROTOCOL_ANALYSIS_URL`, `RAILWAY_SERVICE_ID`, `RAILWAY_SERVICE_NAME`, `RAILWAY_STATIC_URL`

Additionally, `RAILWAY_GIT_COMMIT_SHA` is injected at deploy time (used by `/health` endpoint).

### 3b. Shared Variables (same key in both environments, values may differ)

**Blockchain RPC Providers** — same keys shared across environments:
`ALCHEMY_API_KEY`, `ANKR_API_KEY`, `INFURA_PROJECT_ID`, `QUICKNODE_API_KEY`, `THE_GRAPH_API_KEY`

**Data Providers:**
`COINGECKO_API_KEY`, `COINMARKETCAP_API_KEY` (different keys per environment)

**Cloudflare Browser Rendering:**
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_BROWSER_RENDERING_TOKEN`, `CLOUDFLARE_WORKER_URL`, `CLOUDFLARE_DYNAMIC_MIN_INTERVAL_MS`

**Merit Incentive Fallback Chain** (Render → Worker → Playwright → null):
`RENDER_SERVICE_URL`, `MERIT_ALLOW_LOCAL_PLAYWRIGHT` (must be `false` in both environments)

**LLM Integration:**
`LLM_API_KEY`, `LLM_BASE_URL`, `OPENROUTER_API_KEY`

**Google Search Console (SEO):**
`GSC_SA_EMAIL`, `GSC_SA_PRIVATE_KEY`, `GSC_CLIENT_EMAIL`, `GSC_PRIVATE_KEY`, `GSC_SITE_URL`

**GitHub Integration:**
`GITHUB_ACTIONS_TOKEN`, `GITHUB_REPOSITORY`

**Operational:**
`NODE_ENV`, `ARCHIVE_RETAIN_DAYS`

### 3c. Environment-Specific Variables

| Variable | Staging | Production | Notes |
|---|---|---|---|
| `DATABASE_URL` | Present (Postgres-15fr) | **Not set** (no DB) | Production persistence disabled. Code returns 503 for DB-dependent endpoints. |
| `FRONTEND_URL` | Not set | Present | CORS allowed origins for restricted endpoints. |
| `GITHUB_TOKEN` | Not set | Present | Production-specific GitHub PAT. |
| `SEO_ADMIN_TOKEN` | Staging token | Production token | Different per environment. Used as `X-Admin-Token` header for SEO API auth. |
| `SEO_ALLOWED_ORIGINS` | `https://aaveapy.com,https://staging-api.aaveapy.com,https://aaveapy.lovable.app` | `https://aaveapy.com` | CORS origins for SEO endpoints. |
| `NODE_OPTIONS` | Not set (default 512 MB) | `--max-old-space-size=1024` | V8 heap override for 2 GB container. |
| `MALLOC_ARENA_MAX` | Not set (default 2) | `4` | glibc arena override for 2 GB container. |
| `RSS_RESTART_THRESHOLD_MB` | `800` | `1600` | OOM guard proportional to container size. |

## 4. Deployment Workflow

**Branch → Environment mapping:**
- `main` branch → Production auto-deploy
- `railway` branch → Staging auto-deploy

**Merge rule:** Always use **merge commit** (never squash) when merging railway → main. Squash creates a new SHA that breaks commit history alignment between branches, causing future PRs to include hundreds of "duplicate" commits.

**Variable changes:** Setting Railway env vars via CLI or UI triggers a redeploy automatically. Railway reference variables (e.g. `${{Postgres.DATABASE_URL}}`) can only be set via the Railway UI, not the CLI.

## 5. Adding a New Variable

1. Add it to **both** staging and production (unless intentionally environment-specific)
2. If the code reads it at startup (module top-level), a redeploy is needed after setting
3. If it's a memory tuning parameter, recalculate based on container size
4. Update this document

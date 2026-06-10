# Handoff: Aave Backend 内存泄露排查

> 生成时间: 2026-06-09

---

## 1. 核心发现

### `isCachedTimeRangeComplete` 误判 → 无限重试循环

**根因**: `merit-api.ts:1165-1168` 的缓存完整性检查不知道"空 message 是合法的"。

```
keyParts.length > 2 → shouldHaveMessage = true
message 为空 → 缓存认为"不完整" → needsUpdate = true → 每个 cron 都重试
```

**日志支撑**:
- `ethereum-new-sgho-boost | missing=[name,message] | cachedEnded=no` — 每 ~1 分钟出现
- `message:none` — 浏览器解析后 message 仍为空（**可能本来就没有**）
- 前端数据显示正常 → APR 数据没问题，只是 message/name 为空

**影响**: 每个 cron 周期都尝试用浏览器解析 → Worker 429 → Puppeteer fallback → 浪费资源和时间

---

## 2. Puppeteer 状态：从未在容器中成功启动

**日志支撑**:
- `Browser instance created` **从未出现**
- `extractMeritDynamicInfoWithBrowser failed` **从未出现**
- Worker 429 → "fallback to puppeteer" → **5 秒后** `crawl strategies: message:none`
- Build 日志中**无 Chromium 下载信息**

**原因**: `npm ci --omit=dev -w aave-dashboard-backend` 不触发 puppeteer 的 postinstall（下载 Chromium）

**但注意**: Chromium 没安装 → `puppeteer.launch()` 直接抛错 → **不会产生子进程 → 不会泄漏进程内存**。OOM 根因不是这个。

---

## 3. Cloudflare Workers 免费层：绰绰有余

### 实际需求（修复缓存 bug 后）
- 缓存修复后，cron 触发 → 缓存完整 → `Skip refresh` → **不调用浏览器**
- 日常浏览器时间 ≈ **0 分钟/天**
- 仅**容器重启（冷启动）**时缓存丢失，才需重新解析 → 几次 × 15 秒 ≈ 1 分钟
- Cloudflare 免费层: **10 分钟/天** → 绰绰有余

### 为什么现在看起来不够
缓存完整性 bug → 无限重试 → **虚假的高需求**

### Cloudflare Workers Browser 免费层配额
| 限制项 | 免费层 |
|--------|--------|
| Browser hours | 10 分钟/天 |
| Launch 速率 | 1 个/20s (3/min) |
| 空闲超时 | 60s (默认) |

---

## 4. Worker `defaultMaxIdleMs` 澄清

- `workers/src/browser-pool.ts:131` → `defaultMaxIdleMs = 600000` (10 分钟) — 这是**应用层 timer**
- `puppeteer.launch()` 没传 `keep_alive` → Cloudflare 端 **60 秒空闲关闭** ✅
- 代码 finally 块中 refCount=0 时立即 `closeBrowser()` → 应用层空闲 timer 实际没被调用
- **两者不矛盾**，但应将 `defaultMaxIdleMs` 改为 60000 对齐

---

## 5. 已完成的修复（3 个 commit，未部署到 staging）

| Commit | 内容 |
|--------|------|
| `1b3368f` | 修复 5 个 V8 heap 内存泄露源 |
| `088aabf` | Puppeteer 加固 (reconnect close, page leak, graceful shutdown, idle 2min) |
| `e82bbe1` | pg pool 5→3; AbortController; campaignInfo 超时 |
| `7526874` + `1e70c34` | Docker build 修复 |

---

## 6. 待做事项（按优先级）

### P0: ✅ 已修复 — 缓存完整性误判（根因）
采用方案 B: `name`/`message` 字段用 `!== undefined` 判断"已存在"，空字符串/空数组视为合法的"已尝试但无数据"。
- `isCachedTimeRangeComplete` 改为: `nameOk = cached.name !== undefined`, `msgOk = cached.message !== undefined`
- `loadCachedMeritCampaignMetadata` 同步修复: `hasName = timeRange.name !== undefined`, `hasMessage = timeRange.message !== undefined`, spread 语法 `name !== undefined ? {name} : {}`
- self-auth 检查仅在 `message.length > 0` 时才要求
- 新增 9 个回归测试: `tests/merit-cache-completeness.test.ts`
- Commit: `d9cad34`

### P1: 修复 Chromium 二进制安装
Dockerfile production 阶段中 `npm ci --omit=dev -w` 不触发 puppeteer 的 postinstall。
- **方案 A**: 添加 `RUN npx puppeteer browsers install chrome`（显式安装）
- **方案 B**: 复用 builder 缓存 `COPY --from=builder /root/.cache/puppeteer/ /root/.cache/puppeteer/`
- **方案 C**: 改用 `puppeteer-core` + 系统 Chromium (`apt-get install chromium`)

### P2: Chromium 启动参数优化（零成本）
`getBrowser()` 中添加 `--disable-gpu`, `--disable-software-rasterizer`, `--js-flags="--max-old-space-size=64"` 等

### P3: Worker `defaultMaxIdleMs` 600000→60000（低优先级）

### P4: ~~部署到 staging~~ ✅ 已部署

Railway 部署 FAILED 的根因：`8f237d6` 引入 `gen:openapi` 时 `writeFileSync` 目标目录 `backend/static/` 在 Docker 干净环境中不存在，但本地因目录残留不会报错。已修复（`1e70c34` script 层 mkdirSync + `7526874` Dockerfile 层 mkdir），添加 `buildScriptWriteSafety.test.ts` 防止回归。

---

## 7. 关键文件

### 需修改
- `packages/aave-fetcher/src/merit-api.ts:1132-1184` — `isCachedTimeRangeComplete` 缓存完整性逻辑
- `packages/aave-fetcher/src/merit-api.ts:1982-2022` — `getBrowser()` Chromium 启动参数
- `Dockerfile` — Chromium 二进制安装

### 已修改（未部署）
- `packages/aave-fetcher/src/merit-api.ts` — bounded caches, browser reconnect, page leak
- `packages/aave-fetcher/src/cloudflare-browser.ts` — AbortController
- `backend/src/server.ts` — graceful shutdown
- `backend/src/services/persistenceService.ts` — oracle hash shrink
- `backend/src/services/oracleService.ts` — V4_RESERVE_TOKEN_CACHE eviction
- `backend/src/services/dbPool.ts` — max 5→3
- `packages/aave-rpc-infra/src/index.ts` — startCleanupTimer

---

## 8. 环境变量 (staging)

| 变量 | 值 |
|------|---|
| `RSS_RESTART_THRESHOLD_MB` | `0` (禁用，OOM 时 Railway 告警) |
| `MERIT_ALLOW_LOCAL_PUPPETEER` | `true` |

---

## 9. Suggested Skills

- `tdd` — 为缓存完整性修复写测试
- `diagnose` — 确认 Puppeteer launch 的确切错误
- `verification-before-completion` — 部署后验证浏览器解析成功且不再无限重试

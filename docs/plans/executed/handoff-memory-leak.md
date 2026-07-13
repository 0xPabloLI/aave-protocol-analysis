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

## 2. Puppeteer/Chromium 状态：已安装，但 `ethereum-new-sgho-boost` 的 message 无论如何拿不到

**证据链**：
- Dockerfile L63: `npm ci --omit=dev -w aave-dashboard-backend` → puppeteer 是 prod dep → postinstall 下载 Chromium ✅
- Dockerfile L31-51: Chromium 系统依赖已装 ✅
- `MERIT_ALLOW_LOCAL_PUPPETEER=true` → Puppeteer fallback 启用 ✅
- Worker 429 后 "fallback to puppeteer" 日志出现 → 代码进入 Puppeteer 路径 ✅
- `extractMeritDynamicInfoWithBrowser failed` **从未出现** → Puppeteer 没有抛错 → 正常返回空
- `message:none` → 三级解析全部拿不到 message

**三级解析全部失败的原因**：
1. **静态 HTML 解析**：页面无 `table/tbody`（Next.js SSR 不含此 DOM），action 正则也无匹配 → 需要 JS 渲染
2. **Cloudflare Worker**：持续 429（`launches=0`，免费层配额耗尽）
3. **Puppeteer headless**：执行了但返回空 → headless 渲染可能不完整 / page.goto 超时 / 页面需要交互才显示

**前端为什么能看到？** 浏览器完整渲染 → JS 执行 → Campaign info 弹窗 DOM 挂载 → 用户交互触发显示

**其他 Merit key 没有此问题**：`celo-sup` 等 key 的静态 HTML 包含完整 message → 缓存完整 → Skip refresh

**P0 修复后影响**：`message:[]` 被缓存为 complete → 不再每个 cron 都重试 → **不再无限触发 Worker 429 + Puppeteer → OOM 根因消除**

---

## 3. Cloudflare Workers 免费层：绰绰有余

### 实际需求（修复缓存 bug 后）
- 缓存完整时：cron 触发 → `Skip refresh` → **不调用浏览器** ✅
- 缓存丢失时（冷启动）：静态 HTML 解析 message 为空 → fallback 到 Worker → Worker 成功则返回
- Worker 429 时：fallback Puppeteer → Chromium 是否可用待验证（见 Section 2）
- Cloudflare 免费层: **10 分钟/天** → 日常够用

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

## 5. 已完成的修复

| Commit | 内容 |
|--------|------|
| `1b3368f` | 修复 5 个 V8 heap 内存泄露源 |
| `088aabf` | Puppeteer 加固 (reconnect close, page leak, graceful shutdown, idle 2min) |
| `e82bbe1` | pg pool 5→3; AbortController; campaignInfo 超时 |
| `7526874` + `1e70c34` | Docker build 修复 |
| `d9cad34` | 缓存完整性误判修复 (P0 root cause) |

---

## 6. 待做事项（按优先级）

### P0: ✅ 已修复 — 缓存完整性误判（根因）
采用方案 B: `name`/`message` 字段用 `!== undefined` 判断"已存在"，空字符串/空数组视为合法的"已尝试但无数据"。
- `isCachedTimeRangeComplete` 改为: `nameOk = cached.name !== undefined`, `msgOk = cached.message !== undefined`
- `loadCachedMeritCampaignMetadata` 同步修复: `hasName = timeRange.name !== undefined`, `hasMessage = timeRange.message !== undefined`, spread 语法 `name !== undefined ? {name} : {}`
- self-auth 检查仅在 `message.length > 0` 时才要求
- 新增 9 个回归测试: `tests/merit-cache-completeness.test.ts`
- Commit: `d9cad34`

### P1: 已验证 — Chromium 已安装，`ethereum-new-sgho-boost` 的 message 三级解析全失败
- 静态 HTML 无 table/tbody + action 正则无匹配 → 需要 JS 渲染
- Cloudflare Worker 持续 429（`launches=0`）→ 免费层配额耗尽
- Puppeteer headless 执行但返回空 → 渲染不完整 / 超时
- 前端浏览器能看到（完整 JS 渲染 + 用户交互触发）
- **P0 修复后**：`message:[]` 被缓存为 complete → 不再无限重试 → OOM 根因消除

### P2: Chromium 启动参数优化（零成本）
`getBrowser()` 中添加 `--disable-gpu`, `--disable-software-rasterizer`, `--js-flags="--max-old-space-size=64"` 等

### P3: Worker `defaultMaxIdleMs` 600000→60000（低优先级）

### P4: ~~部署到 staging~~ ✅ 已部署

Railway 部署 FAILED 的根因：`8f237d6` 引入 `gen:openapi` 时 `writeFileSync` 目标目录 `backend/static/` 在 Docker 干净环境中不存在，但本地因目录残留不会报错。已修复（`1e70c34` script 层 mkdirSync + `7526874` Dockerfile 层 mkdir），添加 `buildScriptWriteSafety.test.ts` 防止回归。

---

## 7. 关键文件

### 需修改 (P1 非阻塞 — Puppeteer 拿不到数据是渲染问题; P2-P3 低优先级)
- `packages/aave-fetcher/src/merit-api.ts:1982-2022` — `getBrowser()` Chromium 启动参数 (P2)

### 已修改（已部署）
- `packages/aave-fetcher/src/merit-api.ts` — bounded caches, browser reconnect, page leak, cache completeness fix
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
| `RSS_RESTART_THRESHOLD_MB` | `0` (warn-only，不自动 SIGTERM) |
| `MERIT_ALLOW_LOCAL_PLAYWRIGHT` | `true` (RSS guard 700MB 自动守卫) |

---

## 9. Suggested Skills

- `tdd` — 为缓存完整性修复写测试
- `diagnose` — 确认 Puppeteer launch 的确切错误
- `verification-before-completion` — 部署后验证浏览器解析成功且不再无限重试

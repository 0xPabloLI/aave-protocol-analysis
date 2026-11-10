# AAV-1337 / 1338 / 1339 / 1340 / 1344 — codex findings 收口

五张票一个 PR 收掉（用户决定）。来源：PR #201（AAV-1337/1338/1339/1340）与
PR #202（AAV-1344）的 codex review findings。四张已随 `5e6b87b` 上线到生产。

## 1. Grill 结论（逐票）

### AAV-1337 — `/metrics` 未匹配路由回落 `req.path`

**根因**：`metrics.ts:45` 的 `req.route?.path ? … : req.path`。Express 只在
`Route.prototype.dispatch` 里设 `req.route`，未匹配到路由时（404）它为 `undefined`，
于是标签回落为调用方可控的原始路径；prom-client 的 Counter/Histogram 对每个新
label 组合永久保留 series。生产实测：单个 `GET /wp-login.php` → 约 11 个常驻 series。

**决策：未匹配 → 单一常量 `UNMATCHED_ROUTE_LABEL = "<unmatched>"`。**

探针实测（`express` + `supertest`，2026-11-10）：

| 请求                                                      | `req.route?.path` | `req.baseUrl`（finish 时） |
| --------------------------------------------------------- | ----------------- | -------------------------- |
| `/api/markets/x` 被 `app.use('/api/markets', …)` 直接 429 | `null`            | `/api/markets`             |
| `/health`                                                 | `/health`         | `""`                       |
| `/api/seo/semrush/abc`（router 挂 `/api/seo`）            | `/semrush/:id`    | `""`                       |
| `/wp-login.php`（catch-all 404）                          | `null`            | `""`                       |

**拒绝的替代方案：回落 `req.baseUrl`。** 上表看似可用（429 时能拿到
`/api/markets`，仍有界），但它只在中间件**短路响应**时才存活：一旦中间件
`next()` 穿过 router，Express 的 `restore()` 会把 `baseUrl` 重置为 `""`，
标签语义随调用链形状漂移。更关键的是，未来的 `app.use('/api/x/:param', …)`
会把调用方数据重新引入标签 —— 正是本票要消灭的那类 bug。故取常量。

**接受的代价（显式记录）**：由 path-mounted middleware 直接响应的请求
（429 限流、`express.json` 解析失败的 400、CORS 拒绝）拿不到 per-endpoint 标签，
它们与 404 一起归入 `<unmatched>`。`status` 维度仍在，聚合可查
（`aave_backend_http_requests_total{status="429"}`）；原始路径仍进 404 访问日志。
该行为由测试钉住，不是隐性副作用。

**PII（`pii-handling-policy.md` R3）**：`analytics.path` 与 metrics 的 `route`
是**同一个变量**（`metrics.ts` 里 `path: route`），所以本改动同时修掉两个通道的
回落 → R3 可关闭。匹配路由的标签是**路由 pattern**（`/semrush/:id`），不含调用方
数据，故关闭后残留风险仅剩「未来注册的路由 pattern 自身不得嵌入地址」，已在文档里
写成约束。

**已知限制（不在本票范围）**：router 挂载的子路由，`req.route.path` 不含挂载前缀
（`/semrush/:id` 而非 `/api/seo/semrush/:id`），不同 router 下的同名 pattern 会撞
标签。这是既有行为，本票不改（矩阵 S3/S4 只钉「已匹配路由标签不变」）。

### AAV-1338 — `sideDataHashes` 未登记进内存清单

**决策**：在 `docs/memory-leak-checklist.md` 的 `backend/src/` 表新增一行，编号
**`26d`**。不复用 `27`：表内已有一条「原 #27–#30 随 Merit 下线移除（AAV-1289）」的
历史记录，复用编号会让那条注记失去指代。沿用 `26b`/`26c` 的追加式编号。

三层评估：

| 层     | 结论 | 依据                                                                        |
| ------ | ---- | --------------------------------------------------------------------------- |
| Domain | ✅   | key = `SIDE_DATA_SOURCES` 枚举（`categories`/`fdv`/`forecast`），非外部输入 |
| TTL    | ➖   | 语义是「该 source 最后落库的内容指纹」，不是会变旧的数据，不需要过期        |
| Max    | ✅   | `Map.set` 覆盖同 key；key 空间被枚举穷尽 → size ≤ 3（有测试钉住）           |
| Shrink | ✅   | `warmSideDataFromDb` 启动重填 + `resetSideDataHashes()` 出口                |

**顺带修正**：`AGENTS.md` 的 Memory Safety Rule 写「(38 entries)」，实际主表已有
**42** 行（1–26、26b、26c、31–37、37b、37c、38–42）—— 计数已静默漂移 4 行。本次
登记后更新为 **43**。

### AAV-1339 — side-data 持久化两缺陷（+ 第三个缺陷）

**缺陷 A（票内）**：`shouldPersistSideData` 在写库前就 `sideDataHashes.set`，INSERT
失败后 hash 已推进 → 同样内容被判「未变化」跳过，直到内容本身变化才重试。

**缺陷 B（票内）**：内容未变时整段跳过写库 → `fetched_at` 停在**上一次内容变化**
时刻。重启后 `selectLatestSideData` → `restoreCategoriesFromDb(data, fetchedAt)` →
`hasReusableCategoriesCache()`（`Date.now() - fetchedAt < 6h`）判过期，尽管刚刚刷新
成功，仍重走外部 API。

**缺陷 C（本 spec 新增，票内未写）**：hash 口径不一致 —— `shouldPersistSideData`
（`:55`）用**原始 `data`** 算 hash，`buildSideDataPayload`（`:107`）用 **strip 后**的
`dataToStore` 算 hash（forecast 会 strip `staleTimeMs`）。后果：`warmSideDataFromDb`
写入的是 DB 的 `content_hash`（strip 后口径），重启后第一次 persist 必然算出不同
hash → 无条件多写一行，`warmSideDataFromDb` 里「Pre-fill the content hash so the
first persist tick is a no-op」的注释意图失效。

**文档支撑**（设计不是新发明）：

- `docs/plans/aav-side-data-persistence-spec.md` 矩阵 row 12 已定契约：forecast
  「只存 items+errors，不存 staleTimeMs」→ **`content_hash` 必须是落库形态的 hash**。
  缺陷 C 修的是实现与既有契约不一致，不是改契约。
- 同 spec 矩阵 row 10「content-hash 未变化 → skip（避免重复写入）」→ 修复必须**保留**
  「不产生重复内容行」，只补上新鲜度推进。
- `persistenceService.ts:401-406` / `:444-449` 的既有模式就是
  `await pool.query(...)` **之后**才 `hash.set(...)` —— 缺陷 A 的修法直接对齐同仓
  既有实现。

**决策**：

1. **hash 提交移到 INSERT 成功之后**。失败路径不推进，下一次刷新自然重试。
2. **内容未变时 `UPDATE` 最新行的 `fetched_at`**（不新增行）。SQL 以
   `content_hash = $2` 约束，只推进「内容正是我们刚校验过的那份」的行。
3. **`rowCount === 0` 时回落 INSERT**：DB 被人工清理、或另一实例的行把我们的行挤出
   `RETENTION_COUNT=3` 时自愈，否则 `UPDATE` 会永远 0 行、快照永不落库。
4. **hash 口径统一**：删除 `shouldPersistSideData` 里对原始 `data` 的 hash 计算，
   持久化决策只读 `buildSideDataPayload(...).contentHash`（单一来源，缺陷 C 由构造消除）。

**量化新增写负载**：仅「内容未变」时多一条轻量 UPDATE。上限 = 各 source 刷新频率之和：
categories 6h → 4/天，fdv 15min → 96/天，forecast 10min → 144/天，合计 ≤ 244 条/天。

**测试 seam**：`persistSideData(source, data, fetchedAt, query?)` 增加可选第 4 参数，
默认即真实 `queryWithHealthTracking`；生产调用点（3 处）不传。存在理由：写库/提交
hash 的**顺序保证**必须在 CI 内可验证，而 CI 没有 Postgres；同时 c8 覆盖率是棘轮
（lines 53 门 / 当前 53.55%），新增分支不能留白。真实 SQL 语法与 `rowCount` 语义由
opt-in 集成测试对**真实 Postgres** 验证（`TEST_DATABASE_URL`，未设则 skip；不复用
`DATABASE_URL`，避免误写 staging）。

**移除的导出**：`shouldPersistSideData`（内部专用 + 测试用）。它带副作用（提交 hash）
且语义已被 `persistSideData` 的 INSERT/UPDATE 分支取代；保留会留下两个可能漂移的
变化检测实现。测试改为通过公开入口断言可观察结果（发出了哪条 SQL、hash 是否提交）。

### AAV-1340 — `tagRequestScope` 被 metrics 门包裹

**决策**：抽出 `backend/src/middleware/observability.ts` 的
`registerObservabilityMiddleware(app)`，把 `tagRequestScope` 注册为**无条件**中间件，
metrics 仍留在 `flags.metricsEnabled` 分支内。`server.ts` 在该位置调用它，中间件顺序
不变（`requestIdMiddleware` 仍更早）。

**为什么抽文件**：`server.ts` 是副作用模块（导入即监听端口、起调度器），测试无法
导入。抽成无副作用的注册函数后，接线本身可以在 runtime 被验证（Express app +
supertest），而不是只能靠读源码。`flags` 是 getter（每次读 `process.env`），所以测试
可以逐例切换 `METRICS_ENABLED`，无需注入参数。

`tagRequestScope` 在无 `SENTRY_DSN` 时是安全 no-op：它只做
`Sentry.getCurrentScope().setTag("request_id", …)`，不依赖 `init()`（已实测
`getScopeData().tags` 可读）。

### AAV-1344 — `--from-source` 恢复命令缺 CI triage 前置

**决策**：三处 runbook（`railway-environment-config.md`、`backend-outage.md`、
`app-deploy-failure.md`）把「先判定失败性质」写成显式步骤，并在 `--from-source`
命令旁写明它**不做任何检查**、`-y` 等价于人工批准一次例外。逃生通道保留但显式化：
仅当确认是基础设施噪音（registry 抖动 / runner 掉线 / 上游 5xx）才允许走它，真实
回归必须修好并让正常链路部署。

**「谁批准」是票内要求，不是新增流程**：AAV-1344 方案第 3 条原文为「若希望保留
『明知 CI 红仍要发』的逃生通道，就把它写成显式例外并说明谁批准」。`app-deploy-failure.md`
里对「回滚」措辞的修正同样来自 S4：原文把 `--from-source` 写成「redeploy the previous
tag」，而该命令部署的是**来源的最新提交**，不改就是继续传播被误读的语义。

## 2. Modified Files Impact

| 文件                                                                                                                      | 修改内容                                                                                                                 | 风险   | 评估                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/src/middleware/metrics.ts`                                                                                       | 未匹配路由标签 → 常量；导出 `UNMATCHED_ROUTE_LABEL`                                                                      | Medium | 改变已有 label 语义。下游是 Prometheus 抓取方（无仓内消费者，无告警规则依赖 `route` 回落值）。最坏后果：404/429 指标粒度下降，`status` 维度仍在。验证：新测试钉住 5 个场景 + 生产 `/metrics` 实测                                              |
| `backend/src/middleware/observability.ts`                                                                                 | **新建**：注册 tagRequestScope + metrics                                                                                 | Low    | 纯搬运现有两行接线，无新逻辑。顺序由 `server.ts` 调用点保持                                                                                                                                                                                    |
| `backend/src/server.ts`                                                                                                   | 5 行接线块 → `registerObservabilityMiddleware(app)`                                                                      | Medium | 中间件顺序是敏感面（`requestId` 必须先跑）。调用点位置不变；顺序由测试断言 + 现有 `publicApiSurface` 类静态检查兜底                                                                                                                            |
| `backend/src/services/sideDataPersistenceService.ts`                                                                      | 写路径重写：提交 hash 后置、未变则 UPDATE、`rowCount=0` 回落 INSERT、删除 `shouldPersistSideData`、新增可选 `query` 参数 | Medium | 3 个 fire-and-forget 调用点（categories/fdv/forecast）。最坏后果：快照写不进 DB → 重启后 warm 落空 → 多一轮外部 API 调用（降级，不是中断）；或反之多写行（被 `RETENTION_COUNT=3` 清理兜住）。验证：6 行矩阵的 CI 单测 + 真实 Postgres 集成测试 |
| `backend/src/services/sideDataPersistenceService.ts`（读路径）                                                            | 不改                                                                                                                     | Low    | `selectLatestSideData` / `restoreSideDataFromPayload` / `warmSideDataFromDb` 语义未动                                                                                                                                                          |
| `docs/memory-leak-checklist.md`                                                                                           | 新增 `26d` 行（`sideDataHashes`）                                                                                        | Low    | 纯追加                                                                                                                                                                                                                                         |
| `AGENTS.md`                                                                                                               | Memory Safety Rule 计数 38 → 43                                                                                          | Low    | 修正既有漂移；`check:agents-drift` 只校验路径存在性，不受影响                                                                                                                                                                                  |
| `docs/operations/pii-handling-policy.md`                                                                                  | R3 标记为已修（metrics + analytics 共用标签源）                                                                          | Low    | 文档与代码对齐；R5（`/metrics` 无鉴权）保持 open，本票 out of scope                                                                                                                                                                            |
| `docs/operations/railway-environment-config.md`、`docs/runbooks/backend-outage.md`、`docs/runbooks/app-deploy-failure.md` | 补 CI triage 前置 + `--from-source` 警示                                                                                 | Low    | 纯文档；行为要求来自 AAV-1344 矩阵                                                                                                                                                                                                             |

## 3. Behavioral Scenarios

### AAV-1337（metrics label）

| #   | Scenario                           | Expected Behavior                           | Risk   | Evidence                                         | Mitigation                   |
| --- | ---------------------------------- | ------------------------------------------- | ------ | ------------------------------------------------ | ---------------------------- |
| S1  | 未匹配路径 404                     | `route` = `<unmatched>`，**不等于**请求路径 | High   | automated test（新 `metricsRouteLabel.test.ts`） | 常量标签                     |
| S2  | 两个不同未匹配路径                 | 只产生 1 组 series（同一常量）              | High   | automated test（比较改动前后 series 集合）       | 同上                         |
| S3  | 已匹配 `/health`                   | 标签仍为 `/health`                          | Medium | automated test                                   | 只改 fallback 分支           |
| S4  | 参数化路由 `/api/seo/semrush/<id>` | 两个不同 id → 同一标签，且标签不含 id       | Medium | automated test（router 挂载 + 两请求对比）       | 继续用 `req.route.path`      |
| S5  | `METRICS_ENABLED=false`            | 不注册任何 series                           | Low    | automated test（series 快照前后一致）            | 保持既有门                   |
| S6  | path-mounted middleware 直接 429   | 标签为 `<unmatched>`（显式接受）            | Medium | automated test（钉住该取舍）                     | 记录代价 + `status` 维度保留 |
| S7  | 生产真实流量下的 label 集合        | 无调用方可控路径                            | High   | runtime-real-data（生产 `/metrics` 抓取比对）    | —                            |

### AAV-1338（内存清单）

| #   | Scenario                    | Expected Behavior       | Risk   | Evidence                                                               | Mitigation |
| --- | --------------------------- | ----------------------- | ------ | ---------------------------------------------------------------------- | ---------- |
| S1  | 清单表包含 `sideDataHashes` | 有条目 + 三层结论       | Medium | static check（`rg sideDataHashes docs/memory-leak-checklist.md` 命中） | —          |
| S2  | key 空间上界                | 结论写明 ≤ 3 且给出理由 | Medium | automated test（`getSideDataHashMapSize()` ≤ 3，已有）                 | —          |

### AAV-1339（side-data 持久化）

票内 6 行矩阵，逐行映射：

| #   | Scenario                                     | Expected Behavior                                                   | Risk   | Evidence                                                                      | Mitigation                        |
| --- | -------------------------------------------- | ------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------- | --------------------------------- |
| S1  | 写库成功 + 内容变化                          | 发 INSERT；hash 提交；快照落库                                      | High   | automated test（seam）+ real-DB 集成测试                                      | —                                 |
| S2  | 写库**失败** + 内容变化                      | hash **不**提交；下一次刷新重发 INSERT                              | High   | automated test（seam：第一次 query 抛错 → 断言 hash 未提交、第二次仍 INSERT） | 提交后置于 INSERT 成功之后        |
| S3  | 失败后 DB 恢复、内容仍未变                   | 重试成功、快照最终落库                                              | High   | automated test（seam：先抛错后成功）+ real-DB 集成测试                        | 同上                              |
| S4  | 写库成功 + 内容未变                          | 不发 INSERT，发 UPDATE 推进 `fetched_at`                            | High   | automated test（seam：断言 SQL 类型 + 参数含新时间戳）+ real-DB 集成测试      | 单独轻量 UPDATE                   |
| S5  | 重启后读未变内容                             | `fetched_at` 在 soft TTL 内 → `hasReusableCategoriesCache()` 可复用 | High   | real-DB 集成测试（warm 后断言 `fetchedAt` 距 now < 6h）                       | 由 S4 保证                        |
| S6  | DB 不可用（`DATABASE_URL` 未设 / pool 退避） | 不抛错、零 query、内存缓存不受影响                                  | Medium | automated test（seam 记录调用数 = 0）                                         | 保持既有早退                      |
| S7  | 内容未变但 DB 无匹配行                       | 回落 INSERT（自愈）                                                 | Medium | automated test（seam：UPDATE 返回 `rowCount=0` → 断言随后 INSERT）            | `rowCount` 检查                   |
| S8  | forecast 的 `staleTimeMs` 不同、其余相同     | 判为**未变化**（走 UPDATE，不 INSERT）                              | High   | automated test（seam）                                                        | hash 口径统一为落库形态（缺陷 C） |
| S9  | 启动 warm 后首次 persist                     | 判为未变化（不再无条件多写一行）                                    | Medium | real-DB 集成测试                                                              | 同上                              |

### AAV-1340（Sentry request scope）

| #   | `METRICS_ENABLED` | `SENTRY_DSN` | Expected Behavior                       | Risk   | Evidence                                                                                         |
| --- | ----------------- | ------------ | --------------------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| S1  | true              | 已配置       | Sentry scope 带 request ID              | Medium | automated test（scope tag 断言）+ runtime-real-data                                              |
| S2  | **false**         | 已配置       | scope **仍**带 request ID（本票修复点） | High   | automated test（切 env 后过 app，断言 `getScopeData().tags.request_id` = 响应头 `X-Request-ID`） |
| S3  | true              | 未配置       | 不初始化 Sentry，无副作用               | Low    | automated test（测试环境即无 DSN，同一断言路径通过）                                             |
| S4  | false             | 未配置       | 不初始化 Sentry，无副作用               | Low    | 同 S3                                                                                            |
| S5  | 任一              | 任一         | 响应头 `X-Request-ID` 行为不变          | Medium | automated test（两个 flag 组合下都断言头存在）                                                   |

### AAV-1344（runbook）

| #   | Scenario                   | Expected Behavior                                    | Risk   | Evidence                                 |
| --- | -------------------------- | ---------------------------------------------------- | ------ | ---------------------------------------- |
| S1  | 失败 run 是真实回归        | 文档要求先修复 + 重跑 CI，**不**直接 `--from-source` | Medium | static check（三处文档命中 triage 前置） |
| S2  | 失败 run 是基础设施噪音    | 允许走 `--from-source`，且给出区分标准               | Medium | static check                             |
| S3  | 读到第 2 步命令            | 命令旁即有「不做检查」警示                           | Medium | static check                             |
| S4  | `--from-source` 语义被误读 | 文档写明它部署的是「来源的最新提交」                 | Medium | static check                             |

## 4. 验证结果（2026-11-10）

### 自动化

| 检查                                | 结果                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `backend` 全套（`tests/*.test.ts`） | **539 tests / 535 pass / 4 skip / 0 fail**（含真实 Postgres 套件 7 条）                |
| 无 `TEST_DATABASE_URL` 时           | 532 tests / 528 pass / 4 skip / 0 fail（DB 套件 skip，覆盖门仍在）                     |
| 覆盖率（CI 配置，含 DB 套件）       | lines/statements **56.82%**、branches **82.1%**、functions **68.13%** — 全部高于棘轮门 |
| `test:typecheck`                    | 通过                                                                                   |
| `npm run check:quality`             | 全门通过（含 jscpd、AGENTS.md drift 431 文件）                                         |

真实 Postgres 由 CI 提供（`build-and-prune` 新增 `services.postgres` + `TEST_DATABASE_URL`），
所以这些行在**受控路径**内有证据，不再依赖人工执行。

### Runtime（真实进程 + 真实 Postgres）

| 场景           | 证据                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| AAV-1337 S1/S2 | 25 个不同未匹配路径（`/wp-login.php`、`/.env`、`/scan-probe-*` …）后，registry 只有 `route="<unmatched>"` 一个标签，无原始路径        |
| AAV-1337 S3    | `/health`、`/` 标签保持字面路由；生产基线同样只有 `/`、`/health`、`/side-data` 三个标签（改动前抓取）                                 |
| AAV-1337 S7    | 生产 `/metrics` 抓取：`http=200`，3 个 route 标签全部是路由 pattern，无调用方数据                                                     |
| AAV-1339 S4    | 一次「内容未变」刷新：`side_data_snapshots` 行数不变，最新行 `fetched_at` 前进到本次 tick 时间                                        |
| AAV-1339 S5    | 重启后日志 `💾 Warmed side-data from DB: source='categories', age=139s` → `✅ Coingecko categories cache hit (startup)`，未走外部 API |
| AAV-1339 S1    | 同一进程内 `💾 Side-data restored from DB: 2/3 sources`，`/api/meta/side-data` 返回 `categories` + `forecast`（fdv 因本地网络不可达） |
| AAV-1340 S2/S5 | `METRICS_ENABLED=false` 实例：`/metrics` → **404**，`X-Request-ID` 仍存在且进 analytics 日志                                          |
| 端到端         | `/api/markets` → 200、65 reserves、`schemaFingerprint=0f60c7e06ff5`（与生产一致）、`stale=false`                                      |

### 未覆盖 / 已知限制

- 本地无 Postgres 服务端且 Docker Hub 不可达，真实 DB 验证通过 PGlite（PostgreSQL 18.6,
  wire protocol）完成；CI 用真实 `postgres:16-alpine`。
- 本地网络无法访问 CoinGecko / Aave API（`UND_ERR_CONNECT_TIMEOUT`），所以 categories 的
  **写入**由种子脚本走生产代码路径完成，未在本地触发真实外部刷新。CI 不依赖外部 API。
- AAV-1337 未覆盖 router 挂载前缀导致的标签撞名（既有行为，见 §1 已知限制）。

## 5. 代码审查处置（双轴）

Standards 轴 6 条、Spec 轴 3 条。逐条处置：

| 来源     | 发现                                                            | 处置                                                                                                                  |
| -------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Std 1    | 真实 DB 证据在受控路径内不存在（`TEST_DATABASE_URL` 无人设置）  | **采纳**：`ci.yml` 的 `build-and-prune` 加 `services.postgres` + job 级 `TEST_DATABASE_URL`，DB 套件进 CI             |
| Std 2    | 覆盖率棘轮风险（`defaultQuery` 等仅在默认参数路径可达）         | **已验证**：含 DB 套件的 CI 配置下 56.82 / 82.1 / 68.13，全部高于门；跳过 DB 时也通过（532 tests）                    |
| Std 3    | 两个测试文件复制了相同 helper                                   | **采纳**：抽出 `backend/tests/helpers/metricsTestUtils.ts`                                                            |
| Std 4    | 写路径两个分支重复 `insert + cleanup`                           | **采纳**：改为「未变且 touch 命中则提前返回」的单一路径                                                               |
| Std 5    | `(source, fetchedAtIso, query)` 数据泥团、`fetchedAtIso` 可推导 | **采纳**：helper 改收 `payload`，时间戳在内部派生                                                                     |
| Std 6    | `resetSideDataHashes()`/`resetPoolHealth()` 重复 24 次          | **采纳**：改为 `beforeEach`；S6 的 `DATABASE_URL` 恢复移入 `finally`                                                  |
| Spec 1   | AAV-1339 S5 只覆盖 forecast，未覆盖 categories                  | **采纳**：新增 categories 的 warm + `COINGECKO_TTL.categoriesSoftTtlMs` 断言                                          |
| Spec 2   | spec 声称「顺序由测试断言兜底」但无此断言                       | **采纳**：新增 `server.ts` 中 `requestIdMiddleware` 必须先于 observability 注册的断言                                 |
| Spec 3   | AAV-1337 S7 无静态证据                                          | **已执行**：生产 `/metrics` 抓取基线（3 个 pattern 标签）+ 本地 25 路径验证，记入 §4                                  |
| Spec (c) | `touch` 按 `created_at` 排序、读路径按 `fetched_at` 排序        | **采纳**：`touch` 改为 `ORDER BY fetched_at DESC, created_at DESC` 与读路径对齐，并新增「乱序两行」集成测试钉住该对齐 |

两个"越界"判定经复核为**票内要求**（见 §1 AAV-1344），不修改。

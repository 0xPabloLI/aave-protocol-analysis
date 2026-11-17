# AAV-365 — `GET /api/meta/side-data` 确定性 ETag + 条件请求 304

> **Status: Active** — 实施中（2026-11-17）。票面：`[Backend] side-data endpoints 增加 deterministic ETag + 前端 If-None-Match 304 节流`。
> **Scope**：仅后端。前端显式条件请求（`If-None-Match` 手工拼装）不在本票，浏览器对带 ETag 的响应会自动回填 `If-None-Match`，后端落地即生效。

## Problem Statement

`/api/meta/side-data` 的 `Cache-Control` 是 `public, max-age=60, s-maxage=600, stale-while-revalidate=600`，客户端最多 60 秒后就会重新校验。`app.set("etag", "weak")`（`server.ts:116`）让 Express 默认为每个 `res.json()` 响应生成弱 ETag，看起来条件请求可用 —— 但实际上 **304 在结构上不可达**：

1. `metaController` 每次请求写入 `generatedAt: new Date().toISOString()`，响应体每次都不一样；
2. `campaignAccess.updatedAt` 在每次 markets 刷新（约 1 分钟一次）时被 `setCampaignAccessSnapshot` 重置，即使 campaign 内容逐字节相同。

Express 的默认 ETag 是**响应体哈希**（`W/"<len>-<sha1(body)>"`），所以这两个易变字段让 ETag 每次（或每分钟）都变。结果是：60 秒后每次校验都返回 200 + 完整体（categories 数组 + FDV 列表 + forecast + campaignAccess），一个本该零成本的「内容没变」变成一次全量下载。

## Solution

为 `/api/meta/side-data` 计算 **基于语义内容** 的确定性弱 ETag：对响应体做规范化 JSON（键排序、数组保序），只排除**保活标记**（`generatedAt`、`campaignAccess.updatedAt`），再做 sha256。响应头写入该 ETag；Express 自带的 freshness 判定（`fresh` 2.0.0）会在 `If-None-Match` 命中时自动回 304 并清空响应体。

内容变化（任一子块数据、错误列表、`fetchedAt`/`staleTimeMs` 版本）仍会改变 ETag，304 永远不会掩盖真实变更。

## Implementation Decisions

1. **新增纯函数模块** `backend/src/services/sideDataEtag.ts`：
   - `canonicalJson(value, omitPaths)`：递归规范化。对象键按字典序输出；数组保持顺序；`undefined` 值的对象键按 `JSON.stringify` 语义省略，数组中的 `undefined` 输出 `null`；`bigint` 与 `JSON.stringify` 一样抛 `TypeError`（响应体本来就不可能包含）。
   - `computeWeakETag(value, { omitPaths })`：`W/"<sha256 前 32 hex>"`（128 bit，碰撞概率可忽略，日志可读）。弱标签是正确形态：线上字节（键序、压缩）与标签所代表的内容不是一一对应。
2. **排除列表（唯一来源，写在模块内并被测试钉住）**：
   - `generatedAt` — 请求时刻标记，非内容。
   - `campaignAccess.updatedAt` — 快照被重置的时刻，非内容（`campaigns` 本身仍参与哈希）。
   - `categories.fetchedAt` / `fdv.fetchedAt` / `forecast.staleTimeMs` **不排除**：真实重取（6h / 15m / 发布节奏）应当让缓存失效，即使内容恰好一致也保守失效，不让 304 声称「未修改」。
3. **控制器改为可注入工厂**（对齐 `createEModeMetaHandler`）：`createSideDataMetaHandler({ getCategories, getFdv, getForecast, getCampaignAccess })`，默认绑定现有实现；`getSideDataMeta` 作为默认实例导出，`routes/meta.ts` 不变。这样路由测试能走真实控制器 + 真实 Express freshness，而不是复制一份 handler。
4. **只在 200 上写内容标签**：全子块失败走 500，不写内容标签，并显式 `Cache-Control: no-store`。理由：路由级中间件给该路径下发的是 `public, max-age=60`，若不覆盖，5xx 体会被按可缓存响应处理；而 Express 的 freshness 判定不看状态码，一个被缓存的错误体可以换来 304，把故障藏起来。
5. **不改变任何响应体字段**：`generatedAt` / `updatedAt` 仍按原语义返回；`Cache-Control`、限流、OpenAPI 均不变。
6. **性能**：每请求一次 sha256；payload 规模见 Runtime evidence。若实测成本可感，再考虑按快照版本缓存标签（本票不做，避免新增有状态缓存 —— 参见 `docs/memory-leak-checklist.md`）。

## Testing Decisions

- 纯函数单测：键序无关、数组顺序有关、omit 路径（顶层 + 一层嵌套）、`undefined` 语义、跨调用/跨进程确定性、内容变更与「仅保活标记变更」的区分。
- 路由测试（`supertest` + 真实 `createSideDataMetaHandler`）：200 带 ETag；相同内容两次请求标签相同；`If-None-Match` 命中 304 且空体；陈旧标签 200 + 新标签；标签列表含匹配项 304；请求头 `Cache-Control: no-cache` 强制 200；全失败 500 无 ETag。
- 运行时：本地起后端，`curl` 首次拿 ETag，二次带 `If-None-Match` 确认 304 与体积差；记录 payload 大小与哈希耗时。

## Scenario & Risk Verification Matrix

| ID  | 场景                                                      | 期望                                                                                    | 证据                                  |
| --- | --------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------- |
| S1  | 正常 200                                                  | `ETag: W/"<32hex>"` 存在；`Cache-Control` 不变                                          | 路由测试 + runtime curl               |
| S2  | 同内容两次请求（`generatedAt` 不同）                      | ETag 相同                                                                               | 纯函数单测 + 路由测试                 |
| S3  | `If-None-Match` = 当前标签                                | 304、空体、无 `Content-Type`、ETag 保留                                                 | 路由测试 + runtime curl               |
| S4  | `If-None-Match` = 陈旧标签                                | 200 + 完整体 + 新 ETag                                                                  | 路由测试                              |
| S5  | `If-None-Match` 列表包含匹配项（`"a", W/"x"`）            | 304                                                                                     | 路由测试                              |
| S6  | 请求头 `Cache-Control: no-cache` + 匹配标签               | 200（`fresh` 的强制重取规则）                                                           | 路由测试                              |
| S7  | 任一子块内容变化（如 FDV 数值、errors 文案、forecast）    | ETag 变化                                                                               | 纯函数单测 + 路由测试                 |
| S8  | 仅 `campaignAccess.updatedAt` 变化                        | ETag 不变                                                                               | 纯函数单测                            |
| S9  | 全子块失败                                                | 500，无 ETag；带匹配标签也不 304                                                        | 路由测试                              |
| S10 | 部分子块失败（`errors` 存在）                             | 200 + ETag；错误集合不变时 304                                                          | 路由测试                              |
| S11 | 可选子块缺失（无 categories/fdv/forecast/campaignAccess） | ETag 仍可计算且稳定                                                                     | 纯函数单测                            |
| S12 | 对象键序不同、值相同                                      | ETag 相同                                                                               | 纯函数单测                            |
| S13 | 数组顺序不同                                              | ETag 不同（顺序属于内容）                                                               | 纯函数单测                            |
| S14 | 跨进程/重启                                               | 同 payload → 同标签（无进程内状态）                                                     | 子进程重算断言                        |
| S15 | `Accept-Encoding: gzip` / 无                              | 同一 ETag（标签不随压缩变化）                                                           | 路由测试（Compression 关闭时也成立）  |
| S16 | 缓存语义风险：304 掩盖真实变更                            | 排除项仅两个保活标记；`fetchedAt`/`staleTimeMs`/`campaigns` 参与哈希 ⇒ 真实变更必换标签 | 纯函数单测（S7/S8 的对照） + 代码审查 |
| S17 | 错误路径被缓存                                            | 500：`Cache-Control: no-store`、无内容派生标签；错误体不可被缓存后回放成 304            | 路由测试                              |
| S18 | 304 与 `Content-Length`                                   | 304 无 `Content-Length`（Express 剥离）                                                 | 路由测试                              |

## Out of Scope

- 前端手工 `If-None-Match` / `fetch(..., { cache: 'no-cache' })` 编排：浏览器已自动回填，若需要跨浏览器强一致再开前端票。
- `/api/markets`（`Cache-Control: no-cache, must-revalidate`，体量与变更频率不同）与 `/api/meta/e-mode`（`generatedAt` 来自快照时间戳，默认弱 ETag 已稳定）。
- CDN 侧（Cloudflare）对 304 的缓存策略调优。
- 按快照版本缓存 ETag（性能优化，待实测决定）。

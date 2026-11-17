# AAV-1293 — OpenAPI 只覆盖公开数据面（`/api/seo/*` 不纳入）

> **Status: Active** — decision + guard implementation.
> Ticket: Linear AAV-1293（[后端] 是否将 `/api/seo/*` 管理面纳入 OpenAPI spec（AAV-1290 残留项），Low）

## Problem Statement

`backend/scripts/generate-openapi.ts` 的 `paths` 只手写了两条公开数据端点（`GET /markets`、`GET /meta/side-data`），而 `app.use("/api/seo", seoRouter)` 下的 9 个 handler 完全不在 spec 里。票面要求做一个决定，而不是默认补齐。

关键事实（本轮重新取证，不依赖票面旧述）：

- `backend/src/routes/seo.ts` 第一行就 `router.use(seoAuthMiddleware)`，令牌来自 `SEO_ADMIN_TOKEN`，`timingSafeEqual` 比较，缺 token → 503 / 错 token → 401（`backend/src/middleware/seoAuth.ts`）。
- 前端只有 `/admin/seo` 一个消费者，且经 Supabase `seo-proxy` edge function 注入 `X-Admin-Token`（`aaveapy/src/lib/seoApi.ts` 文件头注释：token 不出现在浏览器 bundle）。
- 该面已经有一份独立文档 `docs/api/seo-api-documentation.md`（认证、BFF 模式、端点表）。
- 公开 spec 由 `backend/static/openapi.json` 提供，`backend/src/routes/swagger.ts` 原样 serve；`gen:openapi` 挂在 backend `build` 里。

一句话：**`/api/seo/*` 是内部运维面，不是对外数据契约；把它写进公开 spec 等于把内部写入字段固化成承诺。**

## Solution

采用票面的选项 1（不纳入 + 记录理由）：

1. 在 `generate-openapi.ts` 的 `paths` 上方写一段决策注释：只覆盖公开数据面；`/api/seo/*` 走 admin 认证、经 Supabase proxy 消费、单独文档化；基础设施端点（`/health`、`/metrics`、`/openapi.json`）同样不在范围内。
2. 在 `docs/api/api-documentation.md` 的基础信息里补一句同样的边界，避免读者以为 spec 漏了 SEO 面。
3. 加两条守卫断言（`backend/tests/openapiAutoGen.test.ts`）：
   - 生成的 spec `paths` 键**恰好**是 `/markets` 与 `/meta/side-data`（多一条就红）；
   - 源码里必须有上述决策注释的锚点文字（删注释就红，防止"以后顺手加进去"）。

不做：不往 spec 写 `/api/seo/*`、不改 `seoRouter`、不动认证、不把 `/health` / `/metrics` 塞进 spec。

## User Stories

- 作为 API 消费者，我打开 `/openapi.json` 只看到两个承诺过的公开数据端点，不会把 SEO 管理面的写入字段当成契约。
- 作为运维人员，我仍能在 `docs/api/seo-api-documentation.md` 找到完整的 SEO 管理 API 说明。
- 作为 reviewer，我能在 `generate-openapi.ts` 里一眼看到"为什么只有两条 path"，不需要翻 Linear。
- 作为维护者，如果我（或未来的 agent）往 `paths` 里加了 `/api/seo`，`npm run test -w aave-dashboard-backend` 会立刻红。

## Implementation Decisions

| #   | 决策                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 决策结论：**不纳入公开 OpenAPI**。理由：admin-only、经 Supabase proxy、已有独立文档、无第三方消费者。                            |
| D2  | 理由写在 `paths` 上方的注释里（代码即文档），并用测试锚定；不同时维护一份容易漂移的 Markdown 决策表。                            |
| D3  | 守卫断言放在 `backend/tests/openapiAutoGen.test.ts`（已有文件，已有读 `static/openapi.json` 与源码的 pattern），不新建测试文件。 |
| D4  | `docs/api/api-documentation.md` 只加一句边界说明，不复制 SEO 端点表（避免第二份真相）。                                          |
| D5  | 不改 `backend/static/openapi.json` 的内容：注释不参与生成，`gen:openapi` 后文件应逐字节不变（作为运行时验证）。                  |

## Testing Decisions

- 行为 seam：生成物 `backend/static/openapi.json` 的 `paths` 键集合；源码 `generate-openapi.ts` 的注释锚点。
- 不测注释全文，只测两个稳定锚点（`SEO admin surface`、`not a public contract`），避免文案微调就红。
- 反向验证：把 `/api/seo/status` 临时加进 `paths` → 第一条断言必须红；删掉注释 → 第二条断言必须红。

## Behavioral Scenarios (Scenario & Risk Verification Matrix)

| #   | 场景                                            | 期望                                                                     | 验证方式                       |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------ |
| S1  | 生成 spec 的 paths 集合                         | 恰好 `/markets`、`/meta/side-data`                                       | 守卫断言                       |
| S2  | 有人加入 `/api/seo/*`                           | 守卫红                                                                   | mutation（临时加一条再跑）     |
| S3  | 决策注释被删                                    | 守卫红                                                                   | mutation（删注释再跑）         |
| S4  | `gen:openapi` 重跑                              | `git diff backend/static/openapi.json` 为空                              | 本地运行                       |
| S5  | `/health` / `/metrics` / `/openapi.json` 被塞入 | S1 红（不在允许集合内）                                                  | 同 S2 的 mutation 形态         |
| S6  | 前端 AdminSeo 仍可用                            | 经 Supabase `seo-proxy` 调 `/api/seo/*`，不依赖公开 spec                 | 静态证据（`seoApi.ts` 头注释） |
| S7  | 运维文档完整性                                  | `docs/api/seo-api-documentation.md` 仍是 SEO 面的唯一详细文档            | 文档指针检查                   |
| S8  | 公开文档读者误解                                | `api-documentation.md` 明确写出「spec 只覆盖公开数据面、SEO 面单独文档」 | 文本检查                       |

## Modified Files Impact

- `backend/scripts/generate-openapi.ts` — `paths` 上方新增决策注释（不改生成结果）。
- `backend/tests/openapiAutoGen.test.ts` — 新增 2 条守卫断言。
- `docs/api/api-documentation.md` — 基础信息补一句边界。
- `docs/plans/aav-1293-openapi-public-surface-spec.md` — 本文件。

## Tickets（tracer bullets）

- **T1**（本票全部）：守卫断言先红 → 注释 + 文档补齐 → 生成物核对。无依赖边。

## Code Review

单文件注释 + 两条断言 + 一句文档，无逻辑分支。审查两轴（Standards / Spec）结论：

- **Spec**：三条验收都有对应证据（决策落注释、公开文档补边界、生成物不变），无 scope creep（没动 `seoRouter`、没动认证、没扩 spec）。
- **Standards**：断言只锚两个稳定短语，不复述整段注释；不新增测试文件；不复制 SEO 端点表，避免第二份真相。

## Verification Evidence

| #   | 场景                   | 证据                                                                   | 结果                |
| --- | ---------------------- | ---------------------------------------------------------------------- | ------------------- |
| S1  | paths 恰好两条公开端点 | `openapiAutoGen.test.ts` 11/11 绿                                      | ✅                  |
| S2  | 加入 `/api/seo/status` | 临时加 path + `gen:openapi` → 10 pass / 1 fail（`deepEqual` 打红）     | ✅ mutation 证明    |
| S3  | 删决策注释             | 实现前首跑即 10 pass / 1 fail（注释锚点缺失）                          | ✅ 红→绿            |
| S4  | `gen:openapi` 重跑     | `git diff backend/static/openapi.json` 为空                            | ✅ 生成物逐字节不变 |
| S5  | 基础设施端点混入       | 同 S2 的形态，不在允许集合内即红                                       | ✅ 由 S1 覆盖       |
| S6  | 前端 AdminSeo 路径     | `aaveapy/src/lib/seoApi.ts` 头注释：经 Supabase `seo-proxy` 注入 token | ✅ 静态证据         |
| S7  | 独立运维文档           | `docs/api/seo-api-documentation.md` 仍是 SEO 面详细文档                | ✅                  |
| S8  | 公开文档边界           | `docs/api/api-documentation.md` 新增「spec 只覆盖公开数据面」段落      | ✅                  |

其他门禁（本地）：

- `npm test -w aave-dashboard-backend` → 572 tests / 563 pass / 0 fail
- `npm run check:prettier` → rc 0（463 tracked / 2 symlink skipped）
- `npm run build -w aave-dashboard-backend` → rc 0（gen:openapi 重新生成后 static 无 diff）
- `npm run check:quality` → rc 0（ESLint / syncpack / TODO / jscpd / knip / test-naming 124 / feature-flags / agents-drift 465）

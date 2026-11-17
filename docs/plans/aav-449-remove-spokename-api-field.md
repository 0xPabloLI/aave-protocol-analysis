# AAV-449 — 从 `/api/markets` 响应中移除 `spokeName`

> **Status: Active** — 实施中（2026-11-17）。
> **票面**：`[Backend] 移除 spokeName 字段 — 语义与 marketName 冗余`（Low / Ready for agent，AAV-387 子票 1/4）。
> **Scope**：只收敛**对外契约**。`RuntimeReserveData` 与 DB archive 保留 `spokeName`，不做数据库迁移。

## Problem Statement

`GET /api/markets` 的 V4 行仍然带 `spokeName`，但它在三个层面都已经没有价值：

1. **语义重复**：V4 的 `marketName` 由 `AaveV4${spoke.name}` 构造成 `AaveV4EthereumCore`，`spokeName`（`Core`）只是它的后缀；Hub 侧另有 `hubName`。对外身份由 `spokeId`（base64 reserveId 前缀）与 `spokeAddress` 承担，而这两个字段前端本来就从 `reserveId` 解析（`src/lib/reserveIdParser.ts`），payload 里根本不返回。
2. **值不稳定**：SDK 路径给 SDK 官方名（`Main`），RPC fallback 路径给 address-book raw key（`MAIN_SPOKE`）或 `unknown`（ADR-0029 已记录为已知降级）。同一个字段在两条链路下语义漂移，作为契约就是不可靠的。
3. **没有消费者**：前端类型里留着 `spokeName?: string`，但除声明与测试 fixture 外零读取；`.passthrough()` 只是让未使用字段悄悄穿过。

实证基线（2026-11-17 staging `snapshot-v3` / fp `0f60c7e06ff5`）：441 条 reserve 中 124 条 V4 行带 `spokeName`，共 19 个不同值（`Main`、`Bluechip`、`Lido`…）；`spokeAddress`/`hubAddress` 均不在 payload 中。

## Solution

把 `spokeName` 从 API 序列化白名单和对外类型里删掉，保留它在内部/档案层的既有职责：

- `serializeReserveForApi` 不再输出该键（`PASSTHROUGH_FIELDS` 删除条目）。
- `MarketWithSpread` 显式 `Omit<…, "spokeName">`，让"类型里声明了但序列化从不输出"这类缺口在编译期就暴露（见 D3）。
- `MARKETS_API_VERSION` 按仓库既有规则（删字段 = 破坏性变更）从 `snapshot-v3` 升到 `snapshot-v4`。
- schema fingerprint 变更：更新 `packages/aave-shared-config/schema-fingerprint.ts`、`backend/tests/apiSchemaFingerprint.test.ts` 与前端 mirror `aaveapy/src/shared/schema-fingerprint.ts`，让前端缓存自然失效。
- OpenAPI 重新生成；API 文档与 ADR-0026 补一条口径说明。

## User Stories

1. 作为前端开发者，我希望 `/api/markets` 只返回我会消费的字段，这样 `passthrough()` 不再放行一个语义重复且值不稳定的字段。
2. 作为契约维护者，我希望"删掉一个 API 字段"必须同时改动序列化白名单与对外类型，这样两者不会静默漂移。
3. 作为排障者，我希望 V4 身份只通过 `spokeId`/`spokeAddress` 表达，这样 SDK 与 RPC fallback 的 `spokeName` 命名差异不会再污染对外数据。
4. 作为数据档案维护者，我希望历史 `spoke_name` 列继续有值，这样线上契约收敛不以丢失档案为代价。
5. 作为 API 消费方，我希望破坏性变更能从 `snapshot.version` 与 `schemaFingerprint` 上被识别，而不是"某天字段没了"。
6. 作为审查者，我希望有测试同时钉住"不输出"和"重新加回会红"，而不是只靠一次手工 grep。

## Implementation Decisions

**D1 — 只收敛对外契约，不删内部字段。** `RuntimeReserveData` 保留 `spokeName`，`EXPECTED_RUNTIME_FIELDS` 不变，persistenceService 的 `spoke_name` 归档列照写。理由：DB 是纯档案（0 SELECT），删内部字段会让归档从某天起变成 NULL，收益为零、代价是历史断裂。

**D2 — 序列化层是唯一出口。** `serializeReserveForApi` 用 `PASSTHROUGH_FIELDS` 白名单控制透传；`serializeMarketsReservesForApi` 与 controller 均不再做二次拼装，因此删白名单条目即可覆盖 SDK 与 RPC fallback 两条链路。

**D3 — 类型层加结构性守卫。** `PASSTHROUGH_FIELDS` 的元素类型从 `keyof RuntimeReserveData` 收紧为 `keyof MarketWithSpread`。这样以后任何字段一旦从对外类型 `Omit` 掉，白名单会立刻编译失败，而不是靠人记得同步。

**D4 — 版本号升级。** `MARKETS_API_VERSION` `snapshot-v3 → snapshot-v4`，`marketsVersionBump.test.ts` 同步更新并写明本次原因。`snapshot.version` 是公开契约信号，删字段属于它注释里明确的"改名/删字段"破坏性变更。

**D5 — fingerprint 三处同步。** `computeSchemaFingerprint()` 的 canonical reserve 去掉 `spokeName` 占位后哈希改变；必须同时更新后端 snapshot 测试常量、`packages/aave-shared-config/schema-fingerprint.ts`、前端 `aaveapy/src/shared/schema-fingerprint.ts`。前端 `CACHE_VERSION` 不动——`SCHEMA_FP` 已经负责形状变更的失效。

**D6 — 保留 `hubId`/`hubName`/`spokeId`。** 它们各自承担 Hub/Spoke 身份与分组（`hubAggregation.ts`），不与 `marketName` 重复；本票不做"顺手清理"。

**D7 — 前端只做必要的 mirror 收敛。** 删除 `aaveapy/src/types/aave.ts` 中零消费的 `spokeName?: string` 声明并更新 fingerprint 常量；生成的 OpenAPI zod schema 由既有 bot 同步，不在本票手改。

## Testing Decisions

好的测试只断言外部行为：喂一条带 `spokeName` 的 reserve，断言**输出对象里没有这个键**（`!("spokeName" in out)`），而不是断言实现里删了哪一行。

- **主 seam**：`serializeReserveForApi`（已有、纯函数、覆盖全字段）。新增 `backend/tests/spokeNameNotExposed.test.ts`：
  - V4 SDK 形态（`spokeName: "Main"`）、V3 形态（无该键）、RPC fallback 形态（`spokeName: "MAIN_SPOKE"` / `"unknown"`）三条输入都必须无该键；
  - `serializeMarketsReservesForApi` 多条混合时逐条无该键（防"只在单条路径删了"）；
  - 同一输入其余 V4 身份字段（`hubId`/`hubName`/`spokeId`）仍在，证明不是把整块删了。
- **白名单覆盖测试**（`marketsApiSerialize.test.ts` 既有"covers all EXPECTED_RUNTIME_FIELDS"）把 `spokeName` 加进 `SERIALIZED_EXCLUDE`——它枚举的是"故意不输出"的字段集合，正好是本决策的记录点。
- **版本号测试**（`marketsVersionBump.test.ts`）钉 `snapshot-v4`。
- **fingerprint 测试**（`apiSchemaFingerprint.test.ts`）钉新哈希。
- **live 契约测试**（`apiFieldsVerification.test.ts`，`RUN_API_FIELDS_TESTS` 门控）追加"任何 reserve 都不得出现 `spokeName`"，作为部署后对真实 payload 的断言。
- 负控：把 `"spokeName"` 加回 `PASSTHROUGH_FIELDS` 后，新增测试必须变红（mutation 验证一次）。

## Scenario & Risk Verification Matrix

| ID  | 场景                                           | 期望                                                                                                        | 证据                                          |
| --- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| S1  | V4 SDK 形态 reserve（`spokeName: "Main"`）     | 输出无 `spokeName` 键                                                                                       | `spokeNameNotExposed` 单测                    |
| S2  | V3 reserve（本来就没有该键）                   | 输出无该键，其余字段不变                                                                                    | 同上                                          |
| S3  | RPC fallback 形态（`spokeName: "MAIN_SPOKE"`） | 输出无该键（两条链路都被白名单覆盖）                                                                        | 同上                                          |
| S4  | 批量序列化混合 V3/V4                           | 每一条都无该键                                                                                              | `serializeMarketsReservesForApi` 单测         |
| S5  | V4 身份字段完整性                              | `hubId`/`hubName`/`spokeId` 仍在输出中                                                                      | 同上（对照断言）                              |
| S6  | 白名单类型收紧                                 | 从 `MarketWithSpread` 移除的字段若仍留在 `PASSTHROUGH_FIELDS`，`tsc` 报错                                   | build / `test:typecheck`                      |
| S7  | 字段被重新加回白名单                           | 新增测试变红                                                                                                | mutation 手验一次                             |
| S8  | 形状变更未同步 fingerprint                     | `apiSchemaFingerprint` 测试红                                                                               | 先红后绿                                      |
| S9  | OpenAPI 生成物                                 | `/markets` schema 不再含 `spokeName`，其余 V4 字段保留                                                      | `gen:openapi` 后 diff + `openapiAutoGen` 测试 |
| S10 | 版本号                                         | `snapshot.version === "snapshot-v4"`；live 断言读常量                                                       | 版本测试 + live 契约测试                      |
| S11 | 部署后真实 payload                             | 441 条 reserve 不缩水、124 条 V4 行无 `spokeName`、`spokeAddress` 仍不返回                                  | staging `curl` 实测                           |
| S12 | 档案层回归                                     | persistence 仍写 `spoke_name`，`EXPECTED_RUNTIME_FIELDS` 仍含该字段                                         | `field-coverage` / persistence 单测保持绿     |
| S13 | 前端消费方                                     | 无任何代码读取 markets 行上的 `spokeName`；深链用 `spokeId`、浏览器链接用 reserveId 解析出的 `spokeAddress` | 前端 grep + 类型声明删除后 build              |
| S14 | 缓存失效                                       | 前端 mirror `SCHEMA_FP` 更新到新值                                                                          | 两仓库文件逐字一致                            |
| S15 | 非 V4 行为                                     | V3 行字段集合与改动前逐键一致                                                                               | S1/S2 对照 + live payload 抽查                |

## Out of Scope

- 删除 `RuntimeReserveData.spokeName`、`EXPECTED_RUNTIME_FIELDS` 条目或 DB `spoke_name` 列（D1）。
- `hubId`/`hubName`/`spokeId` 的清理，或把 `hubAddress`/`spokeAddress` 加进 payload（前端已从 `reserveId` 解析）。
- 前端生成物（`src/generated/api/schemas.ts`）手改：交给 openapi-sync bot。
- 任何与本次字段收敛无关的 schema 清理。

## Further Notes

- ADR-0026 曾把 `spokeName` 的用途写作"日志、API 输出、前端展示"。本票之后它只剩日志与档案用途，ADR 需补一条订正说明。
- `docs/api/FRONTEND-SYNC-CHANGES.md` 是 2026-03 的历史变更记录，不追加本次条目。
- Linear 关闭与 aaveapy roadmap 状态推进按仓库规则需单独授权，本票只落代码/文档与 staging 证据。

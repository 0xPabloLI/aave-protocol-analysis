# AAV-1380 — `/markets` 的 `ltv = 0`：定性、契约与防回归守卫

> **Status: Executed** — 2026-11-16 完成，T1–T5 全绿（证据见文末 Tickets 与交付评论）。
> 票面：Linear AAV-1380（`[后端] /markets 的 ltv 字段 312/441 条为 0 … 待查字段映射与「真 0 vs 缺失」语义`）。

## Problem Statement

前端 Portfolio 的 Borrow capacity 与 e2e 的「LTV 融资额度」门都以 `/markets` 的 `ltv` 为唯一输入。资产里 312/441 条 `ltv = 0`
（`liquidationThreshold` 正常，典型如 AaveV3Ethereum USDC `ltv=0 / lt=78`），于是这些仓位的可借额度被算成 0。

票面假设这是**字段映射缺陷**（拿错字段 / 单位错 / 0 被当成缺失）。如果成立，那是一个把用户可借额度藏起来的数据 bug；
如果不成立，那前端拿一个协议真值去做「有没有数据」的判据，会持续误报。

在定性之前，运维侧已经开始把它当成数据缺口处理（`ltv=0` 被 e2e 的 room/LTV 门当作「不可用」筛掉候选）。

## Solution

**结论：`ltv = 0` 是 Aave 协议的真实 base LTV，不是映射缺陷，也不是「字段缺失」。** 三个互相独立的数据源一致：

1. **链上真值**（`AAVE_PROTOCOL_DATA_PROVIDER.getReserveConfigurationData`，Multicall3 批读）与 staging `/markets` 逐条比对：
   Ethereum 68/68、Base 15/15、Arbitrum 20/20 的 `ltv` **与** `liquidationThreshold` 完全一致（合计 103/103，零差异）。
2. **SDK 原始响应**：`supplyInfo.maxLTV` 对这些 reserve 就是 `raw: "0", decimals: 4`，映射链
   `maxLTV → percentValueToPercent → RuntimeReserveData.ltv（percent）→ serializeReserveForApi` 无单位或符号错误。
3. **生产与 staging 快照逐条一致**：同一 `reserveId` 的 `ltv` 差异 0 条，两侧都是 441 / 312 / 129。

`ltv = 0` 有三种真实成因，必须区分（统计见「Evidence」）：

| 成因                                               | 语义                                                              | 数量（441 条中） |
| -------------------------------------------------- | ----------------------------------------------------------------- | ---------------- |
| 治理把 base LTV 设为 0                             | 可作抵押（计入 HF），但**不给 base 模式借力**；稳定币的反递归设计 | 64               |
| 资产本身不具抵押资格（`liquidationThreshold = 0`） | 只可供应/借贷，不进 HF 分子                                       | 120              |
| `isFrozen = true`（V3.6 冻结联动 `ltv → 0`）       | 阻止新借款，`liquidationThreshold` 不变 ⇒ HF 不受影响             | 128              |

因此本票的交付不是「改映射」，而是**把语义钉进契约 + 防止未来把 0 当缺失丢掉**：

- `RuntimeReserveData.ltv` 的 JSDoc 写清「0 是真实值 / eMode LTV 不并入本字段」，经 `gen:openapi` 落进
  `backend/static/openapi.json` 的对外描述；
- `docs/api/api-documentation.md` 的 `RuntimeReserveData` 块补上漏掉的 `ltv` / `liquidationThreshold` / `collateralRisk`
  （AAV-1222 落地后这三个字段一直没进文档）；
- 两层「0 不得被当 falsy 丢弃」的守卫（fetcher 映射 + backend 序列化），以及 API 层两条不变量断言；
- eMode 差异（WETH base LTV 81% vs ETH-correlated eMode 93%）作为**残余风险**记录并另开 follow-up：API 不暴露
  eMode 参数，任何「按 ltv 算借力」的消费方在 eMode 用户上都会低估。本票不改契约加字段。

## User Stories

1. As a frontend engineer reading the API schema, I want `ltv: 0` documented as a real protocol value, so that I stop treating it as a missing field.
2. As a frontend engineer computing borrow capacity, I want the contract to say that `ltv` is the base (non-eMode) LTV, so that I know when my number is an under-estimate.
3. As a backend engineer changing `concurrent-fetch`, I want a test that fails if a zero `maxLTV` is dropped or turned into `undefined`, so that a refactor cannot silently recreate this ticket.
4. As a backend engineer changing `marketsApiSerialize`, I want a test that keeps `ltv: 0` in the payload, so that a "falsy → omit" cleanup cannot pass review.
5. As an on-call engineer reading a canary failure, I want the API invariants (`ltv ≤ liquidationThreshold`, V4 `ltv === liquidationThreshold`) asserted against real data, so that a wrong-field regression is caught by the weekly canary rather than by a user.
6. As an API consumer, I want the generated OpenAPI description to carry the zero-semantics, so that Swagger UI explains the value without pointing at this ticket.
7. As a maintainer of the docs, I want `RuntimeReserveData`'s risk parameters documented at all, so that the doc stops lagging AAV-1222.
8. As a product owner, I want the eMode gap recorded as a named residual risk with its number, so that "borrow capacity shows 0" does not silently reopen as a bug.

## Implementation Decisions

- **不改映射、不改序列化行为。** `ltv` 在两层都已用 `!== undefined` 判定：`0` 保留，`undefined` 省略。本票只加守卫与文字口径。
  （对照 `protocolFee`：那是**故意**「缺席 = 0」的契约，AAV-1350；两者语义不同，不要合并成一条规则。）
- **口径写进 type JSDoc，而不是 new field。** `ts-json-schema-generator` 会把 JSDoc 带进 schema `description`，
  已有先例（`liquidationThreshold` 现在就在 `backend/static/openapi.json` 里带描述）。改完 type 后必须重新生成静态 spec，
  `backend/tests/openapiAutoGen.test.ts` 读的是提交进仓库的那份。
- **守卫分两层，各自守自己那一层**：
  1. fetcher 层（`buildV3BaseDataset`）：`supplyInfo.maxLTV.value === "0"` 必须产出**键存在**且值为 `0` 的 `ltv`；
     `maxLTV` 整体缺席时才允许没有 `ltv` 键。这一层守的是「SDK 的 0 不得被 `??` / truthiness 吃掉」。
  2. API 层（`serializeReserveForApi`）：`ltv: 0` 保留、`ltv: undefined` 省略。这一层守的是「序列化不许把 0 当空」。
- **数据级不变量留在 `apiFieldsVerification.test.ts`。** 这两条断言的对象是真实 payload（协议对配置的保证），
  fixture 只能证明 helper 写对了，证明不了数据。因此接受它们与既有断言一样只在 `RUN_API_FIELDS_TESTS=true`
  下执行；该套件上一次真跑是 canary `43703832449`（2026-11-15，绿）。
- **V4 的 `ltv === liquidationThreshold` 作为不变量断言**：V4 用单一 `collateralFactor` 同时充当两者，
  两者不等只能说明映射抓错了字段。
- **文档落点**：`docs/api/api-documentation.md` 的字段块（对外契约）+ type JSDoc（机器可读契约）。不再另建文档。
- **eMode 不在本票实施**。它是「暴露新字段」级别的契约变更，且要先决定产品口径（按当前 eMode 类别算？按用户实际启用的类别算？），
  需要单独拍板。

## Testing Decisions

好的测试只断言**外部可观察行为**：给定 SDK 形状 → 内存字段；给定内存字段 → API 字段；给定真实 payload → 协议不变量。
不去断言 `percentValueToPercent` 的中间值（已有 `v4-collateralRisk.test.ts` 覆盖）。

| 层             | 文件                                                         | 性质                   | Prior art                                                                   |
| -------------- | ------------------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------- |
| fetcher 映射   | `packages/aave-fetcher/tests/ltvZeroPreserved.test.ts`（新） | 纯函数 + 真实入参形状  | `borrowInfoMissingKey.test.ts`（同 `buildV3BaseDataset`、同 `any[]` 入参）  |
| backend 序列化 | `backend/tests/ltvSemantics.test.ts`（新）                   | 纯函数                 | `backend/tests/unitsConsistency.test.ts` / `protocolFee` 的「缺席 = 0」测试 |
| API 数据不变量 | `backend/tests/apiFieldsVerification.test.ts`（扩展）        | live payload（canary） | 同文件的 `ALWAYS_PRESENT` / borrow-side 断言                                |
| OpenAPI 描述   | 依赖既有 `openapiAutoGen.test.ts` + 生成产物比对             | 静态                   | 同文件各字段断言                                                            |

两个新单元测试是**characterisation guard**：当前实现已经通过，所以「先红」要靠 mutation 证明（把 `!== undefined`
改成真值判定、把 `maxLTV` 读取改成 `?? 0` 的反面写法），mutation 记录写进交付评论。

## Scenario & Risk Verification Matrix

> 每行都要有 evidence 映射；`T` = 单测，`A` = live API 断言，`E` = 运行期取证（无断言）。

| #   | Scenario / Risk                                            | 期望行为                                                                           | Evidence                                            |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| S1  | SDK `maxLTV = {value:"0"}`（治理 LTV-0，如 USDC/Ethereum） | `ltv` 键存在且为 `0`；`liquidationThreshold` 保留真实值                            | T: `ltvZeroPreserved.test.ts`                       |
| S2  | SDK `maxLTV` 整个缺席（字段不可用）                        | 无 `ltv` 键（能被 `ALWAYS_PRESENT` 抓住，而不是被静默补 0）                        | T: 同上                                             |
| S3  | `maxLTV = {value:"0.81"}`（WETH）                          | `ltv = 81`（percent 口径），不被误当 ratio                                         | T: 同上                                             |
| S4  | 序列化 `ltv: 0`                                            | API payload 保留 `ltv: 0`                                                          | T: `ltvSemantics.test.ts`                           |
| S5  | 序列化 `ltv: undefined`                                    | 省略键（**不得**补 0，也不得写 `null`）                                            | T: 同上                                             |
| S6  | 序列化 `liquidationThreshold: 0`（不具抵押资格）           | 保留 `0`                                                                           | T: 同上                                             |
| S7  | 全量 payload：`ltv > liquidationThreshold`                 | 0 条；违反即映射抓错字段                                                           | A: 今日 441/441 成立                                |
| S8  | 全量 payload：V4 `ltv !== liquidationThreshold`            | 0 条；违反即 V4 抓错 `collateralFactor`                                            | A: 今日 124/124 相等                                |
| S9  | 全量 payload：`ltv` 非数字 / 缺席                          | 0 条（已由 `ALWAYS_PRESENT` 守）                                                   | A: 441/441                                          |
| S10 | 冻结 reserve（V3.6 联动）                                  | `ltv = 0`、`liquidationThreshold` 保持 → HF 不受影响                               | E: 链上 `1INCH ltv=0/lt=67`；今日 128 条            |
| S11 | 生产 vs staging 同 `reserveId`                             | `ltv` 逐条一致（部署不改变语义）                                                   | E: 差异 0 条                                        |
| S12 | 三条链的链上 vs API                                        | `ltv` 与 `liquidationThreshold` 全等                                               | E: 68 + 15 + 20 = 103/103                           |
| S13 | eMode 用户（WETH in ETH-correlated）                       | **本票不改**：API 只有 base LTV ⇒ 借力被低估（81 vs 93）。记为残余风险 + follow-up | E: SDK 快照 eMode 93%；API 无 eMode 字段            |
| S14 | 未来把 `ltv` 改成 truthiness 判定 / `?? 0` 反向写法        | 守卫必须红                                                                         | Mutation（记录在交付评论）                          |
| S15 | OpenAPI 描述                                               | 生成物里 `ltv` 的 `description` 含「0 是真实值 / 不含 eMode」                      | 生成后 `backend/static/openapi.json` 比对 + CI 构建 |
| S16 | 文档块                                                     | `RuntimeReserveData` 列出 `ltv` / `liquidationThreshold` / `collateralRisk` 及单位 | 人工比对（文档 diff）                               |

## Tickets（tracer slices，本地拆分；不写 tracker）

| #   | 交付                                                                                           | Blocked by | 验收                                                                 |
| --- | ---------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------- |
| T1  | fetcher 映射守卫：`maxLTV=0` → `ltv:0` 键存在；缺席 → 无键                                     | 无         | 新测试 3 例全绿；mutation（改成 truthiness / 补 0）各只打红对应用例  |
| T2  | backend 序列化守卫：`ltv:0` 保留、`undefined` 省略、`liquidationThreshold:0` 保留              | 无         | 新测试 3 例全绿；mutation 打红                                       |
| T3  | API 层两条数据不变量（`ltv ≤ lt`、V4 相等）                                                    | 无         | `RUN_API_FIELDS_TESTS=true` 指向 staging 时全绿；对真实 payload 有效 |
| T4  | 契约口径：type JSDoc + `docs/api/api-documentation.md` 字段块 + 重新生成 `static/openapi.json` | 无         | 生成物描述含零语义；`openapiAutoGen.test.ts` 绿                      |
| T5  | 收尾：spec 移入 `executed/`、交付证据与残余风险                                                | T1–T4      | 全量 `npm run ci:remote` 绿                                          |

## Evidence（2026-11-16，staging + production 快照）

- 快照：`/api/markets` → 441 reserves；`ltv` 数值 441/441；`0` 312 条、`>0` 129 条。
- 零值分解：frozen 128 / live-collateral-no-borrow-power 64 / live-not-collateral 120。
- 不变量：`ltv > liquidationThreshold` 0 条；V4 `ltv !== liquidationThreshold` 0 条。
- 链上核对（DataProvider + Multicall3）：Ethereum 68/68、Base 15/15、Arbitrum 20/20，`ltv` 与 `liquidationThreshold`
  双字段全等。
- 链上抽点：USDC `ltv 0 / lt 78`、DAI `0 / 77`、WETH `81 / 84`、AAVE `69 / 76`（`borrowingEnabled = false`）。
- eMode（SDK 侧，API 不暴露）：AaveV3Ethereum `ETH correlated` 类别 `maxLTV 93%`，WETH base `81%`；
  USDC 在该市场 25 个 eMode 类别中 `canBeCollateral` 全为 false ⇒ 稳定币没有「eMode 借力」这条后门。
- 该 SDK 快照的 base 值与当前 API 已不同（快照 WETH 80.5 vs 当前 81），故 eMode 数字只用于说明「差异存在」，
  不作为当前值断言。

## Out of Scope

- **暴露 eMode 参数**（`eModeCategories` / 每个 reserve 的 `eModeInfo`）与「按用户实际 eMode 类别算借力」的口径 ——
  需要产品决策 + 契约变更，另开 follow-up。
- **前端 borrow capacity / e2e LTV 门的重算**（前端仓）。
- **V4 的链上核对**：V4 没有与 `getReserveConfigurationData` 对等的 DataProvider 读法，V4 侧只做了
  SDK 语义 + 不变量断言。
- 把 `protocolFee` 的「缺席 = 0」改成存在性契约（AAV-1350 已定，不动）。

## Further Notes

- 本机跑 `npm run ci:remote` 时，`npm ci` 与 `npm run audit` 两步必须先显式指向官方 registry（`--registry=https://registry.npmjs.org/`）：npmmirror 缺 `@aave/types@1.1.0` 的 tarball，且不实现 `/-/npm/v1/security/*`。其余 13 步按脚本原样通过。这是本机镜像的限制，与本次改动无关。

- 本票的「312」是会随治理变动的实时数字，不是常量：任何基线式断言（例如「0 值应等于 312」）都会在下一次
  治理投票后变红。所以此处只记录日期与当时数值，断言只写不变量。
- 零值三分类里只有 `frozen` 一类会影响 HF（V3.6 冻结不动 `liquidationThreshold`），另两类影响的是借力。

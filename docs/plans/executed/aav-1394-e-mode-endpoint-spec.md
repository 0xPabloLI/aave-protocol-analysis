# AAV-1394 — eMode 抵押参数改为独立端点（后端）

> **Status: Completed** — 2026-11-17（commits `37486f5`/`a01d74d`/`ffc7799`/`6a797f2`；CI `44071575973` 四门绿）
> Ticket: Linear AAV-1394（`[后端] /markets 不暴露 eMode 抵押参数：eMode 用户的 Borrow capacity 被低估`）

## Problem Statement

`/api/markets` 只暴露每个 reserve 的 **base** 风险参数（`ltv` / `liquidationThreshold`）。同一资产在某个 eMode 类别下可能有更高的 LTV（AaveV3Ethereum WETH：base 81% vs ETH correlated 93%），但 API 完全不告诉消费方「这个资产属于哪些 eMode 类别、该类别参数是多少、用户当前类别下能否抵押」。

任何按 `ltv` 算 Borrow capacity 的消费方，在 eMode 用户上都会低估额度。AAV-1380 已确认 `ltv=0` 是协议真值、映射正确；缺的不是修正 base 值，而是**缺一层按 eMode 类别取数的数据**。

## Solution（已确认的设计）

**不改 `/api/markets`**。新增按市场维度的独立只读端点，让前端按用户 `getUserEMode` 返回的类别 id 去取该类别的 LTV/LT，类别 0 回退 base LTV。

- `GET /api/meta/e-mode` — 市场索引：每个 V3 市场的 `marketKey` / 名称 / 类别数量。小响应，供前端发现可查询的市场。
- `GET /api/meta/e-mode/:marketKey` — 单个市场的全量 eMode 类别与成员关系。
- `marketKey` = `v3MarketKey(chainId, poolAddress)` = `` `${chainId}:${poolAddress.toLowerCase()}` ``。与 `reserveId` 的前两段同源，前端可从 `/markets` 的 `reserveId` 无歧义推导。

**不塞 441 reserve × 48 类别的全量矩阵**。每个类别只输出 `collateralReserves` / `borrowableReserves` 两个地址数组；SDK 中 `canBeCollateral=false && canBeBorrowed=false` 的成员直接裁掉。前端用自己的 reserve 索引补齐 symbol/decimals。

**V4 明确不提供该端点数据**。官方 V4 把 eMode 变成独立的 E-Mode Spoke（部署级隔离），不是 V3 这种 per-market 类别参数；V4 reserve 的 `collateralFactor` 已经是 per-Reserve 单一参数。V4 spoke 不出现在 eMode 索引里，避免把两个概念混成一个接口。

## 调研证据（实现前已确认）

| #   | 事实                                                                                                                                 | 证据                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| E1  | `markets()` 的 GraphQL `Market` fragment **已经请求** `eModeCategories`，fetcher 拿到的 `marketList` 里就有该字段，无需额外链上读    | `@aave/graphql` `MarketFragment` 选择集含 `eModeCategories { ...EmodeMarketCategory }`   |
| E2  | `MarketsQuery` 使用 `...Market`，不是另一套精简 fragment                                                                             | `@aave/graphql` document `query Markets(...) { value: markets(...) { ...Market } }`      |
| E3  | `EmodeMarketCategoryFragment` 实际请求字段：`id` / `label` / `maxLTV` / `liquidationThreshold` / `liquidationPenalty` / `reserves[]` | `node_modules/@aave/graphql/dist/index.d.ts` `EmodeMarketCategoryFragment`               |
| E4  | 成员字段只有 `underlyingToken` / `canBeCollateral` / `canBeBorrowed`；`isolated`、`hasLtvZero` 不在 fragment 里，**不能消费**        | 同上                                                                                     |
| E5  | `PercentValue.value` 是比例（0.93），项目统一用 `percentValueToPercent()` 转成 93                                                    | `packages/aave-fetcher/src/utils/number.ts`                                              |
| E6  | V3 市场身份 = `chainId` + `market.address`；`RuntimeReserveData` 没有 `marketAddress` 字段，只有 `reserveId` 可反推                  | `concurrent-fetch.ts` `buildV3BaseDataset`；`packages/aave-shared-contracts/src/keys.ts` |
| E7  | AaveV3Ethereum 的 WETH base LTV 81%、ETH correlated eMode maxLTV 93%；USDC 在 48 个类别里 `canBeCollateral` 全 false                 | AAV-1394 票面证据（2026-11-16），作为验收用的真实样本                                    |
| E8  | 后端是 cron-write / API-read-only：请求路径不能触发外部 fetch                                                                        | `backend/src/services/marketsService.ts` 头注释 + AGENTS.md Architecture Rules           |

## 接口契约

### 类型（shared contracts）

```ts
interface EModeCategoryData {
  id: number;
  label: string;
  maxLtv: number; // percent, 93 = 93%
  liquidationThreshold: number; // percent
  liquidationPenalty: number; // percent
  /** 该类别的可抵押资产地址（小写）。只含 canBeCollateral=true。 */
  collateralReserves: string[];
  /** 该类别的可借资产地址（小写）。只含 canBeBorrowed=true。 */
  borrowableReserves: string[];
}

interface EModeMarketData {
  marketKey: string; // `${chainId}:${poolAddressLower}`
  chainId: number;
  chainName: string;
  marketName: string;
  categories: EModeCategoryData[];
}

interface EModeMarketSummary {
  marketKey: string;
  chainId: number;
  chainName: string;
  marketName: string;
  categoryCount: number;
}

interface EModeIndexPayload {
  generatedAt: string; // ISO, 来自 markets snapshot `_metadata.timestamp`
  markets: EModeMarketSummary[];
}

interface EModeMarketPayload extends EModeMarketData {
  generatedAt: string;
}
```

`MarketsPayload` 增加**内部**字段 `eModeMarkets?: EModeMarketData[]`。`/api/markets` 的 serializer 只读 `payload.data`，不会把这个字段带进公开响应。

### `GET /api/meta/e-mode`

```json
{
  "generatedAt": "2026-11-17T05:00:00.000Z",
  "markets": [
    {
      "marketKey": "1:0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
      "chainId": 1,
      "chainName": "Ethereum",
      "marketName": "AaveV3Ethereum",
      "categoryCount": 48
    }
  ]
}
```

### `GET /api/meta/e-mode/1:0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2`

```json
{
  "generatedAt": "2026-11-17T05:00:00.000Z",
  "marketKey": "1:0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
  "chainId": 1,
  "chainName": "Ethereum",
  "marketName": "AaveV3Ethereum",
  "categories": [
    {
      "id": 1,
      "label": "ETH correlated",
      "maxLtv": 93,
      "liquidationThreshold": 95,
      "liquidationPenalty": 1,
      "collateralReserves": ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"],
      "borrowableReserves": ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"]
    }
  ]
}
```

### 错误契约

| 状态 | `errorCode`                | 触发条件                                                                                       |
| ---- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| 503  | `EMODE_SNAPSHOT_NOT_READY` | `getMarketsData().payload === null`（冷启动）；带 `Retry-After: 10`                            |
| 503  | `EMODE_DATA_UNAVAILABLE`   | snapshot 有数据但 `payload.eModeMarkets === undefined`（V3 fetch 尚未成功）；`Retry-After: 15` |
| 400  | `EMODE_INVALID_MARKET_KEY` | 路径参数不是 `chainId:0x40hex` 格式                                                            |
| 404  | `EMODE_MARKET_NOT_FOUND`   | 格式合法但索引里没有该市场（或该市场是 V4）                                                    |
| 200  | —                          | 索引为空也返回 200 `{ markets: [] }`（V3 成功但没有 eMode 类别是合法状态）                     |

## Implementation Decisions

| #   | 决策                                                                                                      | 理由                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| D1  | `/api/markets` 的 reserve 形状不变                                                                        | 票面最初的「每 reserve 暴露 eMode 参数」会膨胀 441×48；且同一资产在多个类别下参数不同，per-reserve 单值无法表达 |
| D2  | 新端点按市场维度，类别内用两个地址数组表达成员关系                                                        | 48 类别 × 每类别少量成员，响应约 16KB；地址数组可被前端直接索引，不用重复 symbol/decimals                       |
| D3  | `marketKey` 复用 `v3MarketKey()` 纯函数，新增到 shared keys                                               | 消费方和 `reserveId` 前缀同源；禁止各模块自行拼 key（AGENTS“Map key 必须用 shared 工具函数”）                   |
| D4  | `eModeMarkets` 存在 `MarketsPayload`，由 fetcher 从已拉取的 `marketList` 计算                             | SDK 响应已有数据；请求路径零外部读，保持 cron-write / API-read-only                                             |
| D5  | 只输出 `canBeCollateral=true` / `canBeBorrowed=true` 的成员                                               | 默认 false 的成员是「不在该类别」，不是「参数为 0」；裁掉可把 payload 从 11k 条压到数百条                       |
| D6  | 数值统一 percent（`percentValueToPercent`）                                                               | 与现有 API `ltv` 的 percent 语义一致（4.0 = 4%），避免前端二次乘除                                              |
| D7  | V3-only；V4 spoke 不进索引                                                                                | V4 eMode 是 E-Mode Spoke 部署，非 per-market 类别参数；混入会制造错误语义                                       |
| D8  | V3 fetch 成功但 `markets=[]` 视为「无数据」，保留 stale eMode；只有真正解析出市场才更新 stale cache       | 与 `mergeWithPartialStale` 的 `freshV3.length > 0` 同构；防止一次空响应把 eMode 清空                            |
| D9  | eMode stale 跟随 `marketsHardTtlMs`；模块级 `staleV3EMode` + `v3EModeFetchedAt`                           | 与 `staleV3Data` 同生命周期；single snapshot，无 Map，不新增泄漏面                                              |
| D10 | 路由拆成 index + detail 两个 path，而非一个 `?market=` 查询                                               | OpenAPI 两个 path 各自有单一 schema；缓存/CDN 键更稳定；Express 路径参数支持冒号                                |
| D11 | OpenAPI 公开面从 2 条扩到 4 条：`/markets`、`/meta/side-data`、`/meta/e-mode`、`/meta/e-mode/{marketKey}` | 这是无鉴权的公开数据端点；不写进 spec 就是「公开但未承诺」的第三态。AAV-1293 的守卫同步改                       |
| D12 | `Cache-Control: public, max-age=60, s-maxage=600, stale-while-revalidate=600`                             | 与 `/meta/side-data` 同档；eMode 是分钟级 cron 数据，60s 浏览器缓存不会压在 1m 刷新后面                         |
| D13 | 响应不加 `MarketWithSpread` / `FIELD_UNITS` 注册                                                          | 新字段不在 `RuntimeReserveData` 上；没有 ratio 字段，不触发单位注册表                                           |
| D14 | 索引和详情都从 snapshot 的同一份 `eModeMarkets` 读；不建新 Map                                            | 数组规模 = 市场数 × 类别数，单次替换；和 `snapshot` 同生共死                                                    |

## Scenario & Risk Verification Matrix

> 行号即 TDD 用例来源。`Evidence` 列写「由哪个测试/命令证明」。S1–S6 在 fetcher 纯函数，S7–S18 在 backend，S19–S21 在 OpenAPI/cache/docs。

| #   | 场景                                                                       | 预期行为                                                                                               | Evidence（测试/命令）                                             |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| S1  | 单个市场 2 个类别，含可抵押/可借/两者皆可成员                              | 类别按 id 升序；`collateralReserves` 只含 `canBeCollateral`，`borrowableReserves` 只含 `canBeBorrowed` | `emode.test.ts` mapping 用例                                      |
| S2  | 成员 `canBeCollateral=false && canBeBorrowed=false`                        | 两个数组都不包含该地址，成员被裁掉                                                                     | `emode.test.ts` pruning 用例                                      |
| S3  | `maxLTV.value = "0.93"`，`liquidationThreshold = "0.95"`，`penalty="0.01"` | 输出 `93 / 95 / 1`（percent，不是 0.93）                                                               | `emode.test.ts` unit 用例                                         |
| S4  | 地址大小写混合                                                             | 输出地址统一小写                                                                                       | `emode.test.ts` normalize 用例                                    |
| S5  | 两个 market 同 `marketKey`（SDK 重复行）                                   | 只保留第一条，后一条不覆盖                                                                             | `emode.test.ts` dedupe 用例                                       |
| S6  | 空 `markets` / 市场缺 `address` / 缺 `chain.chainId` / 类别缺 `maxLTV`     | 跳过非法市场或类别；不抛错；返回 `[]` 或合法子集                                                       | `emode.test.ts` malformed 用例                                    |
| S7  | `GET /api/meta/e-mode`（snapshot 有 2 个市场）                             | 200；`markets` 按 chainId、marketKey 排序；`categoryCount` 等于类别数                                  | `emodeRoute.test.ts` index 用例                                   |
| S8  | `GET /api/meta/e-mode/:key` 命中                                           | 200；返回 `categories` 全量；`generatedAt` 来自 snapshot                                               | `emodeRoute.test.ts` detail 用例                                  |
| S9  | 路径参数 `1:0xABC...` 大写                                                 | 200；按 lowercase 归一后命中                                                                           | `emodeRoute.test.ts` case 用例                                    |
| S10 | 路径参数 `foo` / `1:` / `1:0x123`（非 40 hex）                             | 400 `EMODE_INVALID_MARKET_KEY`                                                                         | `emodeRoute.test.ts` invalid 用例                                 |
| S11 | 路径参数合法但无此市场（含 V4 市场 key）                                   | 404 `EMODE_MARKET_NOT_FOUND`                                                                           | `emodeRoute.test.ts` not-found 用例                               |
| S12 | snapshot 为 null                                                           | 503 `EMODE_SNAPSHOT_NOT_READY` + `Retry-After: 10`                                                     | `emodeRoute.test.ts` cold 用例                                    |
| S13 | snapshot 有 data，但 `eModeMarkets === undefined`                          | 503 `EMODE_DATA_UNAVAILABLE` + `Retry-After: 15`                                                       | `emodeRoute.test.ts` unavailable 用例                             |
| S14 | V3 fetch 失败 → refresh，eMode 用 stale 且未过 hard TTL                    | 新 snapshot 的 `payload.eModeMarkets` 仍是上一轮数组                                                   | `emodeStale.test.ts` + `marketsRefreshFailure.test.ts` stale 用例 |
| S15 | stale eMode 超过 hard TTL                                                  | 新 snapshot `eModeMarkets` 被移除（`undefined`），端点走 503                                           | `emodeStale.test.ts` expired 用例                                 |
| S16 | V3 成功但 `markets=[]`（空响应）或非空但全部 malformed                     | 不覆盖 stale eMode（`selectFreshEModeMarkets` 返回 `undefined`；避免「空响应/坏数据假成功」清空）      | `emodeStale.test.ts` empty-fresh 用例                             |
| S17 | `/api/markets` 响应                                                        | JSON 根不含 `eModeMarkets`；reserve 字段不变                                                           | `emodeRoute.test.ts` leak 用例 + 现有 schema 指纹                 |
| S18 | 类别数组为空的市场                                                         | 索引 `categoryCount: 0`；详情 200 `categories: []`                                                     | `emodeRoute.test.ts` empty-categories 用例                        |
| S19 | OpenAPI 生成                                                               | paths 恰好 4 条；`EModeIndexPayload` / `EModeMarketPayload` 进 components；schema ref 可解析           | `openapiAutoGen.test.ts` 更新 + `npm run openapi:generate`        |
| S20 | `Cache-Control`                                                            | e-mode 两个路径拿到 `public, max-age=60, s-maxage=600, stale-while-revalidate=600`                     | `cacheHeaders.test.ts` 新增用例                                   |
| S21 | 干净 checkout / CI                                                         | build + tests + prettier + quality gates 全绿                                                          | CI run `44071575973`（四门 required checks 全绿）                 |

### 体积估算（验收「payload 体积评估」）

- eMode 索引：市场数（约 20）× 6 个短字段 ≈ 2–4 KB。
- 单市场详情：staging 实测 AaveV3Ethereum 48 类别 / 16,436 B；索引 24 市场 / 3,564 B。相比把 441×48 全量矩阵塞进 `/markets`，体积下降两个数量级。
- 运行时内存：`eModeMarkets` 与 snapshot 同生命周期，一份数组，无 Map/Set。

## Testing Decisions

**测试 seam（按优先级）**

1. `buildEModeMarkets()` — fetcher 的纯映射 seam：SDK 形状 → shared 类型；覆盖 S1–S6。
2. `buildEModeIndex()` / `findEModeMarket()` — backend 纯选择 seam：snapshot payload → API 形状；覆盖 S7/S8/S11/S18。
3. `createMetaRouter({ getEModeSource })` — 路由 seam，注入 fake snapshot；覆盖 S9–S13/S17。
4. `mergeEModeWithStale()` / `refreshMarketsSnapshot()` 的 stale 逻辑 — 直接调用 backend 纯函数 / 注入失败 fetcher 的刷新逻辑；覆盖 S14–S16。
5. OpenAPI 生成器守卫 — 覆盖 S19；cache middleware 单测覆盖 S20。

**不使用**：真实 Aave GraphQL 的网络集成测试（CI 无稳定网络/额度）；字段存在性由 `@aave/graphql` fragment 静态证据 E1–E4 保证。

**Prior art**：`packages/aave-fetcher/tests/buildV3BaseDataset` 风格的纯映射测试；`backend/tests/cacheHeaders.test.ts` 的 mock req/res；`backend/tests/openapiAutoGen.test.ts` 的生成物断言。

## Tickets

| #   | 标题                                   | Blocked by | 交付                                                                                             |
| --- | -------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| T1  | shared 类型 + fetcher eMode 映射       | —          | `EModeCategoryData`/`EModeMarketData`/`v3MarketKey`；`buildEModeMarkets`；payload 注入；S1–S6 绿 |
| T2  | backend 端点 + stale + OpenAPI + cache | T1         | 两条路由；索引/详情；503/400/404；stale 合并；OpenAPI 4 paths；S7–S20 绿                         |
| T3  | 文档收口 + Linear 评论 + 前端票        | T2         | `docs/api/api-documentation.md`、`CONTEXT.md` E-Mode 术语、SPEC 移入 executed、建前端票 AAV-1399 |

## Out of Scope

- 改 `/api/markets` 的 reserve 形状或 `FIELD_UNITS`。
- 为 V4 预建 eMode 抽象；V4 E-Mode Spoke 的独立数据面不在本票。
- 前端 Borrow capacity 计算改造（第二张票，aaveapy 仓）。
- 在 API 请求路径调用 Aave GraphQL / RPC。
- 全量 441×48 矩阵。

## Acceptance Mapping（对 AAV-1394 票面）

| 票面验收                                                          | 本 spec 的落点                                                                                |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 契约决定并落文档：暴露 eMode 参数，评估 payload 体积              | D1–D6、接口契约、体积估算；`docs/api/api-documentation.md`                                    |
| `RuntimeReserveData` + backend 类型 + `FIELD_UNITS` + 序列化同步  | **不适用**：本设计不新增 per-reserve 字段；后端只消费 shared `EModeMarketData`；无 ratio 字段 |
| fetcher 映射守卫（V4 等价物定性）                                 | S1–S6；D7 明确 V4 E-Mode Spoke 不是同一概念，不进索引                                         |
| 前端 eMode 用户 WETH 81%→93% 复验                                 | 第二张票；后端契约提供 category 1 的 `maxLtv: 93` 与 WETH 地址，前端可按 `getUserEMode` 取数  |
| openapi description 与 `docs/api/api-documentation.md` 字段块同步 | S19、T2/T3；OpenAPI 增 2 条 path，文档增「E-Mode」小节                                        |

## Further Notes

- `CONTEXT.md` 当前的 E-Mode 术语写「V3-only，V4 已移除」，与官方 V4 的 E-Mode Spoke 表述冲突；本票只更新术语行，不改 V4 数据面。
- 若未来前端需要「某资产在哪些类别可抵押」的反向索引，可在前端本地从本端点构建；后端不预计算第二份派生数据。

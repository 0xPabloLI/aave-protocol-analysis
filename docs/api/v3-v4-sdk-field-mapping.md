# V3 vs V4 SDK 字段映射对比

本文档系统记录 Aave V3 与 V4 市场数据各字段的 SDK 来源差异、处理方法、前端映射及 V4 Hub/Spoke 级别。

## 概述

| 维度 | V3 | V4 |
|------|-----|-----|
| **SDK 方法** | `markets()` → `market.supplyReserves[]` | 独立 GraphQL 查询 |
| **数据结构** | 扁平 reserve 列表 | Hub & Spoke 模型 |
| **处理文件** | `src/index.ts` | `src/v4-fetcher.ts` |
| **核心函数** | `buildV3BaseDataset()` | `fetchV4MarketsDataInner()` → 内联循环 |
| **Reserve ID 格式** | `{market}:{chainId}:{token}` | `{market}:{chainId}:{token}:{hubName}` |
| **HTTP 请求数** | 1 次 `markets()` 覆盖多链 | `chains()` + `hubs()` + `reserves()` + N 次 `hubAssets()` |

**V4 请求优化**：
- `fetchHubAssetIndex()` 使用 `Promise.all()` 并行发起所有 `hubAssets()` 查询
- `@aave/client-v4` 底层使用 urql，默认开启 `batch: true`
- 同一 tick 内并行的 GraphQL 查询会被 urql 自动合并为单个 HTTP 请求
- 优化前：串行 N 次 `hubAssets()` 请求；优化后：1~2 次 batch 请求

**V4 数据级别说明**：
- **Reserve 级别**: 数据直接来自 `r` (reserve 对象)，每个 reserve 独立
- **Hub 级别**: 数据来自 `hubInfo` (HubAsset 索引)，同一 hub 内多个 reserves 共享

**判断依据**：
- Hub级别的字段 = 共享的协议参数（利率曲线、费率、上限等）
- Reserve级别的字段 = 每个reserve独立的状态（APY由utilization实时计算得出）

---

## 核心字段对比表

### 基础信息字段

| API 字段 | 前端展示 | V4 级别 | V4 SDK 路径 | V4 处理函数 | V4 处理方法 | V3 SDK 路径 | V3 处理函数 | V3 处理方法 |
|----------|----------|---------|-------------|-------------|-------------|-------------|-------------|-------------|
| **reserveId** | - | Reserve | 构造: `${market}:${chainId}:${token}:${hubName}` | `fetchV4MarketsDataInner()` 内联 | 字符串拼接 | 构造: `${market}:${chainId}:${token}` | `buildV3BaseDataset()` | 字符串拼接 |
| **marketName** | Market 列 | Reserve | 构造: `AaveV4${spokeName}` | `fetchV4MarketsDataInner()` 内联 | `spokeName.replace(/\s+/g, '')` 后拼接 | `market.name` | `buildV3BaseDataset()` | 直接使用 |
| **chainName** | Market 列 | Reserve | `r.chain?.name ?? 'Unknown'` | `fetchV4MarketsDataInner()` 内联 | 带默认值取值 | `market.chain?.name` | `buildV3BaseDataset()` | 直接取值 |
| **chainId** | - | Reserve | `Number(r.chain?.chainId ?? 0)` | `fetchV4MarketsDataInner()` 内联 | 转数字并带默认值 | `market.chain?.chainId` | `buildV3BaseDataset()` | 直接取值 |
| **tokenName** | Token 名称 | Reserve | `r.asset?.underlying?.info?.name ?? 'Unknown'` | `fetchV4MarketsDataInner()` 内联 | 带默认值取值 | `reserve.underlyingToken?.name` | `buildV3BaseDataset()` | 直接取值 |
| **tokenSymbol** | Token 列 | Reserve | `r.asset?.underlying?.info?.symbol ?? 'Unknown'` | `fetchV4MarketsDataInner()` 内联 | 带默认值取值 | `reserve.underlyingToken?.symbol` | `buildV3BaseDataset()` | 直接取值 |
| **tokenAddress** | 合约地址 | Reserve | `r.asset?.underlying?.address ?? ''` | `fetchV4MarketsDataInner()` 内联 | 带默认值取值 | `reserve.underlyingToken?.address` | `buildV3BaseDataset()` | 直接取值 |
| **decimals** | 精度换算除数 | Reserve | `r.asset?.underlying?.info?.decimals ?? undefined` | `fetchV4MarketsDataInner()` 内联 | 带默认值取值 | `reserve.underlyingToken?.decimals` | `buildV3BaseDataset()` | 直接取值 |

### 价格与规模字段

| API 字段 | 前端展示 | V4 级别 | V4 SDK 路径 | V4 处理函数 | V4 处理方法 | V3 SDK 路径 | V3 处理函数 | V3 处理方法 |
|----------|----------|---------|-------------|-------------|-------------|-------------|-------------|-------------|
| **tokenPrice** | Price 列 | Reserve | `r.summary?.supplied?.exchangeRate` | `fetchV4MarketsDataInner()` 内联 | `toFiniteNumber()` 转换 | `reserve.size?.usdPerToken` ?? `reserve.usdExchangeRate` | `buildV3BaseDataset()` | `toFiniteNumber()` 取首个有效值 |
| **reserveSizeUsd** | Total supplied / Supply Size / Size 列 | Reserve | `r.summary?.supplied?.exchange` | `fetchV4MarketsDataInner()` 内联 | `toFiniteNumber(r.summary?.supplied?.exchange) ?? undefined` | `reserve.size?.usd` | `buildV3BaseDataset()` | `toFiniteNumber(reserve?.size?.usd) ?? undefined` |
| **supplyCapUsd** | Supply cap / CapProgressRing | **Reserve** | `r.settings?.supplyCap?.exchange` | `fetchV4MarketsDataInner()` 内联 | `toFiniteNumber(r.settings?.supplyCap?.exchange) ?? undefined` | `reserve.supplyInfo?.supplyCap?.usd` | `buildV3BaseDataset()` | `toFiniteNumber(supplyCapUsdRaw) ?? undefined` |
| **borrowCapUsd** | Borrow cap / CapProgressRing | **Reserve** | `r.settings?.borrowCap?.exchange` | `fetchV4MarketsDataInner()` 内联 | `toFiniteNumber(r.settings?.borrowCap?.exchange) ?? undefined` | `reserve.borrowInfo?.borrowCap?.usd` | `buildV3BaseDataset()` | `toFiniteNumber(borrowCapUsdRaw) ?? undefined` |

### APY 与利率字段

| API 字段 | 前端展示 | V4 级别 | V4 SDK 路径 | V4 处理函数 | V4 处理方法 | V3 SDK 路径 | V3 处理函数 | V3 处理方法 |
|----------|----------|---------|-------------|-------------|-------------|-------------|-------------|-------------|
| **supplyApy** | Supply > Native | **Hub** | `r.summary?.supplyApy?.value` | `fetchV4MarketsDataInner()` 内联 | `toFiniteNumber(r.summary?.supplyApy?.value) ?? undefined` | `reserve.supplyInfo?.apy?.value` | `buildV3BaseDataset()` | 若 `supplyCap === 1` 则为 `undefined`，否则 `toFiniteNumber(supplyApyValue)` |
| **borrowApy** | Borrow > Native | **Hub** | `r.summary?.borrowApy?.value` | `fetchV4MarketsDataInner()` 内联 | `toFiniteNumber(r.summary?.borrowApy?.value) ?? undefined` | `reserve.borrowInfo?.apy?.value` | `buildV3BaseDataset()` | `toFiniteNumber(borrowApyValue) ?? undefined` |
| **utilizationPct** | Utilization 列 / Util% 指示条 | **Hub** | `hubInfo?.utilizationRate` | `fetchV4MarketsDataInner()` 内联 | `hubInfo.utilizationRate * 100`，从 HubAsset 索引查询 | `reserve.borrowInfo?.utilizationRate?.value` | `buildV3BaseDataset()` | `toFiniteNumber(value)` × 100，负数则 `undefined` |
| **availableLiquidity** | Pool liquidity / Liquidity | **Hub** | `hubInfo?.availableLiquidity` | `fetchV4MarketsDataInner()` 内联 | 从 `fetchHubAssetIndex()` 构建的索引获取 | `reserve.borrowInfo?.availableLiquidity?.amount?.raw` | `buildV3BaseDataset()` | 直接取值或 `undefined` |
| **totalVariableDebt** | Total borrowed / Borrow Size | Reserve | `r.summary?.borrowed?.amount?.onChainValue` | `fetchV4MarketsDataInner()` 内联 | `onChainValue.toString()` | `reserve.borrowInfo?.total?.amount?.raw` | `buildV3BaseDataset()` | 直接取值或 `undefined` |

### 利率模型参数字段 (RAY 精度)

| API 字段 | 前端使用 | V4 级别 | V4 SDK 路径 | V4 处理函数 | V4 处理方法 | V3 SDK 路径 | V3 处理函数 | V3 处理方法 |
|----------|----------|---------|-------------|-------------|-------------|-------------|-------------|-------------|
| **reserveFactor** | `useRateSimulation` | **Hub** | `hubInfo?.liquidityFee` | `fetchV4MarketsDataInner()` 内联 | 从 HubAsset 索引获取，值为 4-decimal (bps-like) 格式字符串，与 V3 一致 | `reserve.borrowInfo?.reserveFactor?.raw` | `buildV3BaseDataset()` | 直接取值或 `undefined` |
| **variableRateSlope1** | `useRateSimulation` | **Hub** | `hubInfo?.slopeBelowOptimal` | `fetchHubAssetIndex()` → 内联 | `percentOnChainValueToRay()` 转 RAY | `reserve.borrowInfo?.variableRateSlope1?.raw` | `buildV3BaseDataset()` | 直接取值或 `undefined` |
| **variableRateSlope2** | `useRateSimulation` | **Hub** | `hubInfo?.slopeAboveOptimal` | `fetchHubAssetIndex()` → 内联 | `percentOnChainValueToRay()` 转 RAY | `reserve.borrowInfo?.variableRateSlope2?.raw` | `buildV3BaseDataset()` | 直接取值或 `undefined` |
| **optimalUsageRate** | "Optimal" 标记 / UtilizationSheet | **Hub** | `hubInfo?.optimalUtilizationRate` | `fetchHubAssetIndex()` → 内联 | `percentOnChainValueToRay()` 转 RAY | `reserve.borrowInfo?.optimalUsageRate?.raw` | `buildV3BaseDataset()` | 直接取值或 `undefined` |
| **baseVariableBorrowRate** | `useRateSimulation` | **Hub** | `hubInfo?.baseBorrowRate` | `fetchHubAssetIndex()` → 内联 | `percentOnChainValueToRay()` 转 RAY | 链上 RPC (`UiPoolDataProvider`) | `marketsService.refreshMarketsSnapshot()` on-chain merge | 优先 RPC，缺失时用 APY→APR 反推 |

### 合约地址字段

| API 字段 | 前端使用 | V4 级别 | V4 SDK 路径 | V4 处理函数 | V4 处理方法 | V3 SDK 路径 | V3 处理函数 | V3 处理方法 |
|----------|----------|---------|-------------|-------------|-------------|-------------|-------------|-------------|
| **aTokenAddress** | - | N/A | N/A | `fetchV4MarketsDataInner()` 内联 | 固定填 `null` (V4 无 aToken) | `reserve.aToken?.address` | `buildV3BaseDataset()` | 直接取值或 `null` |
| **vTokenAddress** | - | N/A | N/A | `fetchV4MarketsDataInner()` 内联 | 固定填 `null` (V4 无 vToken) | `reserve.vToken?.address` | `buildV3BaseDataset()` | 直接取值或 `null` |
| **hubId** | 拼接待用 (`pro.aave.com/explore/hub/${hubId}`) | **Hub** | `hub?.id` | `fetchV4MarketsDataInner()` 内联 | `String(hub.id)` 转字符串 | N/A | N/A | N/A |
| **hubName** | 显示 Hub 名称 (如 "Core") | **Hub** | `hub?.name` | `fetchV4MarketsDataInner()` 内联 | 直接取值 | N/A | N/A | N/A |
| **hubAddress** | 合约交互用 | **Hub** | `hub?.address` | `fetchV4MarketsDataInner()` 内联 | 直接取值 | N/A | N/A | N/A |
| **spokeId** | 拼接待用 | Reserve | `spoke?.id` | `fetchV4MarketsDataInner()` 内联 | `String(spoke.id)` 转字符串 | N/A | N/A | N/A |
| **spokeName** | 显示 Spoke 名称 (如 "Main") | Reserve | `spoke?.name` | `fetchV4MarketsDataInner()` 内联 | 直接取值 | N/A | N/A | N/A |
| **spokeAddress** | 合约交互用 (市场入口) | Reserve | `spoke?.address` | `fetchV4MarketsDataInner()` 内联 | 直接取值 | N/A | N/A | N/A |
| **aaveProReserveId** | pro.aave.com 深链拼接用 | Reserve | `r.id` | `fetchV4MarketsDataInner()` 内联 | `String(r.id)` 转字符串 | N/A | N/A | N/A |

### 状态与开关字段

| API 字段 | 前端展示 | V4 级别 | V4 SDK 路径 | V4 处理函数 | V4 处理方法 | V3 SDK 路径 | V3 处理函数 | V3 处理方法 |
|----------|----------|---------|-------------|-------------|-------------|-------------|-------------|-------------|
| **supplyDisabled** | Supply unavailable tooltip | Reserve | `!r.canSupply` | `fetchV4MarketsDataInner()` 内联 | 直接取反 `canSupply` 布尔值 | 派生 | `buildV3BaseDataset()` | `isFrozen \|\| isPaused \|\| supplyCap === 1` |
| **borrowDisabled** | Borrow disabled tooltip | Reserve | `!r.canBorrow` | `fetchV4MarketsDataInner()` 内联 | 直接取反 `canBorrow` 布尔值 | 派生 | `buildV3BaseDataset()` | `borrowingState === "DISABLED" \|\| borrowCap === 1` |
| **isFrozen** | Frozen badge + ❄ icon | Reserve | `r.status?.frozen` | `fetchV4MarketsDataInner()` 内联 | `=== true` 判断 | `reserve.isFrozen` | `buildV3BaseDataset()` | `=== true` 判断 |
| **isPaused** | Paused badge + ❄ icon | Reserve | `r.status?.paused` | `fetchV4MarketsDataInner()` 内联 | `=== true` 判断 | `reserve.isPaused` | `buildV3BaseDataset()` | `=== true` 判断 |

### 激励字段 (外部数据源)

| API 字段 | 前端展示 | V4 级别 | V4 来源 | V4 处理函数 | V4 处理方法 | V3 来源 | V3 处理函数 | V3 处理方法 |
|----------|----------|---------|---------|-------------|-------------|---------|-------------|-------------|
| **supplyIncentives** | Protocol Incentive | Reserve | SDK: `r.summary?.rewards` | `fetchV4MarketsDataInner()` 内联 | **通常跳过** (内部积分，非公开 Merkl) | SDK: `reserve.incentives` | `buildV3BaseDataset()` | 遍历 `incentives` 数组，过滤 `__typename === 'AaveSupplyIncentive'`，提取 `extraSupplyApr` 或 `supplyApr` |
| **borrowIncentives** | Protocol Incentive | Reserve | SDK: `r.summary?.rewards` | `fetchV4MarketsDataInner()` 内联 | **通常跳过** (内部积分，非公开 Merkl) | SDK: `reserve.incentives` | `buildV3BaseDataset()` | 同上，过滤 `AaveBorrowIncentive` |
| **meritSupplys** / **meritBorrows** | ACI Incentive | 外部 | Merit API | `index.ts:enrichDatasetWithIncentiveData()` | 外部 enrich 阶段匹配 | Merit API | `index.ts:enrichDatasetWithIncentiveData()` | 外部 enrich 阶段匹配 |
| **merklSupplys** / **merklBorrows** / **merklHolds** | Merkl Incentive | 外部 | Merkl API | `index.ts:enrichDatasetWithIncentiveData()` | 外部 enrich 阶段匹配 | Merkl API | `index.ts:enrichDatasetWithIncentiveData()` | 外部 enrich 阶段匹配 |
| **brevisSupplys** / **brevisBorrows** | Brevis Incentive | 外部 | Brevis API | `index.ts:enrichDatasetWithIncentiveData()` | 外部 enrich 阶段匹配 | Brevis API | `index.ts:enrichDatasetWithIncentiveData()` | 外部 enrich 阶段匹配 |

### 特殊字段

| API 字段 | 前端展示 | V4 级别 | V4 SDK 路径 | V4 处理函数 | V4 处理方法 | V3 SDK 路径 | V3 处理函数 | V3 处理方法 |
|----------|----------|---------|-------------|-------------|-------------|-------------|-------------|-------------|
| **deficit** | Deficit / Def% / Size 列 Deficit 行 | N/A | N/A (SDK 不提供) | 默认 `'0'` | 默认 `'0'` | 链上 RPC (`UiPoolDataProvider`) | `onchainDataService.refreshOnchainCache()` | 从 RPC 读取，失败则默认 `'0'` |
| **borrowingState** | 用于判断 borrow 是否 DISABLED | Reserve | 待确认 V4 对应字段 | `fetchV4MarketsDataInner()` 内联 | 未直接提供，通过 `canBorrow` 间接判断 | `reserve.borrowInfo?.borrowingState` | `buildV3BaseDataset()` | 直接取值用于判断 |

---

## V4 Hub 级别字段汇总

以下 V4 字段从 **HubAsset 索引** 获取，同一 hub 内多个 reserves 共享相同值：

| 字段 | 说明 | HubAsset 字段 | 为什么共享 |
|------|------|---------------|----------|
| `utilizationPct` | 资金利用率 | `summary.utilizationRate * 100` | 基于 Hub 总流动性计算 |
| `availableLiquidity` | 可用流动性 | `summary.availableLiquidity.amount.onChainValue` | Hub 级别流动性池 |
| `reserveFactor` | 储备因子 | `settings.liquidityFee.onChainValue` | Hub 级别的费率策略 (4-decimal) |
| `variableRateSlope1` | 利率曲线斜率 1 | `settings.slopeBelowOptimal` (经转换) | 同一 Hub 利率模型共享 |
| `variableRateSlope2` | 利率曲线斜率 2 | `settings.slopeAboveOptimal` (经转换) | 同一 Hub 利率模型共享 |
| `optimalUsageRate` | 最优利用率 | `settings.optimalUtilizationRate` (经转换) | 同一 Hub 利率模型共享 |
| `baseVariableBorrowRate` | 基础借款利率 | `settings.baseBorrowRate` (经转换) | 同一 Hub 利率模型共享 |
| `hubId` | Hub ID | `hub.id` | Hub 标识 |
| `hubName` | Hub 名称 | `hub.name` | Hub 标识 |
| `hubAddress` | Hub 合约地址 | `hub.address` | Hub 标识 |
| `assetTotalSupplied` | Hub 资产总供应量 | `hub.summary.totalSupplied.current.value` | HubSummary → ExchangeAmountWithChange |
| `assetTotalBorrowed` | Hub 资产总借款量 | `r.summary.borrowed.amount.onChainValue` | ReserveSummary → Erc20Amount (Spoke 级别) |
| `assetTotalSupplyCap` | Hub 资产供应上限 | `hub.summary.totalSupplyCap.value` | HubSummary → ExchangeAmount |
| `assetTotalBorrowCap` | Hub 资产借款上限 | `hub.summary.totalBorrowCap.value` | HubSummary → ExchangeAmount |

**重要提示 - SDK 字段结构差异**：

V4 SDK 返回的 HubSummary 字段有不同结构（通过 `r.asset.hub.summary` 或 `hubAsset.hub.summary` 访问）：

```typescript
// 1. ExchangeAmountWithChange (totalSupplied, totalBorrowed)
// 结构: { __typename: "ExchangeAmountWithChange", current: { __typename: "ExchangeAmount", value: string } }
hub.summary?.totalSupplied?.current?.value
hub.summary?.totalBorrowed?.current?.value

// 2. ExchangeAmount (totalSupplyCap, totalBorrowCap)
// 结构: { __typename: "ExchangeAmount", value: string }
hub.summary?.totalSupplyCap?.value
hub.summary?.totalBorrowCap?.value

// 3. Erc20Amount (HubAssetSummary.borrowed, availableLiquidity)
// 结构: { __typename: "Erc20Amount", amount: { onChainValue: string } }
asset.summary?.borrowed?.amount?.onChainValue
asset.summary?.availableLiquidity?.amount?.onChainValue
```

**注意**：`supplyCapUsd` 和 `borrowCapUsd` 是 **Reserve 级别** 字段，来自 `ReserveSettings`（`r.settings.supplyCap.exchange` / `r.settings.borrowCap.exchange`），不是 Hub 级别。HubAssetSettings 没有 supplyCap/borrowCap 字段。

**Reserve 级别但依赖 Hub 参数的字段**：

| 字段 | V4 实际级别 | 说明 |
|------|-------------|------|
| `reserveSizeUsd` | Reserve | 每个 reserve 独立的实际供应额（Spoke 级别） |
| `totalVariableDebt` | Reserve | 每个 reserve 独立的实际借款额（Spoke 级别） |

**重要澄清 - 为什么 `supplyApy`/`borrowApy` 是 Hub 级别**：

虽然这两个值从 `r.summary`（reserve 对象）获取，但它们在 V4 中是 **Hub 级别** 的：

1. **计算公式**：APY = f(utilizationPct, 利率模型参数)，其中 utilizationPct 和利率参数都是 Hub 级别的
2. **实际表现**：同一 Hub 内所有 Spoke 的 `supplyApy` 和 `borrowApy` 值**完全相同**
3. **架构原因**：V4 的利率模型在 Hub 层统一计算，然后应用到所有 Spoke

这与 V3 形成对比：V3 中每个 reserve 有独立的利率参数，所以 APY 可以不同；V4 中同一 Hub 内所有 reserves 的 APY 必然相同。

---

## 前端派生值计算公式（带 V4 级别标注）

来自 `docs/api/field-glossary.md`:

| 派生值 | V4 级别 | 公式 | 代码位置 | 说明 |
|--------|---------|------|---------|------|
| **Size 列派生值** |
| Total Supplied | Reserve | `reserveSizeUsd` (API 直接提供) | `marketsApiSerialize.ts` | 市场总供应量 |
| Total Borrowed (USD) | Reserve | `totalVariableDebt / 10^decimals * tokenPrice` | `scenarioSize.ts:106-119` | 每个 reserve 独立的借款总额 |
| Deficit (USD) | N/A | `deficit / 10^decimals * tokenPrice` | `deficit.ts:91-98` | V3 only，V4 默认 '0' |
| Deficit Share Ratio | N/A | `deficitUsd / (deficitUsd + totalSuppliedUsd)` | `deficit.ts:100-111` | V3 only |
| **Util 列派生值** |
| Utilization | **Hub** | `utilizationPct` (API 直接提供) | `marketsApiSerialize.ts` | Hub 级利用率 |
| Liquidity (USD) | **Hub** | `availableLiquidity / 10^decimals * tokenPrice` | `scenarioSize.ts:139-152` | 基于 Hub 级 availableLiquidity |
| **Cap 相关派生值** |
| Available to Supply | **Reserve** | `min(hubRemainingSupplyCap, spokeSupplyCapUsd - reserveSizeUsd)` | 派生 | Hub remaining + Spoke cap 取较小 |
| Supply Cap % | **Reserve** | `reserveSizeUsd / min(spokeSupplyCapUsd, hubSupplyCapUsd) * 100` | 派生 | Spoke 实际供应 / 实际可用上限 |
| Borrow Cap % | **Reserve** | `borrowedUsd / min(spokeBorrowCapUsd, hubBorrowCapUsd) * 100` | 派生 | Spoke 实际借款 / 实际可用上限 |
| Borrow Avail (Available to Borrow) | **Reserve** | `min(spokeBorrowCapUsd - borrowedUsd, hubLiquidityUsd)` | `scenarioSize.ts:173-193` | Spoke cap - Hub liquidity 取较小 |
| **Supply/Borrow 列派生值** |
| Total Supply APY | **Hub** | `supplyApy + sum(supplyIncentives) + sum(meritSupplys) + sum(merklSupplys) + sum(brevisSupplys)` | `formatters.ts:371-374` | 基于 Hub 级 supplyApy 计算 |
| Total Borrow APY | **Hub** | `borrowApy - sum(borrowIncentives) - sum(meritBorrows) - sum(merklBorrows) - sum(brevisBorrows)` | `formatters.ts:384-388` | 基于 Hub 级 borrowApy 计算 |
| Supply Incentive APY | 外部 | `sum(supplyIncentives) + sum(meritSupplys) + sum(merklSupplys) + sum(brevisSupplys)` | `formatters.ts` | 外部激励合计 |
| Borrow Incentive APY | 外部 | `sum(borrowIncentives) + sum(meritBorrows) + sum(merklBorrows) + sum(brevisBorrows)` | `formatters.ts` | 外部激励合计 |
| **Spread 列** |
| Spread | **Hub** | `totalSupplyApy - totalBorrowApy` | `formatters.ts:392-395` | 基于两个 Hub 级 APY 计算 |

---

## 可复用函数抽象建议

### 1. `toFiniteNumber()` - 已完成抽象 ✅

**现状**: 已合并到 `src/utils/number.ts` 单一规范实现，所有调用方从此导入。

**复用收益**:
- 消除了 4 处重复定义
- 统一数值转换逻辑，避免潜在差异
- 约 15 行代码抽象为 1 处维护

### 2. `parseFloat()` vs `toFiniteNumber()` 统一 ✅ 已完成

**变更前**: V3 部分字段用 `parseFloat`，部分用 `toFiniteNumber`

| V3 字段 | 原使用函数 | 现使用函数 |
|---------|------------|------------|
| `supplyCapUsd` | `parseFloat()` | `toFiniteNumber()` ✅ |
| `borrowCapUsd` | `parseFloat()` | `toFiniteNumber()` ✅ |
| `supplyApy` | `parseFloat()` | `toFiniteNumber()` ✅ |
| `borrowApy` | `parseFloat()` | `toFiniteNumber()` ✅ |
| `supplyCapIsOne` | `parseFloat()` | `toFiniteNumber()` ✅ |
| `borrowCapIsOne` | `parseFloat()` | `toFiniteNumber()` ✅ |
| `incentive apr` | `parseFloat()` | `toFiniteNumber()` ✅ |

**变更后**: 全部统一使用 `toFiniteNumber()`，更安全且与 V4 保持一致。

**代码变更**:
```typescript
// 变更前
const supplyCapUsd = supplyCapUsdRaw ? parseFloat(supplyCapUsdRaw) : undefined;

// 变更后  
const supplyCapUsd = toFiniteNumber(supplyCapUsdRaw) ?? undefined;
```

### 3. V4 的 HubAsset 索引模式 - 架构级差异

**V4 特有**: `fetchHubAssetIndex()` 构建 Map 索引供后续查询

```typescript
// 当前 V4 流程
const hubAssetIndex = await fetchHubAssetIndex(chainIds);  // 先建索引
// ... 遍历 reserves ...
const hubInfo = hubAssetIndex.get(hubAssetKey);  // 后查询
```

**评估**: 不建议抽象到 V3，因为：
- V3 数据结构扁平，不需要二次查询
- 抽象会增加 V3 复杂度，无收益
- 仅在 V4 有明确性能收益（避免重复遍历）

### 4. disabled 标志生成逻辑 - 可部分抽象

| 版本 | 逻辑 |
|------|------|
| V3 | `isFrozen \|\| isPaused \|\| supplyCap === 1` |
| V4 | `!canSupply` (SDK 直接提供) |

**评估**: 无法完全抽象，因为数据源不同（V3 需要派生，V4 SDK 直接提供布尔值）。但可以抽象一个辅助函数用于 V3：

```typescript
// src/utils/flags.ts
export function isSupplyDisabledV3(
  isFrozen: boolean,
  isPaused: boolean,
  supplyCapValue?: string
): boolean {
  if (isFrozen || isPaused) return true;
  if (supplyCapValue !== undefined && parseFloat(supplyCapValue) === 1) return true;
  return false;
}
```

**收益**: 较低，仅 V3 使用，且逻辑简单，可不抽象。

### 5. Reserve ID 生成 - 不建议抽象

| 版本 | 格式 |
|------|------|
| V3 | `${marketName}:${chainId}:${tokenAddress}` |
| V4 | `${marketName}:${chainId}:${tokenAddress}:${hubName}` |

**评估**: 不建议抽象，因为：
- 格式差异是根本性的（V4 需要 hubName 区分多 hub）
- 强行抽象会增加参数复杂度
- 当前内联实现清晰易读

---

## 工具函数说明

### `toFiniteNumber(value: unknown): number | null`

**位置**: `src/utils/number.ts`（单一规范实现，所有调用方从此导入）

用于安全转换 SDK 返回的数值。已从 4 处重复定义合并为单一实现。

### `percentOnChainValueToRay(onChainValue: string, decimals: number): string`

**位置**: `src/v4-fetcher.ts:125`

V4 特有：将 4-decimal 精度转换为 RAY (27-decimal)：

```typescript
function percentOnChainValueToRay(onChainValue: string, decimals: number): string {
  const value = BigInt(onChainValue);
  const diff = 27 - decimals;
  if (diff <= 0) return value.toString();
  return (value * BigInt(10) ** BigInt(diff)).toString();
}
```

- V4 SDK 返回的利率参数是 4-decimal (如 `900` 表示 9%)
- 需转换为 RAY 格式 (如 `900000000000000000000000000`) 以与 V3 对齐

### `fetchHubAssetIndex(chainIds: number[]): Promise<{ index: Map<string, HubAssetInfo>; rawAssets: any[] }>`

**位置**: `src/v4-fetcher.ts:140`

V4 特有：构建 HubAsset 索引表，用于查询 utilization、利率参数等 Hub 级别数据：

```typescript
async function fetchHubAssetIndex(chainIds: number[]): Promise<{ index: Map<string, HubAssetInfo>; rawAssets: any[] }> {
  // GraphQL 查询 HubAsset 数据
  // 构建 key: `${chainId}:${tokenAddress}:${hubId}`
  // 返回 Map 供 reserve 处理时查询
}
```

- V4 的 utilization、利率参数、availableLiquidity 等需要从 HubAsset 查询
- 因为 V4 的 Hub & Spoke 架构下，同一 token 可能存在于多个 hub

---

## 关键差异详解

### 1. 架构差异

| 维度 | V3 | V4 |
|------|-----|-----|
| **数据处理** | 单一函数 `buildV3BaseDataset()` | 多阶段：`fetchHubAssetIndex()` + `fetchV4MarketsDataInner()` |
| **Hub & Spoke** | 无 | 需要 `fetchHubAssetIndex()` 预构建索引 |
| **Reserve 遍历** | 外层 `markets.forEach` + 内层 `supplyReserves.forEach` | 单层 `v4Reserves.forEach` |
| **Reserve ID** | 三字段拼接 | 四字段拼接（含 `hubName`） |
| **数据级别** | 全部为 Reserve 级别 | 部分为 Hub 级别（共享同一 hub 数据） |

### 2. `reserveSizeUsd` 路径差异

```typescript
// V3: src/index.ts:602 in buildV3BaseDataset()
const reserveSizeUsd = toFiniteNumber(reserve?.size?.usd) ?? undefined;

// V4: src/v4-fetcher.ts:299 in fetchV4MarketsDataInner()
const reserveSizeUsd = toFiniteNumber(r.summary?.supplied?.exchange) ?? undefined;
```

**说明**：
- V3 的 `size.usd` 直接是 reserve 层级的总供应美元值
- V4 的 `summary.supplied.exchange` 中，`supplied` 是 V4 SDK 的数据结构名，`exchange` 表示美元计价

### 3. `supplyCapUsd` / `borrowCapUsd` 路径差异

```typescript
// V3: src/index.ts in buildV3BaseDataset()
const supplyCapUsd = toFiniteNumber(reserve.supplyInfo?.supplyCap?.usd) ?? undefined;
const borrowCapUsd = toFiniteNumber(reserve.borrowInfo?.borrowCap?.usd) ?? undefined;

// V4: src/v4-fetcher.ts in fetchV4MarketsDataInner()
const supplyCapUsd = toFiniteNumber(r.settings?.supplyCap?.exchange) ?? undefined;
const borrowCapUsd = toFiniteNumber(r.settings?.borrowCap?.exchange) ?? undefined;
```

**说明**：
- V3 的 cap 在 `supplyInfo` / `borrowInfo` 下，用 `toFiniteNumber` 转换
- V4 的 cap 在 `settings` 下（实际来自 HubAsset 索引），且字段名用 `exchange` 而非 `usd`，用 `toFiniteNumber` 转换

### 4. V4 Hub & Spoke 架构影响

V4 采用 Hub & Spoke 模型，导致以下差异：

1. **Reserve ID 包含 hubName**：同一 token 可能在多个 hub（Core/Plus/Prime）中出现
2. **utilizationPct 来自 HubAsset**：不是 reserve 直接提供，需通过 `hubAssetIndex` 查询
3. **无 aToken/vToken**：V4 使用 hub/spoke 合约地址代替

```typescript
// V4: src/v4-fetcher.ts:324-329 in fetchV4MarketsDataInner()
const reserveHubId = String(r.asset?.hub?.id ?? '');
const hubAssetKey = `${chainIdNum}:${tokenAddressLower}:${reserveHubId}`;
const hubInfo = hubAssetIndex.get(hubAssetKey);  // ← 从 fetchHubAssetIndex() 预建的索引查询
const utilizationPct = hubInfo?.utilizationRate !== undefined
  ? hubInfo.utilizationRate * 100
  : undefined;
```

### 5. V4 利率参数单位转换

V4 SDK 的利率参数使用 4-decimal 精度，需转换为 RAY (27-decimal) 以匹配 V3：

```typescript
// src/v4-fetcher.ts:125 percentOnChainValueToRay()
function percentOnChainValueToRay(onChainValue: string, decimals: number): string {
  const value = BigInt(onChainValue);
  const diff = 27 - decimals;
  if (diff <= 0) return value.toString();
  return (value * BigInt(10) ** BigInt(diff)).toString();
}

// 在 fetchHubAssetIndex() 中应用转换
const variableRateSlope1 = percentOnChainValueToRay(
  (asset as any).settings?.variableRateSlope1?.onChainValue,
  (asset as any).settings?.variableRateSlope1?.decimals
);
```

---

## 数据来源优先级

对于 V3 和 V4 共同使用的字段，数据合并优先级：

1. **SDK 值**（每分钟刷新，最优先）
2. **On-chain RPC**（仅 V3 覆盖，`deficit` 和 `baseVariableBorrowRate` 兜底）
3. **Fallback 计算/默认值**

V4 特有字段完全依赖 SDK，无 RPC 覆盖。

---

## 验证脚本

- V3/V4 reserve 数量对比：`node scripts/validate-sdk-reserve-fields.mjs`
- SDK vs On-chain 匹配：`backend/scripts/validate-sdk-onchain-reserve-match.mjs`
- 基础利率 fallback：`backend/scripts/validate-base-rate-fallback.mjs`

---

## 常见前端用语 ↔ API 字段速查

| 前端说 | 找 API 字段 |
|--------|-----------|
| "Total supplied" / "总供应量" | `reserveSizeUsd` |
| "Total borrowed" / "总借款" | `totalVariableDebt`（需 USD 换算） |
| "Pool liquidity" / "池流动性" | `availableLiquidity`（需 USD 换算） |
| "Supply cap" / "供应上限" | `supplyCapUsd` |
| "Borrow cap" / "借贷上限" | `borrowCapUsd` |
| "Available to supply" | `supplyCapUsd - reserveSizeUsd`（派生） |
| "Available to borrow" | `min(borrowCapUsd - borrowed, poolLiquidity)`（派生） |
| "Utilization" / "利用率" | `utilizationPct` |
| "Deficit" / "坏账" | `deficit`（需 USD 换算 + 占比计算） |
| "Supply APY" | `supplyApy`（Native）+ 各激励（合计） |
| "Borrow APY" | `borrowApy`（Native）- 各激励（合计） |
| "Spread" | `totalSupplyApy - totalBorrowApy`（派生） |
| "Protocol Incentive" | `supplyIncentives` / `borrowIncentives` |
| "ACI Incentive" | `meritSupplys` / `meritBorrows` |
| "Merkl Incentive" | `merklSupplys` / `merklBorrows` / `merklHolds` |
| "Brevis Incentive" | `brevisSupplys` / `brevisBorrows` |

---

## GraphQL 客户端与架构说明

### V3 与 V4 SDK 底层架构

| 维度 | V3 (`@aave/client`) | V4 (`@aave/client-v4`) |
|------|---------------------|------------------------|
| **传输协议** | GraphQL over HTTP | GraphQL over HTTP |
| **客户端** | urql (`AaveClient` extends `GqlClient`) | urql (`AaveClient` extends `GqlClient`) |
| **Batching** | 默认开启 (`batch: true`) | 默认开启 (`batch: true`) |
| **Query 合并** | 同一 tick 内多个 query 自动合并为单个 HTTP POST | 同一 tick 内多个 query 自动合并为单个 HTTP POST |

**关键结论**：V3 和 V4 SDK 底层都使用 urql，不是 Apollo Client。urql 的 batching 机制不需要额外配置，只要把请求改为并行发起即可自动合并。

### 为什么不用 Apollo Client / DataLoader

| 工具 | 定位 | 本项目适用性 |
|------|------|-------------|
| **Apollo Client** | 前端 GraphQL 客户端（React/Vue 生态） | ❌ 不适用。我们使用 urql（更轻量），且 SDK 已封装 |
| **DataLoader** | 服务端 resolver 层批处理工具 | ❌ 不适用。我们是客户端调用方，不是服务端 |
| **urql batching** | 前端 GraphQL 请求合并 | ✅ 已内置，无需额外安装 |

**DataLoader 的典型使用场景**（服务端）：
```typescript
// 服务端 resolver 中解决 N+1
const userLoader = new DataLoader(async (userIds) => {
  // 1 次 SQL/GraphQL 查询获取所有 user
  return await db.users.findMany({ where: { id: { in: userIds } } });
});

// resolver 中多次调用自动合并
const user1 = await userLoader.load(1);
const user2 = await userLoader.load(2); // 合并为 1 次查询
```

**我们的场景**（客户端）：
```typescript
// 客户端直接调用 SDK，利用 urql batching
const results = await Promise.all([
  hubAssets(client, { query: { hubId: hub1.id } }),
  hubAssets(client, { query: { hubId: hub2.id } }),
  // urql 自动把这 2 个 query 合并为 1 个 HTTP 请求
]);
```

### V3 的 `markets()` 调用模式

V3 的 `markets(client, { chainIds: [...] })` 本身支持批量 chainIds，设计上已经避免了 N+1 问题：

```typescript
// ✅ V3 推荐：1 次请求覆盖多链
const result = await markets(client, {
  chainIds: [chainId(1), chainId(137), chainId(42161)],
});

// ⚠️ V3 当前实现：逐个 chainId 调用（为了错误隔离）
for (const chainIdValue of chainIds) {
  const result = await markets(client, { chainIds: [chainId(chainIdValue)] });
  // 一个链失败不影响其他链
}
```

**权衡**：
- **批量调用**：1 次 HTTP 请求，速度快，但一个链失败全失败
- **逐个调用**：N 次 HTTP 请求，速度慢，但错误隔离好

---

**文档创建日期**: 2026-04-27  
**依据代码**: `src/index.ts`, `src/v4-fetcher.ts`  
**相关文档**: `docs/backend/data-precision-comparison.md`, `docs/api/markets-api-sdk-field-validation.md`, `docs/api/field-glossary.md`

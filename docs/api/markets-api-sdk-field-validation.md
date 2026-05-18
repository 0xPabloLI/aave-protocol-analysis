# Markets API 与 Aave SDK 字段校验

本文档校验 `GET /api/markets` 响应中的 `reserves[]`（`MarketWithSpread`）各字段是否均由 Aave SDK 或既定补充数据源提供，以及**逐条 reserve** 是否存在字段缺失。

## 结论摘要

- **API 所需字段均有数据源覆盖，无缺失。**
- 来自 **Aave SDK**（`@aave/client` `markets()` → `market.supplyReserves[]`）的字段均已在 `packages/aave-fetcher/src/index.ts` 的 `buildV3BaseDataset()` 中正确映射。
- **baseVariableBorrowRate**、**deficit** 设计上来自链上 RPC（`UiPoolDataProvider.getReservesHumanized()`），非 SDK；缺失时由 backend 做 fallback 或置空。
- **merit***、**merkl***、**brevis*** 来自外部激励 API，非 SDK。

### 逐条 reserve 校验结果（存在缺失的 reserve）

对当前快照 `data/debug/aave-all-markets-data.json` 做逐条检查后：

- **总 reserve 数**: 275  
- **存在至少一处字段缺失的 reserve 数**: 20  

这 20 条 reserve 的共性是：**SDK 未返回整块 `borrowInfo`**（或为 null），因此以下字段在该条 reserve 上均为缺失：
- `borrowInfo.utilizationRate.value`
- `borrowInfo.borrowingState`
- `borrowInfo.borrowCap.amount.value` / `borrowInfo.borrowCap.usd`
- `borrowInfo.apy.value`
- `borrowInfo.availableLiquidity.amount.raw`
- `borrowInfo.total.amount.raw`
- `borrowInfo.reserveFactor.raw`
- `borrowInfo.variableRateSlope1.raw` / `variableRateSlope2.raw` / `optimalUsageRate.raw`

**涉及 reserve 示例**（symbol）：AAVE, ezETH, sDAI, sUSDe, tETH, weETH (EtherFi), ACRED, JAAA, JTRSY, USCC, USTB, USYC, VBILL (Horizon), AAVE (Arbitrum/Avalanche/Optimism/Polygon), AAVE.e, sAVAX, wrsETH, stMATIC 等。

这些多为「仅供应/仅抵押」或 borrow 未开放的资产，协议层不暴露 borrow 信息，故 SDK 无 `borrowInfo`。  
API 中对应字段均为可选；该 20 条在响应里 `borrowApy`、`utilizationPct`、`availableLiquidity`、`totalVariableDebt`、`reserveFactor`、`variableRateSlope1/2`、`optimalUsageRate` 等会为 `undefined` 或不出现在 JSON 中。前端可按「无 borrow 数据」处理（例如不展示 borrow APY、或显示 N/A）。

**复现校验**：运行  
`node scripts/validate-sdk-reserve-fields.mjs`  
（依赖已生成的 `data/debug/aave-all-markets-data.json`）

### 275 vs 240：两脚本对齐（均排除 frozen/paused）

| 脚本 | 数据源 | 数量 | 说明 |
|------|--------|------|------|
| **validate-sdk-reserve-fields.mjs** | `data/debug/aave-all-markets-data.json` | **240** | 与 buildV3BaseDataset 一致：**排除** isFrozen / isPaused 后再统计 |
| **validate-base-rate-fallback.mjs**（payload） | `fetchMarketsData()` → `payload.data` | **240** | 同上，与 API 一致 |

原始 SDK 文件中共 275 条 supplyReserves，排除 35 条 frozen/paused 后为 240，两脚本数量应对齐。  
base-rate 校验报告见 `data/debug/base-rate-fallback-validation-report.json`（含 noBorrowInfo、null fallback、**reservesWithoutOnchainBase 全量列表及条数**、无 on-chain base 原因等）。

### SDK 与链上 reserve 条目不匹配校验

- **目的**：比对 Aave SDK 的 `supplyReserves` 与链上 `UiPoolDataProvider.getReservesHumanized()` 返回的 reserve 集合，按 **reserveId**（`chainId:poolAddress:tokenAddress`）检查是否一致。
- **链上覆盖**：后端已按 **所有 address-book 市场** 拉取链上数据（同链多市场如 Ethereum 主池、Lido、EtherFi、Horizon 均独立拉取），merge 时用 `reserve.reserveId` 匹配。
- **脚本**：`backend/scripts/validate-sdk-onchain-reserve-match.mjs`  
  运行：`npm run build && npm run build -w aave-dashboard-backend && node backend/scripts/validate-sdk-onchain-reserve-match.mjs`
- **结果**：
  - **仅在 SDK**：payload 中有该 reserve 但链上缓存无对应 reserveId（若覆盖全市场后仍出现，多为 RPC 失败或命名不一致）。
  - **仅在链上**：RPC 返回了该 pool 的 reserve，但 SDK 的 supplyReserves 中未包含（池内有但 API 未暴露为 supply，属预期）。
- **报告**：`data/debug/sdk-onchain-reserve-match-report.json`（含 summary 与详细列表）。

---

## 字段对照表

| API 字段 (MarketWithSpread) | 数据源 | SDK/其他路径 | 说明 |
|-----------------------------|--------|----------------|------|
| **reserveId** | 构造 | `${chainId}:${poolAddress}:${tokenAddress}` | ✓ |
| **marketName** | SDK | `market.name` | ✓ |
| **chainName** | SDK | `market.chain?.name` | ✓ |
| **chainId** | SDK | `market.chain?.chainId` | ✓ |
| **tokenName** | SDK | `reserve.underlyingToken?.name` | ✓ |
| **tokenSymbol** | SDK | `reserve.underlyingToken?.symbol` | ✓ |
| **tokenAddress** | SDK | `reserve.underlyingToken?.address` | ✓ |
| **tokenPrice** | SDK | `reserve.size?.usdPerToken` ?? `reserve.usdExchangeRate` | ✓ |
| **reserveSizeUsd** | SDK | `reserve.size?.usd` | ✓ |
| **utilizationPct** | SDK | `reserve.borrowInfo?.utilizationRate?.value` × 100 | ✓ |
| **aTokenAddress** | SDK | `reserve.aToken?.address` | ✓ |
| **vTokenAddress** | SDK | `reserve.vToken?.address` | ✓ |
| **supplyApy** | SDK | `reserve.supplyInfo?.apy?.value` × 100（supplyCap≠1 时） | ✓ |
| **supplyDisabled** | 派生 | `isFrozen \|\| isPaused \|\| supplyCap === 1` | ✓ |
| **supplyCapUsd** | SDK | `reserve.supplyInfo?.supplyCap?.usd` | ✓ |
| **borrowApy** | SDK | `reserve.borrowInfo?.apy?.value` × 100 | ✓ |
| **borrowDisabled** | 派生 | `borrowingState === "DISABLED" \|\| borrowCap === 1` | ✓ |
| **borrowCapUsd** | SDK | `reserve.borrowInfo?.borrowCap?.usd` | ✓ |
| **decimals** | SDK | `reserve.underlyingToken?.decimals` | ✓ |
| **availableLiquidity** | SDK | `reserve.borrowInfo?.availableLiquidity?.amount?.raw` | ✓ |
| **totalVariableDebt** | SDK | `reserve.borrowInfo?.total?.amount?.raw`（TokenAmount） | ✓ |
| **reserveFactor** | SDK | `reserve.borrowInfo?.reserveFactor?.raw` | ✓ |
| **variableRateSlope1** | SDK | `reserve.borrowInfo?.variableRateSlope1?.raw` | ✓ |
| **variableRateSlope2** | SDK | `reserve.borrowInfo?.variableRateSlope2?.raw` | ✓ |
| **optimalUsageRate** | SDK | `reserve.borrowInfo?.optimalUsageRate?.raw` | ✓ |
| **baseVariableBorrowRate** | 链上 | `UiPoolDataProvider.getReservesHumanized()`；缺失时 fallback 计算 | 非 SDK，设计如此 |
| **deficit** | 链上 | 同上；缺失时 backend 写 `"0"` | 非 SDK，设计如此 |
| **supplyIncentives** | SDK | `reserve.incentives`（AaveSupplyIncentive → extraSupplyApr/supplyApr × 100） | ✓ |
| **borrowIncentives** | SDK | `reserve.incentives`（AaveBorrowIncentive → extraBorrowApr/borrowApr × 100） | ✓ |
| **meritSupplys / meritBorrows** | 外部 | Merit API，enrich 阶段写入 | 非 SDK |
| **merklSupplys / merklBorrows / merklHolds** | 外部 | Merkl API，enrich 阶段写入 | 非 SDK |
| **brevisSupplys / brevisBorrows** | 外部 | Brevis API，enrich 阶段写入 | 非 SDK |

---

## SDK 实际结构核对（debug 样本）

基于 `data/debug/aave-all-markets-data.json` 中 `markets[].supplyReserves[]` 的单个 Reserve 结构：

- `size.usdPerToken`、`size.usd`、`usdExchangeRate` 存在 ✓  
- `supplyInfo.apy`（PercentValue）、`supplyInfo.supplyCap.amount.value`、`supplyInfo.supplyCap.usd` 存在 ✓  
- `borrowInfo.apy`、`borrowInfo.total`（TokenAmount，含 `amount.raw`）、`borrowInfo.borrowCap.usd`、`borrowInfo.reserveFactor.raw`、`borrowInfo.availableLiquidity.amount.raw`、`borrowInfo.utilizationRate.value`、`borrowInfo.variableRateSlope1/2.raw`、`borrowInfo.optimalUsageRate.raw`、`borrowInfo.borrowingState` 均存在 ✓  
- `underlyingToken.name/symbol/address/decimals`、`aToken.address`、`vToken.address` 存在 ✓  
- `incentives` 数组存在（可为空）✓  

上述路径与 `buildV3BaseDataset()` 中的使用一致，**无缺失的 SDK 字段**。

---

## 可选字段与空值

- 所有除 7 个标识字段（reserveId, marketName, chainName, chainId, tokenName, tokenSymbol, tokenAddress）外均为可选（`?`）。  
- SDK 某条 reserve 缺少某可选字段时，对应 API 字段为 `undefined` 或不出现在 JSON 中，符合类型与文档。  
- **baseVariableBorrowRate** / **deficit**：RPC 失败或未命中缓存时由 backend 做 fallback 或填 `"0"`，见 `marketsService.ts` 与 `onchainDataService.ts`。

---

---

## 相关文档

各字段的前端展示名称、排序选项、派生计算公式见 [field-glossary.md](./field-glossary.md)。

---

**校验日期**: 2026-03-15  
**依据**: `backend/src/types/index.ts`（MarketWithSpread）、`packages/aave-fetcher/src/index.ts`（buildV3BaseDataset）、`data/debug/aave-all-markets-data.json`（SDK 原始响应）

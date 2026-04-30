# V3/V4 API 精度统一执行方案 (in-progress)

**目标**：让 V3 和 V4 的所有 API 输出字段使用同一精度形态，前端能用同一套代码消费两个版本，并消除 RAY/bps↔百分比 的人工换算。

## 设计决策（最终）

### 字段单位约定

| 字段 | 类型 | 单位 | 备注 |
|---|---|---|---|
| `utilizationPct` | number | 百分比 | 不变 |
| `supplyApy`、`borrowApy` | number | 百分比 | 不变（serializer ×100）|
| `reserveFactor` | **number** | **百分比** | 由 `string` 4-decimal 改 |
| `variableRateSlope1`、`variableRateSlope2`、`optimalUsageRate`、`baseVariableBorrowRate` | **number** | **百分比** | 由 RAY string 改 |
| `tokenPrice`、`reserveSizeUsd`、`*Usd` | number | USD | |
| `reserveSize`、`supplyCap`、`borrowCap`、`totalVariableDebt`、`availableLiquidity`、`suppliable`、`borrowable` | string | raw token units | |

### 删除/新增

- 删除：V4 `fetchHubAssetIndex()`、`hubs/hubAssets` 调用、`percentOnChainValueToRay()`、`assetTotalSupplied/Borrowed/SupplyCap/BorrowCap`。
- 新增（V3+V4 同步）：`reserveSize`、`supplyCap`、`borrowCap`、`suppliable`、`suppliableUsd`、`borrowable`、`borrowableUsd`、`totalVariableDebtUsd`、`availableLiquidityUsd`。

### V4 SDK 路径全景（`reserve.asset.summary/settings` 已包含全部 hub 级数据，不再需要 hubAssets()）

| 字段 | V4 路径 | V3 路径 |
|---|---|---|
| `utilizationPct` | `r.asset.summary.utilizationRate.value` × 100 | `reserve.borrowInfo.utilizationRate.value` × 100 |
| `availableLiquidity` | `r.asset.summary.availableLiquidity.amount.onChainValue` | `reserve.borrowInfo.availableLiquidity.amount.raw` |
| `availableLiquidityUsd` | `r.asset.summary.availableLiquidity.exchange.value` | `reserve.borrowInfo.availableLiquidity.usd` |
| `reserveFactor` | `r.asset.settings.liquidityFee.value` × 100 | `reserve.borrowInfo.reserveFactor.value` × 100 |
| `variableRateSlope1` | `r.asset.settings.slopeBelowOptimal.value` × 100 | `reserve.borrowInfo.variableRateSlope1.value` × 100 |
| `variableRateSlope2` | `r.asset.settings.slopeAboveOptimal.value` × 100 | `reserve.borrowInfo.variableRateSlope2.value` × 100 |
| `optimalUsageRate` | `r.asset.settings.optimalUtilizationRate.value` × 100 | `reserve.borrowInfo.optimalUsageRate.value` × 100 |
| `baseVariableBorrowRate` | `r.asset.settings.baseBorrowRate.value` × 100 | 来自链上 RPC 或 fallback 计算（改输出 number 百分比）|
| `reserveSize` | `r.summary.supplied.amount.onChainValue` | `reserve.size.amount.raw` |
| `reserveSizeUsd` | `r.summary.supplied.exchange.value` | `reserve.size.usd` |
| `totalVariableDebt` | `r.summary.borrowed.amount.onChainValue` | `reserve.borrowInfo.total.amount.raw` |
| `totalVariableDebtUsd` | `r.summary.borrowed.exchange.value` | `reserve.borrowInfo.total.usd` |
| `supplyCap` | `r.settings.supplyCap.amount.onChainValue` | `reserve.supplyInfo.supplyCap.amount.raw` |
| `supplyCapUsd` | `r.settings.supplyCap.exchange.value` | `reserve.supplyInfo.supplyCap.usd` |
| `borrowCap` | `r.settings.borrowCap.amount.onChainValue` | `reserve.borrowInfo.borrowCap.amount.raw` |
| `borrowCapUsd` | `r.settings.borrowCap.exchange.value` | `reserve.borrowInfo.borrowCap.usd` |
| `suppliable` | `r.summary.suppliable.amount.onChainValue` | 服务端派生 `max(0, supplyCap - reserveSize)` |
| `suppliableUsd` | `r.summary.suppliable.exchange.value` | 服务端派生 `max(0, supplyCapUsd - reserveSizeUsd)` |
| `borrowable` | `r.summary.borrowable.amount.onChainValue` | 服务端派生 `max(0, min(borrowCap-totalDebt, availableLiquidity))` |
| `borrowableUsd` | `r.summary.borrowable.exchange.value` | 服务端派生 `max(0, min(borrowCapUsd-totalDebtUsd, availableLiquidityUsd))` |

## 执行 commit 顺序

后端 (`aave-protocol-analysis/`)：

1. **commit 1** — V4 fetcher 删除 `fetchHubAssetIndex()`/`hubs`/`hubAssets`/`percentOnChainValueToRay`，全部从 `reserve.asset.summary/settings` 读；rate params 输出 `value × 100` 的 number；删除 `assetTotal*`。
2. **commit 2** — V3 `buildV3BaseDataset()` 把 5 个 rate params 输出从 RAY/bps string 改为 number 百分比（用 `.value × 100`）。
3. **commit 3** — V3+V4 同时新增 11 个字段（reserveSize、supplyCap、borrowCap、suppliable*、borrowable*、totalVariableDebtUsd、availableLiquidityUsd）。`pruneReserveForRuntime`+`FormattedReserveData`+`RuntimeReserveData`+`EXPECTED_RUNTIME_FIELDS`+`MarketWithSpread`+`marketsApiSerialize.ts` 全套类型同步。
4. **commit 4** — 后端 on-chain ingestion + `calculateBaseRateFallback` 改为 number 百分比（消除 RAY 字符串内部传递）。

前端 (`aaveapy/lovable`)：

5. **commit 5** — `ReserveWithSpread` 把 5 个 rate 字段从 `string` 改 `number`；新增 11 个字段；`apiSchemas.ts` zod 同步。
6. **commit 6** — 重写 `interestRateCalculator.ts`：去掉 `RAY/PERCENTAGE_FACTOR/rayMul/rayDiv/toBigInt/rayToPercent`，改 Float 数学；`useRateSimulation.ts` 删 `(raw/10000)*100`、`(raw/RAY)*100`；`DesktopReserveRow` 删 RAY 转换。
7. **commit 7** — `scenarioSize.ts`/`useRateSimulation.ts` 直接用 `*Usd`/`suppliable*`/`borrowable*` 字段，删除 raw → USD 派生与 cap 推导。
8. **commit 8** — 测试 fixture 全部从 RAY 字符串改成 number，跑 vitest 通过。

## 进度

- [x] commit 1 — V4 fetcher 重构（删除 hubAssets、rate params 改 number 百分比）✅
- [x] commit 2 — V3 rate params 改 number 百分比 ✅
- [x] commit 4 — on-chain `baseVariableBorrowRate` + fallback 改 number 百分比 ✅ (与 commit 1+2 合并：类型耦合)
- [x] commit 3 — V3+V4 新增 11 个字段 (reserveSize, supplyCap, borrowCap, suppliable*, borrowable*, totalVariableDebtUsd, availableLiquidityUsd) ✅
- [ ] commit 5 — 前端类型/zod 调整
- [ ] commit 6 — 前端利率计算器 Float 重写
- [ ] commit 7 — 前端消费新 USD/cap 字段
- [ ] commit 8 — 前端测试 fixture 更新

## 验证命令

```bash
# 后端
npm run build
npm --prefix backend run build
npm --prefix backend run test

# 前端
cd ../aaveapy
npm test
```

# V3/V4 API 精度统一执行方案 (completed)

**目标**：让 V3 和 V4 的所有 API 输出字段使用同一精度形态，前端能用同一套代码消费两个版本，并消除 RAY/bps↔百分比 的人工换算。

## 设计决策（最终）

### 字段类型 / 单位 / 精度 总表

> 单位约定：百分比字段统一为 number、单位 %（例如 `9` 表示 9%）；金额字段拆成两套——链上 raw token units 用 string（避免 JS Number 在 1e18 量级丢精度），USD 折算用 number。

#### 1. 标识字段（永远不动）

| 字段 | 类型 | 单位/精度 | 备注 |
|---|---|---|---|
| `reserveId` | string | — | 后端规范 key |
| `aaveProReserveId` | string? | — | V4 SDK ReserveId |
| `marketName`、`chainName`、`tokenName`、`tokenSymbol` | string | — | |
| `chainId` | number | 整数 | EVM chain id |
| `tokenAddress`、`aTokenAddress`、`vTokenAddress` | string | — | EVM address |
| `decimals` | number | 整数 | ERC-20 decimals (e.g. 6 / 18) |

#### 2. 利率 / APY / 激励（统一 percent number，单位 %）

| 字段 | 类型 | 单位 | 例子 | 备注 |
|---|---|---|---|---|
| `supplyApy`、`borrowApy` | number | percent | `2.07` = 2.07% | Aave 协议 APY |
| `utilizationPct` | number | percent | `45.2` = 45.2% | borrow-side utilization |
| **`reserveFactor`** | **number** | **percent** | `10` = 10% | 由 `string` 4-decimal 改 |
| **`variableRateSlope1`** | **number** | **percent** | `4` = 4% | 由 RAY string 改 |
| **`variableRateSlope2`** | **number** | **percent** | `60` = 60% | 由 RAY string 改 |
| **`optimalUsageRate`** | **number** | **percent** | `80` = 80% | 由 RAY string 改 |
| **`baseVariableBorrowRate`** | **number** | **percent** | `0` = 0% | 由 RAY string 改 |
| `supplyIncentives[]`、`borrowIncentives[]` | number[] | percent | `[1.1]` = 1.1% | 协议激励 |
| `MeritIncentive.apr`、`selfApr` | number | percent | `5.2` = 5.2% | Merit |
| `MerklCampaignBreakdown.campaignApr`、`aprCap` | number | percent | `3.2` = 3.2% | Merkl |
| `BrevisCampaignBreakdown.campaignApr` | number | percent | `4.8` = 4.8% | Brevis |
| `pointsPerThousandUsd` | number | points / 1000 USD | | Tydro 积分换算 |

> **切勿混用**：所有 APR 字段都是 percent number（**不是** decimal fraction，**不是** RAY，**不是** bps）。`convertAprToApy(percent)` 接收 percent 输入；`sanitizePercent` 用于 NaN/负值归一。

#### 3. 链上 raw token 数量（string，单位 token base units）

| 字段 | 类型 | 单位 | 备注 |
|---|---|---|---|
| `availableLiquidity` | string | raw token units | 链上原值，通常需除以 `10^decimals` 显示 |
| `totalVariableDebt` | string | raw token units | scaled debt × index, 后端预先合算 |
| `deficit` | string | raw token units | 用于 supply rate 稀释计算 |
| `reserveSize` | string | raw token units | = available + totalDebt |
| `supplyCap` | string | raw token units | 0 表示无限 |
| `borrowCap` | string | raw token units | 0 表示无限 |

#### 4. USD 金额（number，单位 USD — V4 内部中间字段，不在 API 中）

| 字段 | 类型 | 单位 | 备注 |
|---|---|---|---|
| `tokenPrice` | number | USD per token | |
| `reserveSizeUsd` | number | USD | V4 内部，不在 API 中 |
| `availableLiquidityUsd` | number | USD | V4 内部，不在 API 中 |
| `totalVariableDebtUsd` | number | USD | V4 内部，不在 API 中 |
| `supplyCapUsd` | number | USD | V4 内部，不在 API 中 |
| `borrowCapUsd` | number | USD | V4 内部，不在 API 中 |

#### 5. 状态/标志

| 字段 | 类型 | 备注 |
|---|---|---|
| `supplyDisabled`、`borrowDisabled`、`isFrozen`、`isPaused` | boolean | |

#### 6. V4 Hub & Spoke 标识

| 字段 | 类型 | 备注 |
|---|---|---|
| `hubId`、`hubName`、`spokeId`、`spokeName` | string? | V4 only |
| `hubAddress`、`spokeAddress` | string? | EVM address |

#### 7. 时间/版本

| 字段 | 类型 | 单位 | 备注 |
|---|---|---|---|
| `snapshot.lastUpdated` | string | ISO-8601 | |
| `snapshot.staleTimeMs` | number | ms | |
| 各 incentive `startDate`/`endDate`、`campaignStartedAt`/`campaignEndedAt` | string | ISO-8601 | |
| Merkl forecast `endTimestamp` | number | unix seconds | |
| Merkl forecast `requiredDaily`、`distributedSoFar` | number | reward token (campaign 自带单位) | |

### 删除/新增

- 删除：V4 `fetchHubAssetIndex()`、`hubs/hubAssets` 调用、`percentOnChainValueToRay()`、`assetTotalSupplied/Borrowed/SupplyCap/BorrowCap`。
- 新增（V3+V4 同步）：`reserveSize`、`supplyCap`、`borrowCap`、`totalVariableDebtUsd`、`availableLiquidityUsd`。
- **后续移除**：`suppliable`、`borrowable`、`suppliableUsd`、`borrowableUsd`（纯派生字段，2026-06 已移除，前端自行计算）。

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
| `baseVariableBorrowRate` | `r.asset.settings.baseBorrowRate.value` × 100 | 来自链上 RPC 或 fallback 计算（输出 number 百分比）|
| `reserveSize` | `r.summary.supplied.amount.onChainValue` | `reserve.size.amount.raw` |
| `reserveSizeUsd` | `r.summary.supplied.exchange.value` | `reserve.size.usd` |
| `totalVariableDebt` | `r.summary.borrowed.amount.onChainValue` | `reserve.borrowInfo.total.amount.raw` |
| `totalVariableDebtUsd` | `r.summary.borrowed.exchange.value` | `reserve.borrowInfo.total.usd` |
| `supplyCap` | `r.settings.supplyCap.amount.onChainValue` | `reserve.supplyInfo.supplyCap.amount.raw` |
| `supplyCapUsd` | `r.settings.supplyCap.exchange.value` | `reserve.supplyInfo.supplyCap.usd` |
| `borrowCap` | `r.settings.borrowCap.amount.onChainValue` | `reserve.borrowInfo.borrowCap.amount.raw` |
| `borrowCapUsd` | `r.settings.borrowCap.exchange.value` | `reserve.borrowInfo.borrowCap.usd` |

## 执行 commit 顺序

> **⚠️ 部署状态**：当前生产环境仍运行 `main` 分支（V3 输出 RAY string / bps string，V4 尚未集成）。`railway` 分支的精度统一变更**未合并到 `main`**，在生产 API 响应中 `optimalUsageRate` 等字段仍然是旧格式（`string` RAY/bps）。前端 `aaveapy/lovable` 分支已更新为消费新的 number 格式，需要后端 `railway → main` 合并部署后才能正确工作。

后端 (`aave-protocol-analysis/`)：

1. **commit 1** — V4 fetcher 删除 `fetchHubAssetIndex()`/`hubs`/`hubAssets`/`percentOnChainValueToRay`，全部从 `reserve.asset.summary/settings` 读；rate params 输出 `value × 100` 的 number；删除 `assetTotal*`。
2. **commit 2** — V3 `buildV3BaseDataset()` 把 5 个 rate params 输出从 RAY/bps string 改为 number 百分比（用 `.value × 100`）。
3. **commit 3** — V3+V4 同时新增 `reserveSize`、`supplyCap`、`borrowCap`、`suppliable`、`borrowable`、`suppliableUsd`、`borrowableUsd`、`totalVariableDebtUsd`、`availableLiquidityUsd`。`pruneReserveForRuntime`+`RuntimeReserveData`+`EXPECTED_RUNTIME_FIELDS`+`MarketWithSpread`+`marketsApiSerialize.ts` 全套类型同步。
   > ⚠️ **2026-05 已回滚**：`suppliable`/`borrowable`/`suppliableUsd`/`borrowableUsd` 在后续 cleanup 中移除（纯派生，前端计算）。`FormattedReserveData` 已合并入 `RuntimeReserveData`，`pruneReserveForRuntime` 已删除。
4. **commit 4** — 后端 on-chain ingestion + `calculateBaseRateFallback` 改为 number 百分比（消除 RAY 字符串内部传递）。

前端 (`aaveapy/lovable`)：

5. **commit 5** — `ReserveWithSpread` 把 5 个 rate 字段从 `string` 改 `number`；新增 11 个字段；`apiSchemas.ts` zod 同步并显式列出所有 cap/rate/hub 字段（不再仅靠 `.passthrough()`）。
6. **commit 6** — 重写 `interestRateCalculator.ts`：去掉 `RAY/PERCENTAGE_FACTOR/rayMul/rayDiv/toBigInt/rayToPercent/rayPow` 等所有 BigInt RAY helper，改 Float 数学（Aave 两段斜率模型在 percent 空间直接计算，APY 用 `Math.pow` 复利）。
7. **commit 7** — `useRateSimulation.ts` 删 `RAY_SCALE`、`(raw/10000)*100`、`(raw/RAY)*100`，rate 字段直接当 percent number 用。
8. **commit 8** — 测试 fixture（`interestRateCalculator.test.ts`、`useRateSimulation.test.ts`、`MobileReserveCard.test.tsx`）全部从 RAY/bps 字符串改成 percent number，跑 vitest 通过（482 passed）。

## 进度

后端 (aave-protocol-analysis, railway 分支) — 已完成：
1. V4 fetcher 重构 + V3 rate params 改 number + onchain fallback
2. 新增 9 个字段 + 服务端派生 suppliable/borrowable
3. **2026-05 cleanup** — 移除 suppliable/borrowable（纯派生），合并 FormattedReserveData → RuntimeReserveData，删除 pruneReserveForRuntime + prune helpers + prune-type-helper.ts，清理 V4 USD 中间死代码

前端 (aaveapy, lovable 分支) — 已完成（4 个 commit）：
1. `5e69a1b` feat(types): align ReserveWithSpread + zod schema with unified V3/V4 API（commit 5）
2. `1023dba` refactor(rate-calc): rewrite interestRateCalculator from BigInt RAY math to Float percent math（commit 6）
3. `731998b` refactor(simulation): drop RAY/bps conversion in computeMarketMetrics（commit 7）
4. `2f791b3` test: update fixtures to percent-number rate fields（commit 8）

- [x] commit 1 — V4 fetcher 重构（删除 hubAssets、rate params 改 number 百分比）✅
- [x] commit 2 — V3 rate params 改 number 百分比 ✅
- [x] commit 3 — V3+V4 新增字段 ✅（suppliable/borrowable 后续移除）
- [x] commit 4 — on-chain + fallback 改 number ✅
- [x] **2026-05 cleanup** — 移除派生字段 + 合并类型 + 删除 prune + 清理死代码 ✅
- [x] commit 5 — 前端类型/zod 调整 ✅
- [x] commit 6 — 前端利率计算器 Float 重写 ✅
- [x] commit 7 — 前端 `useRateSimulation` 去 RAY/bps 转换 ✅
- [x] commit 8 — 前端测试 fixture 更新 ✅

## 验证命令

```bash
# 后端
npm run build
npm --prefix backend run build
npm --prefix backend run test

# 前端
cd ../aaveapy
npx tsc --noEmit
npx vitest run   # 482 passed | 2 skipped
```

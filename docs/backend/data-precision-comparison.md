# Data Precision Comparison: Aave SDK vs On-chain RPC

## Data Sources

| Source | Method | Fields |
|--------|--------|--------|
| **Aave SDK** | `@aave/client` GraphQL API | Most market data (rates, caps, balances, etc.) |
| **On-chain RPC** | `UiPoolDataProvider.getReservesHumanized()` | `deficit`, `baseVariableBorrowRate` |

---

## 原 On-chain 数据精度 vs 现 Aave SDK 数据精度

以下字段以前从链上（UiPoolDataProvider / Pool 合约）读取，现在除 `deficit`、`baseVariableBorrowRate` 外均改为从 Aave SDK 获取。精度与单位是否一致见下表。

| 字段 | 原 On-chain 精度/单位 | 现 Aave SDK 精度/单位 | 是否对齐 |
|------|------------------------|------------------------|----------|
| `decimals` | `uint8`，整数 | `number`，整数 | ✅ 一致 |
| `availableLiquidity` | `uint256`，raw 代币单位（与 token decimals 一致） | `string`，raw 代币单位（GraphQL `amount.raw`） | ✅ 一致 |
| `totalVariableDebt` | 链上为 `totalScaledVariableDebt`（scaled）× `variableBorrowIndex`（RAY）算出实际值，raw | `string`，`borrowInfo.total.amount.raw`，已是实际债务 raw | ✅ 一致（SDK 直接给实际值） |
| `reserveFactor` | `uint256`，BPS（10000 = 100%） | `string`，BPS（如 `"2000"` = 20%，API 里 `decimals: 4`） | ✅ 一致 |
| `variableRateSlope1` | `uint256`，RAY（10²⁷） | `string`，RAY（如 `"90000000000000000000000000"` = 9%，API 里 `decimals: 27`） | ✅ 一致 |
| `variableRateSlope2` | `uint256`，RAY（10²⁷） | `string`，RAY，`decimals: 27` | ✅ 一致 |
| `optimalUsageRate` | `uint256`，RAY（10²⁷） | `string`，RAY，`decimals: 27` | ✅ 一致 |
| `baseVariableBorrowRate` | `uint256`，RAY（10²⁷），链上读 | 仍由 **On-chain RPC** 提供；缺失时用 **fallback 反推**（见下） | ✅ 未改来源，精度不变 |
| `deficit` | `uint256`，raw 代币单位，链上读 | 仍由 **On-chain RPC** 提供，`string` raw | ✅ 未改来源，精度不变 |

### baseVariableBorrowRate Fallback（RPC 缺失时）

当链上无法获取 `baseVariableBorrowRate` 时，用 SDK 参数反推：

- **输入**：SDK 的 `borrowApy`（APY %）、`utilizationPct`、`optimalUsageRate`、`variableRateSlope1`、`variableRateSlope2`。
- **APY → APR**：链上 ratePerSecond = rateRay/RAY / SECONDS_PER_YEAR，按秒复利 (1+ratePerSecond)^exp，故 1+APY = (1+APR/SECONDS_PER_YEAR)^SECONDS_PER_YEAR，即 **APR = SECONDS_PER_YEAR×((1+APY)^(1/SECONDS_PER_YEAR)−1)**，再转 RAY。
- **Util**：`utilizationPct` 即 borrow usage = `totalDebt / (availableLiquidity + totalDebt)`，**不含 deficit**，与链上 `borrowUsageRatio` 一致。
- **未使用**：计算中**不使用** reserve size；只用 utilization 与利率参数反推 base。
- **链上复利**：variableBorrowIndex 按秒复利，ratePerSecond = rate/RAY/SECONDS_PER_YEAR，一年后 (1+APR/SECONDS_PER_YEAR)^SECONDS_PER_YEAR = 1+APY，故需用上式做 APY→APR。

### 小结

- **数值含义与精度**：从 on-chain 切到 Aave SDK 的字段，单位与链上一致（RAW / BPS / RAY），可直接用于原有公式。
- **类型**：链上是 `uint256`，SDK 用 `string` 传 raw，避免 JS 大数精度问题，前端用 `BigInt` 计算即可。
- **仅剩两条仍走 on-chain**：`deficit`、`baseVariableBorrowRate`，精度与之前链上一致。

---

## 新旧 Rate-Inputs 参数对比

### ⚠️ 架构变更说明

| 旧架构 (Subgraph) | 新架构 (Aave SDK + RPC) |
|------------------|------------------------|
| 从 Subgraph 获取 `totalScaledVariableDebt` + `variableBorrowIndex` | 从 Aave SDK 直接获取 `totalVariableDebt` (已是实际值) |
| 需要手动计算: `actualDebt = scaledDebt * index / RAY` | 无需计算，SDK 已返回实际债务 |
| `baseVariableBorrowRate` 从 Subgraph 获取 | `baseVariableBorrowRate` 从 On-chain RPC 获取 |
| 单一数据源 | 两个数据源并行: SDK + RPC |

### 字段精度对比表

| 字段 | 旧来源 | 新来源 | 精度 | 单位 | 变化 |
|------|--------|--------|------|------|------|
| `decimals` | Subgraph | Aave SDK | Number | Integer | ✅ 相同 |
| `availableLiquidity` | Subgraph | Aave SDK | String | Raw token units | ✅ 相同 |
| `totalScaledVariableDebt` | Subgraph | **已移除** | - | - | ❌ 移除 |
| `variableBorrowIndex` | Subgraph | **已移除** | - | - | ❌ 移除 |
| `totalVariableDebt` | **新增** | Aave SDK | String | Raw token units | ✅ 新增 (无需手动计算) |
| `reserveFactor` | Subgraph | Aave SDK | String | BPS (e.g., "2000" = 20%) | ✅ 相同 |
| `variableRateSlope1` | Subgraph | Aave SDK | String | RAY (27 decimals) | ✅ 相同 |
| `variableRateSlope2` | Subgraph | Aave SDK | String | RAY (27 decimals) | ✅ 相同 |
| `optimalUsageRate` | Subgraph | Aave SDK | String | RAY (27 decimals) | ✅ 相同 |
| `baseVariableBorrowRate` | Subgraph | On-chain RPC | String | RAY (27 decimals) | ⚠️ 来源变更 |
| `deficit` | On-chain RPC | On-chain RPC | String | Raw token units | ✅ 相同 |

### 精度验证示例

```
// 旧数据 (Subgraph)
reserveFactor: "2000"           // BPS → 20%
variableRateSlope1: "90000000000000000000000000"  // RAY → 9%
totalScaledVariableDebt: "117696480695582200739041"
variableBorrowIndex: "1000000000000000000000000000"  // RAY

// 新数据 (Aave SDK + RPC)
reserveFactor: "2000"           // BPS → 20% ✅ 相同
variableRateSlope1: "90000000000000000000000000"  // RAY → 9% ✅ 相同
totalVariableDebt: "117696978016261246212959"     // 实际值，无需计算
baseVariableBorrowRate: "0"     // RAY → 0% (从 RPC 获取)
deficit: "0"                    // Raw token units (从 RPC 获取)
```

### 前端兼容性

| 场景 | 影响 | 处理建议 |
|------|------|----------|
| 使用 `totalScaledVariableDebt` | ❌ 字段已移除 | 改用 `totalVariableDebt` |
| 使用 `variableBorrowIndex` | ❌ 字段已移除 | 不再需要 |
| 计算实际债务 | ✅ 简化 | 直接使用 `totalVariableDebt` |
| `baseVariableBorrowRate` 缺失 | ⚠️ 可能缺失 | 后端用 APY→APR 反推 fallback；前端可沿用 "0" 或 API 提供的 fallback |

---

## Field Precision Comparison

### Fields from Aave SDK (`/api/markets`)

| Field | Precision | Unit | Notes |
|-------|-----------|------|-------|
| `supplyApy` | Float | Percent (5.2 = 5.2%) | Already converted to percent |
| `borrowApy` | Float | Percent (3.5 = 3.5%) | Already converted to percent |
| `tokenPrice` | Float | USD | Already converted |
| `supplyCapUsd` | Float | USD | Already converted |
| `borrowCapUsd` | Float | USD | Already converted |
| `reserveSizeUsd` | Float | USD | Already converted |
| `utilizationPct` | Float | Percent (75.5 = 75.5%) | Already converted to percent |
| `decimals` | Number | Integer | Token decimals (6, 8, 18, etc.) |
| `availableLiquidity` | String | Raw token units | `BigInt` string |
| `totalVariableDebt` | String | Raw token units | Total borrowed (actual, not scaled) |
| `reserveFactor` | String | BPS (4 decimals) | "2000" = 20%, "1500" = 15% |
| `variableRateSlope1` | String | RAY (27 decimals) | Interest rate parameter |
| `variableRateSlope2` | String | RAY (27 decimals) | Interest rate parameter |
| `optimalUsageRate` | String | RAY (27 decimals) | "900000000000000000000000000" = 90% |

### Fields from On-chain RPC

| Field | Precision | Unit | Notes |
|-------|-----------|------|-------|
| `deficit` | String | Raw token units | Bad debt, same decimals as token |
| `baseVariableBorrowRate` | String | RAY (27 decimals) | Base rate before utilization curve |

## Precision Constants

| Name | Value | Usage |
|------|-------|-------|
| **RAY** | `10^27` | Interest rates, utilization ratios |
| **WAD** | `10^18` | Common ERC20 token amounts |
| **BPS** | `10^4` | Basis points (10000 = 100%) |

## Conversion Examples

```typescript
// RAY to decimal
const rayToDecimal = (ray: string) => BigInt(ray) / BigInt(10 ** 27);

// BPS to decimal
const bpsToDecimal = (bps: string) => Number(bps) / 10000;

// Raw token to human readable
const toHuman = (raw: string, decimals: number) => 
  Number(BigInt(raw)) / 10 ** decimals;
```

## Why Different Precisions?

| Source | Design Reason |
|--------|---------------|
| **SDK floats** | Pre-computed for display, avoids frontend BigInt handling |
| **SDK strings** | Raw values for precise calculations, preserve full precision |
| **RPC strings** | Direct from smart contracts, always full precision |

## Consistency Notes

- `deficit` and `baseVariableBorrowRate` use same precision as other RAY/token values
- Both sources return strings for large numbers to avoid JavaScript float precision loss
- Frontend should use BigInt for calculations, convert to float only for display

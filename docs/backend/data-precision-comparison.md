# Data Precision Comparison: Aave SDK vs On-chain RPC

## Data Sources

| Source | Method | Fields | Version |
|--------|--------|--------|---------|
| **V3 SDK** | `@aave/client` GraphQL API | Most market data (rates, caps, balances, etc.) | V3 only |
| **V4 SDK** | `@aave/client` GraphQL API + HubAsset settings | Most market data + `baseVariableBorrowRate` from HubAsset | V4 only |
| **On-chain RPC** | `UiPoolDataProvider.getReservesHumanized()` | `deficit`, `baseVariableBorrowRate` | V3 only |

### Data Merge Priority (on-chain merge in `refreshMarketsSnapshot`)

For each field, the priority chain is: **SDK value > on-chain RPC > fallback/default**.

| Field | V3 reserve | V4 reserve |
|-------|-----------|-----------|
| `deficit` | absent in SDK → RPC → default `'0'` | absent in SDK → RPC (never covers V4) → default `'0'` |
| `baseVariableBorrowRate` | absent in SDK → RPC → fallback calculation | **provided by SDK** (HubAsset settings) → kept |

SDK data is fetched every 1 minute (cron at second :00) and replaces the entire payload.
On-chain RPC has its own cron (second :10) with 30-min per-pool TTL.
Since SDK is the freshest source, it takes highest priority.

### On-chain RPC Coverage

On-chain RPC **only covers V3 pools**. It iterates `AaveAddressBook` entries filtered by `key.startsWith('AaveV3')` (see `onchainDataService.ts:buildPoolConfigs()`). V4 reserves are never queried via RPC.

### V4 HubAsset Multi-Hub Index

V4 uses a Hub & Spoke model. Multiple hubs can exist on the same chain (e.g., Core, Plus, Prime on Ethereum).
HubAsset index key is `chainId:tokenAddress:hubId` to prevent data collision when the same token exists in different hubs.

### V4 Rate Parameter Unit Conversion

V4 SDK's `PercentNumber` type uses `decimals=4` for IR model params (slopes, optimal, baseBorrowRate).
V3 uses RAY (`decimals=27`) for the same fields.
`percentOnChainValueToRay()` in `v4-fetcher.ts` converts V4 4-decimal `onChainValue` to RAY by padding with zeros, ensuring API returns consistent RAY format for both V3 and V4.

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
| `baseVariableBorrowRate` | `uint256`，RAY（10²⁷），链上读 | V3: On-chain RPC / fallback；V4: **SDK HubAsset settings**（RAY，经 `percentOnChainValueToRay` 转换） | ✅ 精度一致 |
| `deficit` | `uint256`，raw 代币单位，链上读 | V3: On-chain RPC；V4: 默认 `'0'`（SDK 不提供，RPC 不覆盖 V4） | ✅ 精度一致 |

### baseVariableBorrowRate Fallback（SDK 和 RPC 均缺失时）

当 SDK 和 on-chain RPC 都无法获取 `baseVariableBorrowRate` 时，用 fallback 反推：

- **输入**：SDK 的 `borrowApy`（APY %）、`utilizationPct`、`optimalUsageRate`、`variableRateSlope1`、`variableRateSlope2`。
- **APY → APR**：链上 ratePerSecond = rateRay/RAY / SECONDS_PER_YEAR，按秒复利 (1+ratePerSecond)^exp，故 1+APY = (1+APR/SECONDS_PER_YEAR)^SECONDS_PER_YEAR，即 **APR = SECONDS_PER_YEAR×((1+APY)^(1/SECONDS_PER_YEAR)−1)**，再转 RAY。
- **Util**：`utilizationPct` 即 borrow usage = `totalDebt / (availableLiquidity + totalDebt)`，**不含 deficit**，与链上 `borrowUsageRatio` 一致。
- **未使用**：计算中**不使用** reserve size；只用 utilization 与利率参数反推 base。
- **链上复利**：variableBorrowIndex 按秒复利，ratePerSecond = rate/RAY/SECONDS_PER_YEAR，一年后 (1+APR/SECONDS_PER_YEAR)^SECONDS_PER_YEAR = 1+APY，故需用上式做 APY→APR。

### 小结

- **数值含义与精度**：从 on-chain 切到 Aave SDK 的字段，单位与链上一致（RAW / BPS / RAY），可直接用于原有公式。
- **类型**：链上是 `uint256`，SDK 用 `string` 传 raw，避免 JS 大数精度问题，前端用 `BigInt` 计算即可。
- **V3 仅 `deficit` 仍走 on-chain RPC**；`baseVariableBorrowRate` 优先 RPC，fallback 兜底。
- **V4 `baseVariableBorrowRate` 由 SDK 直接提供**（HubAsset settings），`deficit` 默认 `'0'`。

---

## 已移除字段与前端兼容性

以下字段已从 API 移除（原 Subgraph 来源），前端需适配：

| 场景 | 影响 | 处理建议 |
|------|------|----------|
| 使用 `totalScaledVariableDebt` | ❌ 字段已移除 | 改用 `totalVariableDebt`（SDK 直接返回实际值，无需 `× variableBorrowIndex / RAY`） |
| 使用 `variableBorrowIndex` | ❌ 字段已移除 | 不再需要 |
| 计算实际债务 | ✅ 简化 | 直接使用 `totalVariableDebt` |
| `baseVariableBorrowRate` 缺失 | ⚠️ 可能缺失 | V3: 后端用 APY→APR 反推 fallback；V4: SDK 直接提供（HubAsset settings） |

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
- V4 rate params (slopes, optimal, baseBorrowRate) are converted from 4-decimal to RAY via `percentOnChainValueToRay()` to match V3 format
- On-chain RPC data is not persisted to disk — only in-memory `poolCache` with 30-min TTL, lost on process restart

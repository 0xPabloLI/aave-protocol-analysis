# Data Precision Comparison: Aave SDK vs On-chain RPC

## Data Sources

| Source | Method | Fields |
|--------|--------|--------|
| **Aave SDK** | `@aave/client` GraphQL API | Most market data (rates, caps, balances, etc.) |
| **On-chain RPC** | `UiPoolDataProvider.getReservesHumanized()` | `deficit`, `baseVariableBorrowRate` |

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
| `totalVariableDebt` | String | Raw token units | Total borrowed, `BigInt` string |
| `reserveFactor` | String | RAY (27 decimals) | `200000000000000000000000000` = 20% |
| `variableRateSlope1` | String | RAY (27 decimals) | Interest rate parameter |
| `variableRateSlope2` | String | RAY (27 decimals) | Interest rate parameter |
| `optimalUsageRate` | String | RAY (27 decimals) | `900000000000000000000000000` = 90% |

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

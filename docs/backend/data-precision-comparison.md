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
| `supplyApy` | Float | Decimal (0.05 = 5%) | Already converted |
| `borrowApy` | Float | Decimal (0.03 = 3%) | Already converted |
| `tokenPrice` | Float | USD | Already converted |
| `supplyCapUsd` | Float | USD | Already converted |
| `borrowCapUsd` | Float | USD | Already converted |
| `reserveSizeUsd` | Float | USD | Already converted |
| `availableLiquidity` | String | Raw token units | `BigInt` string |
| `reserveFactor` | String | BPS (4 decimals) | `2000` = 20% |
| `variableRateSlope1` | String | RAY (27 decimals) | Interest rate parameter |
| `variableRateSlope2` | String | RAY (27 decimals) | Interest rate parameter |
| `optimalUsageRate` | String | RAY (27 decimals) | `920000000000000000000000000` = 92% |

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

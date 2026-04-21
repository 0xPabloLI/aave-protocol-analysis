# V4 SDK Embedded Rewards (Intentionally Skipped)

> **Status**: Deliberately excluded from API output as of 2026-04-21.
> These rewards are not shown on Aave Pro UI and do not exist in the public Merkl API.

## Background

The Aave V4 SDK returns `summary.rewards[]` on each reserve, containing
`MerklSupplyReward` and `MerklBorrowReward` entries. These are the **only**
two reward `__typename` values observed.

All observed rewards pay out a token called **`aglaMerklUSD`**
(`0x3E0ae4c19C3bDfc9EeD5a2898d3a57c6f61e847a` on Ethereum). This token:

- Does **not** exist in the public Merkl API (`api.merkl.xyz`).
- Is **not** shown as APY on the Aave Pro UI.
- Appears to be an internal Aave points/rewards mechanism.

The SDK also broadcasts each hub-level reward to **every spoke** reserve for
that asset, regardless of whether supply/borrow is enabled on that spoke.

## Why We Skip Them

1. **Not verifiable** — the reward IDs and payout token are absent from Merkl's
   public API, so we cannot confirm they represent real yield.
2. **Misleading** — attaching a 20% "supply incentive" to a spoke where
   `canSupply=false` would confuse downstream consumers.
3. **Duplicate risk** — real Merkl incentives are already fetched separately
   via our Merkl API integration and attached to reserves downstream.

## Snapshot of Observed Rewards (2026-04-21)

### Reward Campaigns

| Reward ID | Type | APY Field | Value | Payout Token | Period |
|-----------|------|-----------|-------|-------------|--------|
| `51d8199b-a594-48f5-836f-af9a8cd40c1a` | MerklSupplyReward | extraApy | 20% | aglaMerklUSD | 2026-04-08 → 2026-04-22 |
| `5f3172df-27de-44fa-98b7-271bf814f6e9` | MerklSupplyReward | extraApy | 20% | aglaMerklUSD | 2026-04-08 → 2026-04-22 |
| `bff7da8e-c57a-4a58-abbf-55b6890ec282` | MerklBorrowReward | discountApy | 5% | aglaMerklUSD | 2026-04-08 → 2026-04-22 |
| `0014f210-5774-4b40-8e23-aedba1dd1c3a` | MerklBorrowReward | discountApy | 4% | aglaMerklUSD | 2026-04-08 → 2026-04-22 |

### Affected Reserves

| Spoke | Token | Token Address | Chain | Reward ID | canSupply | canBorrow |
|-------|-------|--------------|-------|-----------|-----------|-----------|
| Main | frxUSD | `0xCAcd6fd266aF91b8AeD52aCCc382b4e165586E29` | 1 | `51d8199b…` | ✅ | ✅ |
| Bluechip | frxUSD | `0xCAcd6fd266aF91b8AeD52aCCc382b4e165586E29` | 1 | `51d8199b…` | ❌ | ✅ |
| Forex | frxUSD | `0xCAcd6fd266aF91b8AeD52aCCc382b4e165586E29` | 1 | `51d8199b…` | ❌ | ✅ |
| Ethena Ecosystem | frxUSD | `0xCAcd6fd266aF91b8AeD52aCCc382b4e165586E29` | 1 | `51d8199b…` | ❌ | ✅ |
| Gold | frxUSD | `0xCAcd6fd266aF91b8AeD52aCCc382b4e165586E29` | 1 | `51d8199b…` | ❌ | ✅ |
| Main | USDG | `0xe343167631d89B6Ffc58B88d6b7fB0228795491D` | 1 | `5f3172df…` | ✅ | ✅ |
| Gold | USDG | `0xe343167631d89B6Ffc58B88d6b7fB0228795491D` | 1 | `5f3172df…` | ❌ | ✅ |
| Forex | USDG | `0xe343167631d89B6Ffc58B88d6b7fB0228795491D` | 1 | `5f3172df…` | ❌ | ✅ |
| Kelp | WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | 1 | `bff7da8e…` | ❌ | ❌ |
| Etherfi | WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | 1 | `0014f210…` | ❌ | ✅ |

## Re-enabling in the Future

If Aave starts surfacing these rewards on the Pro UI or they appear in the
public Merkl API, re-enable extraction in `src/v4-fetcher.ts`:

1. The data lives at `r.summary.rewards[]` per reserve.
2. `MerklSupplyReward.extraApy` → supply incentive.
3. `MerklBorrowReward.discountApy` → borrow incentive.
4. `.normalized` is percentage (e.g. `20` = 20%), `.value` is ratio (`0.2`).
   Our pipeline expects **ratio** (serializer does `× 100`), so use `.value`.
5. Only attach to reserves where the corresponding action is enabled
   (`canSupply` / `canBorrow`), since the SDK broadcasts hub-level rewards
   to all spoke reserves indiscriminately.

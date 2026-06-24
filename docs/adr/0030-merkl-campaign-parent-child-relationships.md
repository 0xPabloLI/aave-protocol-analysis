# ADR-0030: Merkl Campaign Parent-Child Relationships

**Status**: Implemented (Mode 3 Hub/Spoke double-counting fix — REVISED to spoke-priority dedup via parentCampaignId)

**Date**: 2026-06-17

**Updated**: 2026-06-25

## Context

Merkl API raw response contains three distinct parent-child relationship mechanisms between campaigns. Our current code (`merkl-api.ts`) ignores all of them — it only reads `composedCampaigns` for whitelist detection. This ADR documents the discovered relationships for future investigation.

## Three Relationship Modes

### Mode 1: Tree Hierarchy (`childCampaignIds` / `parentCampaignId`)

- **Fields**: `campaign.childCampaignIds: string[]`, `campaign.parentCampaignId: string?`
- **No `composedCampaigns`** or `composedCampaignsCompute`
- **No calculation logic** — pure organizational hierarchy

**Real example: AAVE_NET_LENDING → ERC20_MAPPING**

```
Parent: Lend USDT0 on Aave (Plasma, LEND)
  opp identifier: e12ee247f6a60e33
  campaign type: AAVE_NET_LENDING, db_id=458186480653073816
  campaignId (onchain): 0xc94928ceed12e219a136ab83a4a1f73d2b1b4666bf624d098c2923f3e7d00b77
  APR: 1.10%, dailyRewards: 22,393.55
  childCampaignIds: ['6141126382587810800', '12026821536277147285', '15179192293818750702']
  URL: https://app.merkl.xyz/opportunities/plasma/AAVE_NET_LENDING/e12ee247f6a60e33

Child: Hold Wrapped Aave Plasma USDT0 on Plasma (HOLD)
  opp identifier: 0xE0126F0c4451B2B917064A93040fd4770D6774b5
  campaign type: ERC20_MAPPING, db_id=6141126382587810800
  campaignId (onchain): 17747604261679968921
  APR: 1.10%, dailyRewards: similar
  parentCampaignId: 458186480653073816
  childCampaignIds: ['13518078112566002547', '883636067465741107'] (further children)
  URL: https://app.merkl.xyz/opportunities/plasma/ERC20_MAPPING/0xE0126F0c4451B2B917064A93040fd4770D6774b5
```

**Tree structure**: AAVE_NET_LENDING → ERC20_MAPPING → [leaf campaigns not in our data]

**Distribution method**: Both parent and child use `AAVE_NET_APR` / `MAX_APR` or `DUTCH_AUCTION` — no composed calculation.

### Mode 2: Composed Calculation (`composedCampaigns` + `composedCampaignsCompute`)

- **Fields**: `campaign.params.composedCampaigns`, `campaign.params.composedCampaignsCompute`
- **Has calculation logic** — determines how sub-campaign APRs combine
- **`composedCampaignsCompute` values observed**: `min(1,2)`, `1-2`
- **Sub-campaign fields**: `composedIndex` (matches compute expression number), `composedType` (MAIN/DEFAULT), `campaignType` (60=FORWARDER, 61=LENDER), `mainParameter` (onchain contract address), `composedMultiplier` (Dutch auction decay multiplier)

**Real example A: `min(1,2)` — sUSDe/USDe looping**

```
Opp: Lend sUSDe and USDe on Aave (looping required)
  Chain: Plasma | Action: LEND | TVL: 155,634,300
  Campaign type: MULTILOG_DUTCH
  APR: 3.28% | rewardToken: aPlaUSDe
  compute: min(1,2)
  distributionMethod: MAX_APR
  Sub[1]: composedType=DEFAULT, campaignType=60, multiplier=1.196x
  Sub[2]: composedType=MAIN, campaignType=60, multiplier=1.0x
  Final APR = min(sub1_APR, sub2_APR)
  URL: https://app.merkl.xyz/opportunities/plasma/MULTILOG_DUTCH/0x2E8f1FA9c73F9d975B46BDFe40C92b6dDEFA3f31BORROW_BL
```

**Real example B: `1-2` — Borrow USDT0**

```
Opp: Borrow USDT0 from Aave on Plasma
  Chain: Plasma | Action: BORROW | TVL: 643,179,935
  Campaign type: MULTILOG_DUTCH
  APR: 0.60% | rewardToken: USDT0
  compute: 1-2
  distributionMethod: DUTCH_AUCTION
  Sub[1]: composedType=MAIN, campaignType=61 (LENDER), multiplier=1.0x
  Sub[2]: composedType=DEFAULT, campaignType=60 (FORWARDER), multiplier=1.0x
  Final APR = sub1_APR - sub2_APR (net borrow incentive)
  URL: https://app.merkl.xyz/opportunities/plasma/MULTILOG_DUTCH/0xF5F05bc52587C14C51a0E04e73c0d91a3ef1924d
```

**Real example C: `min(1,2)` with non-1.0x multiplier — cbETH borrow on Base**

```
Opp: Borrow ETH using cbETH as collateral on Aave
  Chain: Base | Action: BORROW
  Campaign type: MULTILOG_DUTCH
  APR: 1.11% | rewardToken: aBascbETH
  compute: min(1,2)
  Sub[1]: composedType=MAIN, campaignType=60, multiplier=0.823x
  Sub[2]: composedType=DEFAULT, campaignType=61, multiplier=1.0x
```

### Mode 3: V4 Hub-Spoke

- **Fields**: Same `childCampaignIds` / `parentCampaignId` as Mode 1
- **Key difference**: Hub uses `AAVE_V4_NET_APR` distribution, Spoke uses `DUTCH_AUCTION`
- **Hub has `targetAPR`** — caps dailyRewards at `TVL × targetAPR / 365`
- **Spoke has `hubAddress`**, `spokeAddress`, `hubAssetId`, `reserveId` in params
- **Hub `amount` = total budget**, **Spoke `amount` = budget allocated to that spoke**
- **Hub dailyRewards ≈ sum of all Spoke dailyRewards**

**Real example: USDG V4**

```
Hub (PARENT): Supply USDG to the Aave V4 Core Hub
  opp identifier: 0x44E12914eBFB4e4b5bcB4afb359eCca7D51e5E8a
  campaign type: AAVE_V4_HUB_SUPPLY, db_id=8647796357084493685
  onchain: 0xbfe68f7d938f096f519adeb1dbc3e2532b36bda09624f2fac2c5a7270a769c1e
  APR: 7.70% (targetAPR=7.7%, mode=MAX_APR)
  dailyRewards: 4,429.42 USDG/day (capped by TVL × 7.7% / 365)
  amount: 44,423.50 USDG (total budget for 7 days, but capped)
  TVL: 20,996,602.63 | duration: 7 days
  distributionMethod: AAVE_V4_NET_APR
  childCampaignIds: ['6915016562795329213', '6082047287558845423']
  hubAddress: 0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9
  URL: https://app.merkl.xyz/opportunities/ethereum/AAVE_V4_HUB_SUPPLY/0x44E12914eBFB4e4b5bcB4afb359eCca7D51e5E8a

Spoke #1 (CHILD): Supply USDG to the Aave V4 Main Spoke
  opp identifier: 0xD8f06A54813A9549B88dB72798343376A89Eeb37
  campaign type: AAVE_V4_SPOKE_SUPPLY, db_id=6915016562795329213
  onchain: 12893990290143601795
  APR: 7.24%
  dailyRewards: 4,167.57 USDG/day
  amount: 29,110.84 USDG (allocated budget)
  TVL: 20,996,502.66 (nearly same as Hub — same liquidity viewed from spoke side)
  distributionMethod: DUTCH_AUCTION
  parentCampaignId: 8647796357084493685
  spokeAddress: 0x94e7A5dCbE816e498b89aB752661904E2F56c485
  hubAddress: 0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9
  hubAssetId: 8 | reserveId: 11
  URL: https://app.merkl.xyz/opportunities/ethereum/AAVE_V4_SPOKE_SUPPLY/0xD8f06A54813A9549B88dB72798343376A89Eeb37

Spoke #2 (CHILD, ERC20LOGPROCESSOR — not AAVE_V4_SPOKE_SUPPLY!):
  db_id: 6082047287558845423
  onchain: 2111570902941775713
  type: ERC20LOGPROCESSOR (rewards holders of waCoreUSDG wrapped token)
  targetToken: 0xAC2435E3C25e8246870D33ce0a26988A46d5DB68 (waCoreUSDG)
  amount: 3.10 USDG (negligible)
  dailyRewards: 0.44 USDG/day (expired, campaign ended)
  APR: 0% (expired)
  duration: 4.53 days (shorter than Hub's 7 days)
  distributionMethod: DUTCH_AUCTION
  parentCampaignId: 8647796357084493685
  rootCampaignId: 8647796357084493685
  opportunityId: 9865292940757316896
  URL: https://app.merkl.xyz/opportunities/ethereum/ERC20LOGPROCESSOR/0xAC2435E3C25e8246870D33ce0a26988A46d5DB68/campaigns/2111570902941775713
```

**Hub children are NOT both SPOKE_SUPPLY — one is ERC20LOGPROCESSOR:**
- Child #1: `AAVE_V4_SPOKE_SUPPLY` (4,167.57 USDG/day) — spoke pool depositors
- Child #2: `ERC20LOGPROCESSOR` (0.44 USDG/day) — waCoreUSDG token holders

**Hub dailyRewards capping calculation (CORRECTED):**

`targetAPR` is a **total APR target** (native + incentive), NOT just the incentive target. The incentive budget is `targetAPR - nativeAPR`.

```
Hub incentive dailyRewards = min(budget/duration, TVL × (targetAPR - nativeAPR) / 365)
```

Evidence from USDm (chain 4326, AAVE_NET_LENDING):
```
targetAPR = 4.5%, nativeAPR = 1.83%, incentiveAPR = 2.67%
dailyRewards = TVL × 2.67% / 365 = 41,343.30 ✓ (matches actual)
```

For USDG, nativeAPR ≈ 0% (new asset, low utilization), so incentiveAPR ≈ targetAPR:
```
Hub incentive dailyRewards = min(6,346.21, 20,996,602.63 × (7.7% - 0%) / 365) = 4,429.42 ← capped
```

**Hub dailyRewards vs sum of children:**
```
Hub dailyRewards:        4,429.42 USDG/day
Spoke1 dailyRewards:     4,167.57 USDG/day
ERC20LOGPROCESSOR daily: 0.44 USDG/day
Sum of children:         4,168.01 USDG/day
Diff (= Hub self-distribution): 261.41 USDG/day
```

Hub also distributes directly to users who interact with the Hub opportunity (not just through children).

## Open Questions (Resolved)

### Hub/Spoke Distribution Method Mismatch — RESOLVED

Hub uses `AAVE_V4_NET_APR` (target APR capping), Spoke uses `DUTCH_AUCTION` (decay). The constraint chain is:

```
targetAPR - nativeAPR → Hub incentive budget cap → budget allocated to Spoke → Dutch auction distribution
```

Spoke's Dutch auction is **indirectly** constrained by targetAPR via budget allocation, but **not directly**. Early in a campaign (low TVL), Dutch auction APR can exceed Hub targetAPR. As TVL grows, Dutch auction decays and Spoke APR converges toward ≤ Hub targetAPR.

The `nativeAPR` component is dynamic (changes with Aave utilization), so the Hub's daily incentive budget also changes daily:
- nativeAPR rises → incentive budget falls → less for Spokes
- nativeAPR falls → incentive budget rises → more for Spokes

### "Parent and child rewards are not cumulative" — RESOLVED

Merkl app displays:
- On child opp: "Liquidity supplied here earns rewards from a parent opportunity"
- On parent opp: "Supplying to a child opportunity may earn you higher rewards than supplying to the parent"

**Meaning**: You interact with ONE opportunity (Hub or Spoke), not both. Spoke rewards come FROM Hub's budget allocation. "Child may earn higher" refers to Dutch auction's early phase where Spoke APR can temporarily exceed Hub's targetAPR (before TVL grows enough to decay the auction). This is a transient state — as TVL grows, Spoke APR decays below Hub targetAPR.

### Hub `amount` Field Interpretation — RESOLVED

Hub `amount` = total reward budget for campaign duration (max possible distribution). Actual distribution is capped by `targetAPR - nativeAPR`:
- Hub amount: 44,423.50 USDG / 7 days = 6,346.21/day (max possible)
- Actual: 4,429.42/day (capped by `TVL × (targetAPR - nativeAPR) / 365`)
- Undistributed budget remains in campaign

Spoke `amount` = budget allocated to that specific spoke. Spoke1 amount: 29,110.84 USDG.

Hub amount ≠ Spoke1 amount + Spoke2 amount. The diff (15,309 USDG) is: (a) budget reserved for Hub's own direct distribution, and (b) budget that won't be distributed because targetAPR cap prevents it.

## Deep-Dive: Merkl Engine Architecture (from Official Sources)

### Source Code Findings

1. **`AngleProtocol/merkl-contracts`** (链上合约):
   - `DistributionCreator.sol` — 创建 campaign、收钱、存储参数
   - `Distributor.sol` — Merkle tree 验证 + claim 分发
   - `CampaignParameters.sol` — campaign 数据结构：`campaignId`, `creator`, `rewardToken`, `amount`, `campaignType`, `startTimestamp`, `duration`, `campaignData` (bytes, 编码方式取决于 campaignType)
   - **关键发现：计算引擎完全是链下的**。链上合约只管收钱和发钱，不参与 APR 计算

2. **`AngleProtocol/merkl-docs`** (官方文档):
   - `technical-overview.md` — Merkl engine 每 ~2 小时计算一次，每 ~8 小时推送一次 Merkle root
   - `distributions.md` — 三种分发类型：Variable / Fixed / Capped reward rate
   - `reward-forwarding.md` — **核心文档**，解释了 Hub/Spoke 的 forwarder 机制
   - `lending-borrowing.md` — 支持 net lending（防 loop）
   - `encompassing.md` — 外部 API 提供奖励数据的 campaign 类型

3. **`AaveChan/aave-incentives-api`** (Aave 官方 incentives API):
   - `Campaign` 类型已包含 `parentCampaignId`, `childCampaignIds`, `rootCampaignId`
   - `DistributionMethod` 枚举：`MAX_APR`, `DUTCH_AUCTION`
   - 仅用于 whitelist 检测，同样未处理 composed 计算

### Hub/Spoke Distribution Mechanism — RESOLVED (with caveats)

**Key insight from `reward-forwarding.md`**: Merkl has a **forwarder** mechanism. When a smart contract (like a Spoke pool) holds incentivized assets on behalf of users, Merkl automatically creates **subcampaigns** (linked opportunities) and forwards rewards to the end users.

**Hub/Spoke flow (verified with USDG V4 data)**:
1. Creator creates Hub campaign on-chain via `DistributionCreator.sol`, deposits total budget (42,377.66 USDG)
2. Merkl engine detects Spoke contract holding Hub aTokens → automatically creates Spoke subcampaign in its internal database (NOT on-chain)
3. Merkl engine allocates sub-budget from Hub's total budget to Spoke (33,168.59 USDG), leaving Hub self-retained budget (9,209.07 USDG)
4. Hub dailyRewards = `min(budget/duration, TVL × targetAPR / 365)` — computed against **all** Hub TVL (including Spoke contract's deposit)
5. Spoke dailyRewards = `spoke_amount / duration` — Dutch auction constant rate, independent of Hub's targetAPR cap
6. **Hub and Spoke are MERGED in the same Merkle tree** — a user's leaf = `keccak256(user, token, cumulativeAmount)`, where `cumulativeAmount` includes rewards from ALL campaigns (Hub + Spoke)
7. V4 users deposit through Spoke → their Merkle leaf includes rewards attributed to the Hub campaign (confirmed via Merkl API `/users/{addr}/rewards` breakdowns)
8. Hub self-retained budget (9,209.07 USDG) is for direct Hub depositors, but in practice nearly zero direct depositors exist (TVL_hub ≈ TVL_spoke)

**Evidence that Spoke is NOT an on-chain campaign**:
- Hub `onChainCampaignId` = `0x1e20...abc7` (bytes32 keccak256 hash — standard DistributionCreator output)
- Spoke `onChainCampaignId` = `10615816937644305100` (small integer, NOT a hash)
- This proves Spoke is a Merkl-engine-internal subcampaign, not created via `DistributionCreator.sol`

**Why Hub dailyRewards > Spoke dailyRewards**:
```
Hub dailyRewards = min(42,377.66/7, 26,540,445 × 0.0677 / 365) = 4,922.71 (targetAPR cap)
Spoke dailyRewards = 33,168.59 / 7 = 4,738.37 (constant rate)
Diff = 184.34 USDG/day
```
Hub dailyRewards is a **virtual cap value** — it represents the theoretical maximum if all TVL were claimed at the Hub level. But since nearly all TVL goes through Spoke, Hub's actual distribution to direct depositors is ~0.02 USDG/day.

**Why Spoke APR < Hub targetAPR**:
```
Spoke budget needed to reach targetAPR = TVL × targetAPR / 365 × 7 = 34,458.82 USDG
Spoke actual budget = 33,168.59 USDG
Deficit = 1,290.23 USDG
```
Merkl engine allocates less budget to Spoke than what's needed to reach targetAPR, because it reserves budget for Hub's direct depositors. This means Spoke depositors always get slightly less APR than Hub's targetAPR.

**No double-counting at Merkl engine level**: The engine constructs a single Merkle tree where each `(user, token)` leaf contains the cumulative reward from ALL campaigns. A user's leaf = `sum(breakdown amounts from all campaigns for that token)`. The Merkl API breakdowns attribute rewards to the originating campaign — for V4, all breakdowns point to Hub campaigns, confirming that Hub budget is the source of all V4 incentive rewards.

**But our API DOES double-count**: Both Hub and Spoke opportunities map to the same V4 reserve, and both contribute independently to the reserve's Merkl incentive APR. Since Hub dailyRewards already includes the Spoke-forwarded portion, showing both = ~2x the actual reward rate.

### Capped Reward Rate — Key to Understanding MAX_APR

From `distributions.md`:

> **Capped Reward Rate Campaigns**: Rewards are fully distributed across the entire campaign duration. APR adjusts according to TVL. APR cannot exceed the maximum set by the campaign creator.

This is exactly `AAVE_V4_NET_APR` / `MAX_APR`:
- `targetAPR` = the maximum APR cap
- Daily rewards = `min(budget/remaining_days, TVL × targetAPR / 365)`
- When `nativeAPR > 0`: effective incentive cap = `TVL × (targetAPR - nativeAPR) / 365`

### Variable Reward Rate — Key to Understanding DUTCH_AUCTION

From `distributions.md`:

> **Variable Reward Rate Campaigns**: A fixed amount of tokens is distributed per second, regardless of liquidity changes. Variable APR for participants: As more users join, rewards per user decrease.

This is `DUTCH_AUCTION`:
- Constant reward rate per second (= `budget / duration`)
- APR = `(daily_rewards / TVL) × 365 × 100`
- TVL↑ → APR↓, TVL↓ → APR↑ (inverse TVL relationship, NOT time decay)
- The "Dutch auction" name is misleading — it's actually a **constant-rate, variable-APR** model

## Open Questions (Unresolved)

### Composed Multiplier (Dutch Auction Decay)

19 sub-campaigns have non-1.0x `composedMultiplier`. All belong to `MULTILOG_DUTCH` campaigns:

| Opp | Chain | Compute | Sub Multipliers | APR |
|---|---|---|---|---|
| Lend sUSDe/USDe | Plasma | min(1,2) | 1.196x, 1.0x | 3.28% |
| Lend sUSDe/USDe | Ethereum | min(1,2) | 1.196x, 1.0x | 3.05% |
| Lend sUSDe/USDe | Mantle | min(1,2) | 1.196x, 1.0x | 3.50% |
| Borrow cbETH/ETH | Base | min(1,2) | 0.823x, 1.0x | 1.11% |

The multiplier scales the Dutch auction reward rate. It appears to be a **time-dependent decay parameter** (starting at `composedMultiplier` and decaying toward 1.0x), but the exact decay formula is unknown — the engine code is proprietary. Our current code does not use `composedMultiplier` at all.

**Interaction with `composedCampaignsCompute`**: Unknown whether multiplier is applied before or after the compute expression. Likely: `compute(multiplier × sub1_APR, sub2_APR)` but needs verification.

### Hub/Spoke Double-Counting Risk in Our API — CONFIRMED WITH CODE EVIDENCE

**Double-counting is real and currently active**. Verified through code trace:

1. **Hub** `explorerAddress` = USDG token address (`0xe343167631d89B6Ffc58B88d6b7fB0228795491D`) → stored in `merklData["1-0xe34316..."]`
2. **Spoke** `explorerAddress` = Spoke pool address (`0x94e7A5dCbE816e498b89aB752661904E2F56c485`) → stored in `merklData["1-0x94e7a5..."]`
3. **V4 reserve lookup** (`merkl-api.ts:1799-1801`) checks BOTH `tokenAddress` (= underlying = Hub key) AND `spokeAddress` (= Spoke key)
4. **`seenOpportunities`** uses object reference comparison — Hub and Spoke are different objects, NOT deduplicated
5. **Result**: USDG V4 Merkl incentive = Hub APR (7.70%) + Spoke APR (7.23%) = **14.93%** instead of the correct ~7.23%

**Code path**:
```
merkl-api.ts:1799-1801 → tokenAddressesToCheck = [tokenAddress, spokeAddress]
merkl-api.ts:1803-1815 → for each addr, lookup merklData[indexKey]
merkl-api.ts:1809-1812 → if (!seenOpportunities.has(opp)) → adds both Hub and Spoke
```

**Why Hub and Spoke use different explorerAddresses**:
- Hub `explorerAddress` = underlying token (USDG) — because Hub tracks deposits at the token level
- Spoke `explorerAddress` = Spoke pool contract — because Spoke tracks deposits at the pool level
- These are genuinely different addresses, so the Merkl index stores them under different keys

**Mitigation options**:
1. **Filter out `AAVE_V4_SPOKE_*` opportunities entirely** — simplest approach, Spoke is a subset of Hub
2. **Deduplicate by reserve + parent-child relationship** — when Hub and Spoke map to same reserve, prefer Hub
3. **Use only Hub opportunities for V4** — more targeted than option 1

**Recommended**: Option 1 (filter out `AAVE_V4_SPOKE_*`) because:
- Hub APR (6.77% = targetAPR) is the TRUE total incentive APR that users actually receive
- User reward breakdowns in Merkl API all attribute to Hub campaigns, not Spoke campaigns
- Hub dailyRewards = TVL × targetAPR / 365 includes both Hub-direct and Spoke-forwarded portions
- Spoke APR (6.46%) is only the Dutch Auction distribution rate — it understates actual rewards by ~0.31pp (≈nativeAPY delta)
- Spoke budget < Hub total budget because Merkl reserves ~21% for Hub-direct distribution
- **Evidence**: Creator address breakdowns show all 4 USDG rewards attributed to Hub campaigns (campaignId = hash format), not Spoke campaigns (campaignId = small integer format)

## Impact on Current Code

1. **Mode 1 (tree hierarchy)**: Ignored. May cause double-counting if both parent and child opps contribute to the same reserve's APR.
2. **Mode 2 (composed calculation)**: Only whitelist detection. `composedCampaignsCompute` and `composedMultiplier` are not processed. APR calculation may be incorrect for `min(1,2)` and `1-2` campaigns.
3. **Mode 3 (V4 Hub-Spoke)**: CONFIRMED double-counting risk. Both Hub and Spoke opps map to the same Aave reserve.

## Decision

Research phase complete. Key findings:

1. **Mode 1 (tree hierarchy)**: Organizational only, no calculation logic. Low priority — double-counting risk is theoretical since parent/child map to different reserves.
2. **Mode 2 (composed calculation)**: `composedCampaignsCompute` and `composedMultiplier` not processed. AAV-948 filed. Only 6 unique opportunities affected; 4 with non-1.0x multipliers.
3. **Mode 3 (V4 Hub-Spoke)**: CONFIRMED double-counting. **FIX IMPLEMENTED (REVISED)** — `AAVE_V4_SPOKE_*` opportunities are filtered out in `merkl-api.ts` opportunity processing loop.

### Implementation: Spoke-Priority Dedup via parentCampaignId (2026-06-25, REVISED from filter-Spoke)

**Previous approach (filter Spoke, keep Hub) replaced because**:
1. Hub `campaignType = TARGET_TOTAL_APR` → backend `scaleMerklBreakdown` converts targetAPR to incentiveAPR via `computeTargetTotalAprIncentiveApr(targetAPR, nativeAPY, side)`. This conversion depends on `reserve.supplyApy` (nativeAPY).
2. RPC fallback (SDK failure) does not provide `supplyApy` → conversion falls to `campaignApr × 100` = targetAPR (too high by nativeAPY).
3. Spoke `campaignType = DUTCH_AUCTION` → `scaleMerklBreakdown` directly passes through `campaignApr × 100` = incentiveAPR. No `supplyApy` dependency.

**New approach**: When Hub and Spoke are parent-child and match the same V4 reserve, keep Spoke (incentiveAPR) and remove the parent Hub breakdown. Independent Hub campaigns (non-parent) are preserved.

**Key API fact (verified 2026-06-25)**: `parentCampaignId` is a **top-level field** on the Merkl campaign API response (`GET /v4/campaigns/{id}`), not inside `params`:

```
Spoke campaign: parentCampaignId = "11526583104559356735" (top-level)
Hub campaign:   parentCampaignId = null, childCampaignIds = ["5055...", "13451..."]
```

**Code changes**:

1. `packages/aave-shared-contracts/src/index.ts` — `MerklCampaignBreakdown` added `parentCampaignId?: string`
2. `packages/aave-fetcher/src/merkl-api.ts` — `MerklCampaignDetails` added `parentCampaignId?: string`; `fetchMerklCampaignDetails` extracts `campaign.parentCampaignId` (top-level)
3. `packages/aave-fetcher/src/merkl-api.ts` — breakdown building populates `parentCampaignId` from `campaignDetails`
4. `packages/aave-fetcher/src/merkl-api.ts` — removed Spoke filter block (`isV4SpokeOpportunity` continue); Spoke opportunities now indexed normally
5. `packages/aave-fetcher/src/merkl-api.ts` — new `deduplicateHubSpokeBreakdowns()` function: collects Spoke `parentCampaignId`s, removes matching Hub breakdowns at the **breakdown level** (not opportunity level, to preserve independent Hub campaigns from other creators)
6. `packages/aave-fetcher/src/index.ts` — calls `deduplicateHubSpokeBreakdowns` on supply/borrow/hold groups after collecting matched opportunities
7. `backend/src/services/marketsApiSerialize.ts` — `scaleMerklBreakdown` strips `parentCampaignId` from API payload (internal dedup field)

**Why breakdown-level dedup (not opportunity-level)**:
A single Hub opportunity (explorerAddress = underlying token) can aggregate campaigns from multiple creators. Dropping the entire Hub opportunity would lose independent Hub campaigns. Breakdown-level dedup removes only the specific parent Hub breakdown, preserving independent campaigns.

**Hub-only reserves** (no LIVE Spoke): Hub is kept with `TARGET_TOTAL_APR` conversion (existing behavior). This is an acceptable fallback — only triggers when Spoke is not LIVE.

**Verified with live Merkl API data**:

| Asset | Hub APR (targetAPR) | Spoke APR (incentiveAPR) | Before (double) | After (Spoke-priority) |
|---|---|---|---|---|
| USDG | 6.77% | 6.48% | 13.25% | 6.48% |
| frxUSD | 5.36% | 4.87% | 10.23% | 4.87% |

**Forecast**: DUTCH_AUCTION is not in `needsAprCap` list → `aprCap = null`. Forecast uses Spoke's own parameters (totalBudget = Spoke budget, plannedDaily = budget/duration). No forecast code changes needed.

Issues filed:
- AAV-947: Parent-child relationship research (completed → this ADR)
- AAV-948: composedMultiplier correction (updated with 6-opportunity full data)
- AAV-959: Hub/Spoke double-counting fix (Done — filter-Spoke approach, superseded)
- AAV-1004: Spoke-priority dedup via parentCampaignId (this revision)

Open items:
- Composed multiplier decay formula still unknown (engine is proprietary)
- Need to verify if Merkl's returned `apr` at opportunity level already accounts for composed compute/multiplier

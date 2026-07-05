# Merkl HookType & ComputeScoreMethod Reference

> **Source**: Official Merkl API v4 schema endpoints.
> These are live, always-up-to-date endpoints — not static documentation.

## HookType

**Endpoint**: `https://api.merkl.xyz/v4/schemas/hookType`
**Explorer**: https://developers.merkl.xyz/resources/schemas

Official enum `HookType` (valueType: number). Describes eligibility filters, boosts, and other campaign customizations.

| value | key | description |
|---:|---|---|
| 0 | JUMPER | Only allow users who bridged liquidity from another chain prior to deposit to be eligible for rewards. |
| 1 | BOOST | Boost rewards for addresses holding a specific token. |
| 2 | ELIGIBILITY | Only allow users who have held a minimum amount of a token on a chain for a specified amount of time to be eligible for rewards. |
| 3 | BOOSTERC20 | Boost rewards for users holding a specific token or NFT. |
| 4 | **SANCTIONED** | **Exclude addresses flagged by the U.S. Office of Foreign Assets Control (OFAC) from receiving rewards.** |
| 5 | RAFFLE | Set rules to select lucky winners for the campaign rewards. |
| 6 | DISTRIBUTIONPERPERIOD | Modifies the distribution to be done by `<secondsPerPeriod>`. E.G if set to 86400 (1 day), the distribution will be done once every day. |
| 7 | APIBOOST | Apply a reward boost to addresses based on a score from an API. |
| 8 | VAULT | *(no description in schema)* |
| 9 | REFERRALPROGRAM | Set extra rewards for users who refer to your campaign and their invitees. |
| 10 | WORLDCHAINID | Only allow verified humans with a World ID to earn rewards. |
| 11 | STATICBOOST | Applies a multiplier on rewards for a list of user addresses. |
| 12 | MIN_BALANCE | Only allow users who held a minimum amount of a token at a specific point in time to be eligible for rewards. |
| 13 | EULER_SWAP | Boost rewards based on swap activity on EulerSwap. |
| 14 | **BORROW_BL** | **Exclude addresses that have borrowed from the specified lending protocol markets from rewards.** |
| 15 | SINGLE_BENEFICIARY_VESTING | Hook used to distribute rewards to a single beneficiary with vesting. |
| 16 | **COINBASE_ATTESTATION** | **Restrict rewards to addresses holding a valid Coinbase verification attestation.** |
| 17 | HEALTH_FACTOR | Blacklist users whose health factor is above a threshold. |
| 18 | **WHITELIST_CAMPAIGN** | **Provide one or more campaigns. Only addresses that are recipients of those campaigns are eligible for rewards.** |
| 19 | AAVE_COLLATERALIZED_BORROW | Hook used to adjust rewards based on borrowed amounts backed by specific collaterals on aave. |
| 20 | SELF_VERIFICATION | Restrict rewards to addresses verified according to the Self.xyz verification policy. |
| 21 | MAX_BALANCE | Only allow users who held less than a maximum amount of a token at a specific point in time to be eligible for rewards. |
| 22 | WHITELIST_ADDRESSES | Provide a list of addresses. Only leaves with reasons containing at least one of these addresses, or with a recipient matching one of these addresses, will be eligible for rewards. |
| 23 | WHITELIST_PER_PROTOCOL | Provide a list of protocols. The hook will fetch all node recipients for these protocols and whitelist leaves based on those addresses. |
| 24 | WHITELIST_STRINGS | Provide a list of strings. Only leaves with reasons containing at least one of these strings will be eligible for rewards. |
| 25 | WHITELIST_THRESHOLD_CAMPAIGN | Provide a token and a balance threshold. Only addresses whose balance of that token is above (or below) the threshold qualify for rewards. |
| 26 | WHITELIST_KEY_VALUE_STORE | Provide one or more named key-value stores. Only addresses present in at least one of them are eligible for rewards. |
| 27 | BLACKLIST_KEY_VALUE_STORE | Provide one or more named key-value stores. Addresses present in any of them are excluded from rewards. |
| 28 | BLACKLIST_PER_PROTOCOL | Provide a list of protocols. The hook will fetch all node recipients for these protocols and blacklist leaves matching those addresses. |
| 29 | REMAP_TO_SINGLE_RECIPIENT | Remaps all calculated rewards to a single recipient address. Rewards credited to the creator because the contract is not deployed yet are left untouched. |
| 30 | REFERRALPROGRAM_API | Set extra rewards for users who refer to your campaign and their invitees. Referral data is managed by the partner via API key. |

### Prior art corrections (from handoff doc `merkl-position-cap-handoff.md` §1)

The handoff doc originally inferred hookType meanings from field names alone, **without** official source. The official schema corrects 3 misidentifications:

| hookType | Handoff inference (wrong) | Official key (correct) |
|---|---|---|
| 4 | "Registry（链上注册表验证）" | **SANCTIONED** — OFAC sanctions filter |
| 16 | "Attestation（链上 attestation 验证，EAS）" | **COINBASE_ATTESTATION** — Coinbase verification, not generic EAS |
| 18 | "Protocol Position（跨链协议仓位验证）" | **WHITELIST_CAMPAIGN** — whitelist by campaign participation |

The handoff also missed ~17 hookTypes (0/1/3/5/6/8/11/12/13/15/17/19/21/23/24/25/26/28/29/30).

---

## ComputeScoreMethod

**Endpoint**: `https://api.merkl.xyz/v4/schemas/computeScoreMethod`

Official enum `ComputeScoreMethod` (valueType: string). Describes how individual contributions are turned into reward shares.

| key | description |
|---|---|
| genericTimeWeighted | Accumulates score as balance multiplied by time (integral over time) |
| cappedScoreHistorical | Limits total accumulated score across all campaign history |
| cappedScorePercentageHistorical | Limits score growth as a percentage of historical rewards earned |
| cappedScore | Limits the score to a maximum cap value per scoring period |
| genericScore | Uses current balance as score without time weighting |
| maxBalance | Tracks and rewards the maximum balance achieved during the campaign period |
| **maxDeposit** | **Caps the rewarded balance at a specified maximum deposit threshold** |
| indicator | Binary scoring method that returns 0 if computeValue is positive, and 1 otherwise |
| belowThreshold | Binary scoring method that returns 1 if computeValue is below threshold, and 0 otherwise |
| aboveThreshold | Binary scoring method that returns 1 if computeValue is above threshold, and 0 otherwise |
| logarithmic | Applies logarithmic scaling to balance to dampen whale advantage |
| slashingMaxBalance | Tracks max balance but slashes proportionally when balance decreases |
| clammTickDelta | Rewards concentrated liquidity positions based on tick range width constraints |
| clammActiveRange | Scores concentrated liquidity positions whose tick range overlaps a dynamic band around the pool's active tick |
| earlyBirdBoost | Applies time-decaying boost coefficient favoring earlier deposits |
| earlyBirdBoostSlashing | Combines early bird boost with slashing on withdrawals for sustained deposit incentives |
| personalizedBoostWindow | Grants temporary score multiplier window for new users upon their first deposit |
| newDepositsOnly | Rewards only balance increases above a snapshot taken at campaign start or specified time |
| attributionSuffix | Scores deposits tagged with ERC-8021 attribution codes matching a whitelist |
| jumperBridged | Returns the recipient's USD bridged via Li.Fi/Jumper since a given timestamp |
| exactlyBorrowRateSubsidize | Exactly-only: scores principal × clamp(borrow APR, minApr, maxApr) |
| votingPowerIntegral | Integrates voting power over time using polynomial VP coefficients for ERC721 escrow positions |
| locker | Per-slot value = balance × boost(lockTime) |
| oldDepositsOnly | Rewards the portion of a snapshot balance still held — min(snapshot, balance) × time |

---

## DistributionMethod

**Endpoint**: `https://api.merkl.xyz/v4/schemas/distributionMethod`

For reference; not directly related to hookType but often appears alongside.

| key | description |
|---|---|
| AIRDROP | Distributes total remaining campaign amount at once without time weighting |
| DUTCH_AUCTION | Shares a fixed reward amount per second proportionally among users based on their scores |
| FIX_APR | Distributes rewards based on a fixed annual percentage rate |
| AIRDROP_EPOCH | Snapshot-based airdrop distribution per epoch period |
| MAX_DISTRIBUTION_RATE | Event-based distribution with maximum rate constraint |
| VESTING | Distributes rewards with a vesting schedule to a single beneficiary |
| MAX_APR | Dutch auction distribution capped at a maximum APR |
| COMPOSED | Combines external data adapters with configurable distribution logic |
| AAVE_NET_APR | Automatically tops up Aave native APR to reach a target APR |
| ERC4626_APR | Tops up ERC4626 vault APR to reach a target total APR |
| ERC4626_SPREAD_CAPPED | Pays the spread between a target APR and the ERC4626 vault native APR, capped at a maximum Merkl-paid APR |
| AAVE_V4_NET_APR | Tops up Aave V4 native APR to reach a target total APR |
| PIECEWISE_LINEAR_VESTING | Distributes rewards across multiple time segments with cliff or linear release |
| GAS_REBATE_AIRDROP | Airdrop that compensates users for gas costs incurred during campaign participation |
| DEEL_DISTRIBUTION | DEEL split distribution: tops up vault holders to 2.5% effective APR |
| SOFR_SPREAD_RATCHET | Tops up an ERC4626 vault's native APR to a TVL-tiered target (live SOFR + a spread) |
| ERC4626_TARGET_APR_WITH_MERKL | Tops up an ERC4626 vault's native APR and the existing Merkl opportunity APR |
| TARGET_APR_WITH_MERKL | Tops up the existing Merkl opportunity APR to reach a target total APR |
| NET_APR | Generic lending net-APR wrapper (supersedes AAVE_NET_APR / AAVE_V4_NET_APR) |
| BORROW_SUBSIDY | Utilization-aware borrow-side subsidy on a lending protocol |

---

## Impact on Backend Code

### hookType=14 (BORROW_BL) + hookType=17 (HEALTH_FACTOR) — unified borrow-exclusion detection

Backend code in `merkl-api.ts`:

- **`hasBorrowExclusionHook(opp)`**: checks for hookType=14 (BORROW_BL) or hookType=17 (HEALTH_FACTOR). Replaces the older `hasBlacklistWithBorrowHook` which required `params.blacklist` co-occurrence — a requirement that was overly conservative now that the official schema confirms hookType=14's BORROW_BL semantics are self-contained.
- **`extractBorrowHookProtocols(hooks)`**: extracts `protocol` and `borrowBytesLike` from hookType=14 entries only (hookType=17 does not carry borrowBytesLike).
- **`hasBlacklistWithBorrowHook(opp)`**: kept as backward-compatible alias, now delegates to `hasBorrowExclusionHook`.
- **`hasHookType14(opp)`**: kept as deprecated alias, now delegates to `hasBorrowExclusionHook`.
- **`isBorrowBl` detection**: `(identifier?.includes('BORROW_BL') ?? false) || hasBorrowExclusionHook(opp)` — identifier match kept as fallback, hookType detection as primary signal.
- **HookType constants**: `HOOK_TYPE_BORROW_BL = 14`, `HOOK_TYPE_HEALTH_FACTOR = 17`, `BORROW_EXCLUSION_HOOK_TYPES` set — replaces magic number `14`.

### hookType=4 (SANCTIONED) — no code impact, documentation corrected

The handoff doc labeled hookType=4 as "Registry（链上注册表验证）" but it is actually SANCTIONED (OFAC sanctions filter). No backend code handles hookType=4 directly. The `params.blacklist` field (populated by hookType=4/27/28) is read as a top-level Merkl API field and stored in `MerklCampaignAccess.blacklist`.

### hookType=16 (COINBASE_ATTESTATION) — no code impact

Not handled in backend. Previously misidentified as "Attestation (EAS)" — actually Coinbase-specific.

### hookType=18 (WHITELIST_CAMPAIGN) — no code impact

Not handled in backend. Previously misidentified as "Protocol Position" — actually a campaign-based whitelist.

### `params.blacklist` / `params.whitelist` — top-level campaign fields, source annotated

The backend reads `campaign.params.blacklist` and `campaign.params.whitelist` as top-level fields. Code comments now document which hookTypes populate each:
- **whitelist**: hookType=22 (WHITELIST_ADDRESSES), hookType=26 (WHITELIST_KEY_VALUE_STORE), etc.
- **blacklist**: hookType=4 (SANCTIONED/OFAC), hookType=27 (BLACKLIST_KEY_VALUE_STORE), hookType=28 (BLACKLIST_PER_PROTOCOL), etc.

### `computeScoreMethod=maxDeposit` — correctly handled

Backend `extractPositionCapFromCampaign()` correctly reads `computeScoreParameters.computeMethod === 'maxDeposit'` and extracts `computeSettings.maxDeposit`. The official schema confirms: maxDeposit = "Caps the rewarded balance at a specified maximum deposit threshold."

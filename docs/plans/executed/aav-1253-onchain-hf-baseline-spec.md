# AAV-1253 Spec: On-chain HF Baseline 接入（current → after → delta）

> AAV-756 P7 — 将链上真实 Health Factor 作为 baseline 引入 Portfolio Simulation。
> 仓库：`aaveapy/`（前端）

## Problem Statement

P4（AAV-1251）已实现模拟 HF 计算（per-pool/spoke），P6（AAV-1252）已展示在 Summary Bar。但当前 HF 仅有 `after` 值（模拟后），缺少链上真实的 `current` baseline。用户无法看到"我的操作对 HF 的影响"（delta），也无法验证模拟 HF 与链上实际 HF 的一致性。

Wallet 用户连接钱包后，前端已经通过 SDK / on-chain fallback 获取了用户仓位数据，且 on-chain fallback 路径中已经调用了 `getUserAccountData()` 获取了 `V3AccountSummary.healthFactorWad` 和 `V4AccountSummary.healthFactor`，但这些数据被 **丢弃**——只提取了 positions，没有提取 account summaries。

## Solution

新增 **on-chain HF baseline** 数据层：在 wallet 连接时，独立获取用户在每个 pool/spoke 的链上 HF，作为 `current` baseline 注入 simulator，实现 `current → after → delta` 三元组展示。

### 数据流

```
[Wallet Connected]
  ├── useUserPositionsSdk (existing) → positions → PortfolioReserveEntry[]
  │
  └── useOnchainHealthFactor (NEW)    → Map<poolKey, OnchainHfBaseline>
        │
        │  V3: multicall getUserAccountData per Pool
        │  V4: multicall getUserAccountData per Spoke
        │
        └── passed to simulatePortfolioFromEntries()
              │
              ├── computeHealthFactors() → healthFactor (after, simulated)
              ├── merge on-chain baseline → currentHealthFactor (current, on-chain)
              └── deltaHealthFactor = after - current
                    │
                    └── PortfolioSummaryBar renders current → after → delta
```

### 关键设计决策（Grill 确认）

1. **独立 hook 获取 on-chain HF**：`useOnchainHealthFactor(address, entries, reserves)` — 与 `useUserPositionsSdk` 解耦，不污染现有 position 获取逻辑。SDK 成功时也需独立 multicall（SDK 不提供 account-level HF）。

2. **V4 匹配用 `spokeAddress`，不用 `spokeName`**：
   - V4 `marketName`（API）= `AaveV4${SDK spoke.name}`（如 `AaveV4Main`）
   - V4 address book spoke key（如 `MAIN_SPOKE`）≠ SDK spoke name（如 `Main`）
   - `spokeAddress` 是链上地址，全局唯一，跨命名系统无歧义
   - `V4AccountSummary` 新增 `spokeAddress` 字段

3. **V3 匹配用 `(chainId, marketName)`**：
   - V3 一个 Pool = 一个 market，poolKey = `${chainId}:${marketName}` 直接可用
   - `V3AccountSummary` 新增 `marketName` 字段（caller 已知 marketName）

4. **poolKey 作为统一匹配键**：
   - Hook 内部将 on-chain data 转换为 `Map<poolKey, OnchainHfBaseline>`
   - V3: `poolKey = ${chainId}:${marketName}`
   - V4: 通过 `spokeAddress` → reserve → `marketName` 反查 poolKey

5. **HF 精度转换**：
   - V3 `healthFactorWad`：bigint WAD (1e18 = 1.0) → `Number(wad) / 1e18`
   - V4 `healthFactor`：bigint WAD (1e18 = 1.0) → `Number(wad) / 1e18`

6. **命名：Lowest HF**（非 Min HF）：
   - "Min HF" 易与 "Minimum Required HF" 混淆
   - "Lowest HF" 明确表示"所有 pool 中最低的 HF 值"

7. **UI 策略 — 有 Wallet vs 无 Wallet 差异化**：
   - **有 Wallet**：Badge 显示 `after` 值 + ↑/↓ 箭头（delta 方向）；Advanced 区显示 `current → after (delta)`
   - **无 Wallet**：Badge 仅显示 `after` 值，无箭头；Advanced 区仅显示 `after` 值
   - Badge 颜色始终基于 `after` 值（安全状态由模拟后 HF 决定）

## Type Changes

### `PortfolioHealthFactor` 扩展

```typescript
// aaveapy/src/types/portfolio.ts

export interface PortfolioHealthFactor {
  /** `${chainId}:${marketName}` — protocol isolation boundary. */
  poolKey: string;
  /** Simulated HF (after). null = no borrow (display "—"). */
  healthFactor: number | null;
  /** On-chain HF (current). null = no wallet / no on-chain data / no borrow. */
  currentHealthFactor: number | null;
  /** Delta = after - current. null = no current baseline. */
  deltaHealthFactor: number | null;
  /** Σ(supplyUsd × liquidationThreshold / 100) — risk-adjusted collateral. */
  totalCollateralUsd: number;
  /** Σ(effective borrowUsd) — post-clamp debt. */
  totalDebtUsd: number;
  /** Σ(supplyUsd × ltv / 100) — max borrow capacity. */
  totalBorrowCapacityUsd: number;
}
```

### On-chain HF baseline 类型

```typescript
// aaveapy/src/lib/userData/onchainHealthFactor.ts

export interface OnchainHfBaseline {
  /** On-chain HF value (human-readable, e.g. 1.5). null = HF = type(uint256).max (no debt). */
  healthFactor: number | null;
  /** On-chain total collateral in USD (optional, for validation/debug). */
  totalCollateralUsd?: number;
  /** On-chain total debt in USD (optional, for validation/debug). */
  totalDebtUsd?: number;
}

/** Map from poolKey to on-chain HF baseline. */
export type OnchainHfMap = Map<string, OnchainHfBaseline>;
```

### V4AccountSummary 扩展

```typescript
// aaveapy/src/lib/userData/aaveV4UserClient.ts

export interface V4AccountSummary {
  chainId: number;
  spokeName: string;
  spokeAddress: `0x${string}`; // NEW — canonical matching key
  healthFactor: bigint;
  totalCollateralValue: bigint;
  totalDebtValueRay: bigint;
}
```

### V3AccountSummary 扩展

```typescript
// aaveapy/src/lib/userData/aaveV3UserClient.ts

export interface V3AccountSummary {
  chainId: number;
  marketName: string; // NEW — for poolKey construction
  totalCollateralBaseWad: bigint;
  totalDebtBaseWad: bigint;
  availableBorrowsBaseWad: bigint;
  currentLiquidationThresholdWad: bigint;
  ltvWad: bigint;
  healthFactorWad: bigint;
}
```

### SimulatePortfolioEntriesArgs 扩展

```typescript
// aaveapy/src/lib/portfolioSimulator.ts

export interface SimulatePortfolioEntriesArgs extends SimulateCommonArgs {
  entries: PortfolioReserveEntry[];
  lastModifiedReserveId?: string;
  /** On-chain HF baseline per pool (AAV-1253 P7). undefined = no wallet. */
  onchainHfMap?: OnchainHfMap;
}
```

## Implementation Design

### 1. On-chain HF Hook (`useOnchainHealthFactor`)

```typescript
// aaveapy/src/hooks/useOnchainHealthFactor.ts

export function useOnchainHealthFactor(
  address: `0x${string}` | undefined,
  entries: PortfolioReserveEntry[],
  reserves: ReserveWithSpread[]
): { onchainHfMap: OnchainHfMap | undefined; isLoading: boolean };
```

**职责**：

- 从 `entries` 提取所有有仓位的 (chainId, marketName) 组合
- V3: 对每个 market 调用 `getV3UserPositionsOnChain`（仅 accountData 部分）或直接 multicall `getUserAccountData`
- V4: 对每个 spoke 调用 `getV4UserPositionsOnChain`（仅 accountData 部分）或直接 multicall
- 将结果转换为 `Map<poolKey, OnchainHfBaseline>`
- React Query 管理 caching/refetch，与 `useUserPositionsSdk` 同步刷新

**V4 poolKey 构造**：

```typescript
// Build spokeAddress → marketName lookup from reserves
const spokeAddrToMarketName = new Map<string, string>();
for (const r of reserves) {
  if (r.spokeAddress && r.marketName) {
    spokeAddrToMarketName.set(r.spokeAddress.toLowerCase(), r.marketName);
  }
}
// For each V4AccountSummary:
const marketName = spokeAddrToMarketName.get(
  summary.spokeAddress.toLowerCase()
);
const poolKey = `${summary.chainId}:${marketName}`;
```

**V3 poolKey 构造**：

```typescript
// V3AccountSummary.marketName is now available
const poolKey = `${summary.chainId}:${summary.marketName}`;
```

**HF 值转换**：

```typescript
function wadToHf(wad: bigint): number | null {
  // type(uint256).max means no debt → HF is "infinite" → null (display "—")
  if (wad === 2n ** 256n - 1n) return null;
  const WAD = 10n ** 18n;
  return Number(wad / WAD) + Number(wad % WAD) / Number(WAD);
}
```

**触发条件**：

- `address` 存在且 wallet 已连接
- `entries` 非空（有 portfolio positions）
- 仅对 entries 中出现的 pool/spoke 发起 multicall（不是所有链上 pool）

**缓存策略**：

- React Query key: `['onchain-hf', address, poolKeysHash]`
- `poolKeysHash` = entries 中所有 poolKey 的排序 hash，entries 变化时重新 fetch
- Stale time: 与 `useUserPositionsSdk` 相同（`QUERY_STALE_TIMES.default`）
- Refetch: 订阅 `refetchEvent`（F5 / Refresh button / Watch Mode）

### 2. Simulator 扩展 (`computeHealthFactors`)

```typescript
function computeHealthFactors(
  results: PortfolioPositionResult[],
  reserves: ReserveWithSpread[],
  onchainHfMap?: OnchainHfMap
): PortfolioHealthFactor[] {
  // ... existing logic to compute healthFactor (after) ...

  for (const [
    poolKey,
    { totalCollateralUsd, totalDebtUsd, totalBorrowCapacityUsd },
  ] of poolGroups) {
    const healthFactor =
      totalDebtUsd > 0 ? totalCollateralUsd / totalDebtUsd : null;

    // P7: merge on-chain baseline
    const onchain = onchainHfMap?.get(poolKey);
    const currentHealthFactor = onchain?.healthFactor ?? null;
    const deltaHealthFactor =
      healthFactor != null && currentHealthFactor != null
        ? healthFactor - currentHealthFactor
        : null;

    healthFactors.push({
      poolKey,
      healthFactor,
      currentHealthFactor,
      deltaHealthFactor,
      totalCollateralUsd,
      totalDebtUsd,
      totalBorrowCapacityUsd,
    });
  }
  return healthFactors;
}
```

### 3. usePortfolioToggle 扩展

```typescript
// Pass onchainHfMap to simulatePortfolioFromEntries
const { results, summary, healthFactors } = simulatePortfolioFromEntries({
  entries: effectiveEntries,
  reserves,
  isApy: simulationContext.isApy,
  whitelistMerklCampaignIds: simulationContext.whitelistMerklCampaignIds,
  tydroPointToUsdRate: simulationContext.tydroPointToUsdRate,
  forecastStates: simulationContext.forecastStates,
  lastModifiedReserveId,
  onchainHfMap, // NEW
});
```

### 4. PortfolioSummaryBar UI 升级

**Lowest HF Badge（始终可见区）**：

```
有 Wallet：
  🟡 Lowest HF 1.6 ↓        ▸ Advanced
                 ^^^ ^^^
                 after  delta方向（↓ = 变差）

无 Wallet：
  🟡 Lowest HF 1.6          ▸ Advanced
                 ^^^
                 after（无 delta 指示）
```

- Badge 值始终显示 `after`（最低模拟 HF）
- 有 `currentHealthFactor` 时显示 ↑/↓ 箭头：
  - `deltaHealthFactor > 0` → ↑（绿色，安全趋势改善）
  - `deltaHealthFactor < 0` → ↓（红色，安全趋势恶化）
  - `deltaHealthFactor ≈ 0`（|delta| < 0.01）→ 不显示箭头
- Badge 颜色始终基于 `after` 值

**Advanced 区 HF per-pool 详情**：

```
有 Wallet：
  Health Factor (3 pools):
    Ethereum V3    1.8 → 1.6 ↓ 🟡    $8K / $5K
    Sonic V4       2.5 → 2.5    🟢    $5K / $2K
    GHO            0.9 → 0.9    🔴    $4.5K / $5K
                   ^^^   ^^^ ^
                   current after delta

无 Wallet：
  Health Factor (3 pools):
    Ethereum V3         1.6 🟡    $8K / $5K
    Sonic V4            2.5 🟢    $5K / $2K
    GHO                 0.9 🔴    $4.5K / $5K
                        ^^^
                        after only
```

**`getMinHf` 扩展**：

```typescript
// Lowest HF still uses `healthFactor` (after) — unchanged
export function getMinHf(healthFactors: PortfolioHealthFactor[]): number | null { ... }
```

**新增 `getLowestHfDelta`**：

```typescript
export function getLowestHfDelta(healthFactors: PortfolioHealthFactor[]): {
  delta: number | null;
  direction: "up" | "down" | "flat" | null;
} {
  const poolsWithDelta = healthFactors.filter(
    (hf) =>
      hf.deltaHealthFactor != null &&
      hf.healthFactor != null &&
      hf.healthFactor > 0
  );
  if (poolsWithDelta.length === 0) return { delta: null, direction: null };

  // Find the pool with the lowest `after` HF (matches the badge)
  const lowest = poolsWithDelta.reduce((min, hf) =>
    (hf.healthFactor ?? Infinity) < (min.healthFactor ?? Infinity) ? hf : min
  );
  const delta = lowest.deltaHealthFactor!;
  const direction = Math.abs(delta) < 0.01 ? "flat" : delta > 0 ? "up" : "down";
  return { delta, direction };
}
```

## User Stories

1. 作为已连接 Wallet 的 Portfolio 用户，我希望看到链上真实的当前 HF（current），了解我的仓位实际安全状态
2. 作为已连接 Wallet 的 Portfolio 用户，我希望看到模拟操作后 HF 的变化（delta），了解我的操作对安全性的影响
3. 作为已连接 Wallet 的 Portfolio 用户，当我的操作使 HF 下降时，我希望看到 ↓ 箭头提醒，避免做出危险操作
4. 作为已连接 Wallet 的 Portfolio 用户，当我的操作使 HF 上升时，我希望看到 ↑ 箭头确认安全改善
5. 作为未连接 Wallet 的 Portfolio 用户，我希望看到模拟后的 HF（after），行为与当前 P6 一致，无降级感
6. 作为 Portfolio 用户，当某个 pool 没有借款时，其 HF 应显示 "—"（包括 current 和 after）
7. 作为 Portfolio 用户，当链上 HF 获取失败时（RPC 错误），模拟 HF 应正常展示，current/delta 显示 "—"
8. 作为 Portfolio 用户，当我在 Advanced 区查看 per-pool 详情时，有 Wallet 时应看到 current → after 变化，无 Wallet 时只看 after
9. 作为 Portfolio 用户，当链上 HF = type(uint256).max（无债务）时，current HF 应为 null（显示 "—"），而非一个超大数字

## Scenario & Risk Verification Matrix

| #   | 场景                                                   | 输入                                                                          | 预期                                                                                  | 风险维度          | 测试用例 |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------- | -------- |
| C1  | 有 wallet + 有 borrow + 有 on-chain HF                 | entries 有 V3 borrow, onchainHfMap 有对应 poolKey                             | `currentHealthFactor` = 链上值, `deltaHealthFactor` = after - current                 | 正常路径          | ✅       |
| C2  | 有 wallet + 无 borrow                                  | entries 无 borrow, on-chain HF = max uint256                                  | `currentHealthFactor` = null, `deltaHealthFactor` = null                              | 边界：无债务      | ✅       |
| C3  | 有 wallet + on-chain HF 获取失败                       | onchainHfMap = undefined                                                      | `currentHealthFactor` = null, `deltaHealthFactor` = null, `healthFactor` (after) 正常 | 降级处理          | ✅       |
| C4  | 无 wallet                                              | onchainHfMap = undefined                                                      | `currentHealthFactor` = null, `deltaHealthFactor` = null, `healthFactor` (after) 正常 | 无 wallet 场景    | ✅       |
| C5  | V4 spokeAddress 匹配                                   | V4 reserve.spokeAddress = 0xabc, V4AccountSummary.spokeAddress = 0xabc        | poolKey 正确匹配，`currentHealthFactor` = 链上值                                      | V4 命名不匹配风险 | ✅       |
| C6  | V4 spokeAddress 不匹配（address book key vs SDK name） | V4AccountSummary 仅有 spokeName=MAIN_SPOKE, 无 spokeAddress                   | 匹配失败，`currentHealthFactor` = null（降级，不 crash）                              | V4 命名不匹配     | ✅       |
| C7  | V3 marketName 匹配                                     | V3AccountSummary.marketName = "AaveV3Ethereum"                                | poolKey = "1:AaveV3Ethereum" 正确匹配                                                 | V3 正常路径       | ✅       |
| C8  | 多 pool 有 wallet                                      | 3 个 pool，2 个有 on-chain data，1 个 RPC 失败                                | 2 个有 current/delta，1 个 current=null                                               | 部分失败降级      | ✅       |
| C9  | delta = 0（模拟操作不改变 HF）                         | after = current = 1.5                                                         | `deltaHealthFactor` = 0, Badge 无箭头                                                 | 边界：零 delta    | ✅       |
| C10 | delta 微小（< 0.01）                                   | after = 1.5001, current = 1.5                                                 | `deltaHealthFactor` = 0.0001, direction = 'flat', Badge 无箭头                        | 精度边界          | ✅       |
| C11 | HF 改善（delta > 0）                                   | current = 1.2, after = 1.5                                                    | `deltaHealthFactor` = 0.3, direction = 'up', Badge ↑ 绿色                             | 正向 delta        | ✅       |
| C12 | HF 恶化（delta < 0）                                   | current = 2.0, after = 1.5                                                    | `deltaHealthFactor` = -0.5, direction = 'down', Badge ↓ 红色                          | 负向 delta        | ✅       |
| C13 | 链上 HF = max uint256（V3 无 borrow）                  | healthFactorWad = 2^256-1                                                     | `currentHealthFactor` = null（非 Infinity）                                           | V3 边界           | ✅       |
| C14 | 链上 HF = max uint256（V4 无 borrow）                  | healthFactor = 2^256-1                                                        | `currentHealthFactor` = null（非 Infinity）                                           | V4 边界           | ✅       |
| C15 | 仅 V3 有 wallet positions                              | V3 有 on-chain HF, V4 无 entries                                              | V3 pool 有 current/delta, V4 不出现                                                   | V3/V4 混合        | ✅       |
| C16 | 仅 V4 有 wallet positions                              | V4 有 on-chain HF, V3 无 entries                                              | V4 pool 有 current/delta, V3 不出现                                                   | V3/V4 混合        | ✅       |
| C17 | spokeAddress 大小写不一致                              | reserve.spokeAddress = "0xABC...", V4AccountSummary.spokeAddress = "0xabc..." | toLowerCase 匹配成功                                                                  | 大小写容错        | ✅       |
| C18 | 两个 V4 spoke 同链                                     | chainId=1, spokeA + spokeB 各有仓位                                           | 两个独立 poolKey，各自 current/delta                                                  | V4 多 spoke       | ✅       |
| C19 | wallet 断开                                            | address = undefined                                                           | onchainHfMap = undefined，所有 current/delta = null                                   | 断连降级          | ✅       |
| C20 | Portfolio 新增 entry（pool 变化）                      | 新增一个新 pool 的 entry                                                      | useOnchainHealthFactor 重新 fetch 新 pool 的 HF                                       | 动态 pool 变化    | ✅       |

### 风险维度说明

| 风险类型          | 评估                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **并发/竞态**     | `useOnchainHealthFactor` 使用 React Query，自动处理竞态。`onchainHfMap` 是 immutable Map，传入 `useMemo` 重算 simulator |
| **内存泄漏**      | `OnchainHfMap` 随 React Query cache 生命周期管理，gcTime 与现有 query 一致。无新全局缓存/Map/Set                        |
| **数据一致性**    | on-chain HF 与 simulated HF 使用相同 poolKey 匹配。poolKey 构造逻辑在 hook 内部集中，不散落                             |
| **CI/CD 交互**    | 纯前端改动，无后端变更，无 DB 迁移。E2E 需 mock wallet 连接场景                                                         |
| **外部 API 失败** | RPC multicall 失败时，hook 返回 `undefined`，simulator 降级为无 baseline 模式（P6 行为）                                |
| **跨包一致性**    | 仅改 `aaveapy/` 前端。后端 API 已包含 `spokeAddress`（V4 fetcher 已输出），无需后端改动                                 |
| **V4 命名不匹配** | spokeAddress 作为匹配键，绕过 address book key vs SDK name 的命名冲突。ADR-0026 已记录此问题                            |
| **E2E 回归**      | PortfolioSummaryBar 现有 `data-testid` 不变，新增 `data-testid` 用于 delta 元素                                         |

## Testing Decisions

### 测试 Seam

**主 Seam 1**：`useOnchainHealthFactor` hook

- Mock RPC multicall 返回值
- 验证 V3/V4 poolKey 构造正确
- 验证 HF 精度转换（WAD → number）
- 验证 max uint256 → null

**主 Seam 2**：`computeHealthFactors` with `onchainHfMap`

- 纯函数测试，传入 mock `OnchainHfMap`
- 验证 current/delta 合并逻辑
- 覆盖 C1-C14 场景

**主 Seam 3**：`PortfolioSummaryBar` 组件

- 验证有 wallet / 无 wallet 两种渲染模式
- 验证 ↑/↓ 箭头方向
- 验证 Advanced 区 current → after 展示

**辅助 Seam**：`getLowestHfDelta` 纯函数

- 独立测试 delta direction 逻辑

### 测试原则

- on-chain HF 转换用纯函数测试（`wadToHf`），不依赖 React
- Hook 测试用 `@testing-library/react-hooks` + mock RPC
- 组件渲染用 `@testing-library/react` + `data-testid` selector
- 不 mock `simulatePortfolioFromEntries`（使用真实计算）
- 沿用现有 `makeReserve` / `makeEntry` / `baseEntriesSimArgs` 测试工厂

## Out of Scope

- **isCollateral per-reserve 开关**：用户手动切换 collateral 状态 — 独立增强
- **Snapshot HF 对比**：`PortfolioSnapshot` 加 `healthFactors` — 独立增强
- **V4 drawCap（Spoke 级借款上限）**：API 未暴露，follow-up
- **on-chain totalCollateral/totalDebt 与 simulated 值的偏差校验**：P7 仅展示 HF，不做偏差告警
- **SDK path 直接获取 HF**：SDK 不提供 account-level HF，需独立 RPC multicall。未来 SDK 增加后可优化

## Dependencies

- P4 (AAV-1251) — `computeHealthFactors` 已实现 ✅ Done
- P6 (AAV-1252) — `PortfolioSummaryBar` 已实现 ✅ Done
- 后端 API 已包含 `spokeAddress` 字段（V4 fetcher `v4-fetcher.ts:243`）✅ Available

## Reference

- `aaveapy-doc/v3-v4-collateral-and-health-factor.md` — HF 公式对比
- `aaveapy-doc/hub-spoke-position-isolation.md` — Spoke 隔离边界
- ADR-0026 — spokeKey/spokeName 语义分离（spokeAddress 作为 canonical key 的先例）
- Triage doc: `docs/plans/linear-issues-triage.md` — AAV-756 拆分详情
- `aaveapy/src/lib/userData/aaveV4UserClient.ts` — V4 on-chain fetch（`V4AccountSummary`）
- `aaveapy/src/lib/userData/aaveV3UserClient.ts` — V3 on-chain fetch（`V3AccountSummary`）
- `aaveapy/src/lib/portfolioSimulator.ts` — `computeHealthFactors` 所在地
- `aaveapy/src/components/dashboard/PortfolioSummaryBar.tsx` — UI 组件

## Ticket Breakdown

### T1: Type & Data Layer — V4AccountSummary.spokeAddress + V3AccountSummary.marketName

**Scope:**

- `aaveV4UserClient.ts`: Add `spokeAddress` to `V4AccountSummary` interface + populate in `getV4UserPositionsOnChain`
- `aaveV3UserClient.ts`: Add `marketName` to `V3AccountSummary` interface + populate in `getV3UserPositionsOnChain`
- `types/portfolio.ts`: Add `currentHealthFactor`, `deltaHealthFactor` to `PortfolioHealthFactor`
- `portfolioSimulator.ts`: Add `onchainHfMap` to `SimulatePortfolioEntriesArgs`, extend `computeHealthFactors`

**Test:** Unit test `computeHealthFactors` with mock `OnchainHfMap`

**Depends on:** —
**Blocks:** T2, T3, T4

### T2: On-chain HF Hook — `useOnchainHealthFactor`

**Scope:**

- New file `hooks/useOnchainHealthFactor.ts`
- Build poolKey from reserves (V4 spokeAddress → marketName lookup)
- Multicall `getUserAccountData` for each pool/spoke in entries
- WAD → number conversion, max uint256 → null
- React Query integration with refetchEvent

**Test:** Hook test with mock multicall, verify poolKey construction + HF conversion

**Depends on:** T1
**Blocks:** T3

### T3: Simulator Wiring — Pass onchainHfMap through hook chain

**Scope:**

- `usePortfolioToggle.ts`: Accept `onchainHfMap` param, pass to `simulatePortfolioFromEntries`
- `ReservesTable.tsx` / `PortfolioPanel.tsx`: Thread `onchainHfMap` prop
- `PortfolioUnifiedTable.tsx` / `MobilePortfolioCard.tsx`: Accept and pass `onchainHfMap`

**Test:** `usePortfolioToggle.test.ts` — verify onchainHfMap passed through

**Depends on:** T2
**Blocks:** T4

### T4: UI — Lowest HF Badge with delta arrow + Advanced per-pool current→after

**Scope:**

- `portfolioCalculator.ts`: Add `getLowestHfDelta` function
- `PortfolioSummaryBar.tsx`:
  - Badge: show `after` value + ↑/↓ arrow when `deltaHealthFactor` exists
  - Advanced: per-pool row shows `current → after` when wallet connected
- Component tests for both wallet / non-wallet rendering modes

**Test:** Component render test, verify arrow direction + current→after display

**Depends on:** T3
**Blocks:** T5

### T5: Integration Tests — C1-C20 scenario matrix

**Scope:**

- `portfolioSimulator.test.ts`: Extend existing HF test suite with on-chain baseline scenarios
- `PortfolioSummaryBar.test.tsx`: Wallet / non-wallet rendering modes

**Test:** C1-C20 scenario matrix

**Depends on:** T4
**Blocks:** —

### Dependency Graph

```
T1 (types & data layer)
  └── T2 (onchain HF hook)
       └── T3 (simulator wiring)
            └── T4 (UI)
                 └── T5 (integration tests)
```

Linear sequence: T1 → T2 → T3 → T4 → T5. No parallelism.

# Handoff: Merkl V4 Hub/Spoke 过滤策略修正实施

> **Status: Executed** (2026-07-06) — spoke-priority dedup via parentCampaignId 已实施。

> **目的**：将 "过滤 Spoke 保留 Hub" 改为 "parent-child 重叠时保留 Spoke" 的实施方案移交给执行 session。
> **相关 Issue**：AAV-1004 (spoke-priority dedup), AAV-959 (原 filter-Spoke, superseded)
> **相关 ADR**：ADR-0030（已修正 2026-06-25）
> **PRD**：[prd-aav959-merkl-spoke-priority.md](./prd-aav959-merkl-spoke-priority.md)
> **研究文档**：[handoff-merkl-hub-spoke-research.md](./handoff-merkl-hub-spoke-research.md)
> **当前代码状态**：✅ 已实施 — spoke-priority dedup via parentCampaignId (breakdown-level)
>
> **实施修正（grilling 发现）**：
> - `parentCampaignId` 是 API top-level 字段（非 `params.parentCampaignId`，handoff §3.1 描述有误）
> - 去重在 breakdown 级（index.ts），非 opportunity 级（findMatchingMerklOpportunities），以保留独立 Hub campaigns
> - `isV4SpokeOpportunity` 函数保留（dedup 逻辑和测试中使用），仅移除过滤块

---

## 1. 背景与核心结论

### 1.1 研究发现

深度调查（详见研究 handoff）确认：

- **Hub apr (6.77%) = targetAPR** = 总 APR 目标（含 nativeAPY），不是用户从 Merkl 收到的 reward APR
- **Spoke apr (6.48%) = incentiveAPR** = 用户从 Merkl 实际收到的 reward APR（Dutch Auction 分发结果）
- **Spoke 的 `distributionSettings` 为空 `{}`** = Spoke 是 Hub 的执行壳，参数由 Hub 注入
- **Hub forwarding 镜像 Spoke 分发**：97%+ 用户 Hub reward amount == Spoke reward amount（精确到 wei）
- **end_campaign = Hub_budget - Spoke_actual**（已数学验证 Period 1-4）

### 1.2 当前方案的问题

当前代码（ADR-0030）过滤 Spoke、保留 Hub，然后后端通过 `computeTargetTotalAprIncentiveApr(targetAPR, nativeAPY, side)` 转换为 incentiveAPR。

**问题**：
1. 转换依赖 `reserve.supplyApy`（nativeAPY），但 V4 的 supplyApy 来自 SDK，**RPC fallback 不提供 supplyApy**
2. SDK 故障走 RPC fallback 时，所有 V4 reserve 的 supplyApy = undefined → fallback 显示 targetAPR（偏高 nativeAPY）
3. 转换逻辑是间接的、脆弱的——Spoke 的 apr 本身就是 incentiveAPR，无需转换

### 1.3 核心决策

**当 Hub 和 Spoke 是 parent-child 关系且匹配同一 V4 reserve 时，用 Spoke 代替 Hub。**

Spoke 是 Dutch Auction，直接使用 Dutch Auction 自己的参数（campaignApr = incentiveAPR、totalBudget = Spoke budget），不注入 Hub 的 targetAPR。

---

## 2. 判定逻辑：A + B 双条件

仅当 **同时满足** 以下两个条件时，才用 Spoke 替换 Hub：

| 条件 | 含义 | 单独使用的问题 |
|------|------|-------------|
| **A. 同 reserve 匹配** | Hub 通过 `tokenAddress`（underlying）、Spoke 通过 `spokeAddress` 命中同一 V4 reserve | 不相关的 Hub 和 Spoke 也可能命中同一 reserve（多个 creator 可为同一 underlying token 创建不同 Hub campaign） |
| **B. parent-child 关系** | Spoke campaign 的 `parentCampaignId` = Hub campaign 的 `campaignId` | parent-child 可能匹配不同 reserve（一个 Hub 可对应多个 Spoke/Reserve） |

### 2.1 不相关场景示例

```
V4 Reserve R:
  tokenAddress  = USDC (0xA0b8...)
  spokeAddress  = Spoke_Ethereum (0x1234...)

Merkl campaigns:
  Hub X (by creator A, for USDC)                → 匹配 R (via tokenAddress)
  Hub Z (by creator B, for USDC)                → 匹配 R (via tokenAddress)
  Spoke Y (parent = Hub Z, for Spoke_Ethereum)  → 匹配 R (via spokeAddress)

正确行为：Spoke Y 替换 Hub Z（parent-child），但 Hub X 保留（独立 campaign）
```

### 2.2 三种保留情况

| 情况 | 处理 |
|------|------|
| Hub + Spoke 重叠（parent-child + 同 reserve） | 用 Spoke，丢弃 parent Hub |
| 只有 Spoke | 用 Spoke |
| 只有 Hub（Hub 对应多个 Spoke 但当前 reserve 无 Spoke） | 用 Hub |

---

## 3. 实施方案

### 3.1 扩展 MerklCampaignDetails（新增 parentCampaignId）

**文件**：[packages/aave-fetcher/src/merkl-api.ts:154-161](file:///Users/pabloli/Documents/code/aave-protocol-analysis/packages/aave-fetcher/src/merkl-api.ts#L154-L161)

当前 `MerklCampaignDetails` 只有 `startedAt, endedAt, id, apr, whitelistOnly`，**不包含 `parentCampaignId`**。

**改动**：
```typescript
export interface MerklCampaignDetails {
  startedAt: string;
  endedAt: string;
  id: string;
  /** Annual yield ratio; upstream `campaign.apr` is percent → divided by 100 when cached. */
  apr: number;
  whitelistOnly: boolean;
  /** V4 Spoke campaign's parent Hub campaign ID (for Hub/Spoke deduplication). */
  parentCampaignId?: string;
}
```

在 fetch campaign details 时，从 raw API response 的 `params.parentCampaignId` 或 `params.rootCampaignId` 提取。

### 3.2 移除 Spoke 过滤，处理 Hub 和 Spoke

**文件**：[packages/aave-fetcher/src/merkl-api.ts:1448-1455](file:///Users/pabloli/Documents/code/aave-protocol-analysis/packages/aave-fetcher/src/merkl-api.ts#L1448-L1455)

**当前代码**（需删除）：
```typescript
// ADR-0030: Skip AAVE_V4_SPOKE_* opportunities to avoid double-counting with Hub.
// Hub distributes the full incentive budget (Hub-direct + Spoke-forwarded) at targetAPR.
// Users receive rewards at Hub APR level (confirmed via Merkl API breakdowns).
// Spoke APR (Dutch Auction rate) understates actual rewards by ~5% (≈ nativeAPY delta).
if (isV4SpokeOpportunity(opp.type)) {
  logger.info(`   ⏭️ Skipping V4 Spoke opportunity ${opp.id} (${opp.type}) — Hub provides correct APR`);
  continue;
}
```

**改动**：删除上述过滤块，让 Spoke opportunity 正常处理并索引。

### 3.3 在 findMatchingMerklOpportunities 中增加去重

**文件**：[packages/aave-fetcher/src/merkl-api.ts:1905-1939](file:///Users/pabloli/Documents/code/aave-protocol-analysis/packages/aave-fetcher/src/merkl-api.ts#L1905-L1939)

**当前逻辑**：收集所有匹配的 opportunity（Hub via tokenAddress + Spoke via spokeAddress），无去重。

**改动**：在收集完所有匹配后，增加 parent-child 去重：

```typescript
export function findMatchingMerklOpportunities(
  item: { /* ... */ },
  merklData: Record<string, MerklOpportunityData[]>,
): MerklOpportunityData[] {
  // ... 现有匹配逻辑，收集所有 Hub + Spoke 匹配到 matchedOpportunities ...

  // V4 Hub/Spoke 去重：如果 Spoke 的 parentCampaignId 对应的 Hub 也在匹配列表中，移除该 Hub
  return deduplicateHubSpokeOverlap(matchedOpportunities);
}

/**
 * 当 Hub 和 Spoke 是 parent-child 且同时匹配同一 reserve 时，保留 Spoke、移除 parent Hub。
 * 不相关的 Hub（非 parent）保留，因为它们是独立 reward 源。
 */
function deduplicateHubSpokeOverlap(
  matched: MerklOpportunityData[],
): MerklOpportunityData[] {
  // 1. 收集所有 Spoke campaign 的 parentCampaignId
  const spokeParentIds = new Set<string>();
  for (const opp of matched) {
    if (opp.opportunityType?.startsWith('AAVE_V4_SPOKE_')) {
      for (const bd of [...opp.supply, ...opp.borrow]) {
        // 从 campaignDetailsCache 查 parentCampaignId（需传入或通过 breakdown 字段携带）
        // 如果 bd 有 parentCampaignId → spokeParentIds.add(bd.parentCampaignId)
      }
    }
  }

  // 2. 移除 parent Hub campaigns
  return matched.filter((opp) => {
    if (!opp.opportunityType?.startsWith('AAVE_V4_HUB_')) return true; // 非 Hub，保留
    // 检查 Hub 的 campaignId 是否在 spokeParentIds 中
    // 如果是 → 移除（被 Spoke 替代）
    // 如果否 → 保留（独立 Hub）
  });
}
```

**实现要点**：
- `parentCampaignId` 需要从 `campaignDetailsCache` 传递到去重逻辑
- 可选方案 A：在 `MerklCampaignBreakdown` 中新增 `parentCampaignId` 字段，处理时填充
- 可选方案 B：将 `campaignDetailsCache` 传入 `findMatchingMerklOpportunities`
- 推荐方案 A，因为 breakdown 已经携带了 campaignId，加一个 parentCampaignId 字段更自然

### 3.4 scaleMerklBreakdown：TARGET_TOTAL_APR 转换不再对 V4 Spoke 触发

**文件**：[backend/src/services/marketsApiSerialize.ts:26-58](file:///Users/pabloli/Documents/code/aave-protocol-analysis/backend/src/services/marketsApiSerialize.ts#L26-L58)

**当前逻辑**：
```typescript
const isTargetTotal = b.campaignType === 'TARGET_TOTAL_APR';
if (isTargetTotal && nativeApy !== undefined && side !== undefined && b.aprCap != null) {
  const incentiveAprPercent = computeTargetTotalAprIncentiveApr(aprCapPercent, nativeApyPercent, side);
  campaignAprScaled = incentiveAprPercent;
} else {
  campaignAprScaled = roundTo6(b.campaignApr * 100);  // fallback
}
```

**改动**：**无需修改**。改用 Spoke 后：
- Spoke 的 `campaignType` = DUTCH_AUCTION（不是 TARGET_TOTAL_APR）
- `isTargetTotal` = false → 走 else 分支 → `campaignApr × 100` = incentiveAPR 直接透传 ✅
- TARGET_TOTAL_APR 转换逻辑保留，仍用于 V3 campaign（如果有）

### 3.5 fallback 路径不再有问题

**文件**：[backend/src/services/marketsApiSerialize.ts:133-135](file:///Users/pabloli/Documents/code/aave-protocol-analysis/backend/src/services/marketsApiSerialize.ts#L133-L135)

**当前问题**：supplyApy 缺失时 fallback 显示 targetAPR。

**改动**：**无需修改**。改用 Spoke 后：
- Spoke 的 `campaignApr` = incentiveAPR（Dutch Auction 结果）
- `scaleMerklBreakdown` 直接透传 `campaignApr × 100`，不依赖 supplyApy
- supplyApy 缺失不再影响 Merkl reward APR 显示 ✅

### 3.6 Forecast：使用 Dutch Auction 参数

**文件**：[backend/src/services/merklForecastService.ts](file:///Users/pabloli/Documents/code/aave-protocol-analysis/backend/src/services/merklForecastService.ts)

**当前逻辑**：`campaignTypeHint === 'TARGET_TOTAL_APR'` 时设 `aprCap = targetAPR`（[line 897-901](file:///Users/pabloli/Documents/code/aave-protocol-analysis/backend/src/services/merklForecastService.ts#L897-L901)）。

**改动**：Spoke 是 DUTCH_AUCTION，`campaignTypeHint` 不会是 TARGET_TOTAL_APR，forecast 会按 Dutch Auction 参数处理。需要验证：
- `normalizeForecastCampaignTypeLite` 对 DUTCH_AUCTION 返回什么 campaignType？
- Dutch Auction 的 `totalBudget` 和 `plannedDaily` 计算是否正确？
- `aprCap` 不设置是否影响 forecast 显示？

**预期**：Dutch Auction 有自己的参数（totalBudget = Spoke budget, plannedDaily = budget/duration），forecast 应自然工作。需在实施时验证。

### 3.7 修正错误注释

**文件**：[packages/aave-fetcher/src/merkl-api.ts:1451](file:///Users/pabloli/Documents/code/aave-protocol-analysis/packages/aave-fetcher/src/merkl-api.ts#L1451)

**当前注释**（错误）：
```typescript
// Spoke APR (Dutch Auction rate) understates actual rewards by ~5% (≈ nativeAPY delta).
```

**改动**：随 3.2 一起删除（整个过滤块被移除）。

---

## 4. 改动文件清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `packages/aave-fetcher/src/merkl-api.ts` | **核心** | 扩展 MerklCampaignDetails、移除 Spoke 过滤、增加去重逻辑 |
| `packages/aave-shared-contracts/src/index.ts` | **类型** | MerklCampaignBreakdown 新增 `parentCampaignId?` 字段（如选方案 A） |
| `backend/src/services/marketsApiSerialize.ts` | **无需改** | TARGET_TOTAL_APR 转换不再对 V4 Spoke 触发，自然透传 |
| `backend/src/services/merklForecastService.ts` | **验证** | 确认 Dutch Auction forecast 参数正确 |
| `docs/adr/0030-merkl-campaign-parent-child-relationships.md` | **更新** | 修正决策和理由 |

---

## 5. 不受影响的部分

| 部分 | 原因 |
|------|------|
| V3 campaign | V3 是单 campaign（无 Hub/Spoke），不受影响 |
| `computeTargetTotalAprIncentiveApr` 函数 | 保留，V3 可能仍需要 |
| 前端 | `campaignApr` 语义不变（Merkl reward APR），只是数值更准确 |
| Brevis campaign | 不涉及 Hub/Spoke 结构 |

---

## 6. 测试计划

### 6.1 单元测试

1. **去重逻辑测试**：
   - Hub + Spoke parent-child + 同 reserve → 保留 Spoke，移除 Hub
   - Hub + Spoke 非parent-child + 同 reserve → 两者都保留
   - 只有 Hub → 保留 Hub
   - 只有 Spoke → 保留 Spoke

2. **Spoke 参数透传测试**：
   - Spoke campaignApr = incentiveAPR，经 scaleMerklBreakdown 后 = incentiveAPR × 100
   - 不依赖 supplyApy

### 6.2 集成测试

1. **实际 V4 reserve 数据**：验证 USDG/frxUSD 等 V4 reserve 的 merklSupplys 显示 Spoke 的 incentiveAPR
2. **supplyApy 缺失场景**：模拟 RPC fallback（supplyApy = undefined），验证 Merkl APR 仍正确（= Spoke incentiveAPR）
3. **Forecast 验证**：验证 Dutch Auction campaign 的 forecast 参数（totalBudget, plannedDaily）正确

### 6.3 回归测试

1. `npm run ci:remote` 全量通过
2. V3 reserve 的 Merkl campaign 不受影响
3. 现有 `marketsApiSerialize.test.ts` 测试通过（可能需更新部分断言）

---

## 7. ADR-0030 修正要点

| 原 ADR 内容 | 修正为 |
|------------|--------|
| 过滤 Spoke 保留 Hub | parent-child 重叠时保留 Spoke，否则各自保留 |
| Hub provides correct APR | Spoke provides actual incentive APR (Dutch Auction result) |
| Spoke APR understates actual rewards by ~5% | Spoke APR = actual Merkl reward APR (Hub APR = targetAPR 含 native) |
| Hub distributes full incentive budget | Spoke distributes actual user rewards; Hub forwarding mirrors Spoke |

---

## 8. 实施顺序

1. 扩展 `MerklCampaignDetails` + `MerklCampaignBreakdown` 增加 `parentCampaignId`
2. 移除 Spoke 过滤块（[merkl-api.ts:1448-1455](file:///Users/pabloli/Documents/code/aave-protocol-analysis/packages/aave-fetcher/src/merkl-api.ts#L1448-L1455)）
3. 实现 `deduplicateHubSpokeOverlap` 去重函数
4. 在 `findMatchingMerklOpportunities` 中调用去重
5. 验证 forecast 对 Dutch Auction 的处理
6. 更新测试
7. 更新 ADR-0030
8. `npm run ci:remote` 全量验证

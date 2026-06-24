# PRD: AAV-959 — Merkl V4 Hub/Spoke: Spoke-Priority Dedup

## 问题陈述

当前代码（ADR-0030）过滤 Spoke、保留 Hub，然后后端通过 `computeTargetTotalAprIncentiveApr(targetAPR, nativeAPY, side)` 将 Hub 的 targetAPR 转换为 incentiveAPR。

**问题**：
1. 转换依赖 `reserve.supplyApy`（nativeAPY），但 V4 的 supplyApy 来自 SDK，**RPC fallback 不提供 supplyApy**
2. SDK 故障走 RPC fallback 时，所有 V4 reserve 的 supplyApy = undefined → `scaleMerklBreakdown` 走 fallback 分支，显示 targetAPR（偏高 nativeAPY）
3. 转换逻辑是间接的、脆弱的——Spoke 的 apr 本身就是 incentiveAPR，无需转换

**核心决策**：当 Hub 和 Spoke 是 parent-child 关系且匹配同一 V4 reserve 时，用 Spoke 代替 Hub。Spoke 是 Dutch Auction，直接使用自己的参数（campaignApr = incentiveAPR），不注入 Hub 的 targetAPR。

## 数据事实（API 验证 2026-06-25）

### `parentCampaignId` 是 top-level 字段（非 `params` 内）

```
GET /v4/campaigns/5055509984402346017 (Spoke):
  parentCampaignId = "11526583104559356735"  ← top-level
  rootCampaignId   = "11526583104559356735"
  childCampaignIds = []
  distributionType = "DUTCH_AUCTION"
  type             = "AAVE_V4_SPOKE_SUPPLY"

GET /v4/campaigns/11526583104559356735 (Hub):
  parentCampaignId = null
  rootCampaignId   = null
  childCampaignIds = ["13451611881162841856", "5055509984402346017"]
  distributionType = "AAVE_V4_NET_APR"
  type             = "AAVE_V4_HUB_SUPPLY"
```

### APR 语义

| 字段 | Hub | Spoke |
|------|-----|-------|
| `apr` | 6.77% = targetAPR（含 nativeAPY） | 6.48% = incentiveAPR（纯 Merkl reward） |
| `campaignType` (normalized) | TARGET_TOTAL_APR | DUTCH_AUCTION |
| `scaleMerklBreakdown` 行为 | 需转换（依赖 nativeAPY） | 直接透传 `campaignApr × 100` |

### Forecast 行为

- DUTCH_AUCTION 不在 `needsAprCap` 列表中 → `aprCap = null`
- Forecast 使用 Spoke 自有参数（totalBudget = Spoke budget, plannedDaily = budget/duration）
- 无需修改 forecast 代码

## 设计决策

### D1: 去重在 breakdown 级（index.ts），非 opportunity 级

**理由**：一个 Hub opportunity（explorerAddress = underlying token）可以聚合多个 creator 的 campaign。如果只有一个 campaign 是某 Spoke 的 parent，丢弃整个 Hub opportunity 会丢失其他独立 creator 的 campaign。

**实现位置**：`packages/aave-fetcher/src/index.ts` — 在 `matchedOpportunities` 循环收集 breakdowns 后，移除 parent Hub breakdowns。

### D2: `parentCampaignId` 从 top-level 提取（非 `params`）

`fetchMerklCampaignDetails` 中：`campaign.parentCampaignId`（top-level 字段），不是 `campaign.params.parentCampaignId`。

### D3: `parentCampaignId` 添加到 `MerklCampaignDetails` + `MerklCampaignBreakdown`

- `MerklCampaignDetails`：`fetchMerklCampaignDetails` 返回时携带
- `MerklCampaignBreakdown`：构建 breakdown 时从 `campaignDetails.parentCampaignId` 填充
- 去重逻辑通过 breakdown 的 `parentCampaignId` 判断 parent-child 关系

### D4: Hub-only reserves 保留 Hub + TARGET_TOTAL_APR 转换

如果一个 V4 reserve 的 spokeAddress 没有匹配到任何 LIVE Spoke opportunity，保留 Hub。Hub 的 `campaignType = TARGET_TOTAL_APR`，`scaleMerklBreakdown` 仍走转换路径（需要 supplyApy）。这是可接受的 fallback——仅在 Spoke 不 LIVE 时触发。

### D5: 移除 Spoke 过滤块

删除 `merkl-api.ts` 中 `isV4SpokeOpportunity` 的 `continue` 过滤块，让 Spoke opportunity 正常处理并索引。

### D6: `isV4SpokeOpportunity` 函数保留

函数本身保留（测试和去重逻辑中使用），仅移除过滤块的调用。

## 实现范围

| 步骤 | 文件 | 变更 |
|------|------|------|
| 1 | `packages/aave-shared-contracts/src/index.ts` | `MerklCampaignBreakdown` 新增 `parentCampaignId?: string` |
| 2 | `packages/aave-fetcher/src/merkl-api.ts` | `MerklCampaignDetails` 新增 `parentCampaignId?: string` |
| 3 | `packages/aave-fetcher/src/merkl-api.ts` | `fetchMerklCampaignDetails` 提取 `campaign.parentCampaignId`（top-level） |
| 4 | `packages/aave-fetcher/src/merkl-api.ts` | 构建 breakdown 时填充 `parentCampaignId: campaignDetails.parentCampaignId` |
| 5 | `packages/aave-fetcher/src/merkl-api.ts` | 移除 Spoke 过滤块（`isV4SpokeOpportunity` continue） |
| 6 | `packages/aave-fetcher/src/index.ts` | 在 `matchedOpportunities` 循环后新增 `deduplicateHubSpokeBreakdowns` |
| 7 | 测试 | 去重逻辑单元测试（4 场景） |
| 8 | 测试 | 更新 `findMatchingMerklOpportunities.test.ts`（Spoke 不再被过滤） |
| 9 | `docs/adr/0030-merkl-campaign-parent-child-relationships.md` | 修正 Decision 和 Implementation 段 |

### 去重逻辑伪代码（步骤 6）

```typescript
// 在 index.ts 中，收集完所有 breakdowns 后
function deduplicateHubSpokeBreakdowns(
  supplyBreakdowns: MerklCampaignBreakdown[],
  borrowBreakdowns: MerklCampaignBreakdown[],
  supplyGroups: MerklOpportunityGroup[],
  borrowGroups: MerklOpportunityGroup[],
): void {
  // 1. 收集所有 Spoke breakdown 的 parentCampaignId
  const spokeParentIds = new Set<string>();
  for (const bd of [...supplyBreakdowns, ...borrowBreakdowns]) {
    if (bd.parentCampaignId) {
      spokeParentIds.add(bd.campaignId); // Spoke 自己的 campaignId
    }
  }
  // 反向：收集被替代的 Hub campaignId 集合
  const replacedHubIds = new Set<string>();
  for (const bd of [...supplyBreakdowns, ...borrowBreakdowns]) {
    if (bd.parentCampaignId && spokeParentIds.has(/* spoke campaign */)) {
      replacedHubIds.add(bd.parentCampaignId);
    }
  }
  // 2. 从 flat arrays 和 groups 中移除 Hub breakdowns whose campaignId ∈ replacedHubIds
  // 注意：同时更新 supplyBreakdowns, supplyGroups.breakdowns 等
}
```

> 实现时需同时更新 flat breakdown arrays（CSV 用）和 grouped opportunity arrays（JSON 用）。

## 不做的事

- 不修改 `scaleMerklBreakdown`（Spoke 是 DUTCH_AUCTION，自然走透传分支）
- 不修改 `merklForecastService.ts`（DUTCH_AUCTION 不需要 aprCap）
- 不修改 `computeTargetTotalAprIncentiveApr` 函数（V3 和 Hub-only 仍需要）
- 不修改前端（`campaignApr` 语义不变，数值更准确）

## 验收标准

1. V4 reserve 同时匹配 Hub + Spoke（parent-child）时，merklSupplys 只含 Spoke breakdown（incentiveAPR），不含 parent Hub breakdown
2. V4 reserve 只匹配 Hub（无 Spoke）时，保留 Hub breakdown（targetAPR + 后端转换）
3. 不相关的 Hub campaign（非 parent）保留在 breakdowns 中
4. Spoke breakdown 的 `campaignApr` = incentiveAPR，经 `scaleMerklBreakdown` 后 = incentiveAPR × 100（不依赖 supplyApy）
5. `parentCampaignId` 字段在 API payload 中 omitempty（非 Spoke breakdown 不含此字段）
6. `npm run ci:remote` 通过
7. dev server 验证：USDG/frxUSD V4 reserve 的 merklSupplys 显示 Spoke incentiveAPR

## 关联

- AAV-959: Hub/Spoke double-counting fix（本 PRD）
- ADR-0030: 需修正（filter Spoke → spoke-priority dedup）
- 研究 handoff: `docs/plans/handoff-merkl-hub-spoke-research.md`
- 实施 handoff: `docs/plans/handoff-merkl-spoke-priority-implementation.md`

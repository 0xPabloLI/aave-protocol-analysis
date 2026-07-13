# Handoff: Campaign Breakdown 格式 + Ended Campaign 位置变化 + 全链路审计

> **Status: Executed** (2026-07-06) — `lastEndedCampaign` 内嵌已实现（8 处代码引用），P0/P1/P2 已修复。P3/P5 测试补充未做。

## 1. Campaign Breakdown 当前格式

### 1.1 旧格式（AAV-1044 之前）

Ended campaign 作为**独立 stub breakdown** 混入 `breakdowns` 数组：

```jsonc
{
  "link": "https://app.merkl.xyz/opportunities/123",
  "breakdowns": [
    { "campaignId": "hash_a", "campaignApr": 0.05, "rewardTokenSymbol": "USDC", /* live */ },
    { "campaignId": "hash_b", "campaignApr": 0,    "rewardTokenSymbol": "USDC", /* stub for ended */ }
  ]
}
```

- Stub breakdown 特征：`campaignApr: 0`，只有 `campaignId`/`rewardTokenSymbol`/日期字段
- 前端需要 `partition` 拆分 live/ended，再按 `rewardTokenSymbol` re-join
- 多个 ended campaign 同 `rewardTokenSymbol` 时全部保留

### 1.2 新格式（AAV-1044 之后）

Ended campaign 信息**内嵌为嵌套对象**到匹配的 live breakdown 上：

```jsonc
{
  "link": "https://app.merkl.xyz/opportunities/123",
  "opportunityId": "123",
  "breakdowns": [
    {
      "campaignId": "hash_a",
      "campaignApr": 0.05,
      "rewardTokenSymbol": "USDC",
      "lastEndedCampaign": {
        "startedAt": "2026-06-01T00:00:00Z",
        "endedAt": "2026-06-28T00:00:00Z",
        "campaignId": "hash_b"
      }
    }
  ]
}
```

- 无独立 stub breakdown，`breakdowns` 中只有 live campaign
- `lastEndedCampaign` 仅在同 `rewardTokenSymbol` 的 live breakdown 上出现
- 每个 live breakdown 最多嵌入**一个** ended campaign（最近结束的那个）
- Ended campaign URL 前端拼接：`${oppLink}/campaigns/${lastEndedCampaign.campaignId}`
- Live campaign URL 前端拼接：`${oppLink}/campaigns/${breakdown.campaignId}`
- 两者构造方式完全对齐，后端只传 ID，不传 URL

### 1.3 MerklCampaignBreakdown 完整字段

```typescript
// @internal/aave-shared-contracts
interface MerklCampaignBreakdown {
  campaignId: string;                    // Hash ID (R1)
  campaignApr: number;                   // APR 百分比
  campaignStartedAt?: string;            // ISO timestamp
  campaignEndedAt?: string;              // ISO timestamp
  rawDistributionType?: string;          // 分布类型
  rawMode?: string;                      // 分布模式
  budgetBoundMode?: string;              // TARGET_TOTAL_APR 模式
  rewardTokenSymbol?: string;            // 奖励代币符号
  rewardTokenIconUrl?: string;           // 奖励代币图标
  message?: string | Record<string, unknown> | unknown[];
  parentCampaignId?: string;             // V4 spoke 父 campaign
  positionCap?: number;                  // 仓位上限 (USD)
  pointsPerThousandUsd?: number;         // 积分强度
  pointsRewardToken?: string;            // 积分代币
  pointsTokenIconUrl?: string;           // 积分代币图标
  // AAV-1044 — lastEndedCampaign inline embedding
  lastEndedCampaign?: {
    startedAt: string;             // 最近结束 campaign 的开始时间
    endedAt: string;               // 最近结束 campaign 的结束时间
    campaignId: string;            // 最近结束 campaign 的 Hash ID
  };
}
```

### 1.4 范围限制

**当前仅 Merkl 支持 `lastEndedCampaign` 字段**。`MeritCampaignBreakdown` 和 `BrevisCampaignBreakdown` 上没有这些字段：
- 后端 `merit-api.ts` 有 `filterRecentExpiredMeritCampaigns()` 过滤逻辑，但未将 ended 信息嵌入 breakdown
- 后端 `brevis-api.ts` 有 `filterRecentExpiredBrevis()` 过滤逻辑，同样未嵌入
- 前端 `RecentlyEndedSection` 只能收集到 Merkl 来源的 ended campaign

---

## 2. 全链路审计：ended campaign 位置变化影响

### 2.1 后端数据流

```
merkl-api.ts::formatMerklBreakdown()
  → 构建 live breakdowns (L1530-1559)
  → inline embedding: endedBySymbol Map → breakdown.lastEndedCampaign (L1561-1595)
  → filterRecentExpiredCampaigns() (L1618) ✅ 只返回 active breakdowns（P0 已修复）
  → 返回 filteredBreakdowns

incentive-prune.ts::pruneMerklGroup()
  → 透传 lastEndedCampaign 嵌套对象 (L53)

marketsApiSerialize.ts::scaleGroupedCampaigns()
  → spread 透传所有字段，包括 lastEndedCampaign ✅
  → computeSchemaFingerprint 已补 lastEndedCampaign (P2 已修复) ✅

API response
  → MerklCampaignBreakdown 包含 lastEndedCampaign 字段 ✅
```

### 2.2 前端数据流

```
API response → Zod schema 验证 (schemas.ts)
  → lastEndedCampaign z.object({ startedAt, endedAt, campaignId }).optional() ✅

IncentiveTooltip.tsx::buildIncentiveSources()
  → Merkl breakdown 遍历 → 读取 campaignId, lastEndedCampaign → 构建 IncentiveCampaign ✅
  → 无 partition/re-join 逻辑 ✅

IncentiveCampaign 类型
  → lastEndedCampaign?: { startedAt, endedAt, campaignId } 嵌套对象 ✅
  → 旧的 endedCampaigns 数组已删除 ✅

RecentlyEndedSection (L148-339)
  → 遍历 incentiveSources → 检查 campaign.lastEndedCampaign ✅
  → 日期范围：lastEndedCampaign.startedAt – lastEndedCampaign.endedAt ✅
  → URL 构造：sourceLink + /campaigns/ + lastEndedCampaign.campaignId ✅
```

---

## 3. 需要修复的问题

### P0 — ✅ 已修复：filterRecentExpiredCampaigns 双重输出

**文件**: `packages/aave-fetcher/src/merkl-api.ts` L1618, L1750-1755

**修复**: `filterRecentExpiredCampaigns` 对 Merkl 现在只返回 active breakdowns，不再保留 ended breakdown 作为独立条目。ended 信息已通过 `lastEndedCampaign` 内嵌字段传达。

**测试**: `packages/aave-fetcher/tests/filterRecentExpiredCampaigns.test.ts` 已更新，5 个 Merkl 测试用例验证只返回 active breakdowns。

### P1 — ✅ 已修复：OpenAPI schema 补 lastEndedCampaign

**文件**: `backend/static/openapi.json` L1325-1333

**修复**: 在 `MerklCampaignBreakdown` 中添加了 `lastEndedCampaign` 嵌套对象定义。

### P2 — ✅ 已修复：Schema fingerprint 补 lastEndedCampaign

**文件**: `backend/src/services/marketsApiSerialize.ts` L222-241

**修复**: canonical Merkl breakdown 中添加了 `lastEndedCampaign: { startedAt: '2025-01-01', endedAt: '2025-01-01', campaignId: '__fingerprint__' }`。

### P3 — 后端序列化层缺少 lastEndedCampaign 透传测试

**文件**: `backend/tests/marketsApiSerialize.test.ts`

**问题**: 无测试验证 `lastEndedCampaign` 在 `serializeReserveForApi` 后正确透传。

**修复**: 新增测试用例，构造含 `lastEndedCampaign` 的 Merkl breakdown，验证序列化输出中字段存在且值正确。

### P4 — 前端 RecentlyEndedSection 测试完全缺失

**文件**: `aaveapy/src/components/dashboard/IncentiveTooltip.test.tsx`

**问题**: 997 行测试中无任何 `recentlyEnded`/`RecentlyEndedSection` 相关测试用例。

**修复**: 至少补充：
- 有 `lastEndedCampaign` 时，RecentlyEndedSection 渲染正确
- 无 `lastEndedCampaign` 时，RecentlyEndedSection 返回 null
- ended campaign URL 正确拼接（`sourceLink + /campaigns/ + lastEndedCampaign.campaignId`）

### P5 — inline embedding 逻辑无独立单元测试

**文件**: `packages/aave-fetcher/src/merkl-api.ts` L1561-1595

**问题**: 核心内嵌逻辑（按 `rewardTokenSymbol` 匹配 ended campaign 并写入 `breakdown.lastEndedCampaign`）没有独立的单元测试。

**修复**: 新增测试验证：
- 同 `rewardTokenSymbol` 的 ended campaign 被内嵌到 live breakdown 的 `lastEndedCampaign`
- 不同 `rewardTokenSymbol` 的 ended campaign 不被内嵌
- 多个 ended campaign 取最近结束的那个
- 缺少 `rewardTokenSymbol` 时不内嵌

---

## 4. 已确认无需修改的位置

| 位置 | 原因 |
|---|---|
| `merklForecastService.ts` / `merklForecastController.ts` | forecast 按 campaignId 逐条处理，不关心 breakdown 是否为 stub。只处理 live campaign（从 markets snapshot 的 campaignIds 收集），不涉及 recentlyEnded |
| `collectCampaignIdsFromMarkets` | 遍历 breakdowns 取 campaignId，ended campaign 的 campaignId 不会被取到（前端 `isCampaignActive` 过滤 + 后端 `filterRecentExpiredCampaigns` 拆分） |
| `scaleGroupedCampaigns` / `scaleGroupedCampaignsWithContext` | 泛型缩放，只改 `campaignApr`，其他字段 spread 透传，包括 `lastEndedCampaign` |
| `deduplicateHubSpokeBreakdowns` | 按 campaignId 做 Hub/Spoke dedup，与 ended embedding 无关 |
| `persistenceService.ts` Merkl breakdown 哈希 | 仅用 `bd.campaignId` 作为 key，用于变更检测和 SUM 聚合，不直接影响 API payload |
| 前端 `isCampaignActive` 过滤 | 所有 breakdown 遍历都用 `isCampaignActive` 过滤，ended breakdown（`campaignEndedAt < now`）被正确排除 |
| 前端 campaign URL 构造 | Live 和 ended 都用前端拼接模式，已统一 |
| 前端 `IncentiveCampaign` 类型 | 已迁移为 `lastEndedCampaign` 嵌套对象，无旧数组/标量模式残留 |

---

## 5. Merit / Brevis recentlyEnded 扩展（可选）

当前 `lastEndedCampaign` 字段仅存在于 `MerklCampaignBreakdown`。如果 Merit / Brevis 也需要 recently ended 展示：

**后端改动**:
1. 在 `@internal/aave-shared-contracts` 的 `MeritCampaignBreakdown` 上添加 `lastEndedCampaign?` 嵌套对象
2. 在 `merit-api.ts` 的 `buildCampaignGroupFromMeritEntry` 中，将 `filterRecentExpiredMeritCampaigns` 过滤结果嵌入到匹配的 live breakdown
3. Brevis 同理
4. `incentive-prune.ts` 对应透传

**前端改动**:
1. `schemas.ts` 中 `MeritCampaignBreakdownSchema` / `BrevisCampaignBreakdownSchema` 添加 `lastEndedCampaign` 嵌套对象
2. `types/aave.ts` 中 `MeritCampaignBreakdown` / `BrevisCampaignBreakdown` 添加字段
3. `IncentiveTooltip.tsx` Merit / Brevis 遍历中透传 `lastEndedCampaign` 到 `IncentiveCampaign`

**优先级**: 低。Merit ended campaign 的业务需求不明确，Brevis 几乎没有 ended 场景。

---

## 6. Commit 记录

| 改动 | Backend Commit | Frontend Commit |
|---|---|---|
| R1-R5 主 PRD | 90348a2, 84836ab, ed7c8f9, c3f65224 | fbfe6474, c3f65224 |
| AAV-1044 修正 PRD | 52246d7 | b3dcd7c9 |
| lastEndedCampaign 重命名 + P0/P1/P2 修复 | 8cc10b2 | 0e1edfb2 |
| Forecast 404 根因修复（numeric campaignId 泄漏） | d68d4db | — |

---

## 7. Forecast 404 根因修复

**问题**: `collectCampaignIdsFromMarkets` 收集到数字型 campaignId（如 `6680697098953960383`），Merkl `/v4/campaigns/{id}/metrics` 端点返回 404。

**根因**: Merkl V4 API 的 `campaign.campaignId` 字段并非总是 `0x` hash ID。DUTCH_AUCTION 等类型的 `campaignId` 是数字型内部 ID（如 `10768955319320541400`），而 Merkl 的 metrics 端点需要原始 DB ID（如 `7587760385108365908`）。

**数据流**:
1. `rewardsRecord.breakdowns[].campaignId` = DB ID (`7587760385108365908`)
2. `fetchMerklCampaignDetails(dbId)` → Merkl 返回 `campaignId: "10768955319320541400"`（数字型，非 0x）
3. 旧代码：`hashId = campaign.campaignId` → `"10768955319320541400"` 写入 `breakdown.campaignId`
4. Forecast 用 `10768955319320541400` 请求 `/metrics` → 404

**修复**: `fetchMerklCampaignDetails` 中，只有 `campaign.campaignId` 以 `0x` 开头时才用作 hashId，否则 fallback 到 `databaseId`（DB ID 与 Merkl campaigns + metrics 端点兼容）。

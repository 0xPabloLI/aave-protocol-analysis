# Handoff: Campaign Hash ID Migration + Recently Ended + Merkl URL Simplification

> **Status: Executed** (2026-07-06) — R1-R5 全部完成。

## PRD

`docs/plans/prd-campaign-hash-id-migration-and-recently-ended-embedding.md`

## 完成状态

| Requirement | Status | Commit (Backend) | Commit (Frontend) |
|---|---|---|---|
| R1: Campaign Hash ID Migration | ✅ Done | 90348a2 | — (类型同步) |
| R2: Recently Ended Embedding | ✅ Done | — | fbfe6474 |
| R3: Remove PAST Opportunities Fetch | ✅ Done | 90348a2 | — |
| R4: Campaign URL + Remove campaignDatabaseId | ✅ Done | 84836ab | fbfe6474 |
| R5: Merkl URL Simplification | ✅ Done | ed7c8f9 | c3f65224 |
| AAV-1044: opportunityId type fix + CampaignGroup.opportunityType cleanup + inline embedding | ✅ Done | 52246d7 | b3dcd7c9 |

## R5 实现细节

### 后端改动 (ed7c8f9)

- `MerklOpportunityData.opportunityLink` → `opportunityId`（从 `opp.id` 生成）
- `MerklOpportunityGroup` 新增 `opportunityId?: string`
- `pruneMerklGroup`: 输出 `opportunityId`，`link` 从 `opportunityId` 生成（`https://app.merkl.xyz/opportunities/{opportunityId}`），移除 `opportunityType` 输出
- `index.ts`: `oppBase` 统一构建，移除旧 `if (opp.opportunityLink) { ... } else { ... }` 分支，改为无条件推入 supply/borrow/hold
- `formatMerklBreakdown`: 改用 `opportunityId` 分组
- `netPositionConstraint` cache key: `opportunityLink` → `opportunityId`
- CSV 格式化: `link:` → `oppId:`
- 测试文件: `opportunityTypePassthrough.test.ts` → `opportunityIdPassthrough.test.ts`, `borrowBlacklist.test.ts`, `deduplicateHubSpokeBreakdowns.test.ts`, `incentive-prune.test.ts` 均已更新

### 前端改动 (c3f65224)

- `CampaignGroup.opportunityType` → `opportunityId`
- `getMerklLink()` → `getMerklOppLink()`（从 `opportunityId` 构造 URL）
- Campaign URL: `https://app.merkl.xyz/opportunities/${opportunityId}/campaigns/${campaignId}`
- 测试文件: `field-canary.test.ts`, `useRateSimulation.test.ts` 更新

### 注意事项

- `CampaignGroup.link` 是基类必填字段 (`link: string`)，不能设为 undefined。Merkl group 在无 `opportunityId` 时输出 `link: ''`
- `opportunityType` 已从 `CampaignGroup` 基类移除（AAV-1045），仅在 `MerklOpportunityGroup` 子接口和 `MerklOpportunityData` 内部类型中保留，用于 hub/spoke 分类、offsetLevel 判断、netPositionConstraint 检测
- `identifier` 仍用于 `isBorrowBl` 检测（`opp.identifier?.includes('BORROW_BL')`），只是不再输出到 API

## 未提交的后端文件（非 R5）

以下文件有改动但未提交，属于其他 session 的工作：

- `packages/aave-fetcher/src/merklLlmClient.ts` — LLM model list 从虚构模型改为真实 SiliconFlow free models（`LLM_FALLBACK_MODELS` → `LLM_FREE_MODELS`），添加 `enable_thinking: false` 参数，`?sub_type=chat` 过滤，动态 primary models 交集
- `packages/aave-fetcher/tests/merklLlmClient.test.ts` — 对应 LLM 改动的测试更新
- `backend/src/cacheTtl.ts` — 注释更新（persist interval 说明）
- `backend/src/services/persistenceService.ts` — `PERSIST_INTERVAL_MS` 默认值从 1min → 5min（减少 WAL/PITR egress ~80%）
- `backend/src/services/updateScheduler.ts` — 注释更新
- `.gitignore` — 添加 `.playwright-cli/`

## 发现的问题：V3 数据丢失

### 现象

Staging API 只返回 V4 数据（63 条），没有 V3 数据。前端页面也看不到 V3 市场。

### 根因

**不是 R5 导致的**。问题是 Aave V3 SDK 被 rate limit（429 Too Many Requests），V3 fetch 连续超时（35s timeout 不够完成 23 条链的串行 fetch + 3 retries + backoff）。

Railway 日志证据：
```
❌ V3 fetch failed: V3 fetch timeout (timeout after 35000ms)
📊 Unified dataset: 63 reserves (V3: 0, V4: 63)
✅ Markets refresh: 63 reserves (V3:194/stale, V4:63/fresh)
```

### Stale fallback 失效原因

`mergeWithPartialStale()` 中，V3 stale fallback 的条件是 `v3FetchedAt !== null && (now - v3FetchedAt) <= hardTtlMs`。`hardTtlMs = 5min`，V3 连续超时超过 5 分钟后 stale 过期，不再被 merge。但 stale cache 中仍有 194 条 V3 数据（`newStaleV3Data.length = 194`）。

### 建议修复

1. **临时**：增大 `marketsHardTtlMs` 从 5min → 30min。5min 对上游长时间不可用的场景太短，stale 应该在更长时间内仍能提供数据
2. **长期**：V3 per-chain 并发（当前 23 条链串行是瓶颈）。可分 batch 并发（如 5 条一组），减少总耗时。但改动较大

### V3 已有的优化

之前已做过以下优化（非本次 session）：
- V3/V4 并发 fetch（`Promise.allSettled`），各自 35s 独立 timeout
- per-side stale merge（`mergeWithPartialStale`）
- LLM circuit breaker
- 递增延迟重试（2s/4s/6s）

V3 SDK 内部仍然是**逐链串行**调用，这是当前瓶颈。23 条链 × 3 retries × 最多 12s backoff = 理论最差 ~276s，远超 35s timeout。

## 前端未提交的文件

- `public/openapi.json` — schema fingerprint 变化（自动生成）
- `src/components/dashboard/PortfolioPanel.tsx` — 非 R5 改动
- `src/components/dashboard/PortfolioTokenRowPrototype.tsx` — 新文件，非 R5

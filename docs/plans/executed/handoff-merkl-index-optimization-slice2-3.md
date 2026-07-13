# Handoff: Merkl Index 优化 — Slice 2+3 归档

> **Status: ARCHIVED** — Slice 2/3 的所有目标已通过不同实现方式完成。本文档保留作为历史参考。

## 最终 Commit

`ee08baa` — docs(adr-0023): update USDtb opp #6 with borrowBlacklist autodetect (AAV-958)

## 完成状态总览

| Handoff 项目 | 原始方案 | 实际实现 | 状态 |
|---|---|---|---|
| tokenAddrToReserveId 多值映射 | `Map<string, string[]>` | 删除 tokenAddrToReserveId，匹配用索引直接查找 | ✅ AAV-927 Canceled |
| 索引 key 加入 hub 维度 | 改 indexKey 为 `chainId:token:hub` | 不改 indexKey，在 `findMatchingMerklOpportunities` 中用 reserveId 精确匹配 | ✅ AAV-926 Done |
| offsetLevel 默认值改 'spoke' | 默认值 `'hub'→'spoke'` | 类型改为 `'reserve'|'hub-cross-spoke'`，按 opportunityType 确定性映射 | ✅ ADR-0032 |
| Hub/Spoke 去重 | 未提及 | `deduplicateHubSpokeBreakdowns` 用 `parentCampaignId` breakdown 级去重 | ✅ AAV-1004 |
| BORROW_BL 检测 | 未提及 | `borrowBlacklist` 字段 + 双路径检测（identifier + hookType=14） | ✅ AAV-958 |
| V4 Spoke 索引用 underlying | 未提及 | `isV4Spoke && opp.tokens[0].address` 替代 spoke pool address | ✅ 578597a |
| filterByCampaignContext | 新函数 | 不需要 — 用 reserve ID 精确匹配替代 | ❌ 不需要 |
| enrichDataset 简化 | `merklData[reserveId]` | 不需要 — `findMatchingMerklOpportunities` 内部做了精确过滤 | ❌ 不需要 |
| composedMultiplier | 未提及 | 先实现后移除 (YAGNI) | ✅ AAV-948 |

## 关键实现细节

### findMatchingMerklOpportunities 的 V4 reserve ID 精确匹配

```typescript
// merkl-api.ts L1981-1991
if (isV4 && item.reserveId) {
  if (opp.spokePoolAddress && opp.underlyingTokenAddress && opp.hubContractAddress) {
    // Spoke: 构造完整 4-segment reserveId 比对
    const constructedReserveId = `${item.chainId}:${opp.spokePoolAddress}:${opp.underlyingTokenAddress}:${opp.hubContractAddress}`;
    if (constructedReserveId !== item.reserveId) continue;
  } else if (opp.underlyingTokenAddress && opp.hubContractAddress) {
    // Hub: 匹配 underlyingToken + hubAddress
    if (opp.underlyingTokenAddress !== item.tokenAddress.toLowerCase()) continue;
    if (item.hubAddress && opp.hubContractAddress !== item.hubAddress.toLowerCase()) continue;
  }
}
```

### opportunityData 携带的 V4 campaign 参数

```typescript
// merkl-api.ts L1553-1559
const underlyingTokenAddress = typeof firstParams?.underlyingToken === 'string'
  ? firstParams.underlyingToken.toLowerCase() : undefined;
const spokePoolAddress = typeof firstParams?.spokeAddress === 'string'
  ? firstParams.spokeAddress.toLowerCase() : undefined;
const hubContractAddress = typeof firstParams?.hubAddress === 'string'
  ? firstParams.hubAddress.toLowerCase() : undefined;
```

### OffsetLevel 确定性映射（ADR-0032）

| opportunityType | offsetLevel | Reason |
|---|---|---|
| `AAVE_V4_SPOKE_SUPPLY` | `'reserve'` | 有全部 4 段，offset 精确匹配 |
| `AAVE_V4_HUB_SUPPLY` | `'hub-cross-spoke'` | 缺 spokeAddress，跨 spoke 匹配 |
| `AAVE_NET_*` (V3) | `'reserve'` | pool 内精确匹配 |
| `AAVE_V4_NET_APR` | `'hub-cross-spoke'` | 同 HUB_SUPPLY |

### deduplicateHubSpokeBreakdowns 去重逻辑

1. 从 V4 Spoke groups 收集 `parentCampaignId`
2. 在 V4 Hub groups 中移除 `campaignId` 被引用的 breakdown
3. 独立 Hub campaign（无 Spoke 子 opp）保留

## BorrowBL 调查结论（已实现）

5 个 Merkl opportunity 包含 `BORROW_BL`，已通过 `borrowBlacklist: boolean` 字段实现。检测双路径：
1. `identifier.includes('BORROW_BL')` — 从 Merkl identifier 后缀检测
2. `hasBlacklistWithBorrowHook(opp)` — 从 `params.blacklist + hookType=14` 组合语义检测

## V4 Collateral 隔离规则（结论性）

Spoke 是隔离边界，Hub 不是。offset token 的匹配维度取决于 opportunityType 能锚定的维度（见 ADR-0032）。

## 残留风险

- **AAV-1014**: 独立 Hub campaign（无 Spoke 子 opp）的跨 hub 匹配风险。当前已被 `findMatchingMerklOpportunities` 的 hub 维度精确匹配阻止，但如果该逻辑被意外移除会重新出现。
- **7 个 multi-hub token** 在 Ethereum 上（USDC, USDT, WBTC, WETH, weETH 等），3 个不同的 Hub。

## Linear Issues

- AAV-924: PRD → **Done**（所有 User Stories 已实现）
- AAV-925: Slice 1 → **Done**
- AAV-926: Slice 2 → **Done**（实现方式与原始 AC 略有不同，见上方）
- AAV-927: Slice 3 → **Canceled**（方案变更为删除 tokenAddrToReserveId）
- AAV-928: Slice 4 — 待评估（deriveProtocolVersion 是否可进一步清理）
- AAV-906: hub-aware offset → **Done**（ADR-0032 重构为 OffsetLevel）
- AAV-908: spokeAddress in query → **Done**
- AAV-905: 多值映射 → **Canceled**（AAV-927 范畴）
- AAV-921: NPC offset hub-aware → **Done**
- AAV-1014: Hub/Spoke 双重计算风险追踪 → **Backlog**（当前已被精确匹配阻止）

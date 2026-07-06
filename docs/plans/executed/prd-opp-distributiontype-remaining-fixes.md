# PRD: opp.distributionType 残留修复 + ADR 更新 + .env 清理

> **Status: Executed** (2026-07-06) — 3 处 opp.distributionType → campaign.distributionType 均已修复。

## 背景

commit `165fade` 修复了 `processMerklData` 中 `MerklOpportunityData.distributionType` 的数据源（从 breakdown 级别提取），但以下位置仍使用 `opp.distributionType`（Merkl API opp 顶层此字段始终为空），导致功能失效。

## 修改项

### 1. [HIGH] opp.distributionType → campaign.distributionType (3 处)

**文件**: `packages/aave-fetcher/src/merkl-api.ts`

**1258 行** — `processMerklData` 中的 amount variant 预解析循环：
```ts
// 当前（错误）：
const campaignType = normalizeForecastCampaignTypeLite({ distributionType: opp.distributionType });
// 改为：
const campaignType = normalizeForecastCampaignTypeLite({ distributionType: campaign.distributionType });
```
上下文：循环遍历 `opp.campaigns`，`campaign` 是当前迭代的 campaign 对象。

**1341 行** — `processMerklData` 中的 campaignDetailsCache 构建循环：
```ts
// 当前（错误）：
const campaignType = normalizeForecastCampaignTypeLite({ distributionType: opp.distributionType });
// 改为：
const campaignType = normalizeForecastCampaignTypeLite({ distributionType: campaign.distributionType });
```

**1352 行** — 同一循环中 resolveCampaignApr 调用：
```ts
// 当前（错误）：
const resolved = resolveCampaignApr(campaign, opp.distributionType, rewardTokenPrice, targetTokenPrice);
// 改为：
const resolved = resolveCampaignApr(campaign, campaign.distributionType, rewardTokenPrice, targetTokenPrice);
```

**参考**: line 974 和 1008（`buildForecastCampaignMetaLiteMap` 中）已经正确使用 `campaign.distributionType`，这是同样的模式。

**影响**: 
- 1258: amount variant campaign 识别失效 → `FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT` / `MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT` 类型无法识别 → 价格解析跳过 → pointsPerThousandUsd 计算不准确
- 1341: campaignType 识别失效 → 同上
- 1352: APR 解析走错分支 → campaignDetailsCache 中 apr 值可能不正确

**注意**: `MerklEmbeddedCampaign` interface（line 144）没有声明 `distributionType` 字段，但 Merkl API 实际返回了该字段。可以在 interface 中添加 `distributionType?: string`，或依赖 `any` 类型访问（与 line 974 一致）。建议添加到 interface 中以增强类型安全。

### 2. [MEDIUM] ADR-0023 更新

**文件**: `docs/adr/0023-net-position-constraint-detection.md`

需要更新的内容：

1. **distributionType 数据源**: 记录 distributionType 在 Merkl API 中的实际位置（campaign/breakdown 级别，不在 opp 顶层），以及我们的提取策略（从 breakdown 取第一个非空值作为 opp 级别代表；从 campaign 取值用于 campaignDetailsCache 构建）

2. **LLM 空内容处理**: 记录 `llmAnswered` 只在成功解析后设 true 的规则，未解析内容视为 unanswered 继续尝试下一个模型

3. **OpenRouter 移除**: 记录 OpenRouter 免费模型已删除，当前只使用 primary config（LLM_API_KEY + LLM_BASE_URL）

4. **V4 HUB_SUPPLY campaign 理解修正**:
   - `distributionSettings.mode: "MAX_APR"` 是 TARGET_TOTAL_APR 的一种 **dilutive mode**，不是"规范化"
   - Merkl API **没有** `offsetTokenAddresses` 字段 — 不用浪费资源去找

### 3. [LOW] .env 清理

**文件**: `.env`

删除 `OPENROUTER_API_KEY=sk-or-v1-...` 行（OpenRouter 已从代码中移除，环境变量无用）。

## 不在本 PRD 范围

- `tokenAddrToReserveId` key 冲突 → AAV-905（需要调研 Aave Interface）
- `resolveOffsetReserveIds` V4 hub 不区分 → AAV-906（需要调研）
- AAVE_V4_SPOKE_SUPPLY 调查 → AAV-908
- `extractNetPositionConstraint` 中 1829 行的 `opp.distributionType` → 这是 `MerklOpportunityData` 上的字段，已通过 `firstDistributionType` 正确设置，无需修改

## 验证

1. `npm run test -w @internal/aave-fetcher` — 全部通过
2. `npm run ci:remote` — 全部通过
3. 构建后部署到 staging，检查 amount variant campaign 的 `pointsPerThousandUsd` 是否有值（之前可能全部为 undefined）

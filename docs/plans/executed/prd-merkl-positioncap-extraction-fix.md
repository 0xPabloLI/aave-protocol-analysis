# PRD: 修复 Merkl maxDeposit Campaign Position Cap 提取

> **Status: Executed** (2026-07-06) — `buildReserveUnderlyingLookup` 已实现，Brevis `isCombineCap: true` 已修复，DUTCH_AUCTION positionCap 提取路径已打通。

## 需求背景

后端已实现 `extractPositionCapFromCampaign`（commit 3b45f97），从 Merkl v4 campaign 的 `computeSettings.maxDeposit` 提取 position cap 并换算为 USD。但 Celo 链上实际存在的 2 个 maxDeposit campaign（USDT/WETH, `DUTCH_AUCTION` 类型）在 staging API 中不返回 `positionCap` 字段。

**根因**：`extractPositionCapFromCampaign` 需要 `targetTokenPrice` 和 `targetTokenDecimals` 才能将 raw maxDeposit 换算为 USD，但当前代码仅在 `isAmountVariant(campaignType)` 为 true 时才解析这些值。`DUTCH_AUCTION` 不在 `AMOUNT_VARIANT_TYPES` 中，导致 position cap 提取路径被阻断。

同时，Brevis breakdown 构建 `positionCap` 时缺少 `isCombineCap: true`。

## 目标与价值

**目标：**
- 修复 Merkl maxDeposit campaign 的 positionCap 提取，使 Celo USDT/WETH campaign 正确返回 positionCap
- 修复 Brevis breakdown 缺少 isCombineCap 字段
- positionCap 提取不依赖 `isAmountVariant` gate

**价值：**
- 前端 IncentiveTooltip 能正确展示 Merkl position cap 文案（"Incentive on first $X of net supply − borrow only"）
- Brevis position cap 文案能正确展示（"Incentive on first $X of combined supply + borrow only"）
- 消除 positionCap 提取对 APR 域 gate 的错误依赖

## 名词解释

- **targetToken（Merkl 上下文）**：用户存入/借出的 token。对 Aave lending 是 underlying token（如 USDT、WETH）。Merkl v4 API campaigns endpoint 不返回此字段，需从 opportunity 的 `explorerAddress` 关联 reserve 获取。
- **targetTokenPrice**：target token 的 USD 价格，用于将 raw maxDeposit 换算为 USD。来源：Aave reserve 的 `tokenPrice`。
- **targetTokenDecimals**：target token 的小数位数，用于将 raw maxDeposit 换算为 native 数量。来源：Aave reserve 的 `decimals`。
- **explorerAddress（Merkl opportunity）**：V3 opp 指向 aToken address，V4 opp 指向 underlying token address。
- **isAmountVariant**：APR 域概念，判断 campaign 的 APR 是否需要按 token price 换算。与 positionCap 提取无关。
- **maxDeposit**：Merkl computeMethod，限制每个用户的最大存入量。与 distributionType（如 DUTCH_AUCTION）正交。

## 适用范围

- 后端 `packages/aave-fetcher/src/merkl-api.ts`：positionCap 提取路径修复
- 后端 `packages/aave-fetcher/src/brevis-api.ts`：isCombineCap 字段补全
- 后端 `packages/aave-fetcher/src/index.ts`：新增 reserve lookup 构建函数
- 后端测试：新增/更新 positionCap 提取测试

## 非目标

- 不修改 `isAmountVariant` / `amountVariantPriceMap`（APR 域逻辑保持不变）
- 不修改前端代码（前端已有 isCombineCap fallback 处理，后端修复后自动生效）
- 不处理 `fetchMerklCampaignDetails`（单 campaign fetch 路径）的 positionCap 提取——该路径没有 reserve 数据，是已知限制
- 不修改 `extractPositionCapFromCampaign` 的核心逻辑（isCombineCap: false 对 Merkl 正确）

## 功能需求

- FR-1: 新建 `buildReserveUnderlyingLookup(baseDataset)` 函数，返回 `Map<string, { price: number; decimals: number }>`
  - Key 覆盖两种场景：`chainTokenKey(chainId, aTokenAddress)` (V3) + `chainTokenKey(chainId, tokenAddress)` (V4)
  - Value: `{ price: reserve.tokenPrice, decimals: reserve.decimals }`（仅当两者都有效时才存入）
- FR-2: `ProcessMerklDataOptions` 新增 `reserveUnderlyingLookup` 字段
- FR-3: `processMerklData` 入口处构建 `reserveUnderlyingLookup` 并传入 options
- FR-4: opportunities 驱动路径中（L1450-1489 的 campaign 循环），用 `opp.explorerAddress` 查 `reserveUnderlyingLookup` 获取 price 和 decimals
  - 查找方式：`lookup.get(chainTokenKey(opp.chainId, explorerAddress.toLowerCase()))`
  - 无论 `isAmountVariant` 是否为 true，都执行查找
- FR-5: `extractPositionCapFromCampaign` 签名改为 `(campaign, targetTokenPrice: number, targetTokenDecimals: number)`
  - 两个参数都必填（没有就无法换算 USD）
  - 移除内部 `campaign.targetToken` fallback（v4 API 不返回此字段，fallback 无意义）
- FR-6: `extractPositionCapFromCampaign` 调用处（opportunities 驱动路径 L1478）传入从 reserve lookup 获取的 price 和 decimals
  - 如果 lookup 查不到（非 Aave campaign），不调用 `extractPositionCapFromCampaign`，跳过 positionCap 提取
- FR-7: `brevis-api.ts` breakdown 构建时，在 `positionCap` 条件展开旁加 `isCombineCap: true`

## 关键流程/交互说明

**Position Cap 提取流程（修复后）：**

1. `processMerklData` 入口：从 `baseDataset` 构建 `reserveUnderlyingLookup`
2. 遍历 `liveOpportunities` → `opp.campaigns`
3. 对每个 campaign：
   a. 用 `opp.explorerAddress` 查 `reserveUnderlyingLookup`
   b. 如果查到 reserve 数据（price + decimals 有效）且 `computeMethod === 'maxDeposit'`：
      - 调用 `extractPositionCapFromCampaign(campaign, price, decimals)`
      - 存入 `campaignDetailsCache`
   c. 如果查不到 reserve 数据：跳过 positionCap 提取
4. APR 计算（`resolveCampaignApr`）仍走 `isAmountVariant` / `amountVariantPriceMap` 路径，不受影响

**Reserve 匹配逻辑：**
- V3 opp：`explorerAddress` = aToken address → 匹配 `reserve.aTokenAddress` → 拿 underlying price/decimals
- V4 opp：`explorerAddress` = underlying address → 匹配 `reserve.tokenAddress` → 拿 underlying price/decimals
- 非 Aave opp：`explorerAddress` 在 lookup 中查不到 → 跳过

## 风险与依赖

**风险：**
- V4 reserve 的 `aTokenAddress` 可能为 null，但 lookup 同时用 `tokenAddress` 做 key，覆盖了此场景
- `reserve.decimals` 是 optional 字段（`decimals?: number`），lookup 构建时跳过 decimals 无效的 reserve
- `fetchMerklCampaignDetails`（单 campaign fetch 路径）仍无法提取 positionCap，但该路径极少使用

**依赖：**
- `baseDataset`（Aave reserve 数据）必须在 Merkl 数据处理之前可用——当前架构已满足
- Railway staging 自动部署最新 commit 后才能验证端到端效果

## 验收标准

- [ ] Celo USDT maxDeposit campaign（DUTCH_AUCTION 类型）在 staging API 返回 `positionCap` 和 `isCombineCap: false`
- [ ] Celo WETH maxDeposit campaign 在 staging API 返回 `positionCap`
- [ ] Brevis breakdown 在 staging API 返回 `isCombineCap: true`
- [ ] `extractPositionCapFromCampaign` 新签名测试全部通过
- [ ] 新增测试：DUTCH_AUCTION + maxDeposit + reserve lookup 能正确提取 positionCap
- [ ] 新增测试：V4 reserve（aTokenAddress=null）通过 tokenAddress 也能匹配
- [ ] 新增测试：reserve lookup 查不到时不提取 positionCap（非 Aave campaign）
- [ ] 现有 `isAmountVariant` / `amountVariantPriceMap` 相关测试不受影响
- [ ] `npm run lint && npm test && npm run build && npx tsc --noEmit` 全部通过

## 待确认问题

- `fetchMerklCampaignDetails`（单 campaign fetch 路径）的 positionCap 提取是否需要在本次修复中一并处理？

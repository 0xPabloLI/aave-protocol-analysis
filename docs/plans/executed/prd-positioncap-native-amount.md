# PRD: positionCap 改为 Native Raw Amount

## 背景

当前 `positionCap` 在后端 fetch 时用 `tokenPrice` 将 native maxDeposit 换算为 USD 存储。
这导致 positionCap 值是 fetch 时刻的价格快照，而非链上固定的 native 约束值。

**问题**：
- Merkl maxDeposit 是链上固定的 native 值（如 20.15 WETH），不随价格波动
- 后端换算为 USD 后，两次 refresh 之间的价格漂移使 positionCap 不精确
- 前端 simulation 用 `positionCapUsd` 与 `supplyInputUsd` 对比，如果 cap USD 是旧价格的，simulation 结果有偏差

**解决**：positionCap 语义从 "USD 快照值" 改为 "native raw amount (string)"，前端用 reserve 的当前 `tokenPrice` + `decimals` 实时换算。

## 改动范围

### 后端（aave-protocol-analysis, branch: railway）

#### 1. 类型变更
- `BaseCampaignBreakdown.positionCap`: `number` → 删除（或保留为 computed alias）
- 新增 `BaseCampaignBreakdown.positionCapNative`: `string`（raw amount, 如 "20150000000000000000"）
- `isCombineCap` 保持不变
- OpenAPI schema 同步更新

#### 2. `extractPositionCapFromCampaign` 简化
- 不再需要 `targetTokenPrice` 参数，移除
- 仍需确认 reserve 存在（通过 `buildReserveUnderlyingLookup`），但 lookup 只需验证 "explorerAddress 对应的 Aave reserve 存在"，不需要返回 price/decimals
- 返回 `{ positionCapNative: string, isCombineCap: boolean }` 而非 `{ positionCap: number, isCombineCap: boolean }`
- `rawMaxDeposit` 直接作为 string 传出，不做大数运算（避免 JS number 精度丢失）

#### 3. `buildReserveUnderlyingLookup` 简化
- 从 `Map<string, { price: number; decimals: number }>` 简化为 `Set<string>`
- 只需验证 "chainId + explorerAddress 对应的 reserve 存在于 baseDataset"
- 不再需要 price/decimals 信息

#### 4. `ReserveUnderlyingInfo` 接口 → 删除
- `ProcessMerklDataOptions.reserveUnderlyingLookup` 类型从 `Map<string, ReserveUnderlyingInfo>` 改为 `Set<string>`

#### 5. Merit position cap
- Merit 的 position cap 来自文本提取（"$5,000"），本身就是 USD 语义
- 新增 `positionCapNative` 仅适用于 Merkl/Brevis（有链上 native 值的 source）
- Merit 保持 `positionCap` (USD) 不变，或新增 `positionCapUsd` 别名
- **决策**：Merit 的 position cap 本质是 USD（从文案 "$X" 提取），没有 native 值。为统一接口，Merit 也用 `positionCapNative` 但语义为 "USD amount string"（如 "5000"），前端根据 source 区分是否需要价格换算。

  **更优方案**：保持两个字段——`positionCapNative?: string`（Merkl/Brevis 的 raw amount）和 `positionCapUsd?: number`（Merit 的 USD 值）。前端根据哪个有值来决定用哪个。但这样增加了复杂度。

  **最终方案**：
  - `positionCapNative?: string` — Merkl/Brevis 使用，是 raw token amount
  - `positionCapUsd?: number` — Merit 使用，从文案提取的 USD 值
  - 两者互斥：同一 breakdown 不会同时有两者
  - `isCombineCap` 保持不变
  - 删除旧 `positionCap` 字段

#### 6. Brevis position cap
- Brevis 的 position cap 来自文本提取（"up to 5,000 USDC"），也是 USD 语义
- 但 Brevis 有 `isCombineCap: true`
- **决策**：Brevis 使用 `positionCapUsd`（和 Merit 一样），因为提取源就是 USD 文本
- 如果未来 Brevis API 返回 native amount，可迁移到 `positionCapNative`

#### 7. prune 函数
- `pruneMerklBreakdown`: `positionCap` → `positionCapNative`
- `pruneMeritCampaignBreakdown`: `positionCap` → `positionCapUsd`
- `pruneBrevisBreakdown`: `positionCap` → `positionCapUsd`

#### 8. `fetchMerklCampaignDetails`（单 campaign fallback 路径）
- 仍然无法提取 positionCap（没有 reserve context 确认是 Aave reserve）
- 但可以提取 `positionCapNative`——如果 `computeMethod === 'maxDeposit'`，直接取 `rawMaxDeposit` string
- 不需要 reserve lookup 确认，因为 campaign detail API 返回的数据本身就是可靠的
- **问题**：非 Aave 的 maxDeposit campaign（如 BSC TermMax）也会被提取
- **决策**：允许提取，前端会根据 reserve 匹配自然过滤

### 前端（aaveapy, branch: lovable）

#### 1. Zod schema 更新
- `positionCap: z.number().optional()` → 删除
- 新增 `positionCapNative: z.string().optional()`
- 新增 `positionCapUsd: z.number().optional()`

#### 2. `incentiveCaps.ts` 更新
- `buildPositionCapEffect` 参数：`positionCapUsd: number` 不变（内部仍用 USD 计算）
- 调用侧（`applyPositionCapToForecastResult`）需要先将 `positionCapNative` 换算为 USD
- 换算逻辑：`capUsd = Number(BigInt(positionCapNative)) / 10^decimals * tokenPrice`
- 使用 reserve 的 `tokenPrice` 和 `decimals`（已有数据）

#### 3. `rateSimulationCalculator.ts` 更新
- Merkl/Brevis 路径：`breakdown.positionCap` → 从 `breakdown.positionCapNative` 换算
- Merit 路径：`breakdown.positionCap` → `breakdown.positionCapUsd`
- 换算需要传入 reserve 的 `tokenPrice` 和 `decimals`

#### 4. `IncentiveTooltip.tsx` 更新
- campaign 构建：`positionCap` → 根据 `positionCapNative` 换算或直接用 `positionCapUsd`
- 文案渲染：`formatUsd(campaign.positionCap)` → 换算后 `formatUsd`

#### 5. `incentiveAggregation.ts` 更新
- `sumMerklIncentiveApr` 等函数中 `breakdown.positionCap` → `breakdown.positionCapNative` 换算

#### 6. `portfolioCapWarnings.ts` 更新
- `computeIncentiveAdjustToUsd` 参数 `positionCapUsd` 不变（内部仍用 USD）
- 调用侧换算

#### 7. field-canary 测试
- `src/types/field-canary.test.ts` 需要更新字段名

## 不改动的部分

- `isCombineCap` 语义和逻辑不变
- `applyPositionCap` / `applyPositionCapToForecastResult` 核心稀释逻辑不变（仍然用 USD 比较）
- 前端 simulation 的稀释公式不变
- Merit 提取逻辑不变（仍从文案提取 USD）

## 迁移策略

1. 后端同时输出 `positionCapNative` 和 `positionCapUsd`（过渡期）
2. 前端优先读 `positionCapNative`，fallback 到 `positionCapUsd`
3. 确认前端完全迁移后，后端删除旧 `positionCap` 字段

**实际方案**：直接一步到位——删除 `positionCap`，新增 `positionCapNative` 和 `positionCapUsd`。前后端同时更新。

## 测试要点

- Merkl Celo USDT: positionCapNative="1000000000"（6 decimals = 1000 USDT）
- Merkl Celo WETH: positionCapNative="20150000000000000000"（18 decimals = 20.15 WETH）
- Brevis USDC: positionCapUsd=5000
- Merit Self: positionCapUsd 从文案提取
- 前端换算精度：BigInt 运算避免 JS number 精度丢失
- isCombineCap 不变

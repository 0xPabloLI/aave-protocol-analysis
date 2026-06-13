# Handoff: TARGET_TOTAL_APR Campaign Type 实现

**日期**: 2026-06-12  
**来源 Session**: Grill with Docs — Merkl Target Total APR 研究与设计决策  
**下一步**: 写 PRD → Issues → TDD → 实现

---

## 1. 根因问题

3 个 Merkl campaign（13116567236794890552, 12662496063613214537, 8647796357084493685）**持续报 "Missing APR cap"**，每 10 分钟一次，自 2026-06-01 起未中断。

**根因**：`extractMaxApr` 只读 `distributionSettings.apr`，但 Target Total APR 类型的 APR cap 在 `distributionSettings.targetAPR` 字段。`apr` 字段在此类型中不存在。

---

## 2. 已完成的研究

### 2.1 核心发现

- Merkl 有 **4 大 Distribution Type Family**（不是 3 种）：Variable / Fixed / Capped / **Target Total APR**
- Target Total APR 有 **7 种子类型**，每种都是独立的 `distributionMethod`
- 所有 7 种的 APR cap 都在 `distributionSettings.targetAPR`（不是 `apr`）
- `mode` 字段**只有 Target Total APR 才有**，决定 budget-bound fallback 策略
- 7 种子类型**全部与 TVL 相关**（daily cost = Merkl APR × TVL）

### 2.2 7 种 Target Total APR 子类型

| # | distributionMethod | APR 公式 | 额外字段 | budget-bound mode |
|---|---|---|---|---|
| 1 | `AAVE_NET_APR` | `max(targetAPR - aaveNativeAPR, 0)` | `assetId` | `MAX_APR` |
| 2 | `AAVE_V4_NET_APR` | `max(targetAPR - aaveV4NativeAPR, 0)` | `assetId`, `hubAddress`, `side` | `MAX_APR` |
| 3 | `ERC4626_APR` | `max(targetAPR - vaultAPR, 0)` | - | `MAX_APR` |
| 4 | `ERC4626_SPREAD_CAPPED` | `min(max(targetAPR - vaultAPR, 0), cap)` | `cap` | `FIX_APR` |
| 5 | `ERC4626_TARGET_APR_WITH_MERKL` | `max(targetAPR - vaultAPR - merklOppAPR, 0)` | - | 待验证 |
| 6 | `SOFR_SPREAD_RATCHET` | `max(SOFR + spread(maxTVL) - vaultAPR, 0)` | spread tier table | 待验证 |
| 7 | `DEEL_DISTRIBUTION` | `max(0.025 - vaultAPR - merklOppAPR, 0)` | treasury address | 待验证 |

**DEEL_DISTRIBUTION** 是 ERC4626_TARGET_APR_WITH_MERKL 的特化版（target 固定 2.5% + SOFR treasury skim）。treasury skim 精确公式 Merkl 未公开。

**ERC4626_SPREAD_CAPPED** 是唯一有双重 cap 的子类型（`targetAPR` + `cap`）。

### 2.3 Budget-bound Behavior (`mode` 字段)

- **只有 Target Total APR 有 `mode` 字段**（MAX_APR / FIX_APR / DUTCH_AUCTION 不需要）
- `mode=MAX_APR` → budget 用尽后 dilutive（APR 降到 target 以下，campaign 继续）
- `mode=FIX_APR` → budget 用尽后 early-end（campaign 提前结束）
- mode 的值与 distributionMethod 同名但语义不同——mode 是 "fallback 策略"，不是分发类型
- API 路径：`campaign.params.distributionMethodParameters.distributionSettings.mode`

### 2.4 Capped Reward Rate (MAX_APR) 的 Dilutive 行为

- `APR = min(cap, budget_rate / TVL)`，`budget_rate = totalBudget / totalDays`
- **Dilutive 不是最后一天才发生**——当 TVL 超过 `budget_rate / cap` 阈值后 APR 就低于 cap，持续到结束
- 低 TVL 时预算花不完，剩余退给 creator

### 2.5 Forecast Simulation 需要的额外字段

| distributionMethod | APR cap 来源 | 额外字段 | 字段路径 |
|---|---|---|---|
| `MAX_APR` | `distributionSettings.apr` | 无 | - |
| `FIX_APR` | `distributionSettings.apr` | 无 | - |
| `DUTCH_AUCTION` | 无 | 无 | - |
| 所有 Target Total APR | `distributionSettings.targetAPR` | 见各子类型 | - |
| `ERC4626_SPREAD_CAPPED` | 同上 | `cap` | `distributionSettings.cap` |

**单位差异**：
- `targetAPR` / `distributionSettings.apr` = decimal（0.047 = 4.7%）
- top-level `apr` = percentage（4.7 = 4.7%）

### 2.6 FIX/MAX Reward AMOUNT 变体（单独 issue）

`distributionType` 有 6 种变体（`{MAX/FIX}_REWARD_{VALUE/AMOUNT}_PER_LIQUIDITY_{VALUE/AMOUNT}`），当前代码把 AMOUNT 变体全部映射到 VALUE，语义不精确。Aave 目前只有 VALUE 变体。此问题已记录为单独 issue，不阻塞本任务。

详见：`docs/plans/fix-reward-amount-variant-mapping.md`

---

## 3. 已确认的设计决策

### 决策 1：引入 `TARGET_TOTAL_APR` 作为第 4 种 `CampaignForecastType`

- 3 种现有类型：`MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE`、`FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE`、`DUTCH_AUCTION`
- 新增：`TARGET_TOTAL_APR`
- 7 种子类型统一映射到 `TARGET_TOTAL_APR`，通过 `rawDistributionMethod` 透传具体子类型

### 决策 2：APR cap 读取策略

**根据 type 选择字段路径**（type 决定读 `targetAPR` 还是 `apr`）：
- `TARGET_TOTAL_APR` → 读 `distributionSettings.targetAPR`
- `MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE` → 读 `distributionSettings.apr`
- `FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE` → 读 `distributionSettings.apr`
- `DUTCH_AUCTION` → 不需要 APR cap

**`aprCap` 语义差异**（前端按 `campaignType` 区分）：
- MAX/FIX 时：aprCap 是 Merkl 实付 APR 上限
- TARGET_TOTAL_APR 时：aprCap 是总 APR 目标（targetAPR），前端自行减去 nativeAPR 得到实付 APR

**forecast 不做 dilutive 计算**——只做 budget 估算（`requiredDaily = remainingBudget / remainingDays`），和 MAX/FIX 完全一样。dilutive 逻辑记录在文档中，由前端实现。

### 决策 3：`buildForecastState` 需要扩展 aprCap 守卫

forecast 计算逻辑对 TARGET_TOTAL_APR 与 MAX/FIX 相同，但 aprCap 验证守卫需要从二类型扩展到三类型：

```typescript
// 之前：仅 MAX/FIX
if (
  input.campaignType === 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' ||
  input.campaignType === 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
) { ... }

// 之后：MAX/FIX + TARGET_TOTAL_APR
if (
  input.campaignType === 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' ||
  input.campaignType === 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE' ||
  input.campaignType === 'TARGET_TOTAL_APR'
) { ... }
```

### 决策 4：`ERC4626_SPREAD_CAPPED` 的 `cap` 字段

Aave 当前 3 个 failing campaign 都是 `AAVE_NET_APR` / `AAVE_V4_NET_APR`，没有 `ERC4626_SPREAD_CAPPED`。`cap` 字段序列化到 lite file 中（新字段名 `spreadCap?`），以备将来使用，但 forecast 计算暂时不使用它。

### 决策 5：更新 ADR-0024（不新建 ADR）

在 ADR-0024 中更新映射表。关键修正：**删除 L3 (mode) 映射**——`mode` 是 budget-bound 策略，不是类型判断信号。原来 L3 把 `mode=MAX_APR` 映射到 `MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE` 是概念错误。

更新后的映射：
- **L1 (distributionMethod)**: 新增 7 条 Target Total APR 映射
- **L2 (distributionType)**: 新增 7 条 Target Total APR 映射（防御性，处理 distributionMethod 为空的情况）
- **L3 (mode)**: 删除。mode 不再作为类型判断信号

### 决策 6：`mode` 字段透传为 `budgetBoundMode`

`mode` 不参与类型判断，但作为 Target Total APR 的 budget-bound 策略透传给前端。`MerklCampaignBreakdown` 新增 `budgetBoundMode?: string` 字段。

### 决策 7：双侧对等修改

Fetcher 和 Backend 两侧的 aprCap 提取逻辑都需要修改：
- Fetcher: `buildCampaignSnapshotLiteForForecastFile` 序列化 `targetAPR`，`buildForecastFieldsFromOpportunity` 对 TARGET_TOTAL_APR 读 `targetAPR`
- Backend: `extractMaxApr` 改为根据 campaignType 选择读 `targetAPR` vs `apr`，`buildCampaignSnapshotLite` 序列化 `targetAPR`

---

## 4. 需要改动的代码位置

### 4.1 共享类型（`@internal/aave-shared-contracts`）

**文件**: `packages/aave-shared-contracts/src/index.ts`
- `ForecastCampaignTypeLite` 新增 `'TARGET_TOTAL_APR'` 值
- `MerklCampaignBreakdown` 新增 `budgetBoundMode?: string` 字段

### 4.2 Fetcher（`@internal/aave-fetcher`）

**文件**: `packages/aave-fetcher/src/merkl-api.ts`
- `FORECAST_LITE_METHOD_MAP` 新增 7 个 Target Total APR 映射 → `TARGET_TOTAL_APR`
- `FORECAST_LITE_DISTRIBUTION_TYPE_PATTERNS`:
  - 移除 `AAVE_NET_APR`/`AAVE_V4_NET_APR`/`ERC4626_APR` 的旧映射
  - 新增 7 条 Target Total APR 的 distributionType 映射（防御性）
- **删除** `FORECAST_LITE_MODE_MAP` 和 L3 逻辑
- `CampaignSnapshotLiteForForecastFile` interface: `distributionSettings` 新增 `targetAPR?` 和 `spreadCap?` 字段
- `buildCampaignSnapshotLiteForForecastFile` (line ~598): 序列化 `targetAPR` 和 `cap`（作为 `spreadCap`）
- `buildForecastFieldsFromOpportunity` (line ~830): TARGET_TOTAL_APR 类型提取 `targetAPR` 作为 `aprCap`
- `normalizeForecastCampaignTypeLite`: 移除 L3 mode 分支

### 4.3 Backend 运行时

**文件**: `backend/src/services/merklForecastModel.ts`
- `CampaignForecastType` 新增 `'TARGET_TOTAL_APR'`
- `METHOD_TYPE_MAP` 新增 7 个映射
- `DISTRIBUTION_TYPE_PATTERNS`: 移除 `AAVE_NET_APR`/`AAVE_V4_NET_APR`/`ERC4626_APR` 旧映射，新增 7 条防御性映射
- **删除** `MODE_TYPE_MAP` 和 L3 逻辑
- `normalizeCampaignType`: 移除 L3 mode 分支
- `buildForecastState`: aprCap 守卫扩展到三种类型（MAX/FIX/TARGET_TOTAL_APR）

**文件**: `backend/src/services/merklForecastService.ts`
- `extractMaxApr` → 改为 `extractAprCap(campaign, campaignType)`: 根据 campaignType 选择读 `targetAPR` 还是 `apr`
- `CampaignSnapshotLite` interface: `distributionSettings` 新增 `targetAPR?` 和 `spreadCap?` 字段
- `buildCampaignSnapshotLite` (line ~208): 序列化 `targetAPR` 和 `cap`（作为 `spreadCap`）
- `getMerklForecastState` (line ~767): `aprCap` 提取逻辑更新，TARGET_TOTAL_APR 类型调用新的 `extractAprCap`
- `buildForecastFieldsFromOpportunity` 对应逻辑（如果 backend 有 lite file 读取路径）

**文件**: `backend/src/types/index.ts`
- `MarketWithSpread` 同步新增 `budgetBoundMode` 字段（如需在 API 输出）

### 4.4 Backend 序列化

**文件**: `backend/src/services/marketsApiSerialize.ts`
- `MerklCampaignBreakdown` 的 `aprCap` 序列化：TARGET_TOTAL_APR 时 `aprCap = targetAPR × 100`（decimal → percentage），和 MAX/FIX 的 `distributionSettings.apr × 100` 格式一致
- `budgetBoundMode` / `spreadCap` 序列化规则

### 4.5 ADR

**文件**: `docs/adr/0024-merkl-campaign-type-multi-level-mapping.md`
- L1 新增 7 条映射
- L2 新增 7 条映射（防御性）
- **删除 L3** — 补充修正说明：mode 是 budget-bound 策略，不是类型判断信号
- 更新 full mapping matrix
- 新增 Target Total APR 章节

### 4.6 测试

- `backend/tests/merklForecastModel.test.ts`: 新增 TARGET_TOTAL_APR 的 normalize + buildForecastState 测试
- fetcher 测试: 新增 `normalizeForecastCampaignTypeLite` TARGET_TOTAL_APR 测试（含 L1 命中验证、L3 已删除验证）
- `tests/field-coverage.test.ts`: 验证新字段覆盖（`budgetBoundMode`、`spreadCap`）

---

## 5. Stopgap 状态

当前代码中 `extractMaxApr` **没有** `targetAPR` fallback 路径（stopgap 已不存在或从未合入）。3 个 failing campaign 仍在报 "Missing APR cap"。本次实现将正式修复此问题。

---

## 6. 共享文档

所有研究成果已写入前后端共享文档：

- **`aaveapy-doc/merkl-distribution-types.md`** — Merkl 4 大 Family + 7 种 Target Total APR 子类型 + budget-bound mode + dilutive 示例 + forecast 额外字段 + FIX/MAX AMOUNT 变体

---

## 7. 单独 Issue（不阻塞本任务）

- **FIX/MAX Reward AMOUNT 变体语义映射不精确**: `docs/plans/fix-reward-amount-variant-mapping.md`

---

## 8. 下一步

1. 写 PRD（基于本 handoff 的设计决策）
2. 创建 Linear issues
3. TDD 实现
4. 更新 ADR-0024
5. Code review → Commit → Deploy

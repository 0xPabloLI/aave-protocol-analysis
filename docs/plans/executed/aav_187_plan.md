# AAV-187 开发方案：修复 V4 市场 fallback 计算中 Total Borrowed 和 Pool Liquidity USD 的层级不匹配问题

## 1. Issue 概述

V4 的 Hub & Spoke 架构中，`supplied`/`borrowed` 是 Per-Spoke 级别，`liquidity`/`utilizationPct` 是 Hub 级别。跨层混用会导致数值严重偏差。

## 2. 当前状态

- **状态**：已完成（方案变更，纯前端实现）
- **方案变更说明**：原方案要求后端新增 `hubReserveSizeUsd` / `hubTotalBorrowedUsd` 字段。经评估后改为纯前端方案：前端通过 `hubAggregation.ts` 按 `hubId:tokenAddress` 分组求和各 Spoke 的 `supplied` 和 `borrowed`，自行计算 Hub 级别聚合值。

## 3. 已实现内容

### 3.1 hubAggregation.ts — Hub 聚合工具

`src/lib/hubAggregation.ts`：

- `buildHubAggregationMap(reserves)`：按 `hubId:tokenAddress` 分组，BigInt 求和各 Spoke 的 `borrowed` + `supplied`，返回 `Map<HubAssetKey, { hubBorrowed, hubSupplied }>`
- `validateHubAggregateConsistency()`：验证聚合后 utilization 与 API 的 `utilizationPct` 一致性（DEV 模式自动运行）

### 3.2 useRateSimulation.ts — 注入 Hub 聚合值

`src/hooks/useRateSimulation.ts` 的 `useSharedRateSimulations`：

- 用全部 reserves 构建 `hubAggregationMap`
- 对每个 V4 reserve，将 `reserveRateInput.borrowed` 替换为 `hubAgg.hubBorrowed`（Hub 聚合后的 borrowed）
- `liquidity` 本身就是 Hub 级别，无需替换

### 3.3 rateSimulationCalculator.ts — 产生 Hub 级别 marketMetrics

`src/lib/rateSimulationCalculator.ts` 的 `computeMarketMetrics()`：

- `totalBorrowedUsd = (hubAggregatedBorrowed / 10^decimals) * tokenPrice` ← Hub 级别
- `availableLiquidityUsd = (liquidity / 10^decimals) * tokenPrice` ← Hub 级别（无需聚合）

### 3.4 组件层 — 使用 simulation 作为主路径

`ReservesTable.tsx` → `DesktopReserveRow.tsx` / `MobileReserveCard.tsx`：

```typescript
const baseTotalBorrowedUsd =
  simulation?.marketMetrics.totalBorrowedUsd ??
  getDisplayTotalBorrowedUsd(reserve, protocolVersion);
```

- 主路径：`simulation.marketMetrics.*` → 已使用 Hub 聚合值 ✅
- Fallback：`getDisplayTotalBorrowedUsd` → 见下方 4.2

### 3.5 scenarioSize.ts — V4-aware 禁止跨层混用

`src/lib/scenarioSize.ts`：

- `getDisplayTotalBorrowedUsd`：V4 只用 `reserve.borrowed`（per-Spoke），不做 `reserveSizeUsd * utilizationPct` 跨层推导
- `getDisplayAvailableLiquidityUsd`：V4 只用 `reserve.liquidity`（Hub 级别），不做 `reserveSizeUsd - borrowed` 推导

## 4. 已知遗留

### 4.1 rate-calculation.md 的 minor 不准确

`docs/rate-calculation.md` 中说 `borrowed` 是 Hub 级别，但实际 API 数据中 `borrowed` 是 Per-Spoke（同一 Hub+token 的不同 Spoke 有不同的 borrowed 值）。`liquidity` 和 `utilizationPct` 是 Hub 级别（正确）。

### 4.2 scenarioSize.ts fallback 未做 Hub 聚合

`getDisplayTotalBorrowedUsd` 的 fallback 路径（`simulation` 不可用时）直接使用 `reserve.borrowed`（per-Spoke），没有做 Hub 聚合。但此路径几乎不会被触发，因为 `useSharedRateSimulations` 总会为每个 V4 reserve 生成 simulation，`marketMetrics.totalBorrowedUsd` 始终有值。

**建议修复**：给 `getDisplayTotalBorrowedUsd` 加一个可选的 `hubAggregatedBorrowed` 参数，当 V4 + onChain 为 null 时使用。详见下方 prompt。

## 5. 验收标准（更新后）

- ✅ 前端 V4 市场显示的 Total Borrowed USD 和 Pool Liquidity USD 使用 Hub 级别聚合数据（通过 `hubAggregation.ts` + `useRateSimulation.ts` 实现）
- ✅ 禁止跨层混用：V4 不做 `reserveSizeUsd * utilizationPct` / `reserveSizeUsd - borrowed` 推导
- ✅ `hubAggregation.test.ts` 单元测试覆盖聚合逻辑
- ✅ DEV 模式自动验证聚合一致性
- ⬜ `getDisplayTotalBorrowedUsd` fallback 路径支持 Hub 聚合（可选，见 prompt）

## 6. 复杂度评估（更新后）

- **复杂度**：Low（方案变更后）
- **理由**：后端无需改动，前端已有 `hubAggregation.ts` + `useRateSimulation.ts` 完成聚合，仅剩 fallback 路径的 minor fix。

---

## Appendix：前端 fix prompt

> 复制以下内容给 aaveapy 前端 agent：

```
Fix getDisplayTotalBorrowedUsd fallback for V4 in scenarioSize.ts

## Background
V4's Hub & Spoke architecture means `borrowed` is per-Spoke (different across Spokes
of same Hub+token) while `liquidity` is Hub-level. The main path already handles this
correctly via hubAggregation.ts + useRateSimulation.ts, but the fallback doesn't.

## What to change

In src/lib/scenarioSize.ts, getDisplayTotalBorrowedUsd:

1. Add optional parameter `hubAggregatedBorrowed?: string | null`
2. When onChain is null AND protocolVersion === 'v4', use hubAggregatedBorrowed if available:
   nativeToUsd(hubAggregatedBorrowed, reserve.decimals, reserve.tokenPrice)
3. Otherwise return null (existing behavior)

In callers (DesktopReserveRow.tsx, MobileReserveCard.tsx):
- If you have access to the hub aggregation map, pass the aggregated borrowed value.
- If not, just pass undefined — the fallback is already dead code for V4 since
  the simulation path always provides the value via useSharedRateSimulations.

## Files to change
- src/lib/scenarioSize.ts (add parameter + V4 fallback logic)
- src/lib/scenarioSize.test.ts (add test for V4 + hubAggregatedBorrowed path)
- src/components/dashboard/DesktopReserveRow.tsx (pass hubAggregatedBorrowed if available)
- src/components/dashboard/MobileReserveCard.tsx (same)
- src/components/dashboard/ReservesTable.tsx (same)
```

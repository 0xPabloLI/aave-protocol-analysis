# AAV-1252 Spec: 前端 Summary 整合（HF + NE APY + maxBorrow）

> AAV-756 P6 — 合并原 P5（NE APY 展示）到本 step。
> 仓库：`aaveapy/`（前端）

## Problem Statement

Portfolio Simulation 的 Summary 区域目前仅展示基础聚合指标（Total Supply/Borrow USD、Weighted APY、$/day）。三个已计算但未展示的关键指标缺失：

1. **Health Factor**（P4 已计算 `healthFactors`，但 `usePortfolioToggle` 丢弃了它）— 用户无法看到清算风险
2. **Net Effective APY**（`PortfolioSummary.netEffectiveApy` 已计算）— 用户无法看到组合年化净收益率
3. **maxBorrow 剩余容量**（P3 已实现 per-row 截断，但无 Summary 级汇总）— 用户无法看到整体借款余量

## Solution

在现有表格/footer 下方新增 **Summary Bar**（始终可见 Min HF）+ **Advanced 折叠区**（展开后显示 HF per-pool 详情、NE APY、maxBorrow 容量）。桌面端和移动端同构。

### 布局

**桌面端：**

```
[现有表格 + tfoot]
─────────────────────────────────────────
🟡 HF 1.6                              ▸ Advanced
─────────────────────────────────────────
展开后：
  Health Factor (3 pools):
    Ethereum V3    HF 1.6 🟡   $8K collateral / $5K debt
    Sonic V4       HF 2.5 🟢   $5K collateral / $2K debt
    GHO            HF 0.9 🔴   $4.5K collateral / $5K debt
  Net Effective APY: 2.3%
  Borrow capacity:   $12K remaining
```

**移动端：**

```
[现有 summary card（Supply block | Borrow block | Net/day）]
─────────────────
🟡 HF 1.6                    ▸ Advanced
─────────────────
展开后：同桌面端内容，flex-wrap 适配窄屏
```

### 关键设计决策（Grill 确认）

1. **P5 合并到 P6**：NE APY 不单独做 P5，直接在 P6 Advanced 区展示
2. **Min HF 始终可见**：HF 是安全指标，不能藏在折叠区。显示最低 HF + 颜色
3. **Advanced 默认折叠**：保持默认视图简洁
4. **不改现有 tfoot/summary card**：纯增量，不破坏现有布局和测试
5. **HF per-pool 并排展示**：所有 pool 的 HF 在 Advanced 区并排可见

## User Stories

1. 作为 Portfolio 用户，我希望始终看到最低 Health Factor（带颜色），这样我能一眼判断清算风险
2. 作为 Portfolio 用户，我希望能展开 Advanced 区查看每个 pool 的 HF 详情（collateral/debt），这样我知道哪个 pool 最危险
3. 作为 Portfolio 用户，我希望在 Advanced 区看到 Net Effective APY，这样我能评估组合年化净收益率
4. 作为 Portfolio 用户，我希望在 Advanced 区看到剩余借款容量，这样我知道还能借多少
5. 作为 Portfolio 用户，当我没有 borrow 时，我希望 HF 显示 "—"，因为无债务 = 无清算风险
6. 作为 Portfolio 用户，当 totalSupplyUsd=0 时，我希望 NE APY 显示 "—"，因为无供应 = 无收益率
7. 作为 Portfolio 用户，当借款容量耗尽时，我希望看到红色 "Borrow limit reached" 警告
8. 作为 Portfolio 用户，我希望桌面端和移动端的 Summary 体验一致

## Implementation Decisions

### 1. 数据链路打通

`healthFactors` 已由 `simulatePortfolioFromEntries()` 计算，但 `usePortfolioToggle` 只解构了 `{ results, summary }`。需加 `healthFactors` 到返回值。

```
simulatePortfolioFromEntries → usePortfolioToggle (返回 healthFactors)
  → ReservesTable → PortfolioPanel → PortfolioUnifiedTable / MobilePortfolioCard
```

### 2. HF 颜色编码

| HF 范围      | 颜色    | 语义                      | CSS class                                |
| ------------ | ------- | ------------------------- | ---------------------------------------- |
| HF ≥ 2       | 🟢 绿色 | 安全                      | `text-emerald-600 dark:text-emerald-400` |
| 1.5 ≤ HF < 2 | 🟡 黄色 | 注意                      | `text-yellow-600 dark:text-yellow-400`   |
| 1 ≤ HF < 1.5 | 🟠 橙色 | 警告                      | `text-orange-600 dark:text-orange-400`   |
| HF < 1       | 🔴 红色 | 危险                      | `text-red-500 dark:text-red-400`         |
| HF = null    | —       | 无 borrow                 | `text-muted-foreground`                  |
| HF = 0       | —       | liquidationThreshold 缺失 | `text-muted-foreground`                  |

### 3. Min HF 计算

从 `healthFactors` 数组中取最低非 null HF：

- 所有 HF 都是 null → 显示 "—"
- 有非 null HF → 取 `Math.min(...nonNullHFs)`
- HF = 0（liquidationThreshold undefined）→ 视为 "—"（不参与 min 计算）

### 4. NE APY 展示

- 值来自 `summary.netEffectiveApy`
- `totalSupplyUsd = 0` → 显示 "—"（calculator 返回 0，但 UI 展示 "—"）
- NE APY < 0 → 红色文字
- NE APY ≥ 0 → 默认前景色
- 使用 `formatPercent()` 格式化

### 5. maxBorrow 容量展示

Per-pool 展示：

```
Borrow capacity:
  Ethereum V3: $12K remaining / $30K total
  Sonic V4:    $0 — Borrow limit reached
```

- `remaining = Σ(supplyUsd × ltv / 100) - Σ(borrowUsd)` per pool
- `total = Σ(supplyUsd × ltv / 100)` per pool
- `remaining ≤ 0` → 红色 "Borrow limit reached"
- `total = 0`（无 supply 或 ltv=0）→ "No borrowing capacity"

### 6. Advanced 折叠区交互

- 默认折叠
- 点击 "Advanced" 文字 + chevron 图标切换
- 使用 `useState` 管理 `isAdvancedExpanded`
- 桌面端和移动端使用相同的 state（组件内部）
- 展开/收起使用 CSS transition（与现有 mobile card expand 一致）

### 7. 显示条件

- Summary Bar（Min HF）：`summary != null`（与现有 mobile summary 条件一致）
- Advanced 区：`summary != null && healthFactors != null && healthFactors.length > 0`
- 桌面端 tfoot 不变（仍需 `entries.length > 1`）
- 移动端 summary card 不变

### 8. data-testid / data-cell 属性

为 E2E 测试可测试性添加：

- Summary bar: `data-testid="portfolio-summary-bar"`
- Min HF badge: `data-testid="portfolio-min-hf"` + `data-hf-color="green|yellow|orange|red|none"`
- Advanced toggle: `data-testid="portfolio-advanced-toggle"`
- Advanced content: `data-testid="portfolio-advanced-content"`
- NE APY: `data-testid="portfolio-ne-apy"`
- Borrow capacity items: `data-testid="portfolio-borrow-capacity"` + `data-pool-key="..."`

## Scenario & Risk Verification Matrix

| #   | 场景                     | 输入                          | 预期行为                                               | 风险维度       | 测试用例 |
| --- | ------------------------ | ----------------------------- | ------------------------------------------------------ | -------------- | -------- |
| S1  | 单 pool，HF 安全         | 1 pool, HF=2.5                | Min HF 🟢 2.5                                          | 正常路径       | ✅       |
| S2  | 单 pool，HF 注意         | 1 pool, HF=1.6                | Min HF 🟡 1.6                                          | 正常路径       | ✅       |
| S3  | 单 pool，HF 警告         | 1 pool, HF=1.2                | Min HF 🟠 1.2                                          | 正常路径       | ✅       |
| S4  | 单 pool，HF 危险         | 1 pool, HF=0.8                | Min HF 🔴 0.8                                          | 正常路径       | ✅       |
| S5  | 单 pool，无 borrow       | 1 pool, HF=null               | Min HF "—"                                             | 边界：无债务   | ✅       |
| S6  | HF=0（LT undefined）     | 1 pool, HF=0                  | Min HF "—"                                             | 边界：缺失数据 | ✅       |
| S7  | 多 pool，不同 HF         | 3 pools: HF=2.5, 1.6, 0.9     | Min HF 🔴 0.9; Advanced 展示全部 3 个                  | 多 pool 展示   | ✅       |
| S8  | 所有 pool 无 borrow      | 2 pools, all HF=null          | Min HF "—"; Advanced 无 HF 详情行                      | 边界：全无债务 | ✅       |
| S9  | 空组合                   | entries=[]                    | 不渲染 Summary Bar 和 Advanced                         | 边界：空状态   | ✅       |
| S10 | 单 entry（tfoot 不显示） | 1 entry with borrow           | Summary Bar + Advanced 仍显示                          | 边界：单 entry | ✅       |
| S11 | NE APY 正数              | netUsdPerDay>0, totalSupply>0 | NE APY 显示如 "2.30%"                                  | 正常路径       | ✅       |
| S12 | NE APY 负数              | netUsdPerDay<0                | NE APY 红色如 "-1.20%"                                 | 边界：负收益   | ✅       |
| S13 | NE APY 无 supply         | totalSupplyUsd=0              | NE APY "—"                                             | 边界：零供应   | ✅       |
| S14 | maxBorrow 有余量         | remaining=$12K, total=$30K    | "$12K remaining"                                       | 正常路径       | ✅       |
| S15 | maxBorrow 耗尽           | remaining=$0                  | 红色 "Borrow limit reached"                            | 边界：满额     | ✅       |
| S16 | maxBorrow 无容量         | total=$0 (ltv=0 or no supply) | "No borrowing capacity"                                | 边界：无抵押   | ✅       |
| S17 | 多 pool maxBorrow        | 2 pools, 各有不同 remaining   | per-pool 两行展示                                      | 多 pool 展示   | ✅       |
| S18 | Advanced 默认折叠        | 初始渲染                      | isAdvancedExpanded=false, content 隐藏                 | 交互           | ✅       |
| S19 | Advanced 展开            | 点击 toggle                   | content 显示, chevron 旋转                             | 交互           | ✅       |
| S20 | HF 随 borrow 变化        | 增加 borrow → HF 降低         | Min HF 实时更新颜色和值                                | 数据流         | ✅       |
| S21 | NE APY 随输入变化        | 修改 supply amount            | NE APY 实时更新                                        | 数据流         | ✅       |
| S22 | 移动端布局               | isMobile=true                 | Summary Bar + Advanced 在 summary card 下方, flex-wrap | 响应式         | ✅       |
| S23 | healthFactors=undefined  | simulationContext 为空        | 不渲染 Advanced 区（降级）                             | 降级处理       | ✅       |

### 风险维度说明

| 风险类型          | 评估                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| **并发/竞态**     | `isAdvancedExpanded` 是组件内 `useState`，无竞态。`healthFactors` 随 `useMemo` 重算，React 单线程       |
| **内存泄漏**      | 无新缓存/Map/闭包。`isAdvancedExpanded` 是 boolean，随组件生命周期                                      |
| **数据一致性**    | `healthFactors` 从 `simulatePortfolioFromEntries` 返回，与 `summary` 同源同步。`undefined` 降级为不渲染 |
| **CI/CD 交互**    | 纯前端改动，无后端变更，无 DB 迁移。E2E 测试可能需要新 spec                                             |
| **外部 API 失败** | 不涉及外部 API。所有数据来自已有 `simulatePortfolioFromEntries`                                         |
| **跨包一致性**    | 仅改 `aaveapy/` 前端，不涉及 `packages/` 或 `backend/`                                                  |
| **E2E 回归**      | 不改现有 DOM 元素（tfoot/summary card），纯增量。新 `data-testid` 不影响现有 selector                   |

## Testing Decisions

### 测试 Seam

**主 Seam 1**：`usePortfolioToggle` hook — 验证 `healthFactors` 被正确返回

- 现有测试文件：`usePortfolioToggle.test.ts`
- 新增：验证 `simulatePortfolioFromEntries` 的 `healthFactors` 被传递

**主 Seam 2**：`PortfolioUnifiedTable` / `MobilePortfolioCard` 组件渲染

- 验证 Min HF badge 颜色和值
- 验证 Advanced 折叠/展开
- 验证 NE APY 和 maxBorrow 展示

**辅助 Seam**：HF 颜色计算纯函数

- 新增 `getHfColorClass(hf: number | null): string` 纯函数
- 独立测试，不依赖 React

### 测试原则

- HF 颜色计算用纯函数测试（不测组件内部 className）
- 组件渲染用 `@testing-library/react` + `data-testid` selector
- 不 mock `simulatePortfolioFromEntries`（使用真实计算）
- 沿用现有 `makeReserve` / `makeEntry` / `baseEntriesSimArgs` 测试工厂

## Out of Scope

- **on-chain HF baseline**：P7 (AAV-1253) — `V3AccountSummary.healthFactorWad` / `V4AccountSummary.healthFactor`
- **Snapshot HF 对比**：`PortfolioSnapshot` 类型加 `healthFactors` — 独立增强
- **PortfolioCompareView HF**：快照对比中加 HF — 独立增强
- **"Adjust to max" 按钮**：P3 已有 per-row inline warning，Summary 级按钮为独立增强
- **isCollateral per-reserve 开关**：P4/P7
- **V4 drawCap（Spoke 级借款上限）**：API 未暴露，follow-up

## Further Notes

- `healthFactors` 已在 P4 (AAV-1251) 实现，含 16 场景测试
- `netEffectiveApy` 已在 `aggregatePortfolioSummary` 中计算
- `PortfolioCompareView` 已展示 NE APY（`formatPercent`），可参考其 label "Net APY"
- P3 的 `ltvClampedUsd` 提供 per-row 截断信息，P6 的 maxBorrow capacity 是 Summary 级汇总
- 参考 `aaveapy-doc/v3-v4-collateral-and-health-factor.md` §4 "前端公式统一"
- 参考 triage doc `docs/plans/linear-issues-triage.md` AAV-756 拆分详情

## Ticket Breakdown

### T1: Data layer — Thread `healthFactors` + add `totalBorrowCapacityUsd`

**Scope:**

- Add `totalBorrowCapacityUsd: number` to `PortfolioHealthFactor` type (`portfolio.ts`)
- Update `computeHealthFactors()` in `portfolioSimulator.ts` to also compute `Σ(supplyUsd × ltv / 100)` per pool
- `usePortfolioToggle.ts`: Return `healthFactors` from `simulatePortfolioFromEntries`
- `ReservesTable.tsx`: Pass `healthFactors` to `PortfolioPanel`
- `PortfolioPanel.tsx`: Add `healthFactors?: PortfolioHealthFactor[]` prop, pass to `PortfolioUnifiedTable` and `MobilePortfolioCard`
- `PortfolioUnifiedTable.tsx` / `MobilePortfolioCard.tsx`: Add `healthFactors?: PortfolioHealthFactor[]` prop

**Test:** `usePortfolioToggle.test.ts` — verify `healthFactors` returned with `totalBorrowCapacityUsd`

**Depends on:** —
**Blocks:** T3, T5, T7

### T2: HF color utility — Pure function

**Scope:**

- New `getHfColorClass(hf: number | null): string` in `portfolioCalculator.ts`
- Thresholds: ≥2 green, ≥1.5 yellow, ≥1 orange, <1 red, null/0 muted

**Test:** `portfolioCalculator.test.ts` — all thresholds + null + 0

**Depends on:** —
**Blocks:** T3, T5

### T3: Summary Bar — Min HF badge

**Scope:**

- New inline section below table (desktop) / below summary card (mobile)
- Compute Min HF from `healthFactors` (lowest non-null, skip 0)
- Render colored badge with `getHfColorClass`
- `data-testid="portfolio-summary-bar"`, `data-testid="portfolio-min-hf"`, `data-hf-color="green|yellow|orange|red|none"`

**Test:** Component test — renders correct color and value

**Depends on:** T1, T2
**Blocks:** T4

### T4: Advanced expandable section — Shell

**Scope:**

- Collapsible section with "Advanced" toggle + chevron
- `useState<boolean>` for `isAdvancedExpanded` (default false)
- `data-testid="portfolio-advanced-toggle"`, `data-testid="portfolio-advanced-content"`
- Desktop: below summary bar. Mobile: below summary bar.

**Test:** Component test — default collapsed, click expands

**Depends on:** T3
**Blocks:** T5, T6, T7

### T5: HF per-pool detail in Advanced

**Scope:**

- Render all `healthFactors` entries: pool key, HF value, color, collateral/debt
- `data-testid="portfolio-hf-detail"` per entry
- Only show if any non-null HF exists

**Test:** Component test — multi-pool rendering, all-null case

**Depends on:** T1, T2, T4

### T6: NE APY in Advanced

**Scope:**

- Display `summary.netEffectiveApy` with `formatPercent`
- "—" when `totalSupplyUsd = 0`
- Red text when NE APY < 0
- `data-testid="portfolio-ne-apy"`

**Test:** Component test — positive, negative, zero-supply cases

**Depends on:** T4

### T7: maxBorrow capacity in Advanced

**Scope:**

- Per-pool: `$X remaining / $Y total` using `totalBorrowCapacityUsd` and `totalDebtUsd`
- `remaining ≤ 0` → red "Borrow limit reached"
- `total = 0` → "No borrowing capacity"
- `data-testid="portfolio-borrow-capacity"` per entry

**Test:** Component test — normal, exhausted, no-capacity cases

**Depends on:** T1, T4

### Dependency Graph

```
T1 ──┬──→ T3 ──→ T4 ──┬──→ T5
     │                 ├──→ T6
     │                 └──→ T7
T2 ──┘
```

**Execution order:** T1 + T2 (parallel) → T3 → T4 → T5 + T6 + T7 (parallel)

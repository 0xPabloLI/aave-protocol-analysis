# AAV-1251 Spec: 前端模拟 HF 计算（per-pool/spoke）

> **追溯 Spec** — 代码已实现并推送（`aaveapy/` 仓库 `lovable` 分支）。此文档为标准工作流补走产物。
> 工作 spec 原稿位于 `.codeartsdoer/specs/aav-1251-health-factor/spec.md`。

## Problem Statement

Portfolio Simulation 模式下，P3（AAV-1250）已实现 maxBorrow LTV 约束，但用户无法看到自己仓位的安全性（Health Factor）。HF 是 DeFi 借贷的核心风控指标：`HF < 1.0` 意味着仓位可被清算。

本 issue 实现 **per-pool/spoke 隔离**的模拟 HF 计算（纯函数 + 测试，不含 UI）。UI 整合在 P6（AAV-1252）。

## Solution

在 `simulatePortfolioFromEntries` 流程中，LTV 截断（P3）完成后、结果聚合后，新增 `computeHealthFactors()` 函数，从 `PortfolioPositionResult[]` 计算 per-pool/spoke HF。

### 公式

```
HF_group = Σ(supplyUsd_i × liquidationThreshold_i / 100) / Σ(borrowUsd_i)
```

- `supplyUsd_i`：模拟后有效供应量（post-clamp，来自 `PortfolioPositionResult.amountUsd`）
- `liquidationThreshold_i`：来自 API 的 `reserve.liquidationThreshold`（percent，80 = 80%）。`undefined` 或 `0` → 贡献 0
- `borrowUsd_i`：模拟后有效借款量（post-clamp，来自 `PortfolioPositionResult.amountUsd`）

### 隔离边界

- V3: 按 `(chainId, marketName)` 分组（= Pool 隔离边界）
- V4: 按 `(chainId, marketName)` 分组（`marketName` 已包含 spoke 信息，如 `AaveV4EthereumHub_usdc`）
- 统一 key：`poolKey = ${reserve.chainId}:${reserve.marketName}`
- 跨 pool/spoke 的 collateral 不能互相对冲（合约行为）

## User Stories

1. 作为 Portfolio 用户，我希望看到每个 pool/spoke 的模拟 HF，了解仓位安全性
2. 作为 Portfolio 用户，当我没有借款时，HF 应显示 "—" 而非数字
3. 作为 Portfolio 用户，当我在不同 pool 有仓位时，它们的 HF 应互相独立
4. 作为 Portfolio 用户，当 V3 的 ltv < liquidationThreshold 时，HF 应反映安全缓冲带（HF > 1.0 at maxBorrow）
5. 作为 Portfolio 用户，当 V4 的 ltv = liquidationThreshold 时，借到 maxBorrow 上限时 HF = 1.0（无缓冲）

## Implementation Decisions

### 1. 数据来源：post-clamp 有效金额

HF 使用 `PortfolioPositionResult.amountUsd`（post-all-clamps 的最终有效金额）：

- Borrow `amountUsd` = `min(userInput, maxBorrowRemaining, borrowCapRemaining)` 的最终值
- Supply `amountUsd` = 可能被 supplyCap 截断的有效供应量

**理由**：合约在 `borrow()` 后计算 HF，用的是实际债务。Simulation 中 "实际" = post-clamp 金额。用 pre-clamp 金额会导致 HF < 1.0（borrow > maxBorrow），但用户实际借不到那么多。

### 2. 新增类型：PortfolioHealthFactor

```typescript
/** Per-pool/spoke health factor after simulation. */
export interface PortfolioHealthFactor {
  /** `${chainId}:${marketName}` — protocol isolation boundary. */
  poolKey: string;
  /** Simulated HF (after). null = no borrow (display "—"). */
  healthFactor: number | null;
  /** Σ(supplyUsd × liquidationThreshold / 100) — risk-adjusted collateral. */
  totalCollateralUsd: number;
  /** Σ(effective borrowUsd) — post-clamp debt. */
  totalDebtUsd: number;
}
```

> **注**：P6（AAV-1252）后续新增 `totalBorrowCapacityUsd` 字段；P7（AAV-1253）后续新增 `currentHealthFactor`、`deltaHealthFactor` 字段。P4 原始 scope 仅含上述 4 个字段。

添加到 `SimulatePortfolioResult`：

```typescript
interface SimulatePortfolioResult {
  results: PortfolioPositionResult[];
  summary: PortfolioSummary;
  healthFactors?: PortfolioHealthFactor[]; // P4 新增
}
```

**不污染 `PortfolioSummary`**：HF 是 per-group 的风控指标，不是全局财务指标。P6 负责将 `healthFactors` 整合到 UI。

### 3. 函数签名

```typescript
function computeHealthFactors(
  results: PortfolioPositionResult[],
  reserves: ReserveWithSpread[]
): PortfolioHealthFactor[];
```

- 输入：post-clamp 的 `PortfolioPositionResult[]` + reserves（用于查 `liquidationThreshold` 和 `poolKey`）
- 输出：per-pool/spoke 的 HF 数组
- 纯函数，无副作用

> **注**：P7（AAV-1253）后续扩展签名为 `computeHealthFactors(results, reserves, onchainHfMap?)` 以支持 on-chain HF baseline 合并。

### 4. 计算流程

1. 从 `reserves` 构建 `reserveMap`（key → reserve）
2. 遍历 `results`，查 reserve 获取 `poolKey` 和 `liquidationThreshold`
3. 按 `poolKey` 聚合：
   - supply → `totalCollateralUsd += amountUsd × (liquidationThreshold ?? 0) / 100`
   - borrow → `totalDebtUsd += amountUsd`
4. 对每个 pool group：
   - `totalDebtUsd > 0` → `healthFactor = totalCollateralUsd / totalDebtUsd`
   - `totalDebtUsd = 0` → `healthFactor = null`（无债务 = 无清算风险，展示 "—"）

### 5. liquidationThreshold = undefined 处理

与 P3 的 `ltv = undefined` 一致：`(liquidationThreshold ?? 0)` → 该 reserve 贡献 0 collateral。不会 crash。

### 6. isCollateral

P4 不处理 `isCollateral` 字段（默认所有 supply 都是 collateral）。P7 再加入 per-reserve collateral 开关。

### 7. 位置

函数定义在 `portfolioSimulator.ts`，与 `computeLtvClamping`（P3）同文件。类型定义在 `types/portfolio.ts`。

### 8. 数据链路

```
simulatePortfolioFromEntries()
  → computeLtvClamping() (P3 — LTV 截断)
  → computeResultsFromGroups() (现有 — per-reserve 模拟)
  → aggregatePortfolioSummary() (现有 — 全局聚合)
  → computeHealthFactors() (P4 新增 — per-pool HF)
  → return { results, summary, healthFactors }
```

## Scenario & Risk Verification Matrix

| #   | 场景                        | 输入                                                              | 预期 HF              | 风险维度        | 测试用例 |
| --- | --------------------------- | ----------------------------------------------------------------- | -------------------- | --------------- | -------- |
| H1  | 单 reserve 正常             | supply $10k, lt=80%, borrow $5k                                   | 1.6                  | 正常路径        | ✅       |
| H2  | 单 reserve 无 borrow        | supply $10k, lt=80%, borrow $0                                    | null ("—")           | 边界：无债务    | ✅       |
| H3  | 空仓位                      | 无 entry                                                          | `healthFactors = []` | 边界：空        | ✅       |
| H4  | lt=undefined                | supply $10k, lt=undefined, borrow $5k                             | 0                    | 边界：字段缺失  | ✅       |
| H5  | V3 缓冲带                   | supply $10k, ltv=75%, lt=80%, borrow $7.5k(=LTV上限)              | 1.067                | V3 缓冲         | ✅       |
| H6  | V4 满额借入                 | supply $10k, ltv=80%=lt, borrow $8k(=maxBorrow)                   | 1.0                  | V4 无缓冲       | ✅       |
| H7  | 同 pool 两 reserve          | r1: supply $10k lt=80%, r2: supply $5k lt=80%, borrow r2 $3k      | 4.0                  | 跨 reserve 分组 | ✅       |
| H8  | 不同 pool 隔离              | A: supply $10k lt=80% no borrow, B: supply $10k lt=80% borrow $8k | A: null, B: 1.0      | 隔离边界        | ✅       |
| H9  | V4 同链不同 spoke           | spoke A: no borrow, spoke B: borrow $8k                           | A: null, B: 1.0      | V4 隔离         | ✅       |
| H10 | wallet+delta 组合           | wallet supply $5k + delta +$5k, lt=80%, borrow $4k                | 2.0                  | 仓位基准        | ✅       |
| H11 | supply delta 为负           | wallet supply $10k - delta $5k, lt=80%, borrow $3k                | 1.333                | 负 delta        | ✅       |
| H12 | borrow 被 LTV 截断          | supply $10k, ltv=80%, lt=80%, borrow $9k→clamp $8k                | 1.0                  | 截断后 HF       | ✅       |
| H13 | 多 group 同时有 borrow      | pool A+B 各有 supply+borrow                                       | 各自独立 HF          | 并行安全        | ✅       |
| H14 | 100% LT 资产                | supply $10k, lt=100%, borrow $5k                                  | 2.0                  | V4 满额参数     | ✅       |
| H15 | borrow 被多约束截断         | supply $10k, ltv=80%, lt=80%, borrowCap=$5k, borrow $9k→$5k       | 1.6                  | 多约束交互      | ✅       |
| H16 | 两 supply 一 borrow 同 pool | r1: supply $5k, r2: supply $5k, lt=80%, borrow r1 $4k             | 2.0                  | 聚合正确性      | ✅       |

### 风险维度说明

| 风险类型          | 评估                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------- |
| **并发/竞态**     | 无新 state，纯计算函数。`results` 数组只读遍历，无副作用                               |
| **内存泄漏**      | 无新缓存/Map/闭包。`healthFactors` 是普通数组，随 `SimulatePortfolioResult` 返回值消费 |
| **数据一致性**    | `liquidationThreshold=undefined→0`，与 P3 `ltv=undefined→0` 一致                       |
| **CI/CD 交互**    | 纯前端，无后端/DB 变更                                                                 |
| **外部 API 失败** | 不涉及外部调用                                                                         |
| **跨包一致性**    | 仅改 `aaveapy/` 前端，不涉及 `packages/` 或 `backend/`                                 |

## Testing Decisions

### 测试 Seam

**主要 Seam**：`computeHealthFactors(results, reserves)` — 纯函数，直接通过输入/输出断言测试。

通过 `simulatePortfolioFromEntries` 端到端测试（构建 entries + reserves → 调用 → 检查 `result.healthFactors`），复用现有 `makeRateCalcReserve` / `makeEntry` / `baseEntriesSimArgs` 测试工厂。

### 测试原则

- 只测外部行为（输入 → 输出）
- 复用现有测试工厂函数
- 不需要 mock 任何外部依赖
- 场景矩阵 H1-H16 直接成为测试用例

### 先验测试

`portfolioSimulator.test.ts` 中已有 30+ 个测试用例覆盖 `simulatePortfolioFromEntries` 和 `buildPerReserveInputsFromEntries`，新增 HF 测试沿用同样的模式。测试组 `describe('Health Factor calculation (AAV-1251)')` 包含 H1-H16 共 16 个测试用例。

### 运行时验证（补做）

- [x] 单元测试：16 个场景 (H1-H16) 全部通过
- [x] Dev server 验证：`npm run dev:staging` 启动成功，Portfolio 模式 toggle 正常开启
- [x] 现有 P3 LTV 测试无回归

#### 后续 Bug 修复（2026-08-06）

P4 代码逻辑全部正确（`computeHealthFactors` 正确产出 HF 值如 1.56），但 `usePortfolioToggle.ts` 中 `useMemo` 返回对象的 key (`portfolioHealthFactors`) 与解构期望的 key (`healthFactors`) 不匹配，导致 HF 数据从未传递到 `PortfolioSummaryBar`，UI 始终显示 "—"。已修复（commit `45675516` on `aaveapy/lovable`），回归测试已添加（断言 `portfolioHealthFactors` 为 defined 且 `healthFactor > 0`）。

## Out of Scope

- **HF UI 展示**：P6 (AAV-1252) — `PortfolioSummaryBar` 组件
- **HF 颜色编码**：P6 (AAV-1252) — 绿≥2/黄≥1.5/橙≥1/红<1
- **on-chain HF baseline**：P7 (AAV-1253) — `V3AccountSummary.healthFactorWad` / `V4AccountSummary.healthFactor`
- **isCollateral per-reserve 开关**：P7
- **V4 drawCap（Spoke 级借款上限）**：API 未暴露，follow-up

## Further Notes

- 后端 `liquidationThreshold` 已在 AAV-1222 交付，前端类型已在 AAV-1248 (P2) 同步
- V3 的 `ltv` < `liquidationThreshold`（有安全缓冲），V4 两者同值 = `collateralFactor`。P4 使用 `liquidationThreshold`（非 `ltv`）计算 HF
- 参考 `aaveapy-doc/v3-v4-collateral-and-health-factor.md` §二 HF 公式对比、§四 前端公式统一
- 参考 `aaveapy-doc/hub-spoke-position-isolation.md` §三 Spoke 隔离、§六 V3 Market=V4 Spoke
- 参考 triage doc `docs/plans/linear-issues-triage.md` AAV-756 拆分详情

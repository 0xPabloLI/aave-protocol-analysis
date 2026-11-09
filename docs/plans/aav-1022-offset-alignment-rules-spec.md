# AAV-1022: Offset 对齐规则定义 — Spec

> **Linear**: [AAV-1022](https://linear.app/aaveapy/issue/AAV-1022) · [AAV-1023](https://linear.app/aaveapy/issue/AAV-1023) · [AAV-1024](https://linear.app/aaveapy/issue/AAV-1024)
> **父 Issue**: [AAV-832](https://linear.app/aaveapy/issue/AAV-832)（产品决策已定：方案 C）
> **仓库**: 前端 (`aaveapy`)
> **状态**: Spec — 待实施

## 1. 背景与决策

### 1.1 问题

Portfolio simulation 中，Merkl 的 `netPositionConstraint`（NPC）和 `crossAssetPairing`（CAP）会通过跨 reserve offset 降低 incentive 收益。不同视图（Reserve table、Shared scenario、Portfolio summary）对 offset 的应用不一致会导致用户困惑。

### 1.2 产品决策：方案 C

**决策来源**：AAV-832 comment（2026-07-31），用户确认。

| 上下文                                | 是否应用 offset |  展示 note   | 理由                                                            |
| ------------------------------------- | :-------------: | :----------: | --------------------------------------------------------------- |
| Single simulation（无 wallet）        |       ❌        |      ❌      | 无跨 reserve 仓位信息                                           |
| Shared scenario                       |       ❌        | ✅ 通用提示  | uniform input 与 offset 语义冲突；提示用户切 Portfolio 查精确值 |
| Portfolio simulation                  |    ✅ 已实现    | ✅ 精确 note | 有真实跨 reserve 仓位，offset 有物理意义                        |
| Reserve table（Portfolio 模式下展开） |    ✅ 已实现    | ✅ 精确 note | 处于 Portfolio 上下文，应与 Portfolio summary 一致              |

### 1.3 优先级链

offset 检查在 `rateSimulationCalculator.ts` 中的优先级（已实现，spec 确认不变）：

```
borrowBlacklist（短路归零）→ crossAssetPairing（min 公式）→ netPositionConstraint（减法公式）→ 1（无约束）
```

- `borrowBlacklist` 和 `netPositionConstraint` / `crossAssetPairing` 互斥（同一 opportunity 不会同时存在）
- `crossAssetPairing` 和 `netPositionConstraint` 互斥

## 2. 当前代码行为验证

### 2.1 offset 控制机制

`crossReservePositions: Map<string, ReservePositions> | undefined` 是 offset 的总开关：

- **`undefined`** → 所有 offset 逻辑跳过（`crossReservePositions && crossReservePositions.size > 0` 检查失败）
- **空 Map** → 同 `undefined`（`.size === 0`）
- **有值的 Map** → offset 逻辑执行

### 2.2 各上下文的 `crossReservePositions` 来源

| 上下文                              | 来源                                                                                    | 值          |
| ----------------------------------- | --------------------------------------------------------------------------------------- | ----------- |
| Shared scenario                     | `ReservesTable.tsx` L250: `portfolioInputsResult = undefined`（`!isPortfolioMode`）     | `undefined` |
| Portfolio simulation                | `buildPerReserveInputsFromEntries()` 返回 `PortfolioInputsResult.crossReservePositions` | 有值的 Map  |
| Reserve table（Portfolio 模式展开） | 同上（`simulationsById` 共享）                                                          | 有值的 Map  |
| Single simulation                   | `useRateSimulation()` 未传入 `crossReservePositions`                                    | `undefined` |

**验证结论**：当前代码已正确实现方案 C 的 offset 应用规则。✅

### 2.3 note 生成机制

`merklCrossReserveNote` 函数（`rateSimulationCalculator.ts` L1415-1453）：

- 依赖 `crossReservePositions`、`reserveSymbolById`、`grossUsd`
- 当 `crossReservePositions` 为 `undefined` 或空时，返回 `null`（无 note）
- Portfolio 模式下生成精确 note：
  - NPC: `"$X of $Y net eligible (supply minus GHO+USDC borrows)"`
  - CAP: `"$X of $Y effective (capped by cbETH supply ×0.823)"`

**验证结论**：Portfolio 模式 note 已正确实现 ✅。Shared scenario 的通用提示 note **未实现** ❌（AAV-1024 的 scope）。

### 2.4 字段可用性

`CampaignGroup`（`src/types/aave.ts` L65-84）在 API 响应中包含：

- `netPositionConstraint?: NetPositionConstraint | null` — opportunity 级 NPC
- `crossAssetPairing?: CrossAssetPairing | null` — opportunity 级 CAP（AAV-895）
- `borrowBlacklist?: true` — opportunity 级 borrow 黑名单

**关键**：这些字段在 Shared scenario 中也可读取（不需要 `crossReservePositions`），因此可以检测"该 reserve 是否有 NPC/CAP"来决定是否显示通用 note。

## 3. Canonical Offset Alignment Rule

### 3.1 规则定义

```
IF context == Portfolio mode:
    IF crossReservePositions is defined AND non-empty:
        APPLY offset (NPC: subtract, CAP: min)
        SHOW precise note (net eligible amount + offset symbols)
    ELSE:
        NO offset (no positions to offset against)
        NO note
ELSE IF context == Shared scenario:
    NO offset (uniform input, no real positions)
    IF reserve has NPC or CAP:
        SHOW generic informational note
    ELSE:
        NO note
ELSE IF context == Single simulation (no wallet):
    NO offset
    NO note
```

### 3.2 通用 note 文案（Shared scenario）

当 Shared scenario 中的 reserve 有 `netPositionConstraint` 或 `crossAssetPairing` 时，展示：

**NPC note**:

> "⚠️ In Portfolio mode, this incentive applies to net position only. Cross-reserve borrows may reduce eligibility."

**CAP note**:

> "⚠️ In Portfolio mode, this incentive is capped by paired asset position. See Portfolio for precise values."

**设计理由**：

- 不展示具体金额（Shared scenario 无真实仓位，无法计算）
- 明确引导用户切换 Portfolio 模式查看精确值
- `borrowBlacklist` 不需要通用 note（其语义是"有 borrow → 归零"，已在现有逻辑中处理）

### 3.3 精确 note 文案（Portfolio mode，已实现）

**NPC note** (via `buildCrossReserveNetEligibleNote`):

> "$X of $Y net eligible (supply minus GHO+USDC borrows)"

**CAP note** (via `buildCrossAssetPairingNote`):

> "$X of $Y effective (capped by cbETH supply ×0.823)"

## 4. GHO/USDG 示例（AAV-832 原始案例）

### 场景

Ink 网络，用户 Portfolio:

- GHO supply: $200,000
- USDG borrow: $80,000

GHO 有 `AAVE_NET_LENDING` 类型 Merkl opportunity，`netPositionConstraint`:

```json
{
  "sourceSide": "supply",
  "offsetReserveIds": [
    "57073:0x2816cf...:0xfc421a...",
    "57073:0x2816cf...:0xe34316..."
  ]
}
```

### 各上下文行为

| 上下文                          | GHO supply incentive 显示                  | note                                                                   |
| ------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| Shared scenario ($1000 uniform) | 全额 $1000 × APR                           | "⚠️ In Portfolio mode, this incentive applies to net position only..." |
| Portfolio simulation            | $120,000 net eligible × APR ($200k - $80k) | "$120,000 of $200,000 net eligible (supply minus USDG borrows)"        |
| Reserve table (Portfolio 展开)  | 同 Portfolio simulation                    | 同上                                                                   |

### 一致性验证

- Portfolio summary 中的 GHO supply incentive = Reserve table GHO 行的 incentive（同一 `simulationsById`）✅
- Shared scenario 中 GHO supply incentive ≠ Portfolio（前者无 offset，后者有 offset）— 这是预期行为，由 note 解释

## 5. Scenario & Risk Verification Matrix

| #   | 场景                                                     | 上下文    | 风险维度          | 预期行为                                            | 测试类型 |
| --- | -------------------------------------------------------- | --------- | ----------------- | --------------------------------------------------- | -------- |
| S1  | Reserve 有 NPC，Shared scenario                          | Shared    | 正常路径          | 不应用 offset；显示通用 NPC note                    | 单元测试 |
| S2  | Reserve 无 NPC，Shared scenario                          | Shared    | 空值边界          | 不应用 offset；无 note                              | 单元测试 |
| S3  | Reserve 有 NPC，Portfolio mode，offset 降低 incentive    | Portfolio | 正常路径          | 应用 offset；显示精确 note（金额 + offset symbols） | 单元测试 |
| S4  | Reserve 有 NPC，Portfolio mode，offset 归零 incentive    | Portfolio | 零值边界          | 应用 offset；incentive = 0；note 仍显示             | 单元测试 |
| S5  | Reserve 有 NPC，Portfolio mode，无 offset 仓位（空 Map） | Portfolio | 空值边界          | 不应用 offset；无 note                              | 单元测试 |
| S6  | Shared → Portfolio 模式切换                              | 状态转换  | 模式切换          | offset 开始应用；通用 note → 精确 note              | E2E      |
| S7  | Portfolio → Shared 模式切换                              | 状态转换  | 模式切换          | offset 停止应用；精确 note → 通用 note              | E2E      |
| S8  | Reserve table Portfolio 模式展开行                       | Portfolio | 跨视图一致性      | 与 Portfolio summary 数值一致                       | E2E      |
| S9  | Single simulation（无 wallet），NPC reserve              | Single    | 无仓位            | 不应用 offset；无 note                              | 单元测试 |
| S10 | 同 pool 多个 NPC reserve                                 | Portfolio | 多实体            | 每个 reserve 独立 offset                            | 单元测试 |
| S11 | NPC + borrowBlacklist 同时存在                           | Portfolio | 优先级            | borrowBlacklist 短路归零（NPC 不执行）              | 单元测试 |
| S12 | NPC + crossAssetPairing 同时存在                         | Portfolio | 互斥              | crossAssetPairing 先执行（NPC 不执行）              | 单元测试 |
| S13 | Reserve 有 CAP（非 NPC），Shared scenario                | Shared    | crossAssetPairing | 不应用 offset；显示通用 CAP note                    | 单元测试 |
| S14 | `crossReservePositions = undefined` vs 空 Map            | Portfolio | Null/Undefined    | 行为一致（都不应用 offset）                         | 单元测试 |
| S15 | V3 NPC reserve（3段 reserveId）                          | Portfolio | V3/V4 差异        | offset 正常应用（pool 内 offset）                   | 单元测试 |
| S16 | V4 NPC reserve（4段 reserveId）                          | Portfolio | V3/V4 差异        | offset 正常应用（spoke 内 offset）                  | 单元测试 |

## 6. 实施范围

### 6.1 AAV-1022（本 spec）

**Deliverable**: 本 spec 文档。定义 offset 对齐规则、Scenario Matrix、通用 note 文案。

**无代码变更**。spec 完成后 AAV-1023 和 AAV-1024 可并行实施。

### 6.2 AAV-1023: Reserve table 展示逻辑改造

**当前状态**：Portfolio 模式下 Reserve table 已通过 `simulationsById` 正确应用 offset。

**需验证/改进**：

1. ✅ Reserve table 行在 Portfolio 模式下应用 offset（已实现）
2. ✅ 精确 note 已通过 `attachCampaigns(sourceNotes)` 附加到 campaign details（已实现）
3. ⬜ 验证 offset 归零时的展示（incentive = 0 时是否清晰展示原因）
4. ⬜ 验证 Portfolio summary 与 Reserve table 行的数值一致性

**预期结论**：AAV-1023 可能是 **no-op 或 minor display improvement**。核心逻辑已实现，主要是验证和可能的 UX 微调。

**文件**：

- `src/components/dashboard/ReservesTable.tsx` — 验证 `simulationsById` 传递
- `src/components/dashboard/DesktopReserveRow.tsx` — 验证 offset note 展示
- `src/components/dashboard/MobilePortfolioCard.tsx` — 同上

### 6.3 AAV-1024: Shared scenario 通用 note

**当前状态**：Shared scenario 不应用 offset ✅，但不显示通用 note ❌。

**需实现**：

1. 在 `rateSimulationCalculator.ts` 中，当 `crossReservePositions` 为 `undefined` 但 `group.netPositionConstraint` 存在时，生成通用 NPC note
2. 当 `crossReservePositions` 为 `undefined` 但 `group.crossAssetPairing` 存在时，生成通用 CAP note
3. 通用 note 通过 `attachCampaigns(sourceNotes)` 附加到 campaign details

**实现方案**：

在 `merklCrossReserveNote` 函数中增加 `crossReservePositions == null` 分支：

```typescript
const merklCrossReserveNote = (
  side: RateSide
): ((group: MerklOpportunityGroup) => string | null) => {
  const grossUsd =
    side === "supply" ? supplyGrossForEligibility : borrowGrossForEligibility;
  return (group) => {
    // AAV-895: Cross-asset pairing note
    const pairing = group.crossAssetPairing;
    if (
      pairing &&
      crossReservePositions &&
      crossReservePositions.size > 0 &&
      reserveSymbolById
    ) {
      // ... existing precise note logic (unchanged)
    }
    // AAV-1024: Generic note for Shared scenario (no crossReservePositions)
    if (
      pairing &&
      (!crossReservePositions || crossReservePositions.size === 0)
    ) {
      return "⚠️ In Portfolio mode, this incentive is capped by paired asset position. See Portfolio for precise values.";
    }

    const constraint = group.netPositionConstraint;
    if (
      constraint &&
      crossReservePositions &&
      crossReservePositions.size > 0 &&
      reserveSymbolById
    ) {
      // ... existing precise note logic (unchanged)
    }
    // AAV-1024: Generic note for Shared scenario (no crossReservePositions)
    if (
      constraint &&
      (!crossReservePositions || crossReservePositions.size === 0)
    ) {
      return "⚠️ In Portfolio mode, this incentive applies to net position only. Cross-reserve borrows may reduce eligibility.";
    }

    return null;
  };
};
```

**文件**：

- `src/lib/rateSimulationCalculator.ts` — `merklCrossReserveNote` 函数增加 generic note 分支
- `src/lib/rateSimulationCalculator.test.ts` — 新增 S1, S13 场景测试

## 7. 不在 Scope 内

- **AAV-1036**（offsetNote 与 capNote 数据层分离）— 独立技术债，不影响功能
- **后端变更** — offset 计算是纯前端逻辑，后端已提供所有必要字段
- **borrowBlacklist note** — 已在现有逻辑中处理，不需要通用 note
- **V4 `drawCap`** — Spoke 级借款上限，作为 follow-up

## 8. 参考文档

- [ADR-0005: Per-Reserve Simulation Inputs for Portfolio Mode](../../aaveapy/docs/adr/0005-per-reserve-inputs-portfolio-mode.md) — Shared scenario vs Portfolio mode 架构
- [Net Position Constraint 前端对接指南](../../aaveapy-doc/net-position-constraint-frontend-guide.md) — NPC 计算逻辑
- [AAV-895 Cross-Asset Pairing Spec](./aav-895-cross-asset-pairing-spec.md) — CAP 计算逻辑
- [AAV-832 产品决策](https://linear.app/aaveapy/issue/AAV-832) — 方案 C 决策记录

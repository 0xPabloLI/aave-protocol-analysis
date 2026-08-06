# AAV-895: Cross-Asset Pairing (min(1,2)) — Spec

> **Status**: Draft (Grill 完成，待 TDD)
> **Date**: 2026-08-06
> **Linear**: [AAV-895](https://linear.app/aaveapy/issue/AAV-895)
> **Scope**: 后端（fetcher 检测 + 类型 + 序列化）+ 前端（simulation calculator 消费）— 分两个 ticket

---

## 1. 问题

Merkl `min(1,2)` 跨资产配对机会（如 "Borrow ETH using cbETH as collateral"）的奖励按 `min(source_pos, paired_pos × discountFactor)` 计算，而非全额仓位。

当前该类机会 **没有** `netPositionConstraint`（min(1,2) 不是 net position — ADR-0023 明确排除），前端 simulation 当普通机会处理 → **收益高估**。

## 2. 设计决策（Grill 结论）

### D1: 数据模型 — 独立字段 `crossAssetPairing`

min(1,2) 不是 net position constraint，是 **并列的独立约束类型**。新建 `CrossAssetPairing` 类型和 `crossAssetPairing` 字段，与 `netPositionConstraint` 并列在 opportunity 上。

```typescript
// shared-contracts/src/index.ts
interface CrossAssetPairing {
  sourceSide: "supply" | "borrow"; // source 方向（匹配 opportunity action）
  pairedReserveId: string; // paired token 的 reserve ID
  pairedSide: "supply" | "borrow"; // paired 方向（不固定，由 targetToken 类型决定）
  discountFactor: number; // paired 侧 composedMultiplier / 1e9
}
```

### D2: 检测路径 — 独立函数 `detectCrossAssetPairing()`

不扩展 `detectNetPositionConstraint` 的层级。新建独立检测函数，与 `detectNetPositionConstraint` 并行调用。

**与 looping 的关系**：min(1,2) 和 looping 是 **并列条件**，不互斥。`detectCrossAssetPairing` 不受 looping 关键词影响。现有 L1（looping 排除）只防止非 min(1,2) 的 looping 被 LLM 误判为 net position — 不影响 crossAssetPairing 检测。

### D3: source sub 识别

`composedSubCampaigns` 中，`targetToken` 匹配 opportunity `explorerAddress` 的 sub 是 source sub（multiplier=1.0）。另一个是 paired sub。

识别方式：在 `processMerklData` 中已用 `explorerAddress` 反查 `oppReserveId`。将 `explorerAddress` 传入 `detectCrossAssetPairing`，匹配 sub 的 `mainParameter`（= targetToken）。

### D4: pairedSide 方向确定

由 paired sub 的 targetToken 类型决定：

- aToken (以 `a` 开头的 symbol) → `supply`
- vToken / variableDebtToken → `borrow`

### D5: 通用性 — 所有 min(1,2) 跨资产

通用处理所有 `composedCampaignsCompute === 'min(1,2)'` 且子 campaign underlyingToken 不同的机会。不硬编码特定 token 对。

### D6: discountFactor 解析

`composedMultiplier` 字符串 → `Number(str) / 1e9`。NaN 或负数 → return null + warn。source multiplier 始终 = 1.0（基准单位），不传。

### D7: pairedReserveId resolve 失败

return null + warn 日志（与现有 NPC resolve 失败行为一致）。

### D8: 项目范围

- AAV-1036（offsetNote 分离）**不纳入**
- 后端 + 前端分两个 ticket

## 3. 数据流

```
Merkl API → processMerklData (提取 composedSubCampaigns + composedMultiplier)
                                    ↓
           detectCrossAssetPairing(opp, oppReserveId, reserveIdSet, explorerAddress)
                                    ↓
           CrossAssetPairing | null
                                    ↓
           MerklOpportunityGroup.crossAssetPairing (新字段)
                                    ↓
           RuntimeReserveData.merklBorrows[i].crossAssetPairing
                                    ↓
           marketsApiSerialize.ts (pass through, 无单位转换)
                                    ↓
           API JSON → 前端 rateSimulationCalculator
                                    ↓
           effectivePosition = min(sourcePos, pairedPos × discountFactor)
           reward = effectivePosition × APR
```

## 4. 接口契约

### 4.1 后端产出（API JSON）

```json
{
  "merklBorrows": [{
    "link": "https://app.merkl.xyz/opportunities/7267850615864866485",
    "opportunityType": "MULTILOG_DUTCH",
    "name": "Borrow ETH using cbETH as collateral on Aave",
    "message": "Earn rewards by borrowing ETH using cbETH as collateral on Aave on Base",
    "netPositionConstraint": null,
    "crossAssetPairing": {
      "sourceSide": "borrow",
      "pairedReserveId": "8453:0xA736...:0x2Ae3...",
      "pairedSide": "supply",
      "discountFactor": 0.823
    },
    "breakdowns": [...]
  }]
}
```

### 4.2 前端消费

```typescript
function getEffectivePosition(
  opportunity: MerklOpportunity,
  userPositions: Map<string, { supply: number; borrow: number }>
): number {
  if (!opportunity.crossAssetPairing) {
    return -1; // signal: use full position (普通机会)
  }

  const { sourceSide, pairedReserveId, pairedSide, discountFactor } =
    opportunity.crossAssetPairing;

  const sourcePos =
    sourceSide === "supply"
      ? (userPositions.get(sourceReserveId)?.supply ?? 0)
      : (userPositions.get(sourceReserveId)?.borrow ?? 0);

  const pairedPos =
    pairedSide === "supply"
      ? (userPositions.get(pairedReserveId)?.supply ?? 0)
      : (userPositions.get(pairedReserveId)?.borrow ?? 0);

  return Math.min(sourcePos, pairedPos * discountFactor);
}
```

### 4.3 字段位置

`crossAssetPairing` 挂在与 `netPositionConstraint` 相同的层级 — `MerklOpportunityGroup` / `MerklGroupEntry` / API opportunity 对象。两者互斥（min(1,2) 机会不会同时有 net position constraint）。

## 5. 实现变更清单

### 5.1 shared-contracts (`@internal/aave-shared-contracts`)

| 文件           | 变更                                                                              |
| -------------- | --------------------------------------------------------------------------------- |
| `src/index.ts` | 新增 `CrossAssetPairing` 接口 + 导出                                              |
| `src/index.ts` | `MerklOpportunityGroup` 加 `crossAssetPairing?: CrossAssetPairing` 字段（如果有） |

### 5.2 fetcher (`@internal/aave-fetcher`)

| 文件               | 变更                                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| `src/merkl-api.ts` | `ComposedSubCampaign` 加 `composedMultiplier?: number` 字段                       |
| `src/merkl-api.ts` | `extractComposedCampaignInfo()` 提取 `composedMultiplier`                         |
| `src/merkl-api.ts` | 新增 `detectCrossAssetPairing()` 函数                                             |
| `src/merkl-api.ts` | `MerklOpportunityData` 加 `explorerAddress?: string` 字段（用于 source sub 识别） |
| `src/index.ts`     | 调用 `detectCrossAssetPairing()`，结果挂到 `oppBase.crossAssetPairing`            |

### 5.3 backend

| 文件                                  | 变更                                                         |
| ------------------------------------- | ------------------------------------------------------------ |
| `src/types/index.ts`                  | `MerklGroupEntry` 加 `crossAssetPairing?: CrossAssetPairing` |
| `src/services/persistenceService.ts`  | `buildMerklGroups` pass through `crossAssetPairing`          |
| `src/services/marketsApiSerialize.ts` | 序列化 pass through `crossAssetPairing`（无单位转换）        |

### 5.4 前端（aaveapy 仓库 — 独立 ticket）

| 文件                                  | 变更                                   |
| ------------------------------------- | -------------------------------------- |
| `src/types/aave.ts`                   | opportunity 类型加 `crossAssetPairing` |
| `src/shared/schema-fingerprint.ts`    | bump fingerprint                       |
| `src/lib/rateSimulationCalculator.ts` | 消费 `crossAssetPairing` 计算 min 公式 |
| `src/hooks/useRateSimulation.ts`      | 传递 crossAssetPairing 到 calculator   |

## 6. Scenario & Risk Verification Matrix

| #   | 场景                                                    | 风险维度           | 预期行为                                                                    | 测试类型 |
| --- | ------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------- | -------- |
| S1  | cbETH/ETH 机会：用户 supply 100 cbETH + borrow 50 ETH   | 正常路径           | effectivePos = min(50, 100×0.823) = min(50, 82.3) = 50                      | 单元测试 |
| S2  | cbETH/ETH 机会：用户 supply 50 cbETH + borrow 100 ETH   | paired 不足        | effectivePos = min(100, 50×0.823) = min(100, 41.15) = 41.15                 | 单元测试 |
| S3  | cbETH/ETH 机会：用户无 cbETH supply                     | paired = 0         | effectivePos = min(borrow, 0) = 0 → reward = 0                              | 单元测试 |
| S4  | cbETH/ETH 机会：用户无 ETH borrow                       | source = 0         | effectivePos = min(0, supply×0.823) = 0 → reward = 0                        | 单元测试 |
| S5  | sUSDe/USDe 机会：supply 100 sUSDe + 100 USDe            | supply/supply 配对 | effectivePos = min(100, 100×1.196) = min(100, 119.6) = 100                  | 单元测试 |
| S6  | sUSDe/USDe 机会：supply 50 sUSDe + 100 USDe             | paired 不足        | effectivePos = min(100, 50×1.196) = min(100, 59.8) = 59.8                   | 单元测试 |
| S7  | pairedReserveId resolve 失败（token 不在 reserveIdSet） | 失败/降级          | return null + warn 日志，前端当普通机会                                     | 单元测试 |
| S8  | composedMultiplier = "0"                                | 数值边界           | discountFactor = 0 → effectivePos = min(source, 0) = 0                      | 单元测试 |
| S9  | composedMultiplier 为空/undefined                       | 数值边界           | return null + warn                                                          | 单元测试 |
| S10 | composedCampaignsCompute 不是 "min(1,2)"                | 不触发             | return null                                                                 | 单元测试 |
| S11 | min(1,2) 但两个 sub underlyingToken 相同                | 同资产             | return null（同资产 min 是 net position，归 NPC 管）                        | 单元测试 |
| S12 | 机会同时有 netPositionConstraint 和 crossAssetPairing   | 互斥               | 实际数据中不会并存。如果有，两者都传，前端先检查 crossAssetPairing          | 单元测试 |
| S13 | looping 关键词 + min(1,2)                               | 并列条件           | crossAssetPairing 正常返回，不受 looping 影响                               | 单元测试 |
| S14 | 多链多 min(1,2) 机会                                    | 多实体             | 每个 opp 独立检测，无共享状态                                               | 集成测试 |
| S15 | V3 reserve + min(1,2)                                   | V3 路径            | resolveOffsetReserveIds V3 分支正确 resolve pairedReserveId                 | 单元测试 |
| S16 | API 序列化 pass through                                 | 跨Step契约         | crossAssetPairing 字段原样传递到 API JSON                                   | 快照测试 |
| S17 | schema fingerprint 变更                                 | CI/CD              | 后端 snapshot test 捕获 fingerprint 变更                                    | 快照测试 |
| S18 | 真实 Merkl 数据验证                                     | 外部依赖           | 用 merkl-raw-data.json 中的 cbETH/ETH 机会验证 detectCrossAssetPairing 输出 | 集成测试 |

## 7. 不在 scope 内

- AAV-1036（offsetNote 与 capNote 分离）
- 前端 UI 展示逻辑（crossAssetPairing 提示文案）
- V4 链 min(1,2) 机会（当前数据中无 V4 min(1,2) 案例，但 resolveOffsetReserveIds 已支持 V4）
- `max(1,2)` / 其他 compute 模式（当前数据中无）

## 8. 参考文档

- [ADR-0023: netPositionConstraint 检测架构](../adr/0023-net-position-constraint-detection.md)
- [Net Position Constraint 前端对接指南](../../aaveapy-doc/net-position-constraint-frontend-guide.md)
- Merkl 原始数据：`data/debug/merkl-raw-data.json`（cbETH/ETH 在 line 34562，sUSDe/USDe 在 line 5722）

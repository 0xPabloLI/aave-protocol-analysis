# Handoff: BORROW_BL 前端 Simulation 归零逻辑

## Linear Issue

AAV-962

## 问题

Merkl API 中部分 Aave supply opportunity 包含 `BORROW_BL` 标记，语义：**用户有 borrow position → 该 supply incentive 归零**。当前代码不处理。

## BORROW_BL 检测方式

### 可靠信号（主检测）

**`identifier` 字段含 `BORROW_BL` 后缀**

```typescript
// identifier 格式: "{explorerAddress}BORROW_BL"
// 示例: "0xEc4ef66D4fCeEba34aBB4dE69dB391Bc5476ccc8BORROW_BL"
const isBorrowBl = opp.identifier?.includes('BORROW_BL') ?? false;
```

### 辅助信号（不可单独判断）

**hookType=14** — campaign params 中的 hooks 数组含有 `hookType=14` 条目。

hookType=14 ≠ BORROW_BL。hookType=14 是"借款排除 hook"，但可能存在 hookType=14 但不含 BORROW_BL 的情况。检测逻辑以 `identifier` 为准。

### hookType=14 详情（逆向推断，无官方文档）

| hookType | protocol | borrowBytesLike 内容 | 含义 | 出现 opp |
|---|---|---|---|---|
| 14 | 0 | 64 字节 hash（3 个） | 未知 position identifier | 仅 USDtb |
| 14 | 1 | 地址（2 个） | 跨市场 vToken | 仅 USDtb |
| 14 | 2 | **vToken 地址（1 个）** | Aave V3 variableDebtToken | 全部 5 个 BORROW_BL opp |
| 14 | 3 | 地址（5 个） | 多资产 vToken | 仅 USDtb |

另有 hookType=17（HF >= 2.5 门槛），仅出现在 USDe/sUSDe opp 上，与 BORROW_BL 无关。

## 数据事实

5 个 LIVE opp 包含 BORROW_BL：

| Chain | Token | opportunityType | action | offset tokens | hooks |
|---|---|---|---|---|---|
| Ethereum | USDtb | AAVE_SUPPLY | LEND | 无 | hookType=14 (protocol 0,1,2,3) |
| Ethereum | USDe | MULTILOG_DUTCH | LEND | 无 | hookType=14 (protocol 2) + hookType=17 |
| Plasma | USDe | MULTILOG_DUTCH | LEND | 无 | hookType=14 (protocol 2) + hookType=17 |
| Mantle | USDe | MULTILOG_DUTCH | LEND | 无 | hookType=14 (protocol 2) + hookType=17 |
| MegaETH | USDe | AAVE_SUPPLY | LEND | 无 | hookType=14 (protocol 2) + hookType=17 |

- **不存在 SUPPLY_BL** — 0 个 borrow opp 带 `_BL` 后缀
- **BORROW_BL 只影响 supply 侧 incentive**
- **所有 BORROW_BL opp 都没有 offset tokens**

## 与 NET Position Constraint 的区别

| | NET | BORROW_BL |
|---|---|---|
| 效果 | borrow 量按比例抵消 | 有 borrow → 归零（二元排除） |
| offset tokens | 有（`params.tokens`） | 无 |
| hooks | 无 | hookType=14 |
| 代码处理 | `extractNetPositionConstraint` | 未处理 |
| 适用 incentive 侧 | supply | supply |
| 是否应生成 NPC | 是 | **否**（语义不同） |

**不应复用 `netPositionConstraint`**。建议新增独立字段。

## Simulation 已知逻辑

### 当前实现

前端 simulation 中，NET 类型的 incentive 通过 `netPositionConstraint` 处理：
- `sourceSide='supply'` → 用户 borrow 量按比例抵消 supply incentive
- `offsetReserveIds` → 列出参与抵消的 reserve

BORROW_BL 完全不处理 — 即使标识了 BORROW_BL 的 opp，simulation 仍按全额显示。

### 目标行为

BORROW_BL opp 的 simulation 规则：
1. **用户没有该 token 的 borrow position** → incentive 全额显示（无变化）
2. **用户有该 token 的 borrow position**（任何量 > 0）→ 该 supply incentive **归零**

### 与 NET 的交互

同一个 opp **不会同时是 NET 和 BORROW_BL**（数据中无此情况）。如果未来出现：
- NET + BORROW_BL 并存 → BORROW_BL 更严格，直接归零（NET 的按比例抵消被短路）

## 实现方向

### 后端：新增字段

在 `MerklOpportunityData` 或 `MerklCampaignBreakdown` 中新增：

```typescript
borrowBlacklist?: boolean;  // true = 有 borrow position 则 incentive 归零
```

检测逻辑（在 `processMerklData` 中）：

```typescript
const isBorrowBl = opp.identifier?.includes('BORROW_BL') ?? false;
// ...写入 opportunityData
```

### 前端：Simulation 归零

在 incentive simulation 逻辑中：

```typescript
if (breakdown.borrowBlacklist && userBorrowAmount > 0) {
  // 该 breakdown 的 incentive 归零
  effectiveApr = 0;
}
```

### 不需要做的事

- 不需要解析 hookType=14 的具体内容（protocol, borrowBytesLike）
- 不需要为 BORROW_BL 生成 `netPositionConstraint`
- 不需要处理 SUPPLY_BL（不存在）

## 关联

- PRD: AAV-924
- Slice 1: AAV-925 ✅
- AAV-906: hub-aware offset ✅
- Slice 2/3 handoff: `docs/plans/handoff-merkl-index-optimization-slice2-3.md`

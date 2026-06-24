# PRD: AAV-924 + AAV-921 — BORROW_BL 检测 & NPC Offset 默认值修正

## 问题陈述

### AAV-924: Merkl BORROW_BL incentive 未处理

Merkl API 中 5 个 LIVE opportunity 的 `identifier` 包含 `BORROW_BL` 后缀，语义为：**用户有 borrow position → 该 supply incentive 归零（二元排除）**。当前代码完全不处理，导致前端 simulation 对这些 opp 按全额 APR 显示，误导用户。

### AAV-921: NPC offsetLevel 默认值不符合合约语义

V4 合约层 collateral 按 spoke 维度计算（跨 hub 但不跨 spoke），但 `resolveOffsetReserveIds` 等函数默认 `offsetLevel='hub'`（normalizeOffsetLevel 映射为 `'reserve'`，仅精确匹配）。导致 V4 非 SPOKE_SUPPLY/HUB_SUPPLY 的 opportunity 使用过于严格的 offset 范围，可能遗漏合法的 offset reserve。

## 数据事实（AAV-924）

5 个 LIVE opp 包含 `BORROW_BL`：

| Chain | Token | opportunityType | action | offset tokens | hooks |
|---|---|---|---|---|---|
| Ethereum | USDtb | AAVE_SUPPLY | LEND | 无 | hookType=14 (protocol 0,1,2,3) |
| Ethereum | USDe | MULTILOG_DUTCH | LEND | 无 | hookType=14 (protocol 2) + hookType=17 |
| Plasma | USDe | MULTILOG_DUTCH | LEND | 无 | hookType=14 (protocol 2) + hookType=17 |
| Mantle | USDe | MULTILOG_DUTCH | LEND | 无 | hookType=14 (protocol 2) + hookType=17 |
| MegaETH | USDe | AAVE_SUPPLY | LEND | 无 | hookType=14 (protocol 2) + hookType=17 |

关键事实：
- **不存在 SUPPLY_BL** — 0 个 borrow opp 带 `_BL` 后缀
- **BORROW_BL 只影响 supply 侧 incentive**
- **所有 BORROW_BL opp 都没有 offset tokens**
- **BORROW_BL 与 NET 语义不同**：NET 按比例抵消，BORROW_BL 二元排除

## 设计决策

### D1: `borrowBlacklist` 放在 CampaignGroup 级（非 breakdown 级）

理由：
1. BORROW_BL 是 opportunity 级属性，与 `netPositionConstraint` 同级
2. 前端 simulation 先检查 `borrowBlacklist`（短路归零），再检查 `netPositionConstraint`（按比例抵消）
3. 一个 opportunity 下所有 breakdown 共享此约束，放 breakdown 级冗余

### D2: 检测方式以 `identifier` 字段为准

`opp.identifier?.includes('BORROW_BL')` 是主检测信号。`hookType=14` 是辅助信号但不可单独判断（存在 hookType=14 但不含 BORROW_BL 的情况）。

### D3: offsetLevel 默认值从 `'hub'` 改为 `'spoke'`

理由：
- V4 合约层 collateral 按 spoke 维度计算（`_userPositions` 和 `_positionStatus` 按 Spoke 存储）
- normalizeOffsetLevel('hub') = 'reserve'（仅精确匹配），过于严格
- normalizeOffsetLevel('spoke') = 'spoke-cross-hub'（3 段前缀匹配），与合约语义一致
- V3 路径不受影响（始终用 pool prefix 匹配）

### D4: 调用方三元链简化

当前 `index.ts:429` 的 fallback 是 `'hub'`，改为 `'spoke'`：
```typescript
// 改后
const oppOffsetLevel: OffsetLevel = opp.hasCrossMarketNpc
  ? 'cross-market'
  : opp.opportunityType?.includes('SPOKE_SUPPLY')
    ? 'spoke'
    : opp.opportunityType?.includes('HUB_SUPPLY')
      ? 'hub-cross-spoke'
      : 'spoke';  // 原 'hub'
```

### D5: 不复用 netPositionConstraint

BORROW_BL 语义（二元排除）与 NET（按比例抵消）不同。新增独立字段 `borrowBlacklist`。

## 实现范围

### Part 1: BORROW_BL 检测（AAV-924）

| 步骤 | 文件 | 变更 |
|---|---|---|
| 1.1 | `packages/aave-shared-config/index.d.ts` | `CampaignGroup` 新增 `borrowBlacklist?: boolean` |
| 1.2 | `packages/aave-fetcher/src/merkl-api.ts` | `MerklOpportunityData` 新增 `borrowBlacklist?: boolean` |
| 1.3 | `packages/aave-fetcher/src/merkl-api.ts` | `processMerklData` 中新增 `isBorrowBl` 检测逻辑 |
| 1.4 | `packages/aave-fetcher/src/index.ts` | `enrichDatasetWithIncentiveData` 中传递 `borrowBlacklist` 到 CampaignGroup |
| 1.5 | 测试 | 新增 BORROW_BL 检测测试 |

### Part 2: offsetLevel 默认值修正（AAV-921）

| 步骤 | 文件 | 变更 |
|---|---|---|
| 2.1 | `packages/aave-fetcher/src/merkl-api.ts` | 4 个函数默认值 `'hub'` → `'spoke'` |
| 2.2 | `packages/aave-fetcher/src/index.ts` | 调用方 fallback `'hub'` → `'spoke'` |
| 2.3 | 测试 | 更新 `resolveOffsetReserveIds-hub-aware.test.ts` 默认场景期望值 |
| 2.4 | 测试 | 更新 `netPositionConstraint.test.ts` V4 默认场景 |
| 2.5 | 测试 | 更新 `detectNetPositionConstraint.test.ts` V4 默认场景 |

## 不做的事

- 不解析 hookType=14 的具体内容（protocol, borrowBytesLike）
- 不为 BORROW_BL 生成 `netPositionConstraint`
- 不处理 SUPPLY_BL（不存在）
- 不修改 backend 序列化逻辑（`borrowBlacklist` 是 `CampaignGroup` 级字段，已在 shared-config 类型中，后端 `pruneMerklGroup` 会自动处理 undefined 字段）

## 验收标准

1. API 返回的 merklSupplys 中，包含 BORROW_BL 的 opportunity group 有 `borrowBlacklist: true`
2. 不包含 BORROW_BL 的 opportunity group 无 `borrowBlacklist` 字段（omitempty）
3. `resolveOffsetReserveIds` 默认参数行为从 hub 级精确匹配变为 spoke 级前缀匹配
4. V3 路径不受影响
5. 所有现有测试通过
6. `npm run ci:remote` 通过

## 关联

- AAV-924: PRD（BorrowBL + NPC offset）
- AAV-921: NPC offset hub-aware
- AAV-925: Slice 1 ✅
- AAV-962: BorrowBL handoff
- AAV-906: hub-aware offset ✅

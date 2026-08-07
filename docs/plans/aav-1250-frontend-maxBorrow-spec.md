# AAV-1250 Spec: 前端 maxBorrow 约束（per-pool/spoke LTV）

> **追溯 Spec** — 代码已实现并推送（commit `a1fba3cb` on `aaveapy` repo）。此文档为标准工作流补走产物。

## Problem Statement

Portfolio Simulation 模式下，用户可以输入任意 borrow 金额，没有 LTV 约束。这意味着用户能"借"到远超抵押价值上限的金额，导致模拟结果（APY、HF、NE APY）全部失真。用户无法获得真实的借款能力评估。

## Solution

在 `simulatePortfolioFromEntries` 中增加 per-pool/spoke LTV 约束：按 `(chainId, marketName)` 分组计算每个 group 的 `maxBorrowRemaining`，对用户输入的 borrow 金额执行硬截断（hard clamp），并在 UI 中展示截断提示。

## User Stories

1. 作为 Portfolio 用户，我希望模拟借款受到 LTV 约束，这样模拟结果反映真实借款能力
2. 作为 Portfolio 用户，当我输入的 borrow 超过 LTV 上限时，我希望看到截断提示，而不是悄悄改了数字让我困惑
3. 作为 Portfolio 用户，当我在同一个 pool 内有多个 reserve 时，我希望借款约束按 pool 整体计算，而不是每个 reserve 独立
4. 作为 Portfolio 用户，当我在不同 pool/spoke 有仓位时，我希望它们的借款约束互相独立，因为合约就是这样的
5. 作为 Portfolio 用户，当我正在修改某个 reserve 的 borrow 输入时，如果超额，我希望当前输入被截断而不是其他 entry 被截断
6. 作为 Portfolio 用户，当我的某个抵押资产 LTV=0（如 frozen reserve）时，我希望它不贡献借款能力，与合约行为一致
7. 作为 Portfolio 用户，当我的 borrow 输入同时超过 LTV 约束和 borrowCap 约束时，我希望取最严格的那个，而不是按某个固定优先级
8. 作为 Portfolio 用户，当我的 wallet 仓位 + 手动 delta 组合后超过 LTV 上限时，我希望截断基于总仓位而非仅 delta
9. 作为 Portfolio 用户，当我没有 supply 仓位时，我希望 maxBorrow=0，无法借款
10. 作为 Portfolio 用户，当我仅有 wallet supply 仓位（无手动 delta）时，我希望 maxBorrow 基于 wallet 仓位计算

## Implementation Decisions

### 1. 分组 Key

统一 V3/V4 使用 `(chainId, marketName)` 作为隔离边界。V4 的 `marketName` 已包含 spoke 信息（如 `AaveV4EthereumHub_usdc`），因此无需额外 spokeName 字段。

### 2. maxBorrow 公式

```
maxBorrowRemaining_group = Σ(supplyUsd_i × ltv_i / 100) - Σ(borrowUsd_i)
```

- `supplyUsd_i`：模拟后总仓位（wallet + delta），与合约行为一致
- `ltv_i`：来自 API 的 `reserve.ltv` 字段（percent，80 = 80%）。`undefined` 或 `0` → 贡献 0
- `borrowUsd_i`：模拟后总 borrow 仓位

### 3. 截断策略：最后修改优先（Last-Modified Gets Remaining）

- `usePortfolioSimulation` hook 追踪 `lastModifiedReserveId`
- 传入 `simulatePortfolioFromEntries` 的 `SimulatePortfolioEntriesArgs`
- 同一 group 内：非 lastModified 的 borrow entry 先全额占用额度，lastModified entry 拿 remaining
- 如果 `lastModifiedReserveId` 为空（如初始化），则所有 entry 平均受限（按 entry 顺序，后者拿 remaining）

### 4. 截断与 borrowCap 的交互

三个约束同等地位，一步取 min：

```
effectiveBorrowUsd = min(userInput, maxBorrowRemaining, borrowCapRemaining)
```

无优先级，哪个最低就哪个生效。

### 5. UX 模式

- **P3 scope**：Silent clamp + inline amber warning dot
- **P6 scope**（不在本 spec）："Adjust to max" 按钮、Summary 区域 maxBorrow 展示

### 6. 接口变更

- `SimulatePortfolioEntriesArgs` 新增可选字段 `lastModifiedReserveId?: string`
- `PortfolioPositionResult` 新增可选字段 `ltvClampedUsd?: number`（当 LTV 截断生效时记录截断后的金额，UI 据此显示警告）

### 7. ltv=0 / undefined 处理

`ltv=0`（V3 frozen reserve）或 `ltv=undefined`（API 未同步）时，该 reserve 的 `supplyUsd × ltv / 100 = 0`，不贡献借款能力。无需特殊分支，公式自然处理。

### 8. isCollateral

P3 不处理 `isCollateral` 字段（默认所有 supply 都是 collateral）。P4/P7 再加入 per-reserve collateral 开关。

### 9. 仓位基准

使用模拟后总仓位（wallet + delta），而非仅 delta。例如：wallet supply $1000 + delta +$500 → 总 supply $1500，用于计算 maxBorrow。

## Scenario & Risk Verification Matrix

| #   | 场景                                         | 输入                                                                     | 预期行为                                   | 风险维度     | 测试用例 |
| --- | -------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------ | ------------ | -------- |
| S1  | 单 reserve，borrow 在 LTV 限内               | supply $10000, ltv=80%, borrow $5000                                     | 不截断，amountUsd=5000                     | 正常路径     | ✅       |
| S2  | 单 reserve，borrow 超 LTV                    | supply $10000, ltv=80%, borrow $9000                                     | 截断到 $8000, ltvClampedUsd=8000           | 截断正确性   | ✅       |
| S3  | 单 reserve，无 supply                        | supply=0, borrow $1000                                                   | maxBorrow=0, 截断到 0                      | 边界：零抵押 | ✅       |
| S4  | 单 reserve，ltv=0 (frozen)                   | supply $10000, ltv=0, borrow $1000                                       | maxBorrow=0, 截断到 0                      | 边界：frozen | ✅       |
| S5  | 单 reserve，ltv=undefined                    | supply $10000, ltv=undefined, borrow $1000                               | maxBorrow=0, 截断到 0                      | 边界：缺失   | ✅       |
| S6  | 同 pool 两 reserve，第二个超 remaining       | r1: supply $10k ltv=80%, r2: supply $5k ltv=80%, borrow r2 $13k          | group maxBorrow=$12k, r2 截断到 $12k       | 跨 reserve   | ✅       |
| S7  | 不同 pool 两 reserve，各自独立               | pool A: supply $10k ltv=80%, pool B: supply $10k ltv=80%, borrow B $9k   | B 在自身 pool 内 maxBorrow=$8k, 截断到 $8k | 隔离边界     | ✅       |
| S8  | 同 pool 两 borrow entry，lastModified 拿剩余 | r1 borrow $3k (非 last), r2 borrow $10k (last), group maxBorrow=$8k      | r1 全额 $3k, r2 拿 $5k remaining           | lastModified | ✅       |
| S9  | borrowCap 低于 maxBorrow                     | supply $10k ltv=80%, borrowCap remaining=$5k, borrow $7k                 | 截断到 $5k (borrowCap 生效)                | 约束交互     | ✅       |
| S10 | maxBorrow 低于 borrowCap                     | supply $10k ltv=80%, borrowCap remaining=$10k, borrow $9k                | 截断到 $8k (LTV 生效)                      | 约束交互     | ✅       |
| S11 | 三个约束都触发                               | supply $10k ltv=80%, borrowCap=$5k, borrow $15k                          | 截断到 $5k (min of 8k, 5k, 15k)            | 约束交互     | ✅       |
| S12 | V4 同链不同 spoke                            | spoke A: supply $10k ltv=80%, spoke B: supply $10k ltv=80%, borrow B $9k | B 在自身 spoke group 内 maxBorrow=$8k      | V4 隔离      | ✅       |
| S13 | wallet + delta 组合仓位                      | wallet supply $5k + delta +$5k, ltv=80%, borrow $9k                      | 总 supply=$10k, maxBorrow=$8k, 截断        | 仓位基准     | ✅       |
| S14 | 同 reserve 多 entry 聚合后截断               | r1: supply $5k, r1 dup: supply $5k, ltv=80%, borrow $9k                  | 聚合 supply=$10k, maxBorrow=$8k            | 聚合正确性   | ✅       |
| S15 | supply delta 为负（提款）减少抵押            | wallet supply $10k - delta $5k, ltv=80%, borrow $5k                      | 有效 supply=$5k, maxBorrow=$4k, 截断到 $4k | 负 delta     | ✅       |
| S16 | lastModifiedReserveId 为空（初始化）         | 两 borrow entry, 无 lastModified                                         | 按 entry 顺序前者全额，后者拿 remaining    | 降级处理     | ✅       |
| S17 | lastModified 不在当前 group 中               | lastModified 在 pool A, 但 pool B 有超限 borrow                          | pool B 按 entry 顺序截断                   | 跨 group     | ✅       |
| S18 | 100% LTV 资产（V4 collateralFactor=100）     | supply $10k ltv=100%, borrow $10k                                        | maxBorrow=$10k, 不截断                     | V4 满额      | ✅       |
| S19 | 多 group 同时超限                            | pool A 和 pool B 各有超限 borrow                                         | 各自独立截断，互不影响                     | 并行安全     | ✅       |

### 风险维度说明

| 风险类型          | 评估                                                                            |
| ----------------- | ------------------------------------------------------------------------------- |
| **并发/竞态**     | `lastModifiedReserveId` 在 React state 更新中设置，不存在竞态（单线程事件循环） |
| **内存泄漏**      | 无新缓存/Map/闭包。`lastModifiedReserveId` 是一个 string，随 args 传递          |
| **数据一致性**    | `ltv=undefined` 降级为 0，不会 crash。与后端 AAV-1222 已交付的 `ltv` 字段一致   |
| **CI/CD 交互**    | 纯前端改动，无后端变更，无 DB 迁移                                              |
| **外部 API 失败** | 不涉及外部 API 调用，`ltv` 来自已有 API response                                |
| **跨包一致性**    | 仅改 `aaveapy/` 前端，不涉及 `packages/` 或 `backend/`                          |

## Testing Decisions

### 测试 Seam

**主要 Seam**：`simulatePortfolioFromEntries`（纯函数，已有测试覆盖）

这是最高层纯函数入口。所有分组、截断、metrics 计算逻辑都流经此函数。新增的 maxBorrow 截断逻辑在此函数内部实现，可直接通过输入/输出断言测试。

**次要 Seam**：`buildPerReserveInputsFromEntries`（纯函数，已有测试覆盖）

如果需要暴露 per-group 中间数据（如 group maxBorrow），可在此层增加测试。

### 测试原则

- 只测外部行为（输入 → 输出），不测内部实现细节
- 使用现有的 `makeRateCalcReserve` / `makeEntry` / `baseEntriesSimArgs` 测试工厂
- 优先用 `simulatePortfolioFromEntries` 的结果断言 `amountUsd` 和 `ltvClampedUsd`
- 不需要 mock 任何外部依赖

### 先验测试

`portfolioSimulator.test.ts` 中已有 30+ 个测试用例覆盖 `simulatePortfolioFromEntries` 和 `buildPerReserveInputsFromEntries`，新增测试沿用同样的模式。

### 运行时验证（补做）

- [x] 单元测试：19 个场景 (S1-S19) 全部通过
- [x] Dev server 验证：`npm run dev:staging` 启动成功 (port 8080)，Portfolio 模式 toggle 正常开启
- [x] Playwright E2E 回归：跑了 5 个 portfolio 相关 spec 文件（27 passed, 21 failed, 32 skipped）

#### E2E 失败分析（21 failures）

| 失败类别                                   | 数量 | 根因                                                                                 | 类型                      |
| ------------------------------------------ | ---- | ------------------------------------------------------------------------------------ | ------------------------- |
| cross-reserve-offset (self-loop)           | 8    | LTV 截断限制了 borrow ≤ supply×ltv/100，测试中 borrow $1000/$2000 被截断到 maxBorrow | 预期行为变更 — 测试需更新 |
| cross-reserve-offset (cross-reserve)       | 6    | 同 pool 内 borrow 受 target supply 的 LTV 限制                                       | 预期行为变更 — 测试需更新 |
| cross-reserve-offset (mobile)              | 2    | 同上（mobile 变体）                                                                  | 预期行为变更 — 测试需更新 |
| incentive-calculation (columns)            | 1    | supply-incentive 显示 "—"——需排查是 staging 数据变更还是代码问题                     | 待排查                    |
| incentive-calculation (current invariance) | 2    | 大额 supply delta 后 current 值变化——可能与 simulation 重算有关                      | 待排查                    |
| inline-delta                               | 1    | delta badges 因 borrow 截断而显示不同值                                              | 预期行为变更 — 测试需更新 |

**结论**：15/21 失败是 LTV 截断引入的预期行为变更（测试假设 unlimited borrow 不再成立），需更新测试逻辑。6/21 待排查（可能与 staging 数据变更有关，需在 pre-P3 commit 上验证）。

**Follow-up**：创建 Linear issue 跟踪 E2E 测试修复。

## Out of Scope

- **"Adjust to max" 按钮**：P6 (AAV-1252)
- **Summary 区域 maxBorrow 展示**：P6 (AAV-1252)
- **Health Factor 计算**：P4 (AAV-1251)
- **NE APY UI 展示**：P5 (AAV-1249)
- **isCollateral per-reserve 开关**：P4/P7
- **V4 drawCap（Spoke 级借款上限）**：API 未暴露，follow-up
- **on-chain HF baseline**：P7 (AAV-1253)

## Further Notes

- 后端 `ltv`/`liquidationThreshold` 已在 AAV-1222 交付，前端类型已在 AAV-1248 (P2) 同步
- V3 的 `ltv` < `liquidationThreshold`（有安全缓冲），V4 两者同值 = `collateralFactor`。本 spec 只用 `ltv`，不用 `liquidationThreshold`（后者是 P4 HF 计算用的）
- 参考 `aaveapy-doc/v3-v4-collateral-and-health-factor.md` §4 "前端公式统一"
- 参考 `aaveapy-doc/hub-spoke-position-isolation.md` §10 "可借量约束链路"

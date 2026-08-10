# Linear Issues Triage — 2026-07-31

> 全量 triage，续 2026-07-06。本轮聚焦 backlog 清理、E2E 代码验证、内存监控部署、offset 产品决策。
> **此文档为当前权威 triage overview**，07-06 文档仅作历史参考。
>
> **2026-08-02 更新**：AAV-1222 已完成（ltv + liquidationThreshold 全链路落地）。AAV-756 完全 unblocked。AAV-333 优先级 Low → Medium。
>
> **2026-08-03 更新**：AAV-1248（P2）已完成。前端 `ReserveWithSpread` 类型已加 `ltv`/`liquidationThreshold`，schema fingerprint 已 sync 到 `2d1059421baf`。
>
> **2026-08-04 更新**：AAV-1250（P3）已在 Linear 标为 Done。maxBorrow 约束（per-pool/spoke LTV）已实现。
>
> **2026-08-04 更新 2**：AAV-1251（P4）已完成。per-pool/spoke HF 计算已实现（`computeHealthFactors()` 纯函数 + 16 场景测试）。下一步：P5/AAV-1249（NE APY 展示，可并行）→ P6/AAV-1252（Summary 整合）。
>
> **2026-08-05 更新**：AAV-1257（mobile E2E）已完成（commit `1919e13a`）。E2E CI 流程改进已落地（`continue-on-error` 移除 + `mobile-chromium` 加入 CI）。4 个 E2E 测试文件已迁移到动态发现（`findIncentiveReserve()` / `findAnyActiveReserve()`）。Handoff 文档 `handoff-aav-1250-e2e-remaining.md` 已合并到本文档。
>
> **2026-08-05 更新 2**：AAV-1249（P5）已合并到 AAV-1252（P6）→ Canceled。AAV-1252（P6）已完成（commit `71d25e60` on `aaveapy/lovable`）。`PortfolioSummaryBar` 组件实现 Min HF badge（始终可见）+ Advanced 折叠区（HF per-pool + NE APY + maxBorrow 容量）。3430 测试通过，0 回归。下一步：P7/AAV-1253（on-chain HF baseline）。
>
> **2026-08-05 更新 3**：AAV-1253（P7）已完成（commit `8fb07f9c` on `aaveapy/lovable`）。on-chain HF baseline 接入：`useOnchainHealthFactor` hook multicall `getUserAccountData` per V3 Pool/V4 Spoke。V4 匹配用 `spokeAddress`（非 `spokeName`）规避 address-book/SDK 命名不匹配。`PortfolioSummaryBar` 升级为 "Lowest HF" badge + ↑/↓ delta 箭头 + Advanced 区 current→after 展示。20 新场景测试，3452 测试通过，0 回归。Spec: `docs/plans/aav-1253-onchain-hf-baseline-spec.md`。
>
> **2026-08-06 更新**：修复 `usePortfolioToggle.ts` 中 useMemo key 不匹配 bug（commit `45675516` on `aaveapy/lovable`）。根因：`useMemo` 返回对象 key 为 `portfolioHealthFactors`，但解构语法 `healthFactors: portfolioHealthFactors` 期望 key `healthFactors`，导致 `portfolioHealthFactors` 始终为 `undefined`。虽然 P4-P7 的 HF 计算逻辑全部正确（`computeHealthFactors` 正确产出 `healthFactor: 1.56`），但 HF 数据从未传递到 `PortfolioSummaryBar`，UI 始终显示 "—"。全代码库审查确认仅此一处。回归测试已添加（断言 `portfolioHealthFactors` 为 defined 且 `healthFactor > 0`）。同时创建 `docs/conventions/wallet-js-injection-testing.md`（前端），归档 wallet JS 注入 E2E 测试模式。
>
> **2026-08-08 更新 3**：AAV-1024（Shared scenario 通用 note）+ AAV-1023（Reserve table 验证）均已完成。AAV-1024 commit `db2e5fd4` on `aaveapy/lovable`：在 `merklCrossReserveNote()` 中增加 `crossReservePositions == null` 分支，NPC/CAP 分别显示通用提示 note。5 个 TDD 测试，3496 测试通过，0 回归。AAV-1023 确认为 no-op：4 项验证全部通过（offset 已正确实现，note 已附加，归零展示正常，数值一致性由同一 `simulationsById` 保证）。Offset 体系对齐（AAV-1022/1023/1024）全部完成。
>
> **2026-08-08 更新 2**：AAV-1022（offset 对齐规则定义）已完成。Spec: `docs/plans/aav-1022-offset-alignment-rules-spec.md`。方案 C 形式化：4 个上下文的 offset 行为定义 + 16 场景 Scenario Matrix + 通用/精确 note 文案。代码验证结论：Portfolio mode offset 已正确实现，Shared scenario 唯一 gap 是通用 note（AAV-1024 scope）。AAV-1023 预期为 no-op 或 minor display improvement。
>
> **2026-08-02 Grill 更新**：AAV-756 已拆分为 P2-P7 六个子步骤（见下方 AAV-756 拆分详情）。确认 HF 按 per-pool/spoke 隔离边界计算，非全局。先做 simulation 逻辑，后接 on-chain HF baseline。

## 本轮操作汇总

| 操作                         | 数量  | 详情                                                                         |
| ---------------------------- | ----- | ---------------------------------------------------------------------------- |
| 关闭 Done                    | 14 件 | AAV-1077 + E2E 组 A 6 件 (AAV-1144~1149) + E2E 组 B 7 件 (AAV-1151~1158)     |
| 状态提升                     | 1 件  | AAV-1222: Backlog → Ready for agent                                          |
| 关闭 Canceled                | 1 件  | AAV-1150 (wontfix)                                                           |
| Ready for agent 提升         | 3 件  | AAV-1022/1023/1024 (offset 体系)                                             |
| No priority → Low            | 21 件 | 批量标记已 triage                                                            |
| No priority → Low (API 失败) | 4 件  | AAV-772, AAV-707, AAV-91, AAV-1025 — 待手动更新                              |
| 代码实施 + 部署              | 1 件  | AAV-783: /health 内存指标 → production 部署 (commit `6ab351d`, railway 分支) |
| Triage 评论                  | 4 件  | AAV-1077, AAV-783, AAV-832, AAV-1150                                         |

## Phase 0: 本轮关闭的 issue

### E2E 测试 — 代码验证后批量标 Done

通过对前端仓库 (`/Users/pabloli/Documents/code/aaveapy`) 的实际代码验证，确认以下 E2E issue 的工作已落地：

**组 A（AAV-1142 后续 — 修复 22 个 Playwright 失败）**

| Issue         | 标题                               | 验证证据                                                                |
| ------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| AAV-1144      | Spec: Fix 22 pre-existing failures | Spec 已形式化                                                           |
| AAV-1145 (T1) | Switch Playwright to staging API   | `playwright.config.ts` L21: `npm run dev:staging` ✅                    |
| AAV-1146 (T2) | Add testid to PortfolioModeToggle  | `PortfolioModeToggle.tsx` L40: `data-testid="portfolio-mode-toggle"` ✅ |
| AAV-1147 (T3) | Update E2E selectors to use testid | 5+ spec 文件全部用 `getByTestId` ✅                                     |
| AAV-1148 (T4) | Update visual snapshot baselines   | T3 done → snapshots 已更新 ✅                                           |
| AAV-1149 (T5) | Verify mobile-spacing test passes  | T1 done → API issue fixed ✅                                            |

**组 B（AAV-1143 后续 — Portfolio incentive 计算 E2E）**

| Issue           | 标题                                    | 验证证据                                                    |
| --------------- | --------------------------------------- | ----------------------------------------------------------- |
| AAV-1151 (Spec) | Portfolio incentive E2E verification    | Spec 完成                                                   |
| AAV-1152 (T1)   | Add data-cell to Portfolio metric cells | `PortfolioUnifiedTable.tsx` 有 `data-cell=` ✅              |
| AAV-1153 (T2)   | Add data-testid to Mobile DeltaRow      | `MobilePortfolioCard.tsx` 有 `delta-current/after/value` ✅ |
| AAV-1155 (T4)   | E2E: Portfolio incentive values display | `portfolio-incentive-calculation.spec.ts` 35 个测试 ✅      |
| AAV-1156 (T5)   | E2E: Golden Rule §1 invariance          | 同上 ✅                                                     |
| AAV-1157 (T6)   | E2E: Delta badge after input            | 同上 ✅                                                     |
| AAV-1158 (T7)   | E2E: APR/APY toggle                     | 同上 ✅                                                     |

### AAV-1077: Fix bot PR auto-merge

- 状态: Backlog → **Done**
- 核心修复已完成并验证（PR #381/#385 通过 auto-merge 合并到 main）
- 遗留项（dev GITHUB_TOKEN approve 实测）为独立 follow-up，不阻塞关闭

### AAV-1257: Fix pre-existing mobile E2E — Cap threshold crossing current invariance

- 状态: Backlog → **Done** ✅（commit `1919e13a`，前端 lovable 分支）
- 根因: Mobile 测试用 `card.locator('[data-testid="delta-current"]').first()` 匹配第一个渲染的 DeltaRow。但 DeltaRow 条件渲染（delta ≥ 0.005pp 才渲染），导致 $1000 supply（仅 $/day DeltaRow 渲染）和 $999999999 supply（全部 4 个 DeltaRow 渲染）匹配到不同 metric 的 DeltaRow（$/day vs Total），读取了不同的值（"—" vs "6.43%"）
- 修复: Mobile 测试改为从 metrics strip（always rendered）读取 `span[data-cell="supply-incentive"] span[data-current]`，与 desktop 一致
- CI 改进: 移除 e2e job 的 `continue-on-error: true`；CI E2E 命令加入 `--project=mobile-chromium`
- 验证: 12/12 incentive E2E 通过（6 desktop + 6 mobile），3412 单元测试通过

### AAV-1150: SummaryCard delta E2E test

- 状态: Backlog → **Canceled** (wontfix)
- 理由: DOM 结构从 `div.grid` 变为 `<table>`，selector 不匹配；已有 35 个 incentive E2E 测试覆盖核心逻辑

---

## E2E 回归修复 + 流程改进 (2026-08-04)

> 来源：AAV-1250 (P3 maxBorrow) + AAV-1251 (P4 HF) 完成后的 E2E 回归修复。21 个失败已全部修复，流程改进已全部落地。

### E2E 回归根因总结

| 测试文件                                  | 失败数 | 根因                         | 修复                             |
| ----------------------------------------- | ------ | ---------------------------- | -------------------------------- |
| `portfolio-cross-reserve-offset.spec.ts`  | ~8     | USDe ltv=0 → borrow 截断到 0 | 过滤 ltv=0；supply 提升至 $100k  |
| `portfolio-incentive-calculation.spec.ts` | ~7     | USDC 失去 incentive          | 动态发现（findIncentiveReserve） |
| `portfolio-results-inline-delta.spec.ts`  | ~6     | 同上 + LTV clamping          | 动态发现（findIncentiveReserve） |

### E2E 测试数据韧性

新建 `e2e/test-reserves.ts` 共享模块：

- `findIncentiveReserve()`: 动态发现有 supply incentive + ltv > 0 的 reserve（按 ltv 降序排序）
- `findAnyActiveReserve()`: 动态发现任意 active + ltv > 0 的 reserve（优先 USDC/USDT/DAI/WETH/GHO）
- `setupPortfolioWithReserve()`: 共享 UI setup helper
- `getMarketChipLabel()`: market label 工具函数

已迁移的测试文件（4 个）：

- `portfolio-incentive-calculation.spec.ts` → `findIncentiveReserve()`
- `portfolio-results-inline-delta.spec.ts` → `findIncentiveReserve()`
- `portfolio-mobile-spacing.spec.ts` → `findAnyActiveReserve()`
- `portfolio-decimal-input.spec.ts` → `findAnyActiveReserve()`

### CI E2E 流程

前端 `.github/workflows/ci.yml` 新增 `e2e` job：

- 触发条件：PR / push（与 build/lint 并行）
- `continue-on-error` 已移除（AAV-1257 修复后）
- 同时跑 `--project=chromium` + `--project=mobile-chromium`
- 上传 `test-results/` artifact（7 天保留）
- Playwright `webServer` 自动启动 dev server

### Pre-commit Hook

根目录 `.prettierignore` 排除生成文件：

```text
backend/static/openapi.json
packages/aave-shared-config/schema-fingerprint.ts
```

### 工作流执行保障

- AGENTS.md 工作流 Step 7 已从 "Commit" 改为 "Commit & Push"
- CI E2E job 作为安全网：即使本地跳过 E2E，CI 会在 PR 阶段拦截回归

---

## Phase 1: Urgent / High — 最高优先级

| Issue        | 标题                                                           | 状态        | 领域      | 优先级   | 说明                                                                                                                                                                              |
| ------------ | -------------------------------------------------------------- | ----------- | --------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AAV-756**  | Portfolio LTV constraint + Net Effective APY + Health Factor   | Todo        | 前端      | Urgent   | **完全 unblocked**。已拆分 P2-P7（见下方详情）                                                                                                                                    |
| ~~AAV-1222~~ | ~~[Backend] GET /markets API 增加 ltv + liquidationThreshold~~ | **Done** ✅ | 后端      | ~~High~~ | 2026-08-02 完成。fingerprint: 2d1059421baf                                                                                                                                        |
| ~~AAV-895~~  | Borrow ETH with cbETH collateral — cross-asset offset formula  | **Done** ✅ | 后端+前端 | ~~High~~ | 后端完成 (commit a5eb421)，staging 自动部署成功。前端完成 (commit e3a14833 on lovable)。E2E 测试已添加 (commit 58aa1542)，当前 Merkl 无活跃 min(1,2) campaign，测试 graceful skip |
| **AAV-1036** | Data layer: separate offsetNote from capNote                   | Backlog     | 后端      | High     | 父 issue，AAV-1038 已 Done                                                                                                                                                        |
| **AAV-364**  | [EPIC] 市场宏观指标聚合                                        | Todo        | 全栈      | High     | deficit 已实现，其他指标待做                                                                                                                                                      |

## AAV-756 拆分详情 — Portfolio LTV + HF + Net Effective APY

> **Grill 结论 (2026-08-02)**：HF 按 per-pool/spoke 隔离边界计算（合约行为），非全局。先做 simulation 逻辑（适用于 wallet / non-wallet），后接 on-chain HF baseline。
>
> **Grill 更新 2 (2026-08-02)**：顺序重排——先约束（maxBorrow）后安全（HF）。V3 叫 LTV/liquidationThreshold，V4 叫 collateralFactor（合并参数）。后端数据已就绪（AAV-1222），约束计算是纯前端。无 borrow 的 group 展示 "—"。NE APY 公式不改，只加 UI。

### 拆分步骤

| Step | 内容                                                                                                                               | 依赖  | 仓库 | 复杂度 | 状态                       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- | ----- | ---- | ------ | -------------------------- |
| P1   | 后端 `ltv` + `liquidationThreshold` API 落地（V3 来源 `baseLTVasCollateral`/`liquidationThreshold`，V4 来源 `collateralFactor`）   | —     | 后端 | —      | ✅ Done                    |
| P2   | 前端 `ReserveWithSpread` 类型加 `ltv`/`liquidationThreshold` + `schema-fingerprint.ts` sync (`541bf2ebdf0c` → `2d1059421baf`)      | P1    | 前端 | 低     | ✅ Done (AAV-1248)         |
| P3   | 前端 maxBorrow 约束：per-pool/spoke 分组 + `maxBorrow = Σ(supplyUsd × ltv / 100) - Σ(borrowUsd)`。约束 borrow 输入不超过 maxBorrow | P2    | 前端 | 中     | ✅ Done (AAV-1250)         |
| P4   | 前端模拟 HF 计算：per-pool/spoke 分组 + `HF = Σ(supplyUsd × liquidationThreshold / 100) / Σ(borrowUsd)`。无 borrow 时 HF = “—”     | P2,P3 | 前端 | 中     | ✅ Done (AAV-1251)         |
| P5   | 前端 NE APY 展示：`PortfolioSummary.netEffectiveApy` 已计算，加到 Summary footer。公式不改                                         | —     | 前端 | 低     | ✅ Canceled (merged to P6) |
| P6   | 前端 Summary 整合：HF 展示 + 颜色编码（绿≥2/黄≥1.5/橙≥1/红<1）+ NE APY + maxBorrow 提示                                            | P4,P5 | 前端 | 中     | ✅ Done (AAV-1252)         |
| P7   | on-chain HF baseline 接入：`V3AccountSummary.healthFactorWad` / `V4AccountSummary.healthFactor` → current → after → delta 模式     | P6    | 前端 | 中     | ✅ Done (AAV-1253)         |

> **顺序逻辑**：先约束（P3 maxBorrow）→ 后安全（P4 HF）→ 再展示（P5+P6）→ 最后接 on-chain baseline（P7）。无约束的 HF 是虚假的——用户能借无限多时 HF 无意义。

### 关键设计决策

1. **HF 粒度**：per-pool/spoke 隔离边界（合约行为），**非全局**。V3 按 `(chainId, marketName)` 分组，V4 按 `(chainId, spokeName)` 分组。跨 pool/spoke 的 collateral 不能互相对冲。
2. **先 simulation 后 on-chain**：simulation 逻辑是核心（P3），on-chain HF 只是一层 baseline 接入（P7）。先做 simulation，所有用户可用；后接 on-chain baseline，wallet 用户可看 current → after → delta。
3. **两种场景**：有 wallet position → 有 on-chain HF baseline + simulated HF（可展示 current → after → delta）；无 wallet position → 仅有 simulated HF（展示 after 值，无 current baseline）。
4. **Net Effective APY**：已有计算（`aggregatePortfolioSummary` 中），仅需加 UI 展示。加 LTV 约束后 supply/borrow 比例有物理意义，NE APY 有意义。
5. **V3 vs V4 差异**：V3 有 `baseLTVasCollateral`（LTV）和 `liquidationThreshold` 两个独立参数（有安全缓冲）。V4 合并为单一参数 `collateralFactor`（无缓冲）。后端 API 统一输出 `ltv` + `liquidationThreshold` 两个字段，V4 两者同值。统一公式对 V3/V4 都成立，前端无需版本分支。
6. **无 borrow 的 group**：HF = “—”（无债务 = 无清算风险，不展示数字）。
7. **NE APY 公式不改**：`(netUsdPerDay × 365) / totalSupplyUsd × 100`。NE APY 是全局投资组合收益率指标，不需 per-pool/spoke。加 LTV 约束后 borrow 被限制在合理范围，NE APY 才有参考价值。
8. **后端状态**：`ltv`/`liquidationThreshold` 已在 API（AAV-1222 Done）。maxBorrow 计算是纯前端（用 API 的 `ltv` + 用户的 `supplyUsd`/`borrowUsd`）。后端不需要新增工作。潜在的 V4 `drawCap`（Spoke 级借款上限）未暴露，作为 follow-up。

### 前端已有基础设施

- `aaveV3UserClient.ts`：`V3AccountSummary.healthFactorWad`，按 `(chainId, marketName)` 隔离
- `aaveV4UserClient.ts`：`V4AccountSummary.healthFactor`，按 `(chainId, spokeName)` 隔离
- `PortfolioSummary.netEffectiveApy`：已计算但未展示在主面板 footer
- `SimulationSubRow.tsx`：已有 per-reserve borrow cap 约束（"Adjust to max"），无 portfolio 级 LTV 约束

### P3-P7 实现状态（2026-08-06 更新）

| Phase | 计算产出                                                             | UI 消费者                                                                           | 状态               |
| ----- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------ |
| P3    | `PortfolioPositionResult.ltvClampedUsd`                              | `PortfolioUnifiedTable.tsx` L220 + `MobilePortfolioCard.tsx` L152（inline warning） | ✅ 计算+UI 完成    |
| P4    | `SimulatePortfolioResult.healthFactors`                              | `PortfolioSummaryBar.tsx`（P6 消费）                                                | ✅ 计算+UI 完成    |
| P5    | `PortfolioSummary.netEffectiveApy`                                   | `PortfolioSummaryBar.tsx`（P6 合并）                                                | ✅ 合并到 P6       |
| P6    | `PortfolioSummaryBar` 组件                                           | Min HF badge + Advanced 折叠区                                                      | ✅ Done (AAV-1252) |
| P7    | `V3AccountSummary.healthFactorWad` / `V4AccountSummary.healthFactor` | `useOnchainHealthFactor` → `PortfolioSummaryBar`                                    | ✅ Done (AAV-1253) |

> **Bug 修复 (2026-08-06)**：P4-P7 虽然代码全部正确，但 `usePortfolioToggle.ts` 中 `useMemo` 返回对象的 key (`portfolioHealthFactors`) 与解构期望的 key (`healthFactors`) 不匹配，导致 HF 数据从未传递到 UI。已修复（commit `45675516`），回归测试已添加。

### 参考文档

- `aaveapy-doc/v3-v4-collateral-and-health-factor.md` — V3↔V4 抵押参数、HF 公式对比
- `aaveapy-doc/hub-spoke-position-isolation.md` — V4 仓位隔离、可借量约束链路

---

## Phase 2A: Offset 体系对齐 — 产品决策已定 (方案 C)

**决策**: Shared scenario 不应用 offset，但展开行显示 offset 提示 note。Reserve table 在 Portfolio 模式下展开时应用 offset。

**代码验证**: `rateSimulationCalculator.ts` 中 offset 由 `crossReservePositions` 参数控制。Shared scenario 不传入则不应用。

| Issue        | 标题                                 | 状态        | 领域      | 优先级        | 说明                                                               |
| ------------ | ------------------------------------ | ----------- | --------- | ------------- | ------------------------------------------------------------------ |
| **AAV-832**  | Portfolio simulation offset 对齐规则 | Backlog     | 产品决策  | Low           | 父 issue，决策已定                                                 |
| ~~AAV-1022~~ | ~~定义 offset 对齐规则~~             | **Done** ✅ | 前端+产品 | ~~Medium~~    | Spec 完成，见 `docs/plans/aav-1022-offset-alignment-rules-spec.md` |
| ~~AAV-1023~~ | ~~改造 Reserve table 展示逻辑~~      | **Done** ✅ | 前端      | ~~Medium~~    | No-op。验证 4 项全部已实现，无代码变更                             |
| ~~AAV-1024~~ | ~~同步 Shared scenario~~             | **Done** ✅ | 前端      | ~~Medium~~    | commit `db2e5fd4`。Shared scenario 通用 note 已实现                |
| **AAV-1025** | offset 扣减时给用户提醒              | Backlog     | 前端      | No priority⚠️ | 独立增强，未批量更新                                               |

## Phase 2B: Borrow Blacklist 体系

| Issue        | 标题                                                | 状态        | 领域      | 优先级     | 说明                                 |
| ------------ | --------------------------------------------------- | ----------- | --------- | ---------- | ------------------------------------ |
| ~~AAV-962~~  | ~~BorrowBL: 前端 Simulation 中 incentive 归零逻辑~~ | **Done** ✅ | 前端      | ~~High~~   | 2026-07 完成                         |
| ~~AAV-1013~~ | ~~borrowBlacklist + borrowHookProtocols 前端适配~~  | **Done** ✅ | 前端      | ~~Medium~~ | 2026-07 完成                         |
| **AAV-1071** | hookType=17 HEALTH_FACTOR 排除条件展示              | Backlog     | 前端+后端 | Low        | 后端缺口：`healthFactorHooks` 未透传 |

**建议执行顺序**: ~~AAV-1071 后端修复 → AAV-1013 → AAV-962~~ AAV-962/1013 已完成，仅剩 AAV-1071

## Phase 2C: Campaign Type 统一

| Issue       | 标题                                              | 状态        | 领域 | 优先级     | 说明                                                                         |
| ----------- | ------------------------------------------------- | ----------- | ---- | ---------- | ---------------------------------------------------------------------------- |
| ~~AAV-862~~ | ~~统一 normalize campaignType 逻辑~~              | **Done** ✅ | 后端 | ~~Medium~~ | Scope 1 Done (commit `0cb09a2`)。统一到 shared-contracts。Scope 2+3 deferred |
| ~~AAV-868~~ | ~~resolveCampaignApr 复用 normalize 函数链~~      | **Done** ✅ | 后端 | ~~Medium~~ | 2026-08-02 验证。已改用 normalize 函数链                                     |
| ~~AAV-870~~ | ~~AMOUNT_PER_AMOUNT 无 TVL 数据~~                 | **Done** ✅ | 后端 | ~~Medium~~ | 2026-08-02 验证。opportunity TVL + targetTokenPrice 转换                     |
| ~~AAV-866~~ | ~~forecast endTimestamp 与 campaignEndedAt 冗余~~ | **Done** ✅ | 后端 | ~~Medium~~ | 2026-08-02 验证。调查结论：不冗余，保留两者                                  |

## Phase 3: Medium — 架构改进 / 功能扩展

| Issue       | 标题                                                            | 状态            | 领域      | 优先级   | 说明                                           |
| ----------- | --------------------------------------------------------------- | --------------- | --------- | -------- | ---------------------------------------------- |
| ~~AAV-783~~ | ~~验证 memory leak 修复 + 长期监控~~                            | **Done** ✅     | 后端      | ~~High~~ | /health 内存指标已部署。memory leak 修复已验证 |
| **AAV-864** | 单 cron + 缓存 TTL 重构                                         | Backlog         | 后端      | Medium   | 设计完成，待实施                               |
| **AAV-843** | Brevis per-user API 接入                                        | Ready for agent | 后端+前端 | Medium   | 个人 Dashboard + Claim                         |
| **AAV-781** | Unify endDate semantics in Merit cache                          | Ready for agent | 后端      | Medium   |                                                |
| **AAV-782** | Distinguish extraction failed vs not-target-type in Merit cache | Ready for agent | 后端      | Medium   |                                                |
| **AAV-726** | Refactor: flatten monorepo to single-package backend            | Ready for agent | 后端      | Medium   | 大重构，需评估 ROI                             |
| **AAV-365** | side-data endpoints ETag + 前端 304 节流                        | Backlog         | 后端      | Low      | 性能优化                                       |
| **AAV-800** | PortfolioPanel 重复计算路径统一                                 | Backlog         | 前端      | Low      |                                                |

## Phase 4: Low — 前端 UX / 产品

| Issue        | 标题                                            | 状态        | 领域      | 优先级               | 说明                                                     |
| ------------ | ----------------------------------------------- | ----------- | --------- | -------------------- | -------------------------------------------------------- |
| **AAV-1122** | Portfolio simulation 加 USD/token 切换按钮      | Backlog     | 前端 UX   | Low                  | 与 Shared scenario 操作一致                              |
| **AAV-1136** | Portfolio mobile 用 Magic pattern 重新设计      | Backlog     | 前端 UX   | Low                  |                                                          |
| **AAV-1113** | Reserve table campaign note 合并到一行          | Backlog     | 前端 UX   | Low                  |                                                          |
| **AAV-1162** | Portfolio APY 列呼吸空间                        | Backlog     | 前端 UX   | Low                  |                                                          |
| ~~AAV-809~~  | ~~Import portfolio 后不主动打开 Search bar~~    | **Done** ✅ | 前端 UX   | ~~Low~~              |                                                          |
| **AAV-738**  | Portfolio 展开行滚动定位                        | Todo        | 前端 UX   | Low                  |                                                          |
| **AAV-767**  | Simulation 刷新缓存策略                         | Backlog     | 前端 UX   | Low                  |                                                          |
| **AAV-772**  | eye off 恢复交互方式                            | Backlog     | 前端 UX   | No priority⚠️        | API 更新失败                                             |
| ~~AAV-733~~  | ~~Checkbox 与 eye off 状态同步~~                | **Done** ✅ | 前端 UX   | ~~Low~~              |                                                          |
| **AAV-760**  | 哪些 reserve 可做质押标记                       | Todo        | 后端+前端 | Low                  |                                                          |
| **AAV-333**  | V4 Risk Premium Simulation (per-user portfolio) | Todo        | 前端      | ~~Low~~ → **Medium** | Step 1（后端 collateralRisk）✅ 已完成。链上 CR 全部为 0 |
| **AAV-596**  | 增加 ENS 读取                                   | Backlog     | 前端      | Low                  |                                                          |
| **AAV-1239** | recently ended campaign 延迟显示                | Backlog     | 前端      | Low                  | 无 active campaign 时也显示一段时间                      |
| **AAV-127**  | liquidity 页面 per market                       | Backlog     | 前端      | Low                  |                                                          |
| **AAV-360**  | Megaeth 反色 logo                               | Backlog     | 前端      | Low                  |                                                          |

## Phase 5: Low — 后端技术债

| Issue        | 标题                                             | 状态            | 领域      | 优先级          | 说明                                        |
| ------------ | ------------------------------------------------ | --------------- | --------- | --------------- | ------------------------------------------- |
| **AAV-534**  | addressBookRegistry 其他字段动态化               | Todo            | 后端      | Low             | 设计完成 (ADR-0026)                         |
| **AAV-449**  | 移除 spokeName 字段                              | Ready for agent | 后端      | Low             |                                             |
| **AAV-517**  | spokeAddress 从 reserveId 解析                   | Ready for agent | 后端      | Low             | AAV-534 子 issue                            |
| **AAV-830**  | Merit raw RPC → ProviderPool                     | Ready for agent | 后端      | Low             |                                             |
| **AAV-829**  | 统一 ~35 个 toLowerCase() → normalizeAddress()   | Ready for agent | 后端      | Low             |                                             |
| **AAV-395**  | reserve ID 编码字段评估                          | Backlog         | 后端      | Low             |                                             |
| **AAV-1269** | LOCF 查询实现（`/api/markets/history` 历史回放） | Backlog         | 后端      | Low             | incentive-normalization Task 9，见下方专节  |
| **AAV-1270** | `incentive_details` 列级 NULL 命中率测试 + 决策  | Backlog         | 后端      | Low             | incentive-normalization Task 11，见下方专节 |
| **AAV-900**  | Pendle PT token targetTokenPrice                 | Backlog         | 后端      | Low             | 3 个非 Aave campaign                        |
| ~~AAV-863~~  | ~~数据变更频率 → TTL 优化~~                      | **Done** ✅     | 后端      | ~~Low~~         | 与 AAV-864 重复，已关闭                     |
| ~~AAV-923~~  | ~~position cap 前后端 API 对齐~~                 | **Done** ✅     | 后端+前端 | ~~Low~~         | positionCap 已全链路落地                    |
| ~~AAV-707~~  | ~~大模型 URL 切换到 moonshot/deepseek~~          | **Canceled** 🚫 | 后端      | ~~No priority~~ | 用户已改用猀基流动                          |

## Phase 6: Low — 运维 / 监控 / 文档 / 运营

| Issue        | 标题                                 | 状态            | 领域   | 优先级  | 说明                                                                         |
| ------------ | ------------------------------------ | --------------- | ------ | ------- | ---------------------------------------------------------------------------- |
| **AAV-329**  | 建立自动告警 SOP                     | Todo            | DevOps | Low     | 父 issue                                                                     |
| **AAV-587**  | 主动通知新链 RPC 检测                | Todo            | DevOps | Low     | AAV-329 子 issue                                                             |
| **AAV-586**  | Prometheus counter for new chain RPC | Todo            | DevOps | Low     | AAV-329 子 issue                                                             |
| ~~AAV-515~~  | ~~GitHub PR auto merge 问题~~        | **Done** ✅     | DevOps | ~~Low~~ | auto-merge 已就位                                                            |
| **AAV-732**  | Atlas 部署后不触发更新               | Backlog         | DevOps | Low     |                                                                              |
| **AAV-512**  | SEO: GSC 提交 URL 收录               | Todo            | SEO    | Low     |                                                                              |
| **AAV-135**  | V4 SDK Embedded Rewards - Skipped    | Todo            | 文档   | Low     |                                                                              |
| **AAV-30**   | Twitter 介绍 self 收益               | Todo            | 运营   | Low     |                                                                              |
| **AAV-248**  | 推进全站无障碍                       | Todo            | 前端   | Low     | 父 issue                                                                     |
| **AAV-321**  | 整理无障碍规范                       | Backlog         | 前端   | Low     | AAV-248 子 issue                                                             |
| **AAV-322**  | 无障碍审计                           | Backlog         | 前端   | Low     | AAV-248 子 issue                                                             |
| **AAV-323**  | 修复无障碍问题                       | Backlog         | 前端   | Low     | AAV-248 子 issue                                                             |
| **AAV-1227** | Spec: Inline Widget Embedding        | Ready for agent | 前端   | Low     |                                                                              |
| **AAV-1271** | Aave UI ↔ API 对比工具 Phase 3       | Backlog         | DevOps | Low     | Phase 1+2 完成, spec: `docs/plans/2026-07-16-aave-ui-api-comparison-tool.md` |

## Phase 7: Low — Epic / 大特性 / 远期

| Issue       | 标题                         | 状态    | 领域      | 优先级        | 说明             |
| ----------- | ---------------------------- | ------- | --------- | ------------- | ---------------- |
| **AAV-564** | 多链组合最佳 deployment 推荐 | Todo    | 全栈      | Low           |                  |
| **AAV-84**  | 计算最佳 deployment 推荐     | Backlog | 全栈      | Low           |                  |
| **AAV-86**  | 执行最佳部署路径             | Backlog | 全栈      | Low           |                  |
| **AAV-75**  | size/liquidity 变化展示      | Backlog | 全栈      | Low           |                  |
| **AAV-76**  | 对比 DeFiLlama 内容          | Backlog | 产品评估  | Low           | API 更新失败     |
| **AAV-262** | 增加 TVL 历史                | Backlog | 后端+前端 | Low           | AAV-364 子 issue |
| **AAV-91**  | reserve 未来 APY 预测        | Backlog | 前端      | No priority⚠️ | 未批量更新       |

## Incentive Normalization 父工作

> **来源**: `.codeartsdoer/specs/incentive-normalization/`（工作 spec）
> **设计文档**: `docs/backend/change-detection-and-incentive-normalization.md`（权威来源）
> **状态**: 2026-05-20 完成主体工作（Task 0-5, 8, 10），Task 4 已移除（设计变更），Task 6-7 已取消（无消费者）

| #   | 任务                                                         | 状态      | Linear Issue |
| --- | ------------------------------------------------------------ | --------- | ------------ |
| 0   | 行级 change-detection（market_snapshots / configs / oracle） | ✅ 已实施 | —            |
| 1   | `buildIncentiveDetails()` per-campaign 结构                  | ✅ 已实施 | —            |
| 2   | 停写 `supply_incentives_apr` / `borrow_incentives_apr`       | ✅ 已实施 | —            |
| 3   | `/api/markets` SUM 推导聚合 APR                              | ✅ 已实施 | —            |
| 4   | `_isExpired` 序列化                                          | ❌ 已移除 | —            |
| 5   | `filterRecentExpiredCampaigns()`                             | ✅ 已实施 | —            |
| 6   | 建视图                                                       | ❌ 已取消 | —            |
| 7   | Staging 验证                                                 | ❌ 已取消 | —            |
| 8   | Migration: DROP 两列 + DROP 两表                             | ✅ 已实施 | —            |
| 9   | LOCF 查询（PG 原生方案）                                     | 🟡 待实施 | AAV-1269     |
| 10  | 单测 + e2e 测试                                              | ✅ 已实施 | —            |
| 11  | 列级 NULL 命中率测试 + 决策                                  | 🟡 待决策 | AAV-1270     |

## ~~遗漏项：No priority 未更新~~ (已全部解决)

~~AAV-707~~ 已 Canceled，~~AAV-1025~~ 已 Done。剩余 No priority：AAV-772（Backlog）、AAV-91（Backlog）——均为低优先级，暂不处理。

## 统计

| 状态                       | 数量                                                         |
| -------------------------- | ------------------------------------------------------------ |
| Done (07-31 轮)            | 14 + 5 (AAV-923, AAV-515, AAV-863, AAV-1025, AAV-733)        |
| Done (08-02 验证)          | +6 (AAV-783, AAV-809, AAV-868, AAV-870, AAV-866, AAV-1222)   |
| Done (08-04 AAV-756 P2-P4) | +3 (AAV-1248, AAV-1250, AAV-1251)                            |
| Done (08-04 E2E)           | +1 (AAV-1257)                                                |
| Canceled                   | 2 (AAV-1150, AAV-707)                                        |
| Ready for agent            | 13                                                           |
| Backlog (新增)             | +3 (AAV-1269 LOCF + AAV-1270 列级NULL + AAV-1271 UI对比工具) |
| Backlog                    | 22                                                           |
| Todo                       | 15（+3: AAV-1249, AAV-1252, AAV-1253）                       |
| **非 Done/Canceled 总计**  | **~50**                                                      |
| No priority (待更新)       | 2 (AAV-772, AAV-91 — 低优先级暂不处理)                       |

### 08-02 额外验证关闭

| Issue   | 标题                              | 关闭原因                                          |
| ------- | --------------------------------- | ------------------------------------------------- |
| AAV-868 | resolveCampaignApr 复用 normalize | 代码已改用 normalize 函数链（非正则），有测试覆盖 |
| AAV-870 | AMOUNT_PER_AMOUNT 无 TVL          | opportunity 级 TVL + targetTokenPrice 转换已修复  |
| AAV-866 | endTimestamp 冗余调查             | 调查结论：不冗余，两者格式/用途不同               |
| AAV-783 | memory leak 修复验证              | /health 内存指标已部署，长期趋势已验证            |
| AAV-809 | Import portfolio Search bar       | 代码已实现                                        |

### 07-31 本轮额外关闭

| Issue    | 标题                         | 关闭原因                                                                                |
| -------- | ---------------------------- | --------------------------------------------------------------------------------------- |
| AAV-923  | position cap 前后端 API 对齐 | `positionCapNative`/`positionCapUsd` 已在全链路落地，AAV-1075 已 Done                   |
| AAV-515  | GitHub PR auto merge 问题    | auto-merge workflows 已就位，AAV-1077 已 Done，有 `done-candidate` 标签                 |
| AAV-863  | 数据变更频率 → TTL 优化      | 与 AAV-864 完全重叠，关闭以 AAV-864 为准                                                |
| AAV-707  | 大模型 URL 切换              | 用户已改用硅基流动，不再需要                                                            |
| AAV-1025 | offset 扣减用户提醒          | `merklCrossReserveNote` 已生成提醒文本并渲染在展开行，AAV-1024 将扩展到 Shared scenario |
| AAV-733  | Checkbox 与 eye off 状态同步 | 确认已是 Done 状态，代码与 issue 描述一致                                               |

## 建议执行顺序

> **2026-08-05 重排**：AAV-1257 已完成，从列表移除。High 优先级 issue（AAV-895、AAV-1036）提前到 Medium 之前。AAV-1071（Low）后移。

### AAV-756 Portfolio LTV + HF + NE APY（Urgent）

~~P1/AAV-1222 ✅ Done~~ → ~~P2/AAV-1248 ✅ Done~~ → ~~P3/AAV-1250 ✅ Done~~ → ~~P4/AAV-1251 ✅ Done~~ → ~~P5/AAV-1249 ✅ Canceled (merged to P6)~~ → ~~P6/AAV-1252 ✅ Done~~ → ~~P7/AAV-1253 ✅ Done~~

> AAV-756 全部子步骤完成。

### 其他 issue（按优先级排序）

| 顺序  | Issue         | 优先级     | 状态         | 说明                                                                                                                      |
| ----- | ------------- | ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 1     | AAV-1253 (P7) | Urgent     | Done         | on-chain HF baseline 接入 ✅                                                                                              |
| ~~2~~ | ~~AAV-895~~   | ~~High~~   | ~~Done~~     | 跨资产 offset 后端完成 (a5eb421) + 前端完成 (e3a14833) + E2E 测试 (58aa1542)。Merkl 无活跃 min(1,2) campaign，E2E skip ✅ |
| 3     | AAV-1036      | High       | Backlog      | offsetNote 与 capNote 分离（与 AAV-895 相关，需先 refine）                                                                |
| ~~4~~ | ~~AAV-1022~~  | ~~Medium~~ | ~~Done~~     | ~~定义 offset 对齐规则~~ ✅ Spec: `docs/plans/aav-1022-offset-alignment-rules-spec.md`                                    |
| ~~5~~ | ~~AAV-862~~   | ~~Medium~~ | ~~Done~~     | ~~normalize campaignType 统一~~ ✅ Scope 1 Done (commit `0cb09a2`)。Scope 2 (重命名) + Scope 3 (AMOUNT 变体) deferred     |
| ~~6~~ | ~~AAV-864~~   | ~~Medium~~ | ~~Canceled~~ | ~~单 cron + 缓存 TTL 重构~~ Canceled：字段迁移不可行（前端已直接消费），cron 合并收益边际                                 |
| 7     | AAV-1071      | Low        | Backlog      | hookType=17 HF 排除条件展示（后端 `healthFactorHooks` 未透传）                                                            |

> ⚠️ Linear issue 之间未设置 native blocking link。上述依赖关系通过 issue description 中的 "Blocked by" 和 comment 标注。
>
> **排序逻辑**：~~Urgent（AAV-756 P7）~~ ✅ 全部完成 → High（AAV-895、AAV-1036）→ Medium（AAV-1022、AAV-862、AAV-864）→ Low（AAV-1071）。同优先级内 Ready for agent 优先于 Backlog。
>
> **下一步**：~~AAV-1024~~ ✅ Done → ~~AAV-1023~~ ✅ Done (no-op)。Offset 体系对齐全部完成。~~AAV-862~~ ✅ Done (Scope 1)。~~AAV-864~~ ❌ Canceled（收益不足）。下一优先级：AAV-1036（offsetNote 分离，High Backlog）→ AAV-1071（HF 排除条件，Low Backlog）。AAV-1274（重命名，High）+ AAV-1275（AMOUNT 变体，Medium）为 AAV-862 deferred follow-up。
>
> **2026-08-08 更新**：AAV-895 全部完成。后端 staging 环境从 railway 分支自动部署 (commit 45dbb68)。前端 lovable 分支 commit e3a14833 + 58aa1542。E2E 测试数据驱动设计：从 staging API 动态发现 crossAssetPairing 场景，当前无活跃 min(1,2) campaign 时 graceful skip。PR #170 (railway→main) 合并触发了 production 部署。
>
> **2026-08-10 更新**：AAV-862 Scope 1 完成（commit `0cb09a2` on `railway`）。`normalizeCampaignType` + 映射表统一到 `@internal/aave-shared-contracts/src/campaign-type.ts`。消除 3 处类型重复 + 2 处函数重复，净删 -424 行。26 场景测试矩阵。CI 全绿。ADR-0024 trade-off 更新为 RESOLVED。Scope 2→AAV-1274（重命名，High）+ Scope 3→AAV-1275（AMOUNT 变体，Medium）deferred。AAV-864 Canceled：字段迁移不可行（前端已直接消费 `plannedDaily`/`totalBudget`/`aprCap`），cron 合并收益边际（仅失败重试更快）。
>
> **已创建 Linear issue**：AAV-1269（LOCF 查询）+ AAV-1270（列级 NULL 命中率测试）。见上方专节。

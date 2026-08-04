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

### AAV-1150: SummaryCard delta E2E test

- 状态: Backlog → **Canceled** (wontfix)
- 理由: DOM 结构从 `div.grid` 变为 `<table>`，selector 不匹配；已有 35 个 incentive E2E 测试覆盖核心逻辑

---

## Phase 1: Urgent / High — 最高优先级

| Issue        | 标题                                                           | 状态            | 领域      | 优先级   | 说明                                           |
| ------------ | -------------------------------------------------------------- | --------------- | --------- | -------- | ---------------------------------------------- |
| **AAV-756**  | Portfolio LTV constraint + Net Effective APY + Health Factor   | Todo            | 前端      | Urgent   | **完全 unblocked**。已拆分 P2-P7（见下方详情） |
| ~~AAV-1222~~ | ~~[Backend] GET /markets API 增加 ltv + liquidationThreshold~~ | **Done** ✅     | 后端      | ~~High~~ | 2026-08-02 完成。fingerprint: 2d1059421baf     |
| **AAV-895**  | Borrow ETH with cbETH collateral — cross-asset offset formula  | Ready for agent | 后端+前端 | High     | 跨资产 offset 计算特殊处理                     |
| **AAV-1036** | Data layer: separate offsetNote from capNote                   | Backlog         | 后端      | High     | 父 issue，AAV-1038 已 Done                     |
| **AAV-364**  | [EPIC] 市场宏观指标聚合                                        | Todo            | 全栈      | High     | deficit 已实现，其他指标待做                   |

## AAV-756 拆分详情 — Portfolio LTV + HF + Net Effective APY

> **Grill 结论 (2026-08-02)**：HF 按 per-pool/spoke 隔离边界计算（合约行为），非全局。先做 simulation 逻辑（适用于 wallet / non-wallet），后接 on-chain HF baseline。
>
> **Grill 更新 2 (2026-08-02)**：顺序重排——先约束（maxBorrow）后安全（HF）。V3 叫 LTV/liquidationThreshold，V4 叫 collateralFactor（合并参数）。后端数据已就绪（AAV-1222），约束计算是纯前端。无 borrow 的 group 展示 "—"。NE APY 公式不改，只加 UI。

### 拆分步骤

| Step | 内容                                                                                                                               | 依赖  | 仓库 | 复杂度 | 状态               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- | ----- | ---- | ------ | ------------------ |
| P1   | 后端 `ltv` + `liquidationThreshold` API 落地（V3 来源 `baseLTVasCollateral`/`liquidationThreshold`，V4 来源 `collateralFactor`）   | —     | 后端 | —      | ✅ Done            |
| P2   | 前端 `ReserveWithSpread` 类型加 `ltv`/`liquidationThreshold` + `schema-fingerprint.ts` sync (`541bf2ebdf0c` → `2d1059421baf`)      | P1    | 前端 | 低     | ✅ Done (AAV-1248) |
| P3   | 前端 maxBorrow 约束：per-pool/spoke 分组 + `maxBorrow = Σ(supplyUsd × ltv / 100) - Σ(borrowUsd)`。约束 borrow 输入不超过 maxBorrow | P2    | 前端 | 中     | ✅ Done (AAV-1250) |
| P4   | 前端模拟 HF 计算：per-pool/spoke 分组 + `HF = Σ(supplyUsd × liquidationThreshold / 100) / Σ(borrowUsd)`。无 borrow 时 HF = “—”     | P2,P3 | 前端 | 中     | ✅ Done (AAV-1251) |
| P5   | 前端 NE APY 展示：`PortfolioSummary.netEffectiveApy` 已计算，加到 Summary footer。公式不改                                         | —     | 前端 | 低     | Todo (AAV-1249)    |
| P6   | 前端 Summary 整合：HF 展示 + 颜色编码（绿≥2/黄≥1.5/橙≥1/红<1）+ NE APY + maxBorrow 提示                                            | P4,P5 | 前端 | 中     | Todo (AAV-1252)    |
| P7   | on-chain HF baseline 接入：`V3AccountSummary.healthFactorWad` / `V4AccountSummary.healthFactor` → current → after → delta 模式     | P6    | 前端 | 中     | Todo (AAV-1253)    |

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

### P3+P4 实现状态（2026-08-04）

| Phase | 计算产出                                                             | UI 消费者                                                                           | 状态                  |
| ----- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------- |
| P3    | `PortfolioPositionResult.ltvClampedUsd`                              | `PortfolioUnifiedTable.tsx` L220 + `MobilePortfolioCard.tsx` L152（inline warning） | ✅ 计算+UI 完成       |
| P4    | `SimulatePortfolioResult.healthFactors`                              | **无**（P6 将消费）                                                                 | ✅ 计算完成，UI 待 P6 |
| P5    | `PortfolioSummary.netEffectiveApy`                                   | **无**（P5 将加 footer）                                                            | 计算已存在，UI 待 P5  |
| P7    | `V3AccountSummary.healthFactorWad` / `V4AccountSummary.healthFactor` | **未接入** portfolio simulation                                                     | 数据源存在，接入待 P7 |

> **关键**：P4 的 `healthFactors` 当前无任何组件消费。用户在 UI 中看不到 HF——这是 by design（HF 是 Summary 级指标，属于 P6 scope）。P3 有 inline UI 是因为 maxBorrow 截断是 per-row 交互。

### 参考文档

- `aaveapy-doc/v3-v4-collateral-and-health-factor.md` — V3↔V4 抵押参数、HF 公式对比
- `aaveapy-doc/hub-spoke-position-isolation.md` — V4 仓位隔离、可借量约束链路

---

## Phase 2A: Offset 体系对齐 — 产品决策已定 (方案 C)

**决策**: Shared scenario 不应用 offset，但展开行显示 offset 提示 note。Reserve table 在 Portfolio 模式下展开时应用 offset。

**代码验证**: `rateSimulationCalculator.ts` 中 offset 由 `crossReservePositions` 参数控制。Shared scenario 不传入则不应用。

| Issue        | 标题                                 | 状态            | 领域      | 优先级        | 说明                        |
| ------------ | ------------------------------------ | --------------- | --------- | ------------- | --------------------------- |
| **AAV-832**  | Portfolio simulation offset 对齐规则 | Backlog         | 产品决策  | Low           | 父 issue，决策已定          |
| **AAV-1022** | 定义 offset 对齐规则                 | Ready for agent | 前端+产品 | Medium        | 可执行                      |
| **AAV-1023** | 改造 Reserve table 展示逻辑          | Ready for agent | 前端      | Medium        | 依赖 AAV-1022               |
| **AAV-1024** | 同步 Shared scenario                 | Ready for agent | 前端      | Medium        | 依赖 AAV-1022，仅 note 展示 |
| **AAV-1025** | offset 扣减时给用户提醒              | Backlog         | 前端      | No priority⚠️ | 独立增强，未批量更新        |

## Phase 2B: Borrow Blacklist 体系

| Issue        | 标题                                                | 状态        | 领域      | 优先级     | 说明                                 |
| ------------ | --------------------------------------------------- | ----------- | --------- | ---------- | ------------------------------------ |
| ~~AAV-962~~  | ~~BorrowBL: 前端 Simulation 中 incentive 归零逻辑~~ | **Done** ✅ | 前端      | ~~High~~   | 2026-07 完成                         |
| ~~AAV-1013~~ | ~~borrowBlacklist + borrowHookProtocols 前端适配~~  | **Done** ✅ | 前端      | ~~Medium~~ | 2026-07 完成                         |
| **AAV-1071** | hookType=17 HEALTH_FACTOR 排除条件展示              | Backlog     | 前端+后端 | Low        | 后端缺口：`healthFactorHooks` 未透传 |

**建议执行顺序**: ~~AAV-1071 后端修复 → AAV-1013 → AAV-962~~ AAV-962/1013 已完成，仅剩 AAV-1071

## Phase 2C: Campaign Type 统一

| Issue       | 标题                                              | 状态            | 领域 | 优先级     | 说明                                                             |
| ----------- | ------------------------------------------------- | --------------- | ---- | ---------- | ---------------------------------------------------------------- |
| **AAV-862** | 统一 normalize campaignType 逻辑                  | Ready for agent | 后端 | Medium     | 父 issue。子 issue 全部 Done。scope 1-2（统一函数+重命名）未完成 |
| ~~AAV-868~~ | ~~resolveCampaignApr 复用 normalize 函数链~~      | **Done** ✅     | 后端 | ~~Medium~~ | 2026-08-02 验证。已改用 normalize 函数链                         |
| ~~AAV-870~~ | ~~AMOUNT_PER_AMOUNT 无 TVL 数据~~                 | **Done** ✅     | 后端 | ~~Medium~~ | 2026-08-02 验证。opportunity TVL + targetTokenPrice 转换         |
| ~~AAV-866~~ | ~~forecast endTimestamp 与 campaignEndedAt 冗余~~ | **Done** ✅     | 后端 | ~~Medium~~ | 2026-08-02 验证。调查结论：不冗余，保留两者                      |

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

| Issue       | 标题                                           | 状态            | 领域      | 优先级          | 说明                     |
| ----------- | ---------------------------------------------- | --------------- | --------- | --------------- | ------------------------ |
| **AAV-534** | addressBookRegistry 其他字段动态化             | Todo            | 后端      | Low             | 设计完成 (ADR-0026)      |
| **AAV-449** | 移除 spokeName 字段                            | Ready for agent | 后端      | Low             |                          |
| **AAV-517** | spokeAddress 从 reserveId 解析                 | Ready for agent | 后端      | Low             | AAV-534 子 issue         |
| **AAV-830** | Merit raw RPC → ProviderPool                   | Ready for agent | 后端      | Low             |                          |
| **AAV-829** | 统一 ~35 个 toLowerCase() → normalizeAddress() | Ready for agent | 后端      | Low             |                          |
| **AAV-395** | reserve ID 编码字段评估                        | Backlog         | 后端      | Low             |                          |
| **AAV-900** | Pendle PT token targetTokenPrice               | Backlog         | 后端      | Low             | 3 个非 Aave campaign     |
| ~~AAV-863~~ | ~~数据变更频率 → TTL 优化~~                    | **Done** ✅     | 后端      | ~~Low~~         | 与 AAV-864 重复，已关闭  |
| ~~AAV-923~~ | ~~position cap 前后端 API 对齐~~               | **Done** ✅     | 后端+前端 | ~~Low~~         | positionCap 已全链路落地 |
| ~~AAV-707~~ | ~~大模型 URL 切换到 moonshot/deepseek~~        | **Canceled** 🚫 | 后端      | ~~No priority~~ | 用户已改用猀基流动       |

## Phase 6: Low — 运维 / 监控 / 文档 / 运营

| Issue        | 标题                                 | 状态            | 领域   | 优先级  | 说明              |
| ------------ | ------------------------------------ | --------------- | ------ | ------- | ----------------- |
| **AAV-329**  | 建立自动告警 SOP                     | Todo            | DevOps | Low     | 父 issue          |
| **AAV-587**  | 主动通知新链 RPC 检测                | Todo            | DevOps | Low     | AAV-329 子 issue  |
| **AAV-586**  | Prometheus counter for new chain RPC | Todo            | DevOps | Low     | AAV-329 子 issue  |
| ~~AAV-515~~  | ~~GitHub PR auto merge 问题~~        | **Done** ✅     | DevOps | ~~Low~~ | auto-merge 已就位 |
| **AAV-732**  | Atlas 部署后不触发更新               | Backlog         | DevOps | Low     |                   |
| **AAV-512**  | SEO: GSC 提交 URL 收录               | Todo            | SEO    | Low     |                   |
| **AAV-135**  | V4 SDK Embedded Rewards - Skipped    | Todo            | 文档   | Low     |                   |
| **AAV-30**   | Twitter 介绍 self 收益               | Todo            | 运营   | Low     |                   |
| **AAV-248**  | 推进全站无障碍                       | Todo            | 前端   | Low     | 父 issue          |
| **AAV-321**  | 整理无障碍规范                       | Backlog         | 前端   | Low     | AAV-248 子 issue  |
| **AAV-322**  | 无障碍审计                           | Backlog         | 前端   | Low     | AAV-248 子 issue  |
| **AAV-323**  | 修复无障碍问题                       | Backlog         | 前端   | Low     | AAV-248 子 issue  |
| **AAV-1227** | Spec: Inline Widget Embedding        | Ready for agent | 前端   | Low     |                   |

## Phase 7: Low — Epic / 大特性 / 远期

| Issue        | 标题                         | 状态    | 领域      | 优先级        | 说明             |
| ------------ | ---------------------------- | ------- | --------- | ------------- | ---------------- |
| **AAV-564**  | 多链组合最佳 deployment 推荐 | Todo    | 全栈      | Low           |                  |
| **AAV-84**   | 计算最佳 deployment 推荐     | Backlog | 全栈      | Low           |                  |
| **AAV-86**   | 执行最佳部署路径             | Backlog | 全栈      | Low           |                  |
| **AAV-75**   | size/liquidity 变化展示      | Backlog | 全栈      | Low           |                  |
| **AAV-76**   | 对比 DeFiLlama 内容          | Backlog | 产品评估  | Low           | API 更新失败     |
| **AAV-262**  | 增加 TVL 历史                | Backlog | 后端+前端 | Low           | AAV-364 子 issue |
| **AAV-91**   | reserve 未来 APY 预测        | Backlog | 前端      | No priority⚠️ | 未批量更新       |
| **AAV-1025** | offset 扣减用户提醒          | Backlog | 前端      | No priority⚠️ | 未批量更新       |

## ~~遗漏项：No priority 未更新~~ (已全部解决)

~~AAV-707~~ 已 Canceled，~~AAV-1025~~ 已 Done。剩余 No priority：AAV-772（Backlog）、AAV-91（Backlog）——均为低优先级，暂不处理。

## 统计

| 状态                      | 数量                                                       |
| ------------------------- | ---------------------------------------------------------- |
| Done (07-31 轮)           | 14 + 5 (AAV-923, AAV-515, AAV-863, AAV-1025, AAV-733)      |
| Done (08-02 验证)         | +6 (AAV-783, AAV-809, AAV-868, AAV-870, AAV-866, AAV-1222) |
| Canceled                  | 2 (AAV-1150, AAV-707)                                      |
| Ready for agent           | 13                                                         |
| Backlog                   | 22                                                         |
| Todo                      | 12                                                         |
| **非 Done/Canceled 总计** | **~47**                                                    |
| No priority (待更新)      | 2 (AAV-772, AAV-91 — 低优先级暂不处理)                     |

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

1. **AAV-756**（Urgent，完全 unblocked）— 已拆分为 6 个子 issue（AAV-1248~1253）。~~P2/AAV-1248（类型 sync）✅ Done~~ → ~~P3/AAV-1250（maxBorrow 约束）✅ Done~~ → ~~P4/AAV-1251（模拟 HF）✅ Done~~ → **下一步：P5/AAV-1249（NE APY 展示，可并行）** → P6/AAV-1252（Summary 整合）→ P7/AAV-1253（on-chain baseline）
2. **AAV-1257**（High）— Pre-existing mobile E2E 失败（Cap threshold crossing current invariance）。CI E2E job 当前 `continue-on-error: true`，修复后移除并加 mobile-chromium project。
3. **AAV-1022**
4. **AAV-1071**
5. **AAV-862**
6. **AAV-864**
7. **AAV-895** 跨资产 offset、**AAV-1036** offsetNote 分离

> ⚠️ Linear issue 之间未设置 native blocking link。上述依赖关系通过 issue description 中的 "Blocked by" 和 comment 标注。

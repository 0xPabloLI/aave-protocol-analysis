# Linear Issues Triage — 2026-07-06

> 全量 triage，按 phase 分组，标注领域、优先级、代码验证状态。

## Phase 0: 已完成但 Linear 状态滞后（需立即更新）

| Issue | 标题 | 原状态 | 验证结果 | 行动 |
|---|---|---|---|---|
| AAV-1048 | lastEndedCampaign lookback 7→90 天 | ~~Backlog~~ | ✅ Done (本次已更新) | 已标 Done |
| AAV-902 | campaignType vs distributionType 术语 | ~~Backlog~~ | ✅ Done (本次已更新) | 已标 Done |

## Phase 1: 进行中 / 审核中（当前活跃工作）

| Issue | 标题 | 状态 | 领域 | 说明 |
|---|---|---|---|---|
| **AAV-1075** | positionCap → positionCapNative + positionCapUsd (后端) | In Review | 后端 | 代码在 workspace stash 中，待部署验证 |
| **AAV-1076** | positionCap → positionCapNative + positionCapUsd (前端) | Backlog | 前端 | 依赖 AAV-1075 部署完成 |

## Phase 2: 高优先级待做（P1 — 核心 incentive 功能）

### 2A: Borrow Blacklist 体系（3 个 issue 强关联）

| Issue | 标题 | 状态 | 领域 | 优先级 | 说明 |
|---|---|---|---|---|---|
| **AAV-962** | BorrowBL: 前端 Simulation 中 BORROW_BL opp 的 incentive 归零逻辑 | Ready for agent | 前端 | High | 后端 borrowBlacklist 已实现，前端 simulation 未处理 |
| **AAV-1013** | borrowBlacklist + borrowHookProtocols 前端适配 | Ready for agent | 前端 | Medium | 前端类型/展示未接入 |
| **AAV-1071** | hookType=17 HEALTH_FACTOR 排除条件展示 | Backlog | 前端+后端 | Medium | 后端缺口：`healthFactorHooks` 未透传到 API（`merklCampaignAccessService.ts` 缺字段） |

**建议执行顺序**: AAV-1071 后端修复 → AAV-1013 → AAV-962

### 2B: Offset 体系对齐（4 个 issue 级联）

| Issue | 标题 | 状态 | 领域 | 优先级 | 说明 |
|---|---|---|---|---|---|
| **AAV-832** | Portfolio simulation offset vs ReserveTable offset 对齐规则 | Backlog | 产品决策 | No priority | 父 issue，需先定产品规则 |
| **AAV-1022** | 定义 Portfolio/ReserveTable/SharedScenario offset 对齐规则 | Backlog | 产品+前端 | No priority | AAV-832 子 issue |
| **AAV-1023** | 按统一 offset 规则改造 ReserveTable 展示逻辑 | Backlog | 前端 | No priority | AAV-832 子 issue |
| **AAV-1024** | 同步 Shared scenario 与验收用例到新 offset 口径 | Backlog | 前端 | No priority | AAV-832 子 issue |

**阻塞点**: 需要先做产品决策（AAV-832/1022），再执行 1023/1024

### 2C: 其他 High Priority

| Issue | 标题 | 状态 | 领域 | 优先级 | 说明 |
|---|---|---|---|---|---|
| **AAV-1036** | Data layer: separate offsetNote from capNote, lift to source level | Backlog | 后端 | High | 父 issue，AAV-1038（UI render）已 Done |
| **AAV-895** | Cross-asset net position offset formula (cbETH→ETH) | Ready for agent | 后端+前端 | High | 跨资产 offset 计算特殊处理 |
| **AAV-755** | URL 只能指向 chain 而非 market | Ready for agent | 前端 | High | 深链接 bug |
| **AAV-802** | chain 9745 plasma RPC 请求错误 | Ready for agent | 前端+后端 | High | console 报错 |
| **AAV-756** | Portfolio LTV constraint + Net Effective APY + Health Factor | Todo | 全栈 | Urgent | 大特性，待拆解 |

## Phase 3: 中优先级（P2 — 架构改进 / 技术债）

### 3A: Campaign Type 统一

| Issue | 标题 | 状态 | 领域 | 优先级 | 说明 |
|---|---|---|---|---|---|
| **AAV-862** | 统一 aave-fetcher 与 backend 的 normalize campaignType 逻辑 | Ready for agent | 后端 | Medium | 父 issue |
| **AAV-868** | resolveCampaignApr 复用 normalize 函数链 | Ready for agent | 后端 | Medium | AAV-862 子 issue |
| **AAV-870** | AMOUNT_PER_AMOUNT 无 TVL 数据导致 forecast 无法计算 | Ready for agent | 后端 | Medium | AAV-862 子 issue |
| **AAV-866** | forecast endTimestamp 是否与 campaignEndedAt 冗余 | Ready for agent | 后端 | Medium | AAV-862 子 issue |

### 3B: 缓存/性能

| Issue | 标题 | 状态 | 领域 | 优先级 | 说明 |
|---|---|---|---|---|---|
| **AAV-864** | 单 cron + 缓存 TTL 重构 | Backlog | 后端 | Medium | 设计完成，待实施 |
| **AAV-863** | 系统检查后端数据变更频率，优化缓存 | Backlog | 后端 | No priority | 与 AAV-864 重复，AAV-864 为主 |
| **AAV-783** | 验证 memory leak 修复效果 + 长期内存趋势监控 | Ready for agent | 后端 | High | 已修大泄漏，小泄漏仍需监控 |

### 3C: Merit 改进

| Issue | 标题 | 状态 | 领域 | 优先级 | 说明 |
|---|---|---|---|---|---|
| **AAV-781** | Unify endDate semantics in Merit cache | Ready for agent | 后端 | Medium | |
| **AAV-782** | Distinguish extraction failed vs not-target-type in Merit cache | Ready for agent | 后端 | Medium | |
| **AAV-843** | Brevis per-user API 接入 | Ready for agent | 后端+前端 | Medium | 个人 Dashboard + Claim |

### 3D: 架构重构

| Issue | 标题 | 状态 | 领域 | 优先级 | 说明 |
|---|---|---|---|---|---|
| **AAV-726** | Refactor: flatten monorepo to single-package backend | Ready for agent | 后端 | Medium | 大重构，需评估 ROI |
| **AAV-923** | position cap 前后端 API 对齐（self vs brevis） | Backlog | 后端+前端 | No priority | 可能被 AAV-1075/1076 覆盖，需确认 |

## Phase 4: 低优先级（P3 — 远期 / 评估）

### 4A: 后端技术债

| Issue | 标题 | 状态 | 领域 | 优先级 | 说明 |
|---|---|---|---|---|---|
| **AAV-534** | addressBookRegistry 其他字段动态化 | Todo | 后端 | Low | 设计完成（ADR-0026），部分实现 |
| **AAV-449** | 移除 spokeName 字段（与 marketName 冗余） | Ready for agent | 后端 | Low | |
| **AAV-517** | spokeAddress 从 reserveId 解析替代 address-book | Ready for agent | 后端 | Low | AAV-534 子 issue |
| **AAV-830** | Merit raw RPC → ProviderPool | Ready for agent | 后端 | Low | |
| **AAV-829** | 统一 ~35 个 toLowerCase() → normalizeAddress() | Ready for agent | 后端 | Low | |
| **AAV-395** | reserve ID 编码字段评估 | Backlog | 后端 | Low | |
| **AAV-900** | Pendle PT token targetTokenPrice | Backlog | 后端 | Low | 3 个非 Aave campaign |
| **AAV-515** | GitHub PR auto merge 问题 | Backlog | DevOps | Low | |

### 4B: 前端 UX / 产品

| Issue | 标题 | 状态 | 领域 | 优先级 | 说明 |
|---|---|---|---|---|---|
| **AAV-772** | eye off 恢复交互方式 | Backlog | 前端 UX | No priority | |
| **AAV-767** | Simulation 刷新缓存策略 | Backlog | 前端 UX | No priority | |
| **AAV-809** | Import portfolio 后不主动打开 Search bar | Backlog | 前端 UX | No priority | |
| **AAV-733** | Checkbox 与 eye off 状态同步 | Todo | 前端 UX | No priority | |
| **AAV-738** | Portfolio 展开行滚动定位 | Todo | 前端 UX | No priority | |
| **AAV-333** | Risk premium simulation | Todo | 前端 | No priority | |
| **AAV-734** | 统一 destructive hover 样式 | Ready for agent | 前端 | Medium | |
| **AAV-760** | 哪些 reserve 可做质押标记 | Todo | 后端+前端 | No priority | |
| **AAV-596** | 增加 ENS 读取 | Backlog | 前端 | No priority | |
| **AAV-732** | Atlas 部署后不触发更新 | Backlog | DevOps | No priority | |

### 4C: Epic / 大特性

| Issue | 标题 | 状态 | 领域 | 优先级 | 说明 |
|---|---|---|---|---|---|
| **AAV-364** | [EPIC] 市场宏观指标聚合 | Todo | 全栈 | High | deficit 已实现，其他指标待做 |
| **AAV-564** | 计算多链组合下的最佳 deployment 推荐 | Todo | 全栈 | No priority | 远期 |
| **AAV-756** | Portfolio LTV + Net APY + HF | Todo | 全栈 | Urgent | 同 Phase 2C，大特性待拆解 |

### 4D: 无障碍

| Issue | 标题 | 状态 | 领域 | 优先级 | 说明 |
|---|---|---|---|---|---|
| **AAV-248** | 推进全站无障碍 | Todo | 前端 | Low | 父 issue |
| **AAV-321** | 整理无障碍规范 | Backlog | 前端 | Low | AAV-248 子 issue |
| **AAV-322** | 无障碍审计 | Backlog | 前端 | Low | AAV-248 子 issue |
| **AAV-323** | 修复无障碍问题 | Backlog | 前端 | Low | AAV-248 子 issue |

### 4E: 监控/告警

| Issue | 标题 | 状态 | 领域 | 优先级 | 说明 |
|---|---|---|---|---|---|
| **AAV-329** | 建立自动告警 SOP | Todo | DevOps | Low | 父 issue |
| **AAV-587** | 主动通知新链 RPC 检测 | Todo | DevOps | No priority | AAV-329 子 issue |
| **AAV-586** | Prometheus counter for new chain RPC | Todo | DevOps | No priority | AAV-329 子 issue |

### 4F: 文档/运营

| Issue | 标题 | 状态 | 领域 | 优先级 | 说明 |
|---|---|---|---|---|---|
| **AAV-135** | V4 SDK Embedded Rewards - Skipped | Todo | 文档 | Low | |
| **AAV-30** | Twitter 介绍 self 收益 | Todo | 运营 | Low | |
| **AAV-512** | SEO: GSC 提交 URL 收录 | Todo | SEO | Low | |
| **AAV-262** | 增加 TVL 历史 | Backlog | 后端+前端 | Low | AAV-364 子 issue |
| **AAV-76** | 对比 DeFiLlama 内容 | Backlog | 产品评估 | Low | AAV-364 子 issue |

## Canceled Issues（9 个，保留记录）

AAV-130, AAV-88, AAV-867, AAV-886, AAV-344, AAV-107, AAV-552, AAV-904, AAV-762, AAV-763, AAV-831, AAV-724, AAV-885, AAV-901

## 统计

| 状态 | 数量 |
|---|---|
| Done (本次 triage 新标) | 2 (AAV-1048, AAV-902) |
| In Review | 1 (AAV-1075) |
| Ready for agent | 18 |
| Backlog | 22 |
| Todo | 15 |
| Canceled | 14 |
| **非 Done/Canceled 总计** | **56** |

## 建议执行顺序

1. **Phase 1**: 完成 AAV-1075 部署验证 → AAV-1076 前端迁移
2. **Phase 2A**: AAV-1071 后端修复 → AAV-1013 → AAV-962
3. **Phase 2B**: 产品决策 AAV-832 → 1022/1023/1024
4. **Phase 3A**: AAV-862 体系（868→870→866）
5. **Phase 3B**: AAV-864 缓存重构
6. **Phase 2C**: AAV-756 拆解子 issues 后执行

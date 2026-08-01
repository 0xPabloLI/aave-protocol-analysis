# Triage Overview

> 最近更新：2026-08-02（AAV-1222 完成后）

## 按优先级排列的未完成 Issue

### Urgent

| ID      | 标题                                                         | 状态 | 阻塞项      | Assignee | 备注                                                                                         |
| ------- | ------------------------------------------------------------ | ---- | ----------- | -------- | -------------------------------------------------------------------------------------------- |
| AAV-756 | Portfolio LTV constraint + Net Effective APY + Health Factor | Todo | ✅ 全部清空 | —        | **完全 unblocked，随时可开始**。AAV-1222 已完成后端 `ltv`/`liquidationThreshold`，前端需接上 |

### High

| ID      | 标题                                                                                       | 状态            | 阻塞项 | Assignee | 备注 |
| ------- | ------------------------------------------------------------------------------------------ | --------------- | ------ | -------- | ---- |
| AAV-364 | [EPIC] 市场宏观指标聚合 — market size / liquidity / utilization / 全局 deficit             | Todo            | —      | —        |      |
| AAV-895 | Borrow ETH with cbETH collateral — cross-asset net position needs dedicated offset formula | Ready for agent | —      | —        |      |

### Medium

| ID       | 标题                                                                                                   | 状态            | 阻塞项       | Assignee | 备注                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------ | --------------- | ------------ | -------- | --------------------------------------------------------------------- |
| AAV-333  | V4 Risk Premium Simulation（per-user portfolio 级别）                                                  | Todo            | 连接钱包功能 | pabloli  | Step 1（后端 `collateralRisk`）已完成；链上 CR 全部为 0（治理未激活） |
| AAV-1022 | 定义 Portfolio simulation / Reserve table / Shared scenario 的 offset 对齐规则                         | Ready for agent | —            | —        |                                                                       |
| AAV-1023 | 按统一 offset 规则改造 Reserve table 展示逻辑                                                          | Ready for agent | AAV-1022     | —        |                                                                       |
| AAV-1024 | 同步 Shared scenario 与验收用例到新的 offset 口径                                                      | Ready for agent | AAV-1022     | —        |                                                                       |
| AAV-862  | REFACTOR: 统一 aave-fetcher 与 backend 的 normalize campaignType 逻辑                                  | Ready for agent | —            | —        | 有 3 个子 issue（AAV-868/870/866）                                    |
| AAV-726  | Refactor: flatten monorepo to single-package backend                                                   | Ready for agent | —            | —        |                                                                       |
| AAV-843  | Brevis per-user API 接入：个人 Dashboard + Claim 功能                                                  | Ready for agent | —            | —        |                                                                       |
| AAV-781  | Unify endDate semantics and data directory paths in Merit cache                                        | Ready for agent | —            | —        |                                                                       |
| AAV-782  | Distinguish "extraction failed" vs "extraction succeeded but not target incentive type" in Merit cache | Ready for agent | —            | —        |                                                                       |

### Low

| ID       | 标题                                                                          | 状态            | Assignee | 备注                           |
| -------- | ----------------------------------------------------------------------------- | --------------- | -------- | ------------------------------ |
| AAV-449  | [Backend] 移除 spokeName 字段 — 语义与 marketName 冗余                        | Ready for agent | —        |                                |
| AAV-517  | [Tech Debt] onchain 查询 spokeAddress 从 reserveId 解析替代 address-book 查询 | Ready for agent | pabloli  |                                |
| AAV-830  | Migrate merit-api raw RPC fetch to ProviderPool                               | Ready for agent | —        |                                |
| AAV-829  | Unify ~35 address-related `toLowerCase()` calls to `normalizeAddress()`       | Ready for agent | —        |                                |
| AAV-1227 | Spec: Inline Widget Embedding System for Article Pages                        | Ready for agent | —        |                                |
| AAV-738  | Portfolio模式下展开行始终在当前屏幕顶部                                       | Todo            | pabloli  |                                |
| AAV-760  | 哪些 reserve 可以做质押（影响循环贷推荐）                                     | Todo            | pabloli  |                                |
| AAV-564  | 计算多链组合下的最佳 deployment 推荐                                          | Todo            | pabloli  |                                |
| AAV-512  | SEO: 首次部署后到 GSC 提交所有 URL 收录                                       | Todo            | —        |                                |
| AAV-248  | 推进全站无障碍校验、实施与规范建设                                            | Todo            | pabloli  |                                |
| AAV-30   | twitter 介绍 self 收益及使用方法                                              | Todo            | pabloli  |                                |
| AAV-135  | [Docs] V4 SDK Embedded Rewards - Intentionally Skipped                        | Todo            | —        |                                |
| AAV-329  | 建立自动告警 issue 管理 SOP                                                   | Todo            | —        | 有 2 个子 issue（AAV-586/587） |
| AAV-534  | Future: addressBookRegistry 其他字段动态化                                    | Todo            | —        |                                |

## 最近完成

| ID       | 标题                                                              | 完成日期   | 备注                                                                    |
| -------- | ----------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------- |
| AAV-1222 | GET /markets API 增加 per-reserve ltv + liquidationThreshold 字段 | 2026-08-02 | 全链路：shared-contracts → fetcher → serializer → fingerprint → OpenAPI |

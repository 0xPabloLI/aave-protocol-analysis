# PRD: Recently Ended Campaign — 后端数据源修复

## 需求背景

前端已完成 "Recently Ended Campaigns" 功能的全部开发（AAV-463 核心逻辑 + AAV-464 UI 集成），但功能完全不生效。根因是后端 API 返回的数据中不包含已结束的 campaign，导致前端 `collectRecentlyEndedCampaigns` 始终返回空数组。

三个上游 API 在 fetch 阶段就把已结束的 campaign 丢弃，后端 `filterRecentExpired*` 函数的保留策略也过于激进（每种 type 只保留 1 条过期），且无 7 天窗口限制。

### 关联 Issue

| Issue | 标题 | 状态 | 说明 |
|-------|------|------|------|
| AAV-967 | 后端: recently ended campaign 数据源缺失 | Todo (High) | 本次要修的根因 |
| AAV-951 | recently ended campaign好像完全没起作用啊 | Todo | 用户 bug 报告，修完 967 自动关闭 |

## 目标与价值

**目标：**
- 后端 API 在 `/markets` 响应中包含过去 7 天内结束的 campaign 数据
- 三个数据源（Merkl、Brevis、Merit）的过期 campaign 保留策略与前端 `DEFAULT_LOOKBACK_DAYS = 7` 对齐
- 业务判断（"哪些是 recently ended"）由后端完成，前端只负责渲染

**价值：**
- 修复前端已开发完成但完全不生效的功能
- 用户可在 IncentiveTooltip 底部看到 "Recently Ended (N)" 折叠区块，了解近期刚结束的激励

## 名词解释

- **Recently Ended Campaign**：过去 7 天内（`campaignEndedAt` 在 `now - 7d` 到 `now` 之间）已结束的 campaign
- **LIVE opportunity**：Merkl API 中至少有 1 个活跃 campaign 的 opportunity，`status=LIVE`
- **PAST opportunity**：Merkl API 中所有 campaign 都已结束的 opportunity，`status=PAST`
- **per-type 去重**：同一种 `campaignType`（如 `TARGET_TOTAL_APR`、`DUTCH_AUCTION`）只保留最近结束的 1 条
- **7 天窗口**：`campaignEndedAt >= now - 7d && campaignEndedAt < now`，与前端 `DEFAULT_LOOKBACK_DAYS = 7` 对齐

## 适用范围

- 适用：后端 `packages/aave-fetcher` 中 Merkl、Brevis 两个数据源
- 适用：`filterRecentExpiredCampaigns`、`filterRecentExpiredBrevis` 两个过滤函数
- 适用：`fetchMerklOpportunities` 增加 PAST opportunity 请求
- 不适用：Merit 数据源（优先级最低，后续迭代）

## 非目标

- 不包含 Merit 数据源的 recently ended campaign 修复（APR API 无法返回已结束数据，需爬虫/扩展 API，成本高）
- 不包含前端 UI 改动（前端展示逻辑已完整，只缺数据）
- 不包含 Brevis `getAllProtocolsList` 的 status 过滤参数（gRPC API 不支持按 status 过滤 protocols）

## 功能需求

### Merkl

- FR-1: `fetchMerklOpportunities` 必须额外请求 `status=PAST` 的 opportunities，过滤 7 天内有 campaign 结束的 PAST opp，合并进 LIVE 结果
- FR-2: `filterRecentExpiredCampaigns` 必须将保留策略从"每种 campaignType 保留最近 1 条"改为"7 天窗口内每种 campaignType 保留最近 1 条"（超过 7 天的过期 campaign 全部丢弃）
- FR-3: 7 天窗口常量必须定义为 `RECENTLY_ENDED_LOOKBACK_DAYS = 7`，放在 `@internal/aave-shared-contracts`，与前端 `DEFAULT_LOOKBACK_DAYS` 对齐
- FR-4: PAST opportunity 合并时，必须走与 LIVE opp 相同的 processing pipeline（breakdown 解析、campaignDetails cache、forecast enrichment），不重复代码

### Brevis

- FR-5: `getAaveCampaignsData` 中的 campaign status 过滤必须从 `campaignStatus !== 4` 改为 `campaignStatus === 4 || campaignStatus === 5`（4=ACTIVE, 5=ENDED）
- FR-6: status=5 的 campaign 必须按 7 天窗口过滤（`campaignEndedAt` 在过去 7 天内的保留，超过 7 天的丢弃）
- FR-7: status=5 的 campaign 必须做 per-type 去重（同 campaignType 只保留最近结束的 1 条）

### 通用

- FR-8: 三个 `filterRecentExpired*` 函数（Merkl、Brevis、Merit）的保留策略必须统一为 7 天窗口 + per-type 最近 1 条
- FR-9: Merit 的 `filterRecentExpiredMeritCampaigns` 虽然上游数据源暂无已结束数据，但保留策略也需改为 7 天窗口 + per-type，保持一致性

## 关键流程/交互说明

### Merkl 数据流（修改后）

```
fetchMerklOpportunities()
  ├── fetchMerklOpportunitiesSnapshot(status=LIVE) → liveOpps
  ├── fetchMerklOpportunitiesSnapshot(status=PAST) → pastOpps
  ├── 过滤 pastOpps: 只保留 7 天内有 campaign 结束的
  └── 合并: [...liveOpps, ...filteredPastOpps]
        ↓
processMerklData()
  ├── 对每个 opp 做 breakdown 解析 + campaignDetails cache + forecast enrichment
  ├── filterRecentExpiredCampaigns(breakdowns)
  │     ├── active: 未结束的 breakdown → 全部保留
  │     └── expired: 已结束的 → 只保留 7 天内 + per-type 最近 1 条
  └── 输出 merklData index
```

### Brevis 数据流（修改后）

```
getAaveCampaignsData()
  ├── gRPC getAllProtocolDetail → campaignDetails
  ├── 过滤: campaignStatus === 4 || campaignStatus === 5
  ├── 对 status=5 的做 7 天窗口过滤
  ├── 构建 campaignItem (含 campaignEndedAt)
  ├── filterRecentExpiredBrevis()
  │     ├── active: 未结束的 → 全部保留
  │     └── expired: 已结束的 → 只保留 7 天内 + per-type 最近 1 条
  └── 输出 campaignsIndex
```

## 风险与依赖

**风险：**
- Merkl PAST 请求增加 API 调用量，但数据量远小于 LIVE（PAST 需分页，但有 7 天窗口过滤，实际合并量小）
- Brevis status=5 的 campaign 数据格式可能与 status=4 有差异，需验证 gRPC 响应结构
- 7 天窗口是固定值，未来可能需要可配置化

**依赖：**
- Merkl API 支持 `status=PAST` 参数（已验证，返回 PAST opportunity）
- Brevis gRPC `getAllProtocolDetail` 返回的 campaign 包含 status=5（已验证，172 条 status=5 campaign）
- 前端 `collectRecentlyEndedCampaigns` 不需改动，只消费 `campaignEndedAt` 字段

## 验收标准

- [ ] 后端 `/markets` API 返回的 reserve 中，某些 `merklSupplys`/`merklBorrows` 包含 `campaignEndedAt` 在过去 7 天内的 breakdown
- [ ] 后端 `/markets` API 返回的 reserve 中，某些 `brevisSupplys`/`brevisBorrows` 包含 `campaignEndedAt` 在过去 7 天内的 breakdown
- [ ] `filterRecentExpiredCampaigns` 不保留超过 7 天的过期 campaign
- [ ] `filterRecentExpiredBrevis` 不保留超过 7 天的过期 campaign
- [ ] 同 campaignType 的过期 campaign 只保留最近 1 条
- [ ] Merkl PAST opportunity 的 7 天窗口过滤正常工作
- [ ] Brevis status=5 campaign 被正确纳入处理
- [ ] 前端 IncentiveTooltip 底部出现 "Recently Ended (N)" 折叠区块
- [ ] 现有测试全部通过（`npm run ci:remote`）
- [ ] 为新增逻辑添加单元测试

## 待确认问题

- Merit 数据源修复是否纳入本次迭代？（当前建议：不纳入，后续迭代）
- 7 天窗口常量是否需要通过环境变量可配置？（当前建议：先硬编码，YAGNI）

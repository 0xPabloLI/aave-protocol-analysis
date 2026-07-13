# Campaign 历史保留方案

Last updated: 2026-05-21

> **已归档**。本方案已被 `change-detection-and-incentive-normalization.md` 替代。

## 完成状态

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 1 | DB 写入路径（`campaign_history` UPSERT + `markExpiredCampaigns` + cron 集成） | ✅ 完成，但 `markExpiredCampaigns` 已从 cron 移除（无消费端） |
| Phase 2A | fetcher recent-expired 过滤 + `_isExpired` 序列化 | ✅ 核心已完成（fetcher 已实现 `filterRecentExpiredCampaigns`，序列化已实现 `computeIsExpired`） |
| Phase 2A | `recentlyExpiredService.ts` 重启兜底 | ❌ 未实现 |
| Phase 2B | APR 曲线 API + LOCF 查询 + view | ❌ 未实现 |

> **注意**：`campaign_history` 和 `campaign_apr_observations` 表计划删除（由 `incentive_details` JSONB 替代），见 `change-detection-and-incentive-normalization.md` §3.4。

## 当前任务跟踪

见 `docs/backend/change-detection-and-incentive-normalization.md` §6。

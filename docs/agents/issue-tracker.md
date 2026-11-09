# Issue Tracker: Linear

Issues are tracked in **Linear** using the integrated Linear MCP tools. Backend-agnostic contract (triage lifecycle, cognitive offload) comes from the agent-harness core; this file adds the Linear-specific operations.

## Workflow (Linear-specific)

- **Create issue**: use `mcp__linear_create_issue` with `title`, `teamId`, and optional `description`/`priority`/`labels`
- **List issues**: use `mcp__linear_list_issues` with optional `teamId`/`status`/`assigneeId` filters
- **Update issue**: use `mcp__linear_update_issue` with `issueId` and fields to change
- **Search issues**: use `mcp__linear_search_issues` with a text `query`
- **Get issue detail**: use `mcp__linear_get_issue` with `issueId`
- **List teams**: use `mcp__linear_list_teams` to discover team IDs
- **List projects**: use `mcp__linear_list_projects` with optional `teamId` filter

## Conventions

- Always specify `teamId` when creating issues to ensure they land in the correct team
- Use `priority` (0–4) to signal urgency: 0 = no priority, 1 = urgent, 2 = high, 3 = medium, 4 = low
- Include enough context in `description` for an AFK agent to execute without human input when the issue is `ready-for-agent`
- Use labels for triage (see `triage-labels.md`)
- 远端 tracker 写入（创建、编辑、label、关闭）是 consequential external action，需要用户对当次动作授权；未授权时停在本地草稿，不得声称 tracker 已更新

## Triage 生命周期（core 契约）

- 每个新 issue 进入 `needs-triage`；
- 澄清后进入 `ready-for-agent`（完全指定 + 有验收标准 + Agent 可独立执行）或 `ready-for-human`；
- 等待报告者补充信息 → `needs-info`；
- 拒绝项 → `wontfix`（关闭时必须附解释；完成项不得用 `wontfix`）；
- 关闭已完成的 issue：保留 category label（如 `bug`/`enhancement`），移除所有 state label。

## Session 认知卸载（core 契约）

tracker 是 session 的外部记忆：fresh session 必须能只从 durable sources 重建全部状态——绝不依赖对话。session 结束前，工作产出的每种状态都有唯一卸载 home：

| 产出状态                                                   | Home                        | 完成标准                                                   |
| ---------------------------------------------------------- | --------------------------- | ---------------------------------------------------------- |
| Per-issue 交付记录（commits、测试、live evidence、遗留项） | issue 关闭评论              | 没见过该 session 的读者能仅凭评论恢复或审计这项工作        |
| Roadmap 状态（tier、wave、blockers、labels）               | repo 内 roadmap 文档        | tracker open list 与文档表一致                             |
| Session 叙事（跑了什么、按什么顺序）                       | roadmap 文档的 inventory 行 | 下个 session 的「Last inventory」是最新一行并指明 frontier |
| 超出单任务存活期的用户决策与约束                           | roadmap 文档 inventory      | 下个 session 不再重复问已决策的问题                        |

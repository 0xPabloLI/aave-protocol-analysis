# Issue Tracker: Linear

Issues are tracked in **Linear**（team `Aaveapy`）via the Linear MCP tools. 后端无关契约（写入/读取纪律、triage 生命周期、认知卸载）来自 agent-harness core；本文补 Linear 侧操作与本地现状。

**术语**：_issue_ 指 tracker 条目；_ticket_ 指 S2 拆出的实施票（`to-tickets` 产物）。二者不混用。

## Linear 操作（实测可用的工具面）

| 场景                    | 工具                                   | 关键参数                                                                  |
| ----------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| 读票                    | `mcp__linear_oauth__get_issue`         | `id`（票号如 `"AAV-449"`）；返回 state/labels/stateHistory/parent/project |
| 读评论                  | `mcp__linear_oauth__list_comments`     | `issueId`                                                                 |
| 写评论（交付记录/进度） | `mcp__linear_oauth__save_comment`      | `issueId` + `body`                                                        |
| 改状态 / label / 优先级 | `mcp__linear_oauth__save_issue`        | `id` + `state`（名/类型/ID）+ `addLabels`/`removeLabels`/`labels`         |
| 列 label                | `mcp__linear_oauth__list_issue_labels` | `team`                                                                    |

工具名差异：早期写法 `mcp__linear_create_issue` / `mcp__linear_update_issue` / `mcp__linear_search_issues` 已不存在，当前是 `linear_oauth` 前缀的 `save_issue` / `get_issue` / `list_issues` 等；`tool_search` 用宽泛关键词（如 `get_issue`）会命中文档类工具，用完整工具名经 `execute_defer_tool` 才稳定命中。

## 通用契约（core）

- **Issue body is write-once**：body 建票时定稿，此后不改写——Linear 的正文编辑是整体替换，会覆盖其他 session 的内容。新证据、交付记录、进度一律走评论。
- **读票先读评论**：body 单独不是票的全部状态。三条守卫让漏读可判定：(a) body 顶部固定告示块；(b) 评论计数一查即得（`list_comments`，open 票非零即有正文外状态）；(c) unread 信号（本 repo 未装机，见下）。
- **认领必须回读断言**：认领后回读该票的 assignee/state，确认落盘才算领取成功。
- **PRs as request surface**：默认 off，外部 PR 不当作 issue 分诊。
- **远端写入需当次授权**：创建、编辑、label、关票都是 consequential external action；未授权时停在本地草稿，不得声称 tracker 已更新。

### Body notice（建票时写一次）

> **正文是创建时的规格（write-once，永不改写）。** 当前状态、跨 session 证据与交付记录都在评论里——读票必须带评论。

本 repo 大量存量票无此告示块——对它们守卫 (b) 仍然适用（评论计数全量追溯）；不回填 unread 信号。

## Triage 生命周期（core）

- 新 issue → `needs-triage`；澄清后 → `ready-for-agent`（完全指定 + 有验收标准 + 可独立执行）或 `ready-for-human`；等报告者补充 → `needs-info`；拒绝 → `wontfix`（关闭必须附解释）。
- 关闭已完成 issue：保留 category label，移除所有 state label（以及 triage 期的临时 label 如 `done-candidate`、`manual-review`）。
- **开工前对齐模型/工具裁决史**：票面推荐的模型、工具、方案可能已被后续裁决否决——到该名字的调研/决策文档查现行裁决，不只验证环境可行性。

## Session 认知卸载（core）

tracker 是 session 的外部记忆：fresh session 必须能只从 durable sources 重建全部状态。

| 产出状态                                                             | Home                                                                 | 完成标准                                            |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| Per-issue 交付记录（commits、测试、live evidence、机制发现、遗留项） | issue 关闭评论，**以固定标记开头**（`交付记录` / `Delivery record`） | 没见过该 session 的读者能仅凭评论恢复或审计这项工作 |
| Roadmap 状态（tier、wave、blockers、labels）                         | `aaveapy/docs/issue-roadmap.md`                                      | tracker open list 与文档表一致                      |
| Session 叙事                                                         | roadmap 的 inventory 行                                              | 「Last inventory」是最新一行并指明 frontier         |
| Commit 溯源                                                          | commit sha（交付评论内列出）                                         | 评论可直接追到 commit                               |
| 超出单任务的用户决策与约束                                           | roadmap inventory 或 agent memory                                    | 下个 session 不再重复问已决策的问题                 |

## 本地现状（未装的机器兜底，纯约定）

- `comments-unread` 信号、`delivery-record-missing` 账本标签：**未装**。读票靠 `list_comments` 计数 + 人工确认；关票前自查交付评论是否带标记。
- `dormant`、`P0`–`P3` label：本 repo 不用 label 表达——闲置/优先级分别由 Linear 状态与 priority 字段（0–4）承载，见 `triage-labels.md`。
- Wayfinding（S3 foggy-route）：**未启用**。若启用，按 core 契约用 map issue + 单类型 label 的 child ticket，不用含糊占位票。

# Agent Harness 本地改编登记

> core 通用层的唯一编辑入口在 agent-harness 核心仓（`~/Documents/code/agent-harness`，其 MANIFEST.md 是跨 repo 全景与拷贝映射）。本文件只登记**本 repo 相对 core 的偏离**：同步 core 时按此表保留本地化，防止覆盖；不承担组件地图职责。

## 本地改编登记（相对 core 的偏离与刻意不搬）

| 组件                       | 状态                                                                                                                                                     | 原因                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 实施工作流                 | **内联在 AGENTS.md**（10 步 + checklist），无独立文档                                                                                                    | 历史；暂不拆                                                     |
| issue-tracker.md           | core 后端无关契约 + 本 repo Linear MCP 段                                                                                                                | 后端是 Linear                                                    |
| git 纪律                   | **刻意不搬 core git-workflow**：本 repo 是单写者纪律（一切提交直提 `railway` 分支、不建 feature branch/worktree），与 core 的「写入者独占 worktree」相反 | 单人节奏 + Railway 部署绑定分支；改为多 session 并行时须重新评估 |
| git-concurrent-recovery.md | **未搬**                                                                                                                                                 | 单写者纪律下不适用                                               |
| proposal-review.md         | **未引入**                                                                                                                                               | AGENTS.md 无对应路由                                             |
| scenario 位置              | 住 `docs/best-practices/`（非 conventions/）                                                                                                             | 与本 repo 现有布局一致                                           |
| 专项 checklist             | memory-leak-checklist（38 项缓存审计）、ci-security-automation 等为本 repo 专属                                                                          | 领域层，core 不收                                                |

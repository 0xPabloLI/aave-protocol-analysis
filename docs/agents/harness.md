# Agent Harness 架构总览

> 本仓库的 agent harness 让 agent 并行、安全、可追溯地工作。core 通用层源自 agent-harness 核心仓（`~/Documents/code/agent-harness`，其 MANIFEST.md 是跨 repo 全景）。**每个新 session 的起点：读本文件 → 按需加载组件。**

## 组件地图

```
AGENTS.md (每 session 必读，路由 + 插槽值)
│  Workflow Router（lightweight/substantial 分流 → 10 步强制工作流，内联）
│  Hard Safety Gates（Railway 部署 gate、stash/checkout 禁令、分支纪律）
└─→ docs/ (无 DOCS-INDEX；按需查阅)
    │
    ├─ 怎么干活：
    │   ├─ AGENTS.md 内联 10 步工作流（Grill → Spec → Tickets → TDD →
    │   │   Review → Runtime Verify → Commit&Push → Docs+Issue → Session
    │   │   结束 checklist → 最佳实践确认）
    │   ├─ best-practices/scenario-enumeration-checklist.md（core 合并版）
    │   ├─ best-practices/scenario-matrix.md（core 合并版，本次新增）
    │   └─ best-practices/memory-leak-checklist.md（内存缓存专项，38 项清单）
    │
    ├─ 怎么碰 git：
    │   └─ AGENTS.md 内联（railway 分支直提、PR 前本地合并、跨 session 边界）
    │
    ├─ 怎么找信息：
    │   ├─ agents/issue-tracker.md（core 契约 + Linear MCP 后端操作）
    │   ├─ agents/triage-labels.md（五角色 label，core 版）
    │   └─ agents/domain.md（CONTEXT.md/ADR 消费规则，含词汇纪律）
    │
    └─ 机器兜底（不靠自觉）：
        ├── .husky/ pre-commit（build + typecheck + auto-fix + lint-staged）
        ├── pre-push hook-autofix.sh（ci + auto-fix + audit）
        └── CI auto-revert（fail 的直接 push 自动回滚）
```

## 什么时机读哪份

- **session 开始**：AGENTS.md → 本文件
- **拿到实施任务**：AGENTS.md 内联 10 步工作流
- **R2/R3 场景分析**：`best-practices/scenario-enumeration-checklist.md` → `scenario-matrix.md`
- **改缓存/长生命周期对象**：`best-practices/memory-leak-checklist.md`（必须对表审计，不许 ad-hoc 扫）
- **准备 commit / push / 部署**：AGENTS.md（Railway gate：先 `railway status` 确认目标 service）
- **要建/查 issue**：`agents/issue-tracker.md`；triage 用 `agents/triage-labels.md`
- **命名领域概念**：`agents/domain.md` + CONTEXT.md 词汇纪律（Market ≠ pool、Reserve ≠ asset）

## 移植记录（本 repo 视角）

- 来源：agent-harness core（2026-09-06 同步）。**逐组件对照移植，不整目录覆盖。**

### 本地改编登记（相对 core 的偏离与刻意不搬）

| 组件                       | 状态                                                                                                                                                     | 原因                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 实施工作流                 | **内联在 AGENTS.md**（10 步 + checklist），无独立文档                                                                                                    | 历史；暂不拆                                                     |
| issue-tracker.md           | core 后端无关契约 + 本 repo Linear MCP 段                                                                                                                | 后端是 Linear                                                    |
| git 纪律                   | **刻意不搬 core git-workflow**：本 repo 是单写者纪律（一切提交直提 `railway` 分支、不建 feature branch/worktree），与 core 的「写入者独占 worktree」相反 | 单人节奏 + Railway 部署绑定分支；改为多 session 并行时须重新评估 |
| git-concurrent-recovery.md | **未搬**                                                                                                                                                 | 单写者纪律下不适用                                               |
| proposal-review.md         | **未引入**                                                                                                                                               | AGENTS.md 无对应路由                                             |
| scenario 位置              | 住 `docs/best-practices/`（非 conventions/）                                                                                                             | 与本 repo 现有布局一致                                           |
| 专项 checklist             | memory-leak-checklist（38 项缓存审计）、ci-security-automation 等为本 repo 专属                                                                          | 领域层，core 不收                                                |

# Triage Labels

Triage uses canonical roles. 本 repo 的 label 集合来自 Linear team `Aaveapy` 实测（2026-11-18）；**优先级不是 label**，由 Linear `priority` 字段承载。

## Category Labels（每张票恰好一个）

| Label           | Meaning                    |
| --------------- | -------------------------- |
| `Bug`           | 坏的 / 回归                |
| `Feature`       | 新功能                     |
| `Improvement`   | 既有能力改进、重构、技术债 |
| `documentation` | 文档                       |

外加仓库归属 label `repo:backend` / `repo:frontend`（区分交付到哪个仓，可同时存在）。

## Priority（Linear 字段，不是 label）

| 字段值   | 对应 core 档位 | Meaning                      |
| -------- | -------------- | ---------------------------- |
| 1 Urgent | P0             | 生产/线上服务受阻，立即处理  |
| 2 High   | P1             | 核心链路受损但有变通，本周修 |
| 3 Medium | P2             | 常规排期项                   |
| 4 Low    | P3             | 有空或顺手时做               |
| 0 None   | —              | 未评定                       |

## State Labels / 状态

Linear 工作流状态承载 state；`state` 字段与 label 二选一，**不重复打 label**。

| 状态                        | Meaning                            |
| --------------------------- | ---------------------------------- |
| `Backlog`                   | 未排期                             |
| `Todo` / `Ready for agent`  | 已澄清，可执行（agent 可直接开工） |
| `In Progress` / `In Review` | 在途 / 待审                        |
| `Done`                      | 已完成                             |
| `Wontfix`                   | 不做，关闭时必须附解释             |

历史遗留的 state 型 label（`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`）仍可能出现在旧票上——读票时与本仓状态字段一起判断，新票不要再打。

## Signal Labels（机器管理的临时标记）

| Label            | Meaning                                              |
| ---------------- | ---------------------------------------------------- |
| `done-candidate` | 代码看像已实现，需人工核实后才能关票；核实后**移除** |
| `manual-review`  | 需人工审查的机器产出（机器人 PR / 自动修复）         |

这两类不是 triage 状态：关票 sweep 时一律清掉。

## Triage Flow

```
New issue → needs-triage / 待评估
          → needs-info（等报告者补充）
          → Ready for agent（可被 agent 领取）
          → Done
 拒绝项   → Wontfix（附解释关闭）
```

## Conventions

- 每张已 triage 的票：一个 category label + 一个 Linear 状态 + 一个 priority 字段值；`repo:*` 与 signal label 不受此限。
- `Ready for agent` 的判据：(1) 完全指定且有验收标准，(2) 优先级已评，(3) agent 无需额外人工输入即可执行。
- 关闭完成票：移除所有 state 型 label、`done-candidate`、`manual-review`，保留 category label 与 `repo:*`。
- `Wontfix` 只用于拒绝项，关闭必须附解释；完成项不得用 `Wontfix` 替代 `Done`。

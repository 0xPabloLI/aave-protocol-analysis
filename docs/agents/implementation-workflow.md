# Implementation Workflow

> 实施入口与分级。核心原则：**Planning Scale 决定是否创建 Spec/Tickets，Risk 决定验证强度。**
> 底本 `~/Documents/code/agent-harness/core/implementation-workflow.md`；本 repo 的十步清单仍在 `AGENTS.md` Step 9，本文件负责**分级与走法**，两者不重复。

## 1. 授权与自动推进

1. 用户明确要求实施后才改文件；只要求分析/review/调研时停在实施前。
2. 授权后自动推进后续阶段，不要求用户逐条确认。
3. 仅在这些情况暂停：关键产品决策有多个合理答案；需要用户选 prototype；不可逆操作或 consequential external action（部署、远端 tracker 写入、发布）；环境/凭据缺失。

## 2. Skill 调用契约

- **Model-invoked**：`grilling`、`domain-modeling`、`research`、`tdd`、`codebase-design`、`code-review`、`diagnosing-bugs` 可直接调用。
- **User-invoked**（`grill-with-docs`、`to-spec`、`to-tickets`、`implement`）：execute-by-reference——读 `.agents/skills/<name>/SKILL.md`，以它为方法来源执行，再叠加本文件覆写；如实描述为「按 `<name>` 执行」。
- **降级**：skill/子 agent 不可用或缺必需工具时，主 agent 自己执行该步骤，完成标准不变，并在汇报里标注「阶段 N 降级 + 原因」。

## 3. 第一次分流：Planning Scale

选能可靠完成任务的**最低**等级；代码量、文件数不是判据。

| 等级                              | 判定                               | 路线                                         | 本 repo 落点                                                           |
| --------------------------------- | ---------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| **S0 Read-only**                  | 未授权改动，或只解释/调查/review   | 检查并汇报                                   | 无                                                                     |
| **S1 Single-session**             | 决策与实施能在一个 context 完成    | 必要时 Grill → 直接 Implement                | Step 1（按需）+ Step 4/5/6/7；**可跳过 Step 2 Spec 与 Step 3 Tickets** |
| **S2 Multi-session, clear route** | 路线清楚，但实施跨多个 context     | Grill → Spec → Tickets → 逐 ticket Implement | 完整 Step 1–9                                                          |
| **S3 Multi-session, foggy route** | 目的地能命名，但规划本身跨 session | Wayfinder → 路线清晰后转 S2                  | 先解决策票，再起 S2                                                    |

判定示例（本 repo 实测）：

- 删一个对外字段 + 测试 + 契约产物 + 文档 → **S2**（跨 TDD/Review/Runtime/文档四个 context 才收得掉）。
- 只改文档/规则文件、无运行时行为 → **S1**（不需要 spec 与 ticket 拆分）。
- 单个 bug 修复 + 一条回归测试 → **S1**。

## 4. 第二次分流：Risk

与 Planning Scale 独立判定。

| 等级   | 判定                                                                   | 验证强度                                                         |
| ------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **R0** | 无文件修改                                                             | 无                                                               |
| **R1** | 不改变运行时行为、契约、数据流、发布路径（文档、注释、配置默认值不变） | 定向检查 + diff 自审                                             |
| **R2** | 有界的普通行为变化                                                     | 场景矩阵 + TDD + 受影响测试 + review                             |
| **R3** | 命中下列任一触发                                                       | 场景穷举 + **真实失败基线** + 全量相关验证 + 运行时/真实数据证据 |

### R3 触发（本 repo 专属）

通用：认证/授权/secret 边界；migration、数据删除、不可逆状态变化；公共接口、持久化 schema、跨组件契约；发布/部署/外部写入/用户可见生产路径；多消费者共享模块。

本 repo 追加（对应 AGENTS.md「High-Risk Areas」）：

- **对外 API 契约**：`marketsApiSerialize.ts`、`MarketWithSpread`、`MARKETS_API_VERSION`、schema fingerprint、OpenAPI 生成物；
- **单位与数值**：`units.ts`（`FIELD_UNITS`/`SERIALIZER_RULES`）、任何 RAY/decimals/USD 换算；
- **内存与长驻状态**：新增缓存/Map/Set/长生命周期闭包（先读 `docs/memory-leak-checklist.md` 的 43 项清单）；
- **抓取编排与外部数据源**：`fetchMarketsData` 编排、Merkl/Brevis/CoinGecko 适配器、chain/platform 映射；
- **部署链路与门禁**：`.github/workflows/*`、husky hooks、Dockerfile、Railway 配置。

R3 实现前必须留下真实失败基线：失败的自动化测试、可重复的 runtime/真实数据复现，或对旧状态 fail 的静态 gate。仅声明「可以变红」不算证据。会破坏真实数据时用 fixture / dry-run / 既有失败 artifact。

## 5. 决策阶段

- **Grill**：仅当需求、边界、seam 或产品行为未决定时执行；R2/R3 按 `docs/best-practices/scenario-enumeration-checklist.md` 穷举场景（含跨 step 契约）。路线已由 issue / 明确验收标准决定时跳过。
- **Prototype**：只有 Talk 无法回答状态模型或视觉选择时才做；原型放隔离 worktree 的 `prototype/<name>` 分支，遵守 `docs/agents/git-workflow.md`。
- **Spec**（仅 S2/S3）：按 `to-spec` 执行；默认落 `docs/plans/`，完成并验证后移入 `docs/plans/executed/`。Spec 必须含 Scenario & Risk Verification 矩阵（无矩阵 = 不完整），并吸收已决定内容、不重开访谈。R3 还必须含 Modified Files Impact。
- **Tickets**（仅 S2/S3）：按 `to-tickets` 执行；tracer-bullet 垂直切片，每片可独立验证、适合一个 fresh context。单点闭环任务不拆票。

## 6. 实施与验证循环

1. 先在本 context 写明 scope、acceptance criteria、test seams 与适用风险场景。
2. **R2/R3 走 TDD**：先写失败的测试（真实失败基线），再实现，再重构。
3. 改完跑分层验证：受影响单测 → 包级测试 → `npm run check:quality` → 需要时 `npm run ci:remote`；契约类改动另跑 live 断言（`RUN_API_FIELDS_TESTS=true`）与 staging 真实 payload。
4. **Review 前先 commit**（只 commit 不 push），终点用 `taskHead = git rev-parse HEAD`，审查 `baseline...taskHead`；accepted finding 回 Step 4 修复并追加 commit。
5. Runtime Verify 不可跳过：后端 `npm run dev` + 端点实测；spec 标「不做 UI」不豁免。

## 7. 收尾汇报

按 AGENTS.md Step 9 的 checklist 汇报，**首段是产品视角结论**（issue 原本要什么 / 用户现在看到什么），再列各步完成情况与证据，跳过的步骤显式标注原因。

# AAV-1295 — 让 `deploymentRollback` 第一次执行发生在演练里，而不是事故里

> **Status: Active** — 实施中。
> 完成后移入 `docs/plans/executed/`，并在此文件补运行时证据。

## Problem

AAV-1294 修好 `resolveDeploymentTarget` 之后，`deployment-smoke-test.yml` 的
`rollback` job 第一次真正可达。但这条链路里的四段逻辑**从未在任何一次运行中执行过**：

1. `deploymentRollback` GraphQL mutation 本身 —— token scope、返回值形状
   （`jq -e '.data.deploymentRollback == true'`）是否与真实响应一致。
2. 回滚目标挑选启发式 —— 先取 `canRollback == true and id != head` 的最新一条，
   空了再退化成「任意一条 canRollback 为 true 的」。这段逻辑只在真实
   `deployments(input:, first:)` 返回上才验得了。
3. production 的回滚路径 —— 此前完全是死代码，现在第一次可达。
   对生产事故恢复手段来说，「第一次真用就是真事故」是最差的验收方式。
4. `rollback_executed` 输出的串联 —— `steps.rollback.outputs` → github-script
   的 issue body。纯函数 `createSmokeTestIssuePayload` 有单测，但串联段没有。

## 已完成的只读取证（2026-11-16T05:05Z 左右）

用已登录的 Railway CLI token 对 `https://backboard.railway.com/graphql/v2`
执行 workflow 中**同一条** `deployments` query，未触发任何 mutation：

| 环境       | head deployment                        | head commit | 下一个 `canRollback` 目标              | 目标 commit |
| ---------- | -------------------------------------- | ----------- | -------------------------------------- | ----------- |
| staging    | `49e5f677-5755-4e9f-a25d-2d3829b030ae` | `5ceb6e6`   | `b211ea61-3dbf-4560-b9fb-5517c8188524` | `878f41e`   |
| production | `1586d53f-c8ac-46ad-9e16-22ffe458ff1a` | `4ab7243`   | `6195f301-ab73-4f8f-aba6-6cc52b72edd5` | `192c3dc`   |

返回形状确认：`data.deployments.edges[].node.{id,status,createdAt,canRollback,meta}`
全部存在；`meta.commitHash` 是完整 40 位 SHA，`meta.reason` 对所有历史部署都是
`"deploy"`。`status` 为 `SUCCESS`/`REMOVED`，`canRollback` 对历史部署为 `true`。
按 workflow 将要发送的**同一条** query（含 `meta`）在本地重放，staging 的
eligible 数为 5、production 为 2；目标仍是上表的 `b211…` / `6195…`。
`/health.commitSha` 是完整 40 位 SHA（staging `5ceb6e65…`，production `4ab7243f…`）。

GraphQL schema introspection：

```
deploymentRollback(id: String!): Boolean!
deploymentRedeploy(id: String!, usePreviousImageTag: Boolean): Deployment!
```

即 workflow 的 `Boolean` 判定与 schema 一致；`deploymentRedeploy` 可用于演练后
恢复 head。

未验证、且本票不打算验证的：production **真实** mutation。按用户拍板，production
只做只读 plan；真实 mutation 由生产闸门兜住，闸门默认关闭。

## Solution

### 1. 目标选择与闸门收敛成纯函数

在 `.github/scripts/deployment-smoke-test-helpers.mjs` 新增：

- `selectRollbackCandidate(edges, { headId })`：输入真实 `deployments` 响应的
  `edges`，返回
  `{ headId, targetId, targetCommit, targetStatus, targetCreatedAt, eligibleCount, reason }`。
  - 只选 `canRollback === true` 的部署；
  - **永远不选 head**：head 是刚失败的那次部署，回滚到它等于重新部署坏版本；
  - 没有非 head 候选时返回 `reason: "only-head-eligible"`，由 workflow 报错并建
    issue，而不是静默重部署 head（fail closed）；
  - `headId` 可选覆盖，默认取 `edges[0].node.id`；workflow 依赖 Railway 返回的
    最新优先顺序，本地用真实响应验证过。
- `resolveRollbackGate({ environmentLabel, productionRollbackEnabled })`：
  - `staging` → allowed；
  - `production` + 变量**精确**等于 `"true"` → allowed；
  - 其他任何值（未设置、`"TRUE"`、`"1"`、`"yes"`、空串）→ gated；
  - 未知环境 → gated（fail closed）。
- `createSmokeTestIssuePayload` 新增 `rollbackGated`，状态优先级：
  `gated` > `succeeded` > `skipped` > `failed`。

### 2. 现有 workflow 增加 dispatch 演练入口

`deployment-smoke-test.yml` 增加 `workflow_dispatch`，三个输入：

| 输入          | 取值                   | 作用                                                  |
| ------------- | ---------------------- | ----------------------------------------------------- |
| `environment` | `staging`/`production` | plan 两者都允许；execute 仅 staging                   |
| `mode`        | `plan`/`execute`       | plan 只读；execute 执行真实 mutation                  |
| `confirm`     | 字符串                 | execute 必须精确等于 `rollback-staging`，否则拒绝启动 |

- `plan`：拉取真实 `deployments`，用 `selectRollbackCandidate` 选出 head/target，
  打印到 step summary；**不调用任何 mutation**。production 也允许 plan。
- `execute`：仅 staging；要求 `confirm=rollback-staging`；先
  `deploymentRollback(targetId)`，轮询 `/health.commitSha` 到 target commit；
  再用 `deploymentRedeploy(headId)` 恢复，轮询回 head commit。
  - 任一步失败都保留 `always()` 的恢复/汇总步骤，job 最终为红；
  - 恢复失败时 runbook 给出手动命令；不允许把失败报成绿。

### 3. production 自动回滚闸门

`rollback` job 在执行 mutation 前读 `vars.RAILWAY_PRODUCTION_ROLLBACK_ENABLED`：

- `staging`：始终放行；
- `production`：只有变量精确等于 `"true"` 才放行；
- 闸门关闭时：**不做 mutation**，输出 `rollback_gated=true`，建一条
  `smoke-test-failure` issue（标题写明 `auto-rollback GATED`），job 以非零退出，
  让 workflow 红而不是假绿；
- 闸门打开后，production 走与 staging 相同的 `deploymentRollback` 路径。

变量默认未设置 = 关闭。staging 演练通过后，由用户在 Linear 里明确授权后再执行
`gh variable set RAILWAY_PRODUCTION_ROLLBACK_ENABLED --body true`。本票不擅自打开。

### 4. 修掉「回滚部署取消回滚运行」的竞态

当前 workflow 的 concurrency group 是
`smoke-test-${{ github.event.deployment.environment || ... }}`。Railway 的
`deployment.environment` 对所有 staging 部署都是 `"aaveapy / staging"`，所以
回滚产生的新 deployment 会取消**正在执行回滚/发 issue 的那次 run**。

改为：

```yaml
concurrency:
  group: smoke-test-${{ github.event.deployment.id || github.run_id }}
  cancel-in-progress: false
```

deployment id 对每次部署唯一；dispatch run 用 `run_id`，互不取消。

### 5. 输出串联

`Rollback Railway deployment` 步骤同时在所有分支（成功、失败、闸门、无目标）
写出 `rollback_executed` 与 `rollback_gated`；通知步骤把
`steps.rollback.outputs.rollback_executed`、`steps.rollback.outcome`、
`steps.rollback.outputs.rollback_gated` 一起传给 `createSmokeTestIssuePayload`。
静态测试钉住这条引用链，防止后续编辑把 gate 状态丢掉。

## Verification Plan

### 1. 自动化测试

- `tests/deploymentSmokeTest.test.ts`：真实 staging/production 部署 fixture 下的
  目标选择、只读 head 的 fail-closed、空/坏 payload、闸门精确值、issue payload
  四态。
- `tests/deploymentSmokeTestWorkflow.test.ts`：workflow 静态断言 ——
  mutation 前有 gate、mutation 请求只有一个调用点、drill 拒绝 production
  execute、execute 需要 confirm、恢复用 `deploymentRedeploy`、concurrency
  group 含 deployment id、通知步骤传 `rollbackGated`。静态测试只把
  `mutation($id: String!) { deploymentRollback(id: $id) }` 计为调用点；
  `jq` 结果判定里出现的字段名不算第二次调用。

### 2. 运行时真实数据

1. `gh workflow run deployment-smoke-test.yml --ref railway -f environment=staging -f mode=plan`
   → 选中 staging head/target，零 mutation。
2. `gh workflow run deployment-smoke-test.yml --ref railway -f environment=production -f mode=plan`
   → 选中 production head/target，证明 production secrets 的读权限。
3. 负控：`-f environment=staging -f mode=execute -f confirm=wrong`
   → 在任何 mutation 前失败。
4. 真实演练：`-f environment=staging -f mode=execute -f confirm=rollback-staging`
   → `deploymentRollback` 返回 true；staging `/health.commitSha` 从 `5ceb6e6`
   变为 `878f41e`；恢复后回到 `5ceb6e6`。
5. 记录 run URL、mutation 响应、两次 health 读数到本文件与 Linear。

### 3. 门禁

- `npm test`（root，含新增两个测试文件）
- `npm run build`
- `npm run ci` / pre-push 全门
- `npm run check:test-naming`
- `npm run lint`

## Scenario & Risk Verification Matrix

### Modified Files Impact

| 文件                                                | 修改内容                                                          | 风险   | 评估                                                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `.github/scripts/deployment-smoke-test-helpers.mjs` | 新增 `selectRollbackCandidate` / `resolveRollbackGate` / gated 态 | Medium | 纯函数；现有导出签名不变；所有新分支有单测；workflow 与 drill 复用同一实现。                                |
| `.github/workflows/deployment-smoke-test.yml`       | dispatch 演练、production 闸门、concurrency key、目标选择 helper  | High   | 生产恢复路径；闸门默认关闭、execute 仅 staging、mutation 前有静态守卫；负控证明 production execute 不可达。 |
| `tests/deploymentSmokeTest.test.ts`                 | 真实 fixture + 新增 helper/payload 用例                           | Low    | 测试专用；真实数据来自 2026-11-16 只读查询。                                                                |
| `tests/deploymentSmokeTestWorkflow.test.ts`         | 新增 workflow 静态守卫                                            | Low    | 测试专用；只读文本，不执行外部动作。                                                                        |
| `docs/ci-security-automation.md`                    | 记录闸门、drill、concurrency 语义                                 | Low    | 文档；与代码同步。                                                                                          |
| `docs/runbooks/app-deploy-failure.md`               | production 闸门关闭/恢复失败时的手动步骤                          | Low    | 文档；操作员入口。                                                                                          |
| `AGENTS.md`                                         | 一行闸门与 drill 命令                                             | Low    | 文档；`check:agents-drift` 会验证引用的 workflow 文件存在。                                                 |
| `docs/plans/aav-1295-rollback-drill-spec.md`        | 本 spec                                                           | Low    | 新文件。                                                                                                    |
| `SESSION-BOARD.md`                                  | 注册与注销                                                        | Low    | 协调文件。                                                                                                  |

### Behavioral Scenarios

| #   | Scenario                                         | Expected Behavior                                                                                | Risk   | Evidence                                    | Mitigation                                                                                                     |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| S1  | Real staging `deployments` payload               | target = `b211…` (878f41e), not head `49e5…` (5ceb6e6)                                           | Medium | automated test + runtime plan               | 真实 fixture；drill plan 复验                                                                                  |
| S2  | Real production `deployments` payload            | target = `6195…` (192c3dc), not head `1586…` (4ab7243)                                           | Medium | automated test + runtime plan               | 真实 fixture；production plan 复验                                                                             |
| S3  | Only head is `canRollback`                       | `targetId=""`, reason `only-head-eligible`; rollback step fails loudly                           | High   | automated test + static assertion           | fail closed，不重新部署坏 head                                                                                 |
| S4  | No deployment is `canRollback`                   | `targetId=""`, reason `no-eligible-deployment`; step fails                                       | Medium | automated test                              | 同上                                                                                                           |
| S5  | Empty/malformed `edges`                          | no target, no crash, reason `no-deployments`                                                     | Low    | automated test                              | 纯函数兜底                                                                                                     |
| S6  | Production smoke failure, variable unset         | gate closed, no mutation, `rollback_gated=true`, issue says GATED, job red                       | High   | automated test + static assertion           | 默认关闭；issue 明确要求人工操作                                                                               |
| S7  | Production smoke failure, variable `"true"`      | gate allowed, mutation path runs                                                                 | High   | automated test                              | 只在用户授权后设置变量                                                                                         |
| S8  | Production variable `"TRUE"`/`"1"`/`"yes"`/empty | gate closed                                                                                      | Medium | automated test                              | 精确匹配，拒绝宽松真值                                                                                         |
| S9  | Staging smoke failure, variable unset            | gate allowed, mutation path runs                                                                 | Medium | automated test                              | staging 始终放行                                                                                               |
| S10 | Unknown/empty environment                        | gate closed, reason `unknown-environment`                                                        | Low    | automated test                              | fail closed                                                                                                    |
| S11 | Mutation returns `true`                          | `rollback_executed=true`; issue says succeeded                                                   | Medium | automated test + runtime drill              | drill 真实返回                                                                                                 |
| S12 | Mutation returns `false`/error                   | `rollback_executed=false`; issue says failed; no false success                                   | High   | automated test + static assertion           | 现有布尔判定保留                                                                                               |
| S13 | Drill execute without `confirm=rollback-staging` | rejected before any mutation                                                                     | High   | static assertion + runtime negative control | 输入校验步骤                                                                                                   |
| S14 | Drill execute on production                      | rejected before any mutation                                                                     | High   | static assertion                            | 仅 staging execute                                                                                             |
| S15 | Staging drill execute                            | health SHA target → head; both polls pass; summary records both                                  | High   | runtime-real-data                           | 自动 restore + `always()` 汇总                                                                                 |
| S16 | Restore/health never reaches head                | job red, manual steps in runbook; staging may stay on target                                     | High   | static assertion + human acceptance         | `deploymentRedeploy(headId)`，失败不吞                                                                         |
| S17 | Rollback deployment triggers a new smoke run     | new run does not cancel the run performing rollback/notification                                 | High   | static assertion + runtime drill            | concurrency group 用 deployment id                                                                             |
| S18 | Head itself is a rollback deployment (loop risk) | if `meta.reason` identifies rollback, do not auto-rollback again; otherwise record residual risk | High   | runtime-real-data (observe `meta.reason`)   | 已确认历史部署的 `meta.reason` 全是 `"deploy"`；drill 再观察回滚部署是否不同；未识别则开 follow-up，不在本票猜 |
| S19 | Environment secrets missing                      | `rollback_executed=false`; issue says skipped, not gated                                         | Medium | automated test + static assertion           | 现有 skip 路径保留                                                                                             |
| S20 | Production plan drill                            | read-only; no mutation; prints target and gate state                                             | High   | static assertion + runtime plan             | plan 分支不含 mutation                                                                                         |

## Tickets

| #   | Title                                                           | Blocked by | What it delivers                                                  |
| --- | --------------------------------------------------------------- | ---------- | ----------------------------------------------------------------- |
| T1  | helper：目标选择 + 闸门 + gated payload 纯函数与单测            | None       | 所有决策逻辑可在稳定 seam 上测试；现有 helper 行为不变            |
| T2  | workflow：dispatch 演练 + production 闸门 + concurrency 修复    | T1         | plan/execute 入口、fail-closed 目标选择、gate 输出、静态守卫      |
| T3  | runtime：staging execute 真实回滚 + restore，production plan    | T2         | mutation 第一次真实执行、health SHA 双向切换、production 只读证据 |
| T4  | docs + Linear + roadmap：记录证据、runbook、是否放行 production | T3         | 操作员可复现；AAV-1295 的残余风险明确；由用户决定变量是否打开     |

## Out of Scope

- **不在本票执行 production mutation**。production 只做只读 plan；真实 mutation 由
  闸门保护，是否打开由用户单独授权。
- 不改 smoke test 的四项检查（health / markets / side-data / frontend）。
- 不重写 Railway 的回滚算法（例如按 commit 日期做单调回滚）；如果 drill 观察到
  `meta.reason` 能识别 rollback，再单独加 loop guard。
- 不引入 GitHub Environment required reviewers；用户选择仓库变量。
- 不把 `deploymentRollback` 封装成新的 Node 客户端；继续复用现有 curl/jq 风格。

## Residual Risks

- staging 演练证明的是 staging 的 token/ID/返回形状；production 的 mutation 仍未
  真实执行。production 的读路径（plan）与共享 token 已证明，剩余差异是 production
  专属 secret ID 与项目环境 —— 闸门把这段风险留到人工放行。
- 回滚部署的 smoke test 如果也失败，现有启发式可能把「坏版本」当成下一目标
  （S18）。2026-11-16 的只读查询显示所有历史部署的 `meta.reason` 都是
  `"deploy"`，所以不能靠它识别 rollback；drill 会观察回滚产生的新部署是否仍是
  `"deploy"`。若无法识别，本票只记录风险，loop guard 另开票。
- `deploymentRedeploy` 恢复失败时，staging 可能停在旧版本；runbook 给出手动恢复
  命令，drill 不会把它报成绿。
- `RAILWAY_PRODUCTION_ROLLBACK_ENABLED` 是 repo variable，不进入 git 历史；
  放行记录在 Linear 与本文件的 evidence 段。

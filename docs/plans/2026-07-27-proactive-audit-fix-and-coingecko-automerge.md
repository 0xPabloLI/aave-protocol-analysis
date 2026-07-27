# Spec: Proactive Audit Fix + CoinGecko PR Auto-merge

## Problem Statement

PR #148 (CoinGecko platform map sync) CI 因 `security-audit` 失败而被阻塞。根因是 npm registry 新发布了 `fast-uri`（high）和 `hono`（moderate）的安全公告，这些是 `@modelcontextprotocol/sdk` 的传递依赖，Dependabot 不覆盖传递依赖。

`continue-on-error: true`（commit `a110eb9`）解决了 audit 阻塞 PR 的问题，但引入了新缺口：`ci-auto-remediation.yml` 只在 CI failure 时触发，audit 不再触发它 → 传递依赖漏洞无人修复，静默积累。

同时，CoinGecko sync PR 需要手动 merge，增加了不必要的人工环节。

## Solution

两个互补的自动化机制：

1. **Proactive Audit Fix**（方案 1）：每日定时运行 `npm audit fix`，修复传递依赖漏洞，覆盖 `main` 和 `railway` 两个分支。填补 `continue-on-error` 引入的 reactive gap。
2. **CoinGecko PR Auto-merge**（方案 2）：扩展 `auto-approve-remediation-pr.yml`，对 CoinGecko sync PR 自动审批 + auto-merge。

## User Stories

1. As a maintainer, I want transitive dependency vulnerabilities to be automatically fixed within 24 hours, so that bot PRs (CoinGecko sync, Dependabot) are not blocked by stale audit failures.
2. As a maintainer, I want the proactive audit fix to cover both `main` and `railway` branches, so that neither branch accumulates vulnerabilities during async sync periods.
3. As a maintainer, I want CoinGecko sync PRs to auto-merge when CI passes, so that I don't need to manually merge routine generated-file updates.
4. As a maintainer, I want the proactive audit fix to validate build + audit gate before creating a PR, so that auto-merge doesn't get stuck on a broken PR.
5. As a maintainer, I want unfixable vulnerabilities to remain tracked by existing mechanisms (security-moderate-report, ci-auto-remediation escalation), so that proactive fix failure doesn't create duplicate noise.
6. As a maintainer, I want the `continue-on-error: true` constraint to be documented in an ADR, so that future developers don't remove it and reintroduce the auto-revert loop.

## Implementation Decisions

### Proactive Audit Fix Workflow

- **File**: `.github/workflows/proactive-audit-fix.yml`（新建）
- **Trigger**: `schedule: cron "0 6 * * *"` (daily UTC 06:00, after Dependabot 03:00) + `workflow_dispatch`
- **Matrix**: `["main", "railway"]` — 两个 job 并行，各自独立 PR
- **Steps per branch**:
  1. `checkout` target branch
  2. `setup-node` (Node 20, npm cache)
  3. `npm ci`
  4. `npm audit fix --omit=dev || true`（non-breaking fixes only）
  5. `npm ci`（reinstall to verify lockfile consistency）
  6. `npm run build`（root build verification）
  7. `npm run build -w aave-dashboard-backend`（backend build verification）
  8. `npm run audit`（canonical audit gate — same as CI）
  9. If steps 6-8 all pass AND lockfile changed → create PR via `peter-evans/create-pull-request`
  10. If steps 6-8 fail → silent exit (no issue, no PR)
- **PR branch name**: `bot/proactive-audit-fix-${{ matrix.branch }}`（固定 per branch，`create-pull-request` 会更新已有 PR 而非创建新的）
- **PR labels**: `ci-auto-remediation, dependencies`
- **Concurrency**: `group: proactive-audit-fix-${{ matrix.branch }}`, `cancel-in-progress: false`（不取消正在运行的 job）
- **Permissions**: `contents: write`, `pull-requests: write`

### CoinGecko PR Auto-merge

- **File**: `.github/workflows/auto-approve-remediation-pr.yml`（扩展）
- **New job**: `approve-coingecko-pr`
- **Condition**: `github.event.pull_request.user.login == 'github-actions[bot]' && startsWith(head.ref, 'bot/sync-coingecko-platform-map-')`
- **Allowed files**: `src/generated/coingecko-platform-by-chain-id.ts` only
- **Action**: policy check → approve → enable auto-merge (squash)
- **No CI wait logic**: GitHub required checks automatically gate auto-merge

### Proactive Audit Fix PR Auto-merge

- **File**: `.github/workflows/auto-approve-remediation-pr.yml`（扩展）
- **Extend existing job** `approve-github-actions-pr`: add branch pattern `bot/proactive-audit-fix-*`
- **Allowed files**: `package.json`, `package-lock.json`, `backend/package.json`（same as ci-auto-remediation）

### ADR

- **File**: `docs/adr/0037-proactive-audit-fix.md`（新建）
- **Records**:
  1. `continue-on-error: true` on `security-audit` is a hard constraint — removing it reintroduces the auto-revert loop
  2. Proactive audit fix is a补充层, not a replacement for `continue-on-error` or `ci-auto-remediation`
  3. Matrix covers `main` + `railway` because async sync periods can cause lockfile divergence

## Testing Decisions

- **Test seam**: No new test seam. CI workflow execution is the validation mechanism.
- **YAML validation**: `actionlint` if available; otherwise CI itself validates YAML syntax on push.
- **Audit gate**: `npm run audit` in the workflow step is the same canonical gate used by CI.
- **Build verification**: `npm run build` + `npm run build -w aave-dashboard-backend` in the workflow step matches CI's `build-and-prune` job.
- **Manual verification**: After implementation, trigger `workflow_dispatch` on `proactive-audit-fix.yml` and observe the run.

## Scenario & Risk Verification

### 场景矩阵

| 场景                                              | 输入状态                                                           | Proactive Fix 期望                                     | Auto-approve 期望                          | Auto-revert 期望                  | 风险等级 | 缓解措施                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------ | --------------------------------- | -------- | ------------------------------------------------------------------ |
| S1: 新传递依赖公告发布                            | npm registry 新增 GHSA, `npm audit fix` 可修                       | fix → build pass → audit pass → create PR → auto-merge | approve + enable auto-merge                | 不触发（CI pass）                 | 低       | 设计内行为                                                         |
| S2: 新公告但 no fix available                     | `npm audit fix` 无 diff (如 elliptic)                              | no diff → no PR                                        | 不触发                                     | 不触发                            | 低       | 由 security-moderate-report 跟踪                                   |
| S3: 新公告需 breaking fix                         | `npm audit fix` 有 diff, audit gate 仍失败                         | fix → build pass → audit fail → silent exit            | 不触发                                     | 不触发                            | 低       | 由 ci-auto-remediation escalation 跟踪                             |
| S4: `npm audit fix` 升级导致 build break          | fix → build fail → silent exit                                     | 不创建 PR                                              | 不触发                                     | 不触发                            | 低       | 次日重试；若 npm 修复了上游，自动恢复                              |
| S5: main 和 railway lockfile 差异大               | 两分支独立 fix，结果不同                                           | 各自创建独立 PR                                        | 各自 approve                               | 各自独立                          | 低       | Matrix 设计的期望行为                                              |
| S6: Dependabot 周一先 merge 同一 fix              | Dependabot PR merge → proactive 跑时无 diff                        | no diff → no PR                                        | 不触发                                     | 不触发                            | 低       | `create-pull-request` 基于最新 branch 计算 diff                    |
| S7: CoinGecko PR CI fail (audit)                  | `continue-on-error` → CI overall success                           | N/A                                                    | approve + auto-merge                       | 不触发                            | 低       | `continue-on-error` 保证 audit 不阻塞                              |
| S8: CoinGecko PR CI fail (build)                  | build-and-prune fail → CI failure                                  | N/A                                                    | approve 已提交，auto-merge 不执行          | 触发（push 事件）→ revert         | 中       | CoinGecko workflow 自身有 build 验证，build fail 不会创建 PR       |
| S9: CoinGecko PR 含非生成文件                     | 篡改 PR 含额外文件                                                 | N/A                                                    | policy check fail → skip approve + comment | 不触发                            | 低       | 文件策略检查拦截                                                   |
| S10: proactive PR merge 后 CI build fail          | runner 环境差异导致 build fail                                     | PR 已 merge → push → CI fail                           | N/A                                        | 触发 → revert merge commit        | 中       | 验证步骤与 CI `build-and-prune` 完全一致，环境差异概率低           |
| S11: 有人移除 `continue-on-error`                 | audit fail → CI failure                                            | proactive 可能已修，但窗口期内 CI fail                 | N/A                                        | 触发 → revert → CI 仍 fail → 循环 | 高       | ADR-0037 记录不可移除约束                                          |
| S12: proactive PR merge 后分支被 revert，次日重跑 | revert → 次日 proactive 再跑 → 同样 fix → 同样 merge → 同样 revert | 每日一次有限循环                                       | approve                                    | 每日一次 revert + issue           | 中       | escalation issue 提醒人工介入；与 ci-auto-remediation 相同风险等级 |

### 风险总结

| 风险 ID | 场景                                                             | 严重性 | 缓解措施                                          | 残余风险                                    |
| ------- | ---------------------------------------------------------------- | ------ | ------------------------------------------------- | ------------------------------------------- |
| R1      | S10/S12: proactive PR merge 后 CI build fail → daily revert loop | 中     | 验证步骤与 CI 完全一致；escalation issue 提醒人工 | 与 ci-auto-remediation 相同风险等级，可接受 |
| R2      | S8: CoinGecko PR build fail → auto-revert                        | 低     | CoinGecko workflow 自身有 build 验证步骤          | 极低概率                                    |
| R3      | S5: 两个 proactive PR 竞争                                       | 低     | Matrix 设计，各分支独立                           | 无                                          |
| R4      | S11: `continue-on-error` 被移除 → auto-revert loop 回归          | 高     | ADR-0037 记录约束                                 | 需 code review 把关                         |
| R5      | S12: PR 分支残留                                                 | 低     | `delete-branch: true` + 固定 branch name          | 无                                          |

## Out of Scope

- 方案 3（自动更新排除列表）：用户评估有风险，暂不实施
- 修改 `ci-auto-remediation.yml`：现有 reactive 机制不变
- 修改 `dependabot.yml`：现有 Dependabot 配置不变
- 修改 `security-moderate-report.yml`：现有 moderate 追踪机制不变
- 修改 `ci.yml` 的 `continue-on-error`：保持现状（ADR 记录约束）

## Further Notes

- `peter-evans/create-pull-request` 的 branch name 固定（如 `bot/proactive-audit-fix-main`），如果已有 open PR，会更新而非创建新的。这避免了每日创建新 PR。
- Proactive workflow 的验证步骤与 `ci-auto-remediation.yml` step 115-129 完全一致，确保创建的 PR 能通过 CI。
- CoinGecko workflow 的 `create-pull-request` 未指定 `base`，默认用 default branch（`main`）。CI 的 `pull_request` 触发条件包含 `main`，所以 CoinGecko PR 会触发 CI。

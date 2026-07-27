# ADR-0037: Proactive Audit Fix — `continue-on-error` 约束 + 每日定时修复

## 状态

Proposed

## 上下文

### 问题链

1. npm registry 新发布 `fast-uri`（high）和 `hono`（moderate）安全公告
2. 这些是 `@modelcontextprotocol/sdk` 的传递依赖，Dependabot 不覆盖
3. `ci-auto-remediation.yml` 只在 CI failure 时触发（reactive）
4. commit `a110eb9` 在 `security-audit` job 上加了 `continue-on-error: true`，解决了 audit 阻塞 PR 的问题（如 PR #148），但也导致 audit 失败不再让 CI 整体 failure
5. `ci-auto-remediation.yml` 不再被 audit 问题触发 → 传递依赖漏洞无人修复 → 静默积累

### `continue-on-error: true` 的历史

commit `a110eb9` ("ci: make security-audit non-blocking (continue-on-error) to prevent auto-revert loop") 引入此设置。在此之前，audit 失败 → CI failure → `auto-revert-on-failure` revert 推送的 commit → 形成 revert 循环。`continue-on-error` 解决了这个问题，但引入了 reactive remediation gap。

### 中间尝试：硬门禁恢复

commit `482448b` ("fix: restore security-audit as hard gate + fix vulnerabilities via npm audit fix") 尝试移除 `continue-on-error` 并手动修复了 `fast-uri`/`hono` 漏洞。这在当前漏洞已修复时有效，但 npm registry 是外部不可控系统：

- "no fix available" 公告（如 `elliptic` GHSA-848j-6mx2-7j84）→ audit 持续失败 → CI 阻塞所有 PR → 开发冻结
- "breaking change" 公告（如 `@hono/node-server` GHSA-frvp-7c67-39w9）→ 同上
- 直接 push 到 `main`/`railway` → auto-revert loop 回归

### 最终决策：恢复 `continue-on-error` + proactive fix

保留 `482448b` 的 `package-lock.json` 漏洞修复，但恢复 `continue-on-error: true`。理由：

- `continue-on-error` 不是"忽略安全"，而是"不让外部系统控制开发节奏"
- 真正的安全修复由 Proactive Audit Fix 在 24h 内自动完成
- `482448b` 的手动修复解决了当前漏洞，但不能防止未来新公告造成的冻结

## 决策

### 1. `continue-on-error: true` 是硬约束，不可移除

`ci.yml` 中 `security-audit` job 的 `continue-on-error: true` 必须保留。移除它会：

- 新公告 + no fix available → CI 阻塞所有 PR → 开发冻结
- 新公告 + breaking change → 同上
- 直接 push → auto-revert loop 回归

npm registry 随时可能发布不可修复的公告。`continue-on-error` 是防御性安全网，不是临时权宜之计。commit `482448b` 曾尝试移除它，本 ADR 恢复并确立为永久约束。

### 2. Proactive Audit Fix 作为补充层

新增 `.github/workflows/proactive-audit-fix.yml`，每日 UTC 06:00 运行，matrix 覆盖 `main` 和 `railway` 两个分支。

**层级关系**：

| 层  | 机制                       | 触发       | 覆盖                                  |
| --- | -------------------------- | ---------- | ------------------------------------- |
| 1   | `continue-on-error`        | 每次 CI    | 防止 audit 阻塞 PR + auto-revert loop |
| 2   | Dependabot                 | 每周       | 直接依赖安全更新                      |
| 3   | Proactive Audit Fix        | 每日       | 传递依赖安全更新                      |
| 4   | `ci-auto-remediation`      | CI failure | 其他 CI 失败（build break 等）        |
| 5   | `security-moderate-report` | 每周       | unfixable 公告追踪                    |

Proactive Audit Fix 是层 3，填补层 1 引入的 reactive gap。它不是层 1 的替代品。

### 3. Matrix 覆盖 main + railway

`main` 和 `railway` 在 async sync 期间可能 lockfile 不同步。Proactive fix 各自独立修复，不依赖跨分支 sync。

### 4. 验证门槛与 CI 完全一致

Proactive workflow 的验证步骤（`npm run build` + `npm run build -w aave-dashboard-backend` + `npm run audit`）与 `ci-auto-remediation.yml` 和 CI `build-and-prune` job 完全一致，确保创建的 PR 能通过 CI required checks。

### 5. Failure path 静默

Proactive fix 的 failure path（build fail 或 audit gate fail）不创建 issue。理由：

- unfixable 公告已有 `security-moderate-report`（每周追踪）和 `ci-auto-remediation` escalation 覆盖
- 每日跑 → 每日建 issue = 噪音
- 某天 npm registry 新增 fix 时，proactive 的 success path 会自动创建 PR

## 风险

| 风险                                                    | 严重性 | 缓解                                                                                     |
| ------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| proactive PR merge 后 CI build fail → daily revert loop | 中     | 验证步骤与 CI 完全一致；escalation issue 提醒人工。与 `ci-auto-remediation` 相同风险等级 |
| `continue-on-error` 被未来开发者移除                    | 高     | 本 ADR 记录约束；code review 把关                                                        |
| main/railway lockfile 差异导致 fix 结果不同             | 低     | Matrix 设计的期望行为                                                                    |

## 验证

- [ ] `proactive-audit-fix.yml` workflow 语法正确
- [ ] `auto-approve-remediation-pr.yml` 扩展支持 `bot/proactive-audit-fix-*` branch pattern
- [ ] `auto-approve-remediation-pr.yml` 扩展支持 `bot/sync-coingecko-platform-map-*` branch pattern
- [ ] `docs/ci-security-automation.md` 更新
- [ ] `workflow_dispatch` 手动触发验证 workflow 执行

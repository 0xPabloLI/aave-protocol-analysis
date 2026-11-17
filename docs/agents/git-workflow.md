# Git Workflow

> 在 staging、commit、push、PR、跨分支操作或 context 切换前读取。
> 底本是 `~/Documents/code/agent-harness/core/git-workflow.md`；本文是本 repo 的本地化版本，差异集中在 §2（部署绑定分支 + 并行 session worktree）与 §5（npm registry / Railway 部署门）。

## 1. Safety Baseline

1. 先运行 `git status --short --branch`，再检查本次相关 diff。
2. 未提交和未跟踪内容一律视为用户工作。只操作本 session 创建或修改的内容。
3. 同一文件混有其他工作时，用 `git add -p` 只选择本 session hunk。
4. stage 时显式列路径，不使用 `git add -A` 或 `git add .`。
5. 不通过 restore、reset、clean、checkout 等方式覆盖或删除用户工作。

## 2. Branch 与 Worktree

本 repo 的分支即部署通道：`railway` → staging，`main` → production（PR 合并），详见 AGENTS.md「Deployment」。

- 永远不要在当前工作目录运行 `git checkout` 或 `git switch`——主工作树锁定在 `railway`。
- **写入型并行任务开独立 worktree**（`git worktree add <dir> -b session/<id> railway`），主工作树只留给单一 owner。可预判的并行任务一律走这条，不走应急路径。理由：共享工作目录即共享 index 与工作树，是并行冲突的直接根因。
- 只读查看其他分支用 `git show <branch>:<path>`，不要为查看而切换目录。
- 交付方式二选一：
  - **PR 路径（默认）**：`session/<id>` 分支推远端后开 PR 到 `railway`，由 required checks（`build-and-prune` / `security-audit` / `socket-firewall` / `quality-gates`）把关。
  - **独占窗口路径**：主工作树无人使用时，在 worktree 内 fast-forward 合入 `railway` 再 push（等价于历史单写者习惯）；出现第二个写入者时立即回到 worktree 隔离。
- 添加 worktree 前确认目标目录、branch 名和当前 working tree 状态；任务结束删除 worktree 与 `session/<id>` 分支。

## 3. Stash

- 未经当前对话明确确认，不运行任何 stash 命令。
- 如用户授权暂存，使用带说明的 `git stash push -m "<msg>"`。
- 恢复前先展示 `git stash list`，未经确认不运行 `stash pop/apply/drop/clear`。
- 如果 push 前必须 stash 非本 session 改动，只 commit，不 push。

## 4. Commit Cadence

1. 每个已验证的原子任务立即 commit。原子任务是一个 bug fix、独立 feature slice、机械 migration batch 或文档结构变更。
2. 同一任务后续修复：尚未 push 时优先 amend；已 push 时追加新 commit。
3. 跨任务更正默认创建新的 atomic commit，不 amend 另一个任务。
4. commit 前检查 staged diff 与 staged file list，确保只有本 session 内容。
5. pre-commit hook 修改文件时，复查后只 amend 一次以纳入修复。
6. commit 后立即 `git show --stat HEAD` 核对文件清单只含本任务文件；混入他人文件立即报告，不改写已发布历史来掩盖。

本 repo 环境怪癖（每次提交前确认）：

- `commit.gpgsign=true` 但本机 gpg 不可用 → 使用 `git -c commit.gpgsign=false commit`。
- 本机 npm registry 是 `https://registry.npmmirror.com/`，`npm audit` 端点未实现会让 pre-push 必红 → push 时带 `npm_config_registry=https://registry.npmjs.org`（这不是 `--no-verify` 的替代品，hook 照常执行）。
- 本机 npm 版本与锁文件生成版本不一致时，hook 内的 `audit fix` 会改写 `package-lock.json`（例如剥掉 `libc` 字段）→ push 后检查并 `git checkout -- package-lock.json` 还原。

## 5. Push 与历史

- 新增 commit 使用普通 `git push`；禁止 `git push --force`。
- 历史已发布时一律追加 commit；用户明确要求且历史未发布时才考虑 `--force-with-lease`。
- push 是外部动作，只有用户已授权当前 push 才执行。
- **push 即部署**：push `railway` = 部署 staging，push `main` = 部署 production。确认目标分支再 push，不把 app 代码推到数据库服务（见 AGENTS.md「Manual `railway` CLI use」）。
- 部署是否真的生效要轮询 public host 的 `/health` 里 `commitSha` 核实，CI 失败会让部署被 SKIPPED 而不报错。

## 6. Review-Compatible Baseline

1. 开工前记录 baseline commit。
2. ticket 定向验证通过后 commit。
3. review 开始前记录 `taskHead = git rev-parse HEAD`；`code-review` 比较 `baseline...taskHead`，不使用会被并行 session 移动的裸 `HEAD`。
4. 若 `baseline..taskHead` 含其他 session 的 commit，改用本任务首个 commit 的直接父提交作 baseline；仍无法形成连续区间时停止并报告，不用路径过滤伪装成完整 review。
5. review 修复后重新验证并创建修复 commit，再记录新的 `taskHead`；已 push 时只追加 commit。

## 7. PR Guardrails

本 repo 的门禁细节（required checks 集合、`required_conversation_resolution`、自主合并常设授权、`auto-revert-on-failure` 依赖直推 `main`）以 AGENTS.md「PR Guardrails & Merge Authorization」为准，本节只保留与 core 一致的通用纪律：

- PR 内容只总结相对目标分支的变化；push/open 后不 amend 或 rebase，后续使用新 commit。
- Testing section 只列真正跑过并通过的检查，不写「应当通过」。
- 存在未 resolve 的 review thread（bot 与人一视同仁）时不合并；不为清线程做 cosmetic fix。
- 自主合并的前提四条同时成立：required checks 绿、无未 resolve thread、diff 未超出已授权范围、与 `main` 无冲突。

## 8. Session Boundary

- 只 commit 本 session 的改动；不顺手修复无关或非本 session 引入的问题。
- 无法确认改动来源时停止，向用户报告。
- commit 前检查 `git diff` 与 `git diff --staged`：存在非本 session 的改动时 **STOP**，由用户决定 include / exclude / stash，绝不静默打包他人改动。
- session 结束时记录 commit hash、未 push 状态、验证证据与剩余 blocker。
- **Issue 交付落档与读票**：per-issue 交付记录按 `docs/agents/issue-tracker.md` 的认知卸载表执行——closing comment 落档，不改正文（body 编辑是整体替换，会覆盖其他 session 的内容）；读票按 read-before-claim 三守卫执行。

## 9. 并发 Session 与恢复

同仓库可能有多条 session 写 git。本 repo 2026-11-18 起进入多 session 并行（跨仓实证：aaveapy 共享工作树上两个 session 的 commit 在同一条 `dev` 链上交替落地，一方 pre-commit 的全仓 lint 会因另一方在途改动变红）。规则如下：

1. **写入者独占**是默认规则：写入型并行任务开独立 worktree（§2）。把 `pull --rebase`、`push`、`switch` 留在自己的 worktree 内——在共享目录执行它们会搬走他人未推送的提交。
2. 检测到对方操作进行中（reflog 持续推进、存在 rebase 目录）时等待其停滞，期间不写任何 ref。
3. 竞态应急（提交被并行挤出、或必须在不动共享工作区与 index 的前提下提交）按 `docs/agents/git-concurrent-recovery.md` 的配方执行；该路径绕过 commit hooks，完成后须按配方对齐 index。
4. 目标文件已有非本 session 的未提交改动时，本 session 停止并报告，由用户决定落库顺序。
5. **写 ref 前紧邻复核身份**：`commit` / `amend` / `reset` / `rebase` 前，在同一批命令里先取 `git rev-parse HEAD` 与 `git diff --cached --name-only`，与预期不符即停止并报告；判据取 HEAD 本身（`git status` 在 HEAD 被他人 rebase 后仍显示「干净」）。
6. **Session-Id 纯约定**（本 repo 未安装 session hooks 机器兜底）：commit 可带 `git commit --trailer "Session-Id: <yyyymmdd>-<task>-<6hex>"`，同一 session 用同一 id，amend 不叠加第二个 id；登记表（约定 `$(git rev-parse --git-common-dir)/session-pilot/pilot-log.md`，本地不入库）只放接力状态，不放持久教训与交付细节。

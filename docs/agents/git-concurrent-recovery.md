# Git Concurrent Recovery

> `docs/agents/git-workflow.md` §9 的应急配方。仅在竞态已发生、且无法用 worktree 时加载：对方 session 把你的提交挤出分支历史、或必须在不动共享工作区/index 的前提下完成提交。
> 可预判的并行任务一律走 worktree 规则，不进入本文件路径。
> 底本 `~/Documents/code/agent-harness/core/git-concurrent-recovery.md`；本 repo 未安装 session hooks，Session-Id 为纯约定（见 `git-workflow.md` §9.6）。
> 本配方使用 plumbing，**绕过 commit hooks**：hook 覆盖的 lint/test 必须在事后用同一条命令补跑，Session-Id 必须手写并事后复核。

## 配方 1：临时 index 隔离提交

共享目录被并行 session 占用时，不触碰当前 index 与工作区，直接组装提交：

```bash
BASE=$(git rev-parse <branch>)                        # 记录期望旧值，供 update-ref 比对
GIT_INDEX_FILE=<tmp> git read-tree "$BASE"            # 临时 index，不动共享 index
GIT_INDEX_FILE=<tmp> git add <本任务路径>              # 显式列路径；同文件交叠时不可用（会装入混合内容）
TREE=$(GIT_INDEX_FILE=<tmp> git write-tree)           # 产出树对象
git ls-tree -r "$TREE"                                # 核对只含本任务文件
MSG=$(printf '%s\n\nSession-Id: <your-id>' "<message>")
COMMIT=$(GIT_INDEX_FILE=<tmp> git commit-tree "$TREE" -p "$BASE" -m "$MSG")
git update-ref refs/heads/<branch> "$COMMIT" "$BASE"   # 带期望旧值：他方已推进则失败而不是覆盖
```

要点（均为事故教训，不得省略）：

1. **`update-ref` 必须带期望旧值** `<expected-old>`。不带旧值时，他方在你组装期间推进的 ref 会被静默覆盖。失败退出码非 0，此时等待对方停滞并重新取 BASE。
2. **禁止整表重置共享 index**。`GIT_INDEX_FILE=<tmp> git read-tree` 只写临时 index，安全；对共享 index 执行 `git read-tree HEAD` / `git reset` 会清掉他方已 staged 的内容。确需对齐时先检查：
   ```bash
   git diff --cached --quiet || { echo "STOP: 共享 index 含未提交内容，禁止重置"; exit 1; }
   git read-tree HEAD
   ```
3. **同文件交叠时禁用本配方**：`git add` 会把混合内容装进树。
4. **绕过 hook 的补偿**：`commit-tree` 不触发 commit-msg/pre-commit，本 repo 的 `pre-commit`（build + typecheck + prettier）与 `pre-push`（`ci:remote`）覆盖必须在提交后用同源命令补跑，并把结果写进汇报；trailer 视为手写，提交后立即精确复核：
   ```bash
   git log --all --format='%h%x09%(trailers:key=Session-Id,valueonly,separator=%x2C)%x09%s' \
     | awk -F '\t' -v id="<your-id>" '$2 == id'
   ```
5. 提交后共享 index 仍停留在旧树：`git status` 会出现反向 diff，按第 2 点的检查流程对齐。
6. 该 commit 未过 hook，**不得直接 push 到 `railway`**——push 前在干净 worktree 里至少跑一次 `npm run check:quality` 与 `npm test`，否则 staging/production 会接一个没验证过的头。

## 配方 2：找回被挤出的孤儿提交

自己的提交被并行 amend/rebase 挤出分支历史时内容并未丢失（reflog 可达）。等对方停止后：

1. `git reflog` / `git fsck --lost-found` 定位孤儿 commit sha，`git show --stat <sha>` 确认内容。
2. 按配方 1 在新 HEAD 上重做提交（message 保留，trailer 改为本 session id）。

## 配方 3：从孤儿提交恢复单个文件

不经过工作区，直接把 blob 装进临时 index：

```bash
git rev-parse <orphan-sha>:<path>                   # 取 blob sha
GIT_INDEX_FILE=<tmp> git update-index --cacheinfo 100644,<blob-sha>,<path>
```

随后按配方 1 的 `write-tree` 起继续。

## 配方 4：pathspec 重提（混合 index 场景）

staging 区含他方 staged 改动、而自己的改动在工作区时，**禁止裸 `git commit`**（会把 index 里全部 staged 内容一锅端进你的提交）。用 pathspec commit 只取指定文件的工作区内容：

```bash
git commit <你的文件...> --trailer "Session-Id: <your-id>"
```

注意：untracked 文件不能直接走 pathspec commit，先 `git add <file>` 再列入 pathspec。适用前提：你的文件与他方 staged 文件**不交叠**（同文件交叠回到配方 1）。

交叠判定不能依赖开工时的 `git status`——并行 session 会在你工作期间持续修改共享文件。每次 pathspec 提交前，对每个列入的文件逐 hunk 归属核查：

```bash
git diff <baseline> -- <path>   # 逐 hunk 确认归属；未提交文件用 git diff -- <path>
```

陌生内容 = 外来源 hunk = 同文件交叠，回到配方 1。

本 repo 额外一步：pathspec commit 会触发 pre-commit（全仓 build/typecheck/lint），他方在途改动一红就会挡住提交；此时不要用 `--no-verify` 绕过，改为等对方停滞，或按配方 1 走 plumbing 并在事后补跑门禁。

## 复评触发（不要遗忘项）

本文件是应急路径，每次实际使用后复评一次：

- worktree 纪律稳定执行、竞态未再触发 → 评估降级为 archive 或删除（需求可由 reflog + worktree 覆盖）。
- 反复触发 → 先修 worktree 执行纪律，而不是把应急路径常态化。
- 复评结论写回 session 登记表（`$(git rev-parse --git-common-dir)/session-pilot/pilot-log.md`）。

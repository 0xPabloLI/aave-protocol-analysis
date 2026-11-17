# AAV-1347 — Prettier 纳入 CI 门禁

> **Status: Active** — implementation in progress.
> Ticket: Linear AAV-1347（[Chore] Prettier 未纳入 CI 门禁 → 227 文件漂移的成因，会随时间重新积累）

## Problem Statement

`npm run check:quality`（CI job `quality-gates` 与本地同一套）目前跑 ESLint → syncpack → TODO → jscpd → knip → test-naming → feature-flags → AGENTS.md drift，**没有任何格式检查**。格式化只发生在本地 `lint-staged` 的 pre-commit，且只作用在**被 staged 的文件**上。

结果：一个文件只要不被触碰，它的旧格式就永远存活；等它某天被改到，diff 里就夹带整篇重排。2026-11-10 的 `dc77f32` 一次性归一了 **227 个已跟踪文件**（127 ts / 81 md / 8 mjs / 6 json / …），正是这条缺口积累了三个月的产物。同一天的 prettier `3.8.3 → 3.9.10` 升级又扩大了差异面。没有门禁，`dc77f32` 的收益会随时间归零，下一次规则或版本变化再变成一次「定时炸弹」。

一句话：**格式只在「你碰它的时候」被修，而没人保证将来碰它的人愿意背一篇纯格式 diff。**

## Solution

在 `check:quality` 里加一道 `check:prettier`：对**全部 git 跟踪文件**跑 `prettier --list-different --ignore-unknown`（与 `--check` 同一判定，输出只有不合格文件名，便于直接拼报告），失败时列出不合格文件并给出可执行的修复命令。门禁必须能在**干净 checkout**（fresh clone / CI runner）上通过与报红，不能依赖任何未跟踪文件。

已有行为不动：`.prettierignore` 继续排除两个生成物；`lint-staged` 继续在 pre-commit 修被 staged 的文件（门禁只检查、不写盘）；`.prettierrc` 规则不改。

## User Stories

1. 作为仓库 owner，我希望 CI 在格式漂移进入分支前就拦下它，这样 review 里不会出现纯格式 churn。
2. 作为提交 PR 的 agent，我希望格式门的失败输出直接告诉我「是格式问题、哪几个文件、用什么命令修」，这样我不用翻脚本源码就知道下一步。
3. 作为审查者，我希望 `dc77f32` 这类一次性归一不会随时间重新积累。
4. 作为在干净 clone 上验收的 agent，我希望这道门只依赖 git 跟踪的文件，因为未跟踪文件在 CI 里不存在。
5. 作为本地开发者，我希望 `npm run check:quality` 在格式问题上**快速失败**（prettier 约 4–5s，比 ESLint 快），不必等完整套件跑完才知道。
6. 作为维护生成器的开发者，我希望新增的门禁不会和 `sync-coingecko-platform-map --check` 的逐字节比对互相打架。
7. 作为维护 `.prettierignore` 的人，我希望被忽略的生成物不会让门禁误报。
8. 作为 Windows/含空格路径环境的用户（潜在），我希望文件列表以数组方式传给 prettier，不经过 shell 分词。
9. 作为 CI 维护者，我希望门禁在「一个文件都没检查」时**响亮失败**而不是报告成功，这正是本仓多次修过的假绿灯族（AAV-1294/1330/1349/1352）。
10. 作为排障者，我希望环境错误（不是 git 仓库、prettier 缺失）与格式违规用**不同退出码**区分，这样日志一眼能分辨「工具坏了」还是「代码要格式化」。
11. 作为未来的 agent，我希望 `AGENTS.md` 的质量门表格与实现一致，`check:agents-drift` 能守住这条指针。
12. 作为单人写者，我希望门禁不改变既有提交纪律（直提 `railway`），也不进入 pre-commit 的写入路径。

## Implementation Decisions

### 需要解决的问题（grill 结论）

| #   | 决策                                                                                                  | 理由                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **文件清单来自 `git ls-files -z`**，不扫描目录                                                        | 与 CI/干净 checkout 同源；天然排除 `dist/`、`data/`、`node_modules/`、本地 scratch；`check-agents-drift` 已确立「只相信 fresh clone 会有的文件」这一先例                                      |
| D2  | **tracked symlink 排除**（`lstat` → `isSymbolicLink`）                                                | 本仓有两个：`.agents/skills`、`aaveapy-doc`。显式把符号链接交给 prettier 会报 `Explicitly specified pattern "…" is a symbolic link.` 并 exit 1 ⇒ 永久假红                                     |
| D3  | **索引里有、磁盘上不存在的条目跳过**                                                                  | `git ls-files` 会列出「staged 删除但尚未提交」的路径；prettier 会因 `No such file` 报错。跳过并计数，不当作格式违规                                                                           |
| D4  | **`--ignore-unknown`**                                                                                | 仓库里有 `.sh` / `.sql` / `LICENSE` / `.prettierrc` 等无 parser 文件；不加会 `No parser could be inferred`                                                                                    |
| D5  | **`.prettierignore` 交给 prettier 自己处理**，不手写排除表                                            | 已验证：显式传入 `backend/static/openapi.json` 与 `packages/aave-shared-config/schema-fingerprint.ts` 时 prettier 仍按其 ignore 规则跳过（rc 0）。维护点单一                                  |
| D6  | **调用 prettier 用 execFile 数组 + 分批（200/批）**，不经 shell                                       | 路径含空格/中文不会被分词；459 个文件一次 4.48s，分批只防 argv 上限，不改变语义                                                                                                               |
| D7  | **prettier 二进制可覆写**：`PRETTIER_BIN` 环境变量优先，否则 `node_modules/prettier/bin/prettier.cjs` | 让守卫测试与「干净 clone」验证可以复用主仓库的 node_modules，而不必在 clone 里装依赖（也不让脚本版本与 CI 钉的 `prettier@3.9.10` 漂移）                                                       |
| D8  | **空清单 ⇒ exit 2**，不 exit 0                                                                        | 「一个文件也没检查」却报绿 = 假绿灯族。仓库里不可能没有 tracked 文件，所以这是环境异常                                                                                                        |
| D9  | **退出码分层**：`0` 干净 / `1` 格式违规 / `2` 环境或工具错误                                          | CI 日志与本地排障可区分；与 `check:todo-format` 的「违规 exit 1」一致                                                                                                                         |
| D10 | **失败输出三段**：计数头 + 文件清单 + 修复命令                                                        | 验收要求「失败信息要能直接看出是格式问题」。修复提示给 `npx prettier --write <files>`（门禁本身不写盘）                                                                                       |
| D11 | **接线位置：`check:quality` 第一道门 + `ci.yml` 的 quality-gates 新增一步**                           | prettier 4.5s，是最廉价的失败信号；后面才是 ESLint/jscpd 等重门。CI 的 quality-gates job 是逐条跑命令而不是跑 `check:quality`，所以必须同时加 workflow step，否则「AGENTS.md 说同一套」是假话 |
| D12 | **纯函数抽到 `scripts/lib/prettier-gate.mjs`**，入口只做 I/O                                          | `isDirectRun` 坑（AAV-1335）：测试 import 不得触发真实扫描。纯函数（清单过滤、分批、输出文本）单测；入口行为用子进程验                                                                        |
| D13 | **`format:prettier` 不作为门禁的一部分**，不新增写盘脚本                                              | 修复命令在输出里给；新增自动写盘入口会扩大事故面（本票 out of scope 是「再次全仓格式化」）                                                                                                    |
| D14 | **`.gitignore` 的 `scripts/*` 白名单必须登记新入口与 lib**                                            | 本仓 `.gitignore` 用 `scripts/*` + 逐文件 `!` 白名单；不登记则新脚本只存在于作者机器（AAV-1290 的假绿形态）。由「脚本必须被 git 跟踪」的测试守住                                              |

### 模块与接口

- `scripts/lib/prettier-gate.mjs`（新）
  - `selectFormattableFiles(entries)` — 入参 `{ path, exists, isSymlink }[]`，出参 `{ checkable: string[], skippedSymlinks: number, skippedMissing: number }`
  - `chunkFiles(files, size = 200)` — 纯函数
  - `formatFailureReport({ files, skipped })` — 生成给人读的失败文本
  - `formatEmptyListReport()` / `formatToolingErrorReport(reason)` — 环境错误文本
- `scripts/check-prettier-format.mjs`（新，入口）
  - 解析仓库根（`git rev-parse --show-toplevel`）→ `git ls-files -z` → lstat 分类 → 分批调 prettier → 汇总 → 退出码
- `package.json`
  - `check:prettier` = `node scripts/check-prettier-format.mjs`
  - `check:quality` = `npm run check:prettier && npm run lint && …`（插到最前）
- `AGENTS.md`
  - Core Commands 的 `check:quality` 描述 + Quality gates 表格新增一行（命令、策略）
- `tests/checkPrettierGate.test.ts`（新）
  - 纯函数矩阵 + 真实脚本的子进程行为用例 + 接线守卫

### 不做（Out of scope，与票面一致）

- 再次全仓格式化（当前漂移为 0，本轮实现后由门禁保证）
- 修改 `.prettierrc`
- 把格式化写盘能力接进门禁或 pre-commit

## Testing Decisions

Seams（预先约定）：

1. **纯函数 seam**：`scripts/lib/prettier-gate.mjs` 的导出函数——清单过滤、分批、报告文本。稳定，不需要临时仓库。
2. **入口行为 seam**：`node scripts/check-prettier-format.mjs` 子进程 + 临时 git 仓库 fixture。断言退出码与 stdout/stderr，不触及内部实现。
3. **接线 seam**：`package.json` 的脚本串、`AGENTS.md` 的表格行、`.github/workflows/ci.yml` 的 quality-gates 命令。静态断言，防「加了脚本但没接进门」。

不做 mock：prettier 用仓库真实二进制（`node_modules/prettier`），临时仓库用真实 `git`。这与「依赖外部格式/进程的行为用真实输入」的既有约定一致。

---

## Modified Files Impact

| 文件                                      | 修改内容                                                   | 风险等级 | 评估                                                                                                                                                                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json`                            | 新增 `check:prettier`；`check:quality` 前置该命令          | Medium   | 质量门行为变化：不合格格式现在会红。已在当前树上验证漂移为 0，所以不会让既有 CI 变红。下游消费者是 `quality-gates` job 与本地 `check:quality`，行为单一。最坏后果＝门禁误报导致 PR 卡住；由场景矩阵 S6/S7/S9 与 clean-clone 验证对冲 |
| `AGENTS.md`                               | Core Commands 一行 + Quality gates 表格一行                | Low      | 文档指针；`check:agents-drift` 会验证命令/文件存在。写错会被 drift 门打红而不是静默                                                                                                                                                  |
| `.github/workflows/ci.yml`                | **不改**（`quality-gates` 已调用 `npm run check:quality`） | Low      | 需验证 grep 确实如此，避免「以为接了其实没接」                                                                                                                                                                                       |
| `scripts/check-prettier-format.mjs`（新） | 新入口                                                     | Low      | 纯新增，无既有消费者                                                                                                                                                                                                                 |
| `scripts/lib/prettier-gate.mjs`（新）     | 纯函数模块                                                 | Low      | 纯新增                                                                                                                                                                                                                               |
| `tests/checkPrettierGate.test.ts`（新）   | 守卫测试                                                   | Low      | 纯新增；跑在 root `npm test`（`tests/*.test.ts`）                                                                                                                                                                                    |

## Behavioral Scenarios (Scenario & Risk Verification Matrix)

> 逐类过 `docs/best-practices/scenario-enumeration-checklist.md`：1 Null/Empty、5 失败/降级、6 跨系统键匹配、7 多实体组合、8 跨 step 契约（生成器 vs 门禁）、以及本仓专属的「假绿灯族」。

| #   | Scenario                                                                                         | Expected Behavior                                                                                                                          | Risk                                       | Evidence                                                                                  | Mitigation                                   |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------- |
| S1  | 全部文件已格式化（当前树 / 干净 clone）                                                          | exit 0，`Checking formatting...`                                                                                                           | Low                                        | automated test + runtime smoke（真仓库、fresh clone）                                     | 正向基线                                     |
| S2  | 一个 tracked 文件被故意改坏格式                                                                  | exit 1；输出点名该文件；给出 `prettier --write` 提示                                                                                       | High（这是门禁的全部价值）                 | automated test（临时仓库 subprocess）                                                     | 断言退出码 + 文件名同时在输出里              |
| S3  | tracked 符号链接（`.agents/skills`、`aaveapy-doc`）                                              | 跳过，不进入 prettier；计为 `skippedSymlinks`                                                                                              | High（否则永久假红）                       | automated test（临时仓库建 symlink 并 `git add`）+ clean-clone 实例                       | lstat 判 `isSymbolicLink`；报告里显式计数    |
| S4  | 索引里有、磁盘已删除的条目（staged deletion）                                                    | 跳过；不影响结论                                                                                                                           | Medium                                     | automated test                                                                            | lstat 失败 ⇒ skippedMissing                  |
| S5  | 未跟踪文件格式很糟                                                                               | 不检查、不报红（ci 里根本不存在）                                                                                                          | Medium（干净 checkout 一致性）             | automated test                                                                            | 清单只来自 `git ls-files`                    |
| S6  | `.prettierignore` 内的生成物（`backend/static/openapi.json`、`schema-fingerprint.ts`）被显式传入 | prettier 自行忽略，exit 0                                                                                                                  | High（生成物不跟 prettier 规则走）         | automated test（临时仓库 `.prettierignore`）+ runtime（真仓库）                           | 信任 prettier ignore（D5），不手写排除表     |
| S7  | 无 parser 文件（`.sh` / `.sql` / `LICENSE`）                                                     | `--ignore-unknown` 跳过，不报错                                                                                                            | Medium                                     | automated test                                                                            | 参数固定带 `--ignore-unknown`                |
| S8  | 仓库里一个 tracked 文件都没有（异常环境）                                                        | exit 2 + 「nothing to check」说明                                                                                                          | Medium（假绿灯族）                         | automated test                                                                            | D8；与 AAV-1294/1330/1349/1352 同族防线      |
| S9  | 当前目录不是 git 仓库 / `git` 不可用                                                             | exit 2 + 环境错误说明，不误报格式                                                                                                          | Medium                                     | automated test                                                                            | `rev-parse` 失败 ⇒ 工具错误分支              |
| S10 | `node_modules/prettier` 缺失                                                                     | exit 2，明确「prettier 不可用 + 先 npm ci」                                                                                                | Medium                                     | automated test（把 PRETTIER_BIN 指向不存在的路径）                                        | D7 + 预检 existsSync                         |
| S11 | 路径含空格 / 中文                                                                                | 正常检查，不因分词错位                                                                                                                     | Low                                        | automated test（临时仓库建中文/空格文件名）                                               | execFile 数组，不经 shell                    |
| S12 | 文件名数量增长到 argv 上限                                                                       | 分批调用，语义不变（任一批红即整体红）                                                                                                     | Low                                        | automated test（小 chunkSize 模拟多批）+ 纯函数测试                                       | `chunkFiles`；跨批汇总                       |
| S13 | 多批中仅一批有违规                                                                               | exit 1，只列违规文件（不列干净的）                                                                                                         | Medium                                     | automated test                                                                            | 按批收集输出/退出码，汇总失败文件            |
| S14 | 生成器一致性：`sync-coingecko-platform-map.ts` 输出 vs prettier                                  | 生成物本身通过 `.prettierignore` 或已被格式化，门禁不与之冲突                                                                              | Medium                                     | runtime smoke：`npm run sync:coingecko-platform-map -- --check` + `check:prettier` 同时绿 | 已有生成物在 ignore 表内；不加新的生成器规则 |
| S15 | 接线完整性                                                                                       | `check:quality` 实际包含 `check:prettier`；`check:prettier` 指向真实脚本；CI `quality-gates` job 有一步跑 `check:prettier`；AGENTS.md 命中 | High（「加了没接」是本仓常见形态）         | automated test（静态断言）                                                                | 四条断言 + `check:agents-drift`              |
| S16 | 失败信息可读性                                                                                   | 首行即 `check:prettier` + 计数；随后文件清单；最后修复命令                                                                                 | Medium（验收第 4 条）                      | automated test（断言文本形状）                                                            | `formatFailureReport` 纯函数                 |
| S17 | 与 pre-commit 写入路径的关系                                                                     | 门禁**只读**；`lint-staged` 行为不变；pre-commit 不因本票变化                                                                              | Low                                        | automated test（静态：`.lintstagedrc`/`.husky/pre-commit` 未引用新脚本）                  | 门禁脚本不写任何文件                         |
| S18 | 干净 checkout 上首验（Lessons Learned 硬约束）                                                   | fresh clone + 主仓 node_modules 跑 `check:prettier` ⇒ exit 0；`git clean -xdn` 清单里无本票依赖                                            | High（本仓 quality-gates 曾连挂七个 push） | runtime smoke（`git clone` 到 /tmp + PRETTIER_BIN 指向主仓 + 断言）                       | 脚本只用 `git ls-files`；不读环境特有文件    |
| S19 | 新脚本被 `.gitignore` 的 `scripts/*` 吞掉（只在作者机器存在）                                    | 两个新脚本都在 `git ls-files` 里 ⇒ fresh clone 也有                                                                                        | High（AAV-1290 同族：本地绿、CI 红）       | automated test（`git ls-files` 断言）+ S18 fresh clone 实证                               | D14 白名单 + `check:agents-drift` 双保险     |

## Tickets（tracer bullets）

| Ticket                                    | 交付物                                                                                                                                                                          | Blocked by |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **T1 — 门禁核心**                         | `scripts/lib/prettier-gate.mjs` 纯函数 + `scripts/check-prettier-format.mjs` 入口 + `tests/checkPrettierGate.test.ts` 的 S1–S14/S16 行为用例。先红（脚本不存在 / 行为缺失）→ 绿 | —          |
| **T2 — 接线与文档**                       | `package.json` 的 `check:prettier` / `check:quality`、`AGENTS.md` 两处口径、S15/S17 静态守卫一起翻绿                                                                            | T1         |
| **T3 — 干净 checkout 与生成器一致性验证** | S18 fresh clone 实证 + S14 生成器 `--check` 与门禁同时绿；证据回填 spec                                                                                                         | T2         |

## 当前状态记录

- 开工基线：`git rev-parse HEAD` 记录于 Step 5，审查区间取 `baseline...taskHead`。
- 现状取证：`git ls-files` 461 条，symlink 2 条（`.agents/skills`、`aaveapy-doc`）；对 459 条跑 prettier `--check --ignore-unknown` = rc 0 / 4.48s。

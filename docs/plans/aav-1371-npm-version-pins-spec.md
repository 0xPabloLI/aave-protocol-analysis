# AAV-1371 — 所有 `npm ci` 工作流钉死 npm 版本

> **Status: Active** — implementation in progress.

## Problem

`AGENTS.md` 的 Learned Lessons 已经写明：npm 的锁文件校验跨小版本不稳定（npm 11 的 `install` 会丢弃 `@emnapi/*` 可选链条目，而 `ci` 又要求它们），因此 **CI 和 Dockerfile 里的 npm 版本必须钉死**。但只有 `ci.yml` 与 `ci-auto-remediation.yml` 真正执行了 `npm install -g npm@11.6.2`。

周频的 `test-canary.yml` 直接 `npm ci`，用的是 Node 26 自带 npm。canary 的唯一产物是「hot-path CI 抓不到的 flaky 信号」；如果它自己跑在不同 npm 版本上，一次 `npm ci` 失败会被读成 flaky，噪音持续几周后这个通道就会被习惯性忽略。同一缺口也存在于 `coingecko-platform-sync.yml` 与 `security-moderate-report.yml`。

## Solution

1. 三个缺 pin 的工作流在 `npm ci` 之前补 `npm install -g npm@11.6.2`（与 `ci.yml` / Dockerfile 完全一致）。
2. 新增静态守卫 `backend/tests/workflowNpmPins.test.ts`：任何 workflow 的 job 内出现 `npm ci`（含 `sfw npm ci`），同一 job 中必须更早出现 `npm install -g npm@<version>`；并断言全仓 workflow 与 Dockerfile 的 npm 版本唯一。
3. 把 `AGENTS.md` 的表述从「CI 和 Dockerfile」修正为「所有跑 `npm ci` 的工作流和 Dockerfile」。

## Implementation Decisions

- 版本用字面量 `11.6.2`，与既有 `ci.yml` / Dockerfile 保持一致；不引入 workflow 级 `NPM_VERSION` env。升级时由静态守卫列出所有漂移点，而不是靠人记得住每个文件。
- 静态守卫按 `jobs:` 下的 2 空格 job key 切分作用域；`npm ci` 必须在前一个 job 边界内找到 pin，避免「A job 有 pin、B job 没 pin」被误判为通过。
- 注释行（`#` 开头）不参与匹配，避免 `auto-merge-bot-prs.yml` 里的说明文字造成幻影违规。
- `sfw npm ci` 与 `npm ci --prefix backend` 都是真实安装步骤，必须被同一规则覆盖。

## Scenario & Risk Verification

| #   | 场景                                       | 期望                           |
| --- | ------------------------------------------ | ------------------------------ |
| S1  | 同一 job：pin 在 `npm ci` 之前             | 通过                           |
| S2  | 同一 job：有 `npm ci`、无 pin              | 失败，报 `file:line`           |
| S3  | 同一 job：pin 在 `npm ci` 之后             | 失败                           |
| S4  | pin 在另一个 job，当前 job 只有 `npm ci`   | 失败（作用域按 job 隔离）      |
| S5  | `sfw npm ci`                               | 被识别为安装步骤，遵守同一规则 |
| S6  | `npm ci --prefix backend`                  | 被识别为安装步骤，遵守同一规则 |
| S7  | 注释里出现 `npm ci`                        | 忽略，不产生违规               |
| S8  | 同一 job 多个 `npm ci`，pin 只在最前       | 全部通过                       |
| S9  | 所有 workflow / Dockerfile 的 pin 版本一致 | 通过                           |
| S10 | 某个 workflow 或 Dockerfile 的版本漂移     | 失败，列出所有版本与来源       |
| S11 | 仓库里一个 `npm ci` 都没有（守卫自身失效） | 失败，防止空断言恒绿           |

## Testing Decisions

- 纯函数 `findMissingNpmPins(label, text)` 与 `collectNpmPinVersions(sources)` 放在测试文件内并导出，用内联 YAML 夹具覆盖 S1–S8、S10，避免为测试脚本新建生产模块。
- 真实文件断言覆盖 S9–S11：遍历 `.github/workflows/*.yml` 与 Dockerfile。
- 先写测试并确认在现状下变红（三个 workflow 缺 pin），再补 pin 转绿。

## Out of Scope

- 升级 npm 版本本身（仍为 11.6.2）。
- 把 `npm ci` 之外的安装命令（`npm install`、`npm exec`）纳入守卫。
- 改写 Node 版本策略（所有 workflow 已统一 `26`）。

## Further Notes

- 既有 `backend/tests/ciAutoRemediationWorkflow.test.ts` 已经断言 `ci.yml` 与 `ci-auto-remediation.yml` 的版本一致；本守卫把它推广到全仓，两者不冲突。

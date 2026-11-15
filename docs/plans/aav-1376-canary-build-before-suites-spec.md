# AAV-1376 — canary 先构建再跑套件

> **Status: Active** — implementation in progress.
> 票面：Linear AAV-1376。三个候选修法（A/B/C）的选型结论记在下面「Decision」。

## Problem

`test-canary.yml` 的顺序是 suites（`:54`）→ `Build (timed)`（`:87`）。canary 要跑的五个 suite 都通过包入口消费 workspace 包：

- `@internal/aave-shared-contracts` 的 `exports` 指向 `dist/index.js`，`packages/aave-fetcher` / `rpc-infra` / root `tests/` / `backend/tests` 全部 `import ... from "@internal/..."` ⇒ 解析到 dist；
- `packages/aave-shared-contracts/tests/validation.test.ts` 直接 `from "../dist/index.js"`；
- `packages/aave-fetcher/tests/side-effects.test.ts` 既 `import("../dist/index.js")`，又 `readFileSync("dist/index.d.ts")` 断言类型去重。

干净 checkout 上没有 dist，所以第一个 suite 就 `ERR_MODULE_NOT_FOUND`（run `43694747017`）。`Build (timed)` 的注释把「build 放最后」当成保护（"a timing change can never alter what the suites see"），实际是让 suites 看到一个不存在的构建产物。`ci.yml` 走 `npm run ci`，build 在 test 之前——热路径是对的。

## Decision

**A + C 一起做；B 不是独立选项。**

- **A（必做）**：把 `Build (timed)` 移到 suites 之前。这是唯一能修好 canary 的改动：`@internal/*` 的解析路径固定在 `exports → dist`，不构建就没有出口。
- **B（不做）**：B 想在保住「趋势样本不受 suites 影响」的同时先构建 workspace 包 —— 但 A 之后 `Build (timed)` 仍是独立一步、单独计时，样本语义完全不变，B 只是多跑一次构建。A 与 B 是同一根时间轴的两种排法，不能叠加。
- **C（做，但范围收窄）**：包**自己**的测试不该 import 自己的构建产物。`shared-contracts/tests/` 里三个文件改成 `../src/index.js`（同目录的 `campaign-type` / `fifoEvict` 早已这么写），使 `npm run test -w @internal/aave-shared-contracts` 在无 dist 的干净 checkout 上也能跑。
  - **不能推广到 fetcher**：`side-effects.test.ts` 的第二组用例读 `dist/*.d.ts` 断言类型去重，天然需要构建产物；把它改成 src 会让那组断言失去意义。dist 入口的可导入性由消费方（backend / root / fetcher）覆盖。

## Changes

1. `.github/workflows/test-canary.yml`
   - `Build (timed)` 移到 `Install root dependencies` 之后、`Run full suites` 之前；去掉 `if: always()` 与 `continue-on-error: true`（构建是前置条件，红就该红在这条上，而不是让套件在坏产物上连着红）。`Build duration trend` 的 `if: always() && steps.build.outputs.seconds != ''` 保持不变。
   - 注释改成陈述事实：suites 消费 `dist`，所以构建必须在前；失败归因靠步骤名，不靠猜。
2. `packages/aave-shared-contracts/tests/{validation,crossAssetPairing,netPositionConstraint}.test.ts` — `../dist/index.js` → `../src/index.js`。
3. `backend/tests/testCanaryOrder.test.ts`（新）— 两条静态守卫，见下表。
4. `AGENTS.md` — canary 段落补一句顺序约束与守卫位置（顺序类约定不写在 YAML 注释里）。

## Scenario matrix（`backend/tests/testCanaryOrder.test.ts`）

| #   | 场景                                                             | 期望                                                   |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| O1  | test-canary 里 `Build (timed)` 在 `Run full suites` 之前         | 通过                                                   |
| O2  | 有人把 build 移回 suites 之后                                    | 失败，点名两个步骤的行号                               |
| O3  | build 步骤消失，或被改名成不含 `build` 的名字                    | 失败（步骤缺失）                                       |
| O4  | suites 步骤里少了某个 suite 命令                                 | 失败，列出缺的套件名                                   |
| O5  | `packages/aave-shared-contracts/tests/*.test.ts` 出现 `../dist/` | 失败，列出文件（C 的守卫；该包测试必须能脱离构建运行） |
| O6  | 守卫自己在真实文件上至少解析出 1 个 build 步骤与 5 个 suite      | 失败即证明守卫失效（防空断言恒绿）                     |

解析口径：按 `- name:` 切 step、只在 `run: |` 块内匹配命令；注释行（`#` 开头）不参与。与 `backend/tests/workflowNpmPins.test.ts` 同一套思路，便于日后合并。

## Validation

- 本地先证明「无 dist ⇒ 套件红」：把三个包的 `dist/` 临时移开，跑 `npm run test -w @internal/aave-shared-contracts`，确认 `shared-contracts` 在 C 之后**不再**红（回归前后对比）。
- `npm run test -w aave-dashboard-backend`、`npm run check:quality` 全绿。
- 真实验收靠 canary 本身：push 后 `workflow_dispatch` run 必须整 run 绿，且五个 suite 都出现在 step summary 的表格里（证明没被跳过）。

## Out of Scope

- `railway → main` 晋升（AAV-1292）：main 上仍缺 AAV-1371 的 npm pin，周一定时在晋升前仍会红。
- 把 canary 变成 required check。
- 让 fetcher 的 `side-effects.test.ts` 脱离构建产物（它读 `dist/*.d.ts` 是刻意的）。

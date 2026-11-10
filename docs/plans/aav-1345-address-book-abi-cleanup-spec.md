# AAV-1345 — 升级 aave-address-book 到 4.75.8 并移除冗余的 HUB_EXTENSIONS_ABI

Spec for AAV-1345. Triggered by Renovate PR #190.

## 问题

`HUB_EXTENSIONS_ABI` 是本地补充，存在理由是「上游 `IHubV4_ABI` 当时没有
`getSpokeDeficitRay`」。上游 4.75.8 补上了它，本地补充变成冗余 —— 组合出的
`V4_HUB_FULL_ABI` 里同一个签名出现两次，ethers 打印
`duplicate definition - getSpokeDeficitRay(uint256,address)` 后静默去重。

没有任何守卫发现这件事：`backend/tests/abi-drift.test.ts` 对
`V4_ORACLE_PRICES_ABI` vs `IAaveOracle_ABI` 有一条「本地补充不得与上游重复」
的守卫，Hub 这条路径没有，所以 PR #190 挂出来的是
`actual: 65, expected: 5` 这种看不出所以然的数字。

## 决策

采纳 4.75.8 并清理。依据：

- 4.75.8 发布于 2026-11-03，检查时 7.13 天 —— 通过 ≥7 天冷却期门，且是「≥7 天的
  最新稳定版」（4.76.0 仅 5.46 天，4.77.0 仅 0.71 天）。
- 上游只增不减（+60 / −0），`getAsset`、`getAssetCount`、`getSpokeDeficitRay`
  签名全部未变，无重载函数。
- 实际调用面只有 3 个函数；新增的 60 个（含状态变更函数）不会被调用。
- 消费者全是 backend-only，前端 bundle 不受影响。

`V4_HUB_FULL_ABI` 保留为命名导出并别名到 `IHubV4_ABI`：名字仍然准确（完整的 V4 Hub
ABI 现在就是上游那份），保留名字让「将来上游再缺方法时重新加回本地补充」成为单行改动，
不必再动三个消费者。

## Scenario & Risk Verification

矩阵行直接成为 TDD 测试用例。`abi-drift.test.ts` / `onchainDataService.test.ts` 中
已存在的断言标注为「已有」，本次新增或修改的标注为「新增」/「改」。

| #   | 场景                                                                    | 期望                                                            | 覆盖                                  |
| --- | ----------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------- |
| S1  | `V4_HUB_FULL_ABI` 含 5 个必需函数                                       | 全部存在                                                        | 已有 `abi-drift.test.ts:68-71`        |
| S2  | `V4_HUB_FULL_ABI` 无重复函数名                                          | 重复数 = 0                                                      | **新增**（Hub 路径缺失的守卫）        |
| S3  | `getAsset` 有 17 个 component，名称与顺序不变                           | 与预期数组 deepStrictEqual                                      | 已有 `onchainDataService.test.ts:486` |
| S4  | `getAsset` 的 `underlying` 在 index 12                                  | 位置不变                                                        | 已有 `:502`                           |
| S5  | `getAsset` 的 `deficitRay` 在 index 16（最后）                          | 位置不变                                                        | 已有 `:509`                           |
| S6  | `getAsset` 的 selector 与上游 `IHubV4` 一致                             | selector 相同                                                   | 已有 `:516`                           |
| S7  | `getAssetCount` 签名不变                                                | `() → uint256`                                                  | **改**（原断言是「恰好 5 个方法」）   |
| S8  | `V4_HUB_FULL_ABI` 的函数数 = 上游 `IHubV4_ABI` 的函数数                 | 相等（不再叠加本地补充）                                        | **改** `abi-drift.test.ts:68-76`      |
| S9  | `new utils.Interface(V4_HUB_FULL_ABI)` 无重复定义警告                   | 不打印 `duplicate definition`                                   | **新增**（这是本 issue 的直接症状）   |
| S10 | `getSpokeDeficitRay` encode/decode 往返                                 | calldata 与 selector 正确，decode 回原值                        | **新增**（V4 deficit 读取路径）       |
| S11 | 上游若移除 `getSpokeDeficitRay`                                         | CI 变红                                                         | **新增**（加进 `DRIFT_SPECS.IHubV4`） |
| S12 | 上游若移除 `getAssetCount`/`getAsset`/`getSpokeCount`/`getSpokeAddress` | CI 变红                                                         | 已有 `abi-drift.test.ts:93`           |
| S13 | 将来新增的本地补充若与上游重叠                                          | CI 变红且信息可操作                                             | **新增**（S2 的通用形式）             |
| S14 | 4 个 workspace 的 address-book 声明一致                                 | 同一个 specifier                                                | 已有 `check:syncpack`                 |
| S15 | 锁文件解析到 4.75.8                                                     | 4 个 workspace 全部解析到 4.75.8                                | **改**（锁文件重生成后断言）          |
| S16 | 无残留的 `HUB_EXTENSIONS_ABI` 引用                                      | grep 为空（源码 + 测试；`docs/plans/executed/` 属历史记录不改） | **新增**（手工核对）                  |
| S17 | V4 deficit 读取路径端到端仍可用                                         | `fetchV4ReserveDeficit` 相关测试通过                            | 已有 `onchainDataService.test.ts`     |
| S18 | `IHubV4` 的 `minFnCount` 不落后于实际                                   | 上调到实际值，防止上游收缩                                      | **改** `abi-drift.test.ts:93`         |

## 不做

- 不改 `docs/plans/executed/abi-bridge-layer-hardening.md`：已执行的 plan 是历史记录，
  不重写。其中「已知缺失」的描述由本 spec 承接。
- 不重命名 `V4_HUB_FULL_ABI`：保留名字避免动三个消费者，且名字仍准确。
- 不采纳 4.76.0 / 4.77.0：未过冷却期。

## 验证

| 项                     | 命令                                                     | 结果                                                                                                |
| ---------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| root                   | `npm test`                                               | 63 pass / 0 fail                                                                                    |
| shared-contracts       | `npm run test -w @internal/aave-shared-contracts`        | 109 pass / 0 fail                                                                                   |
| fetcher                | `npm run test -w @internal/aave-fetcher`                 | 401 pass / 0 fail                                                                                   |
| rpc-infra              | `npm run test -w @internal/aave-rpc-infra`               | 49 pass / 0 fail / 26 skip                                                                          |
| backend                | `npx --no-install tsx --test tests/*.test.ts`            | 513 pass / 0 fail / 4 skip（514 → 517 例）                                                          |
| backend 覆盖率门       | `npm run test:coverage -w aave-dashboard-backend`        | 53.55 / 83.28 / 62.23 / 53.55（门 53/80/60/53）                                                     |
| 质量门                 | `npm run check:quality`                                  | 全过（jscpd 2.85% < 5%）                                                                            |
| typecheck              | `npm run test:typecheck -w aave-dashboard-backend`       | 通过                                                                                                |
| **真实链上（运行时）** | `RUN_INTEGRATION=1 ... tests/onchainDataService.test.ts` | 62 pass / 0 fail / 0 skip，aggregate3 打 CORE_HUB 成功                                              |
| selector 一致性        | 脚本比对 canonical signature                             | `getSpokeDeficitRay` `0x21a3bebc`、`getAssetCount` `0xa0aead4d`、`getAsset` `0xeac8f5b8` 全部 MATCH |
| 锁文件副作用           | 与 `HEAD` 逐包比对                                       | 仅 1 个包版本变化（4.57.1 → 4.75.8）                                                                |

RED 阶段证据：升版本后未清理时 `V4_HUB_FULL_ABI` 有 65 条函数、`getSpokeDeficitRay`
重复，ethers 打印 `duplicate definition` 三次，两条新断言失败。

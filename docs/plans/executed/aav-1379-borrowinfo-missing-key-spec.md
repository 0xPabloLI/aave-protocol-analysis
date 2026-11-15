# AAV-1379 — `borrowInfo` 键缺失与 `null` 必须同义

> **Status: Executed (2026-11-15)** — 改动待推 `railway`；本文件随交付一起提交。

## Problem

`packages/aave-fetcher/src/concurrent-fetch.ts`（修复前 :57-59）：

```ts
const isBorrowDisabledByState =
  reserve.borrowInfo?.borrowingState === "DISABLED" ||
  reserve.borrowInfo === null;
```

`buildV3BaseDataset(markets: any[])` 的入参是 `any`，**没有任何约束保证
`borrowInfo` 这个键存在**；GraphQL 侧只承诺它可空（`borrowInfo` 为 nullable 对象，
`node_modules/@aave/graphql` 的 introspection 里 `ofType: null`）。若某次响应**省略键**
而不是显式 `null`：

- `reserve.borrowInfo === null` → `false`（`undefined !== null`）
- 其后 10 处 `reserve.borrowInfo?.x` 全部 `undefined` → `borrowApy` / `liquidity` /
  `borrowed` / `borrowCap` / `protocolFee` / `slopeBelowOptimal` / `slopeAboveOptimal` /
  `optimalUtilization` / `utilizationPct` 一律缺席

⇒ 该 reserve 在 API 上表现为「**可借、但借入侧一个数字都没有**」，而不是「借入已禁用」。
前端拿到的是一条自相矛盾的记录，且没有任何字段能提示这是数据退化。

## 证据边界：这是防御，不是线上故障

2026-11-15 22:42 (+08) 抓取 `https://staging-api.aaveapy.com/api/markets`，441 条 reserve：

| 组                             | 条数 | 说明                                                     |
| ------------------------------ | ---- | -------------------------------------------------------- |
| `borrowDisabled: true`         | 142  | 与 AAV-1378 的基线一致，说明 `=== null` 当前**确实生效** |
| 无任何借入侧数字               | 19   | 与 `NO_BORROW_SIDE_BASELINE = 19` 一致                   |
| 其中 `borrowDisabled !== true` | 1    | Linea `wrsETH`，`isFrozen: true`（协议标记优先，非缺口） |

即：**尚未在 441 条样本里观察到键缺失**。本票定性为「输入是 `any`、判定只覆盖 `null`」
的健壮性缺口。

## Solution

键缺失与 `null` 在这个 payload 里语义相同，所以**只收敛一次**，后续只读这一处：

```ts
const borrowInfo = reserve.borrowInfo ?? null;
```

- `isBorrowDisabledByState` 改用 `borrowInfo?.borrowingState === "DISABLED" || borrowInfo === null`
- 其余 10 处 `reserve.borrowInfo?.` 改为 `borrowInfo?.`（含 `utilizationRate`）

`borrowCap === 1`（V3 的「上限为 1」约定）与 `isFrozen`/`isPaused` 的优先级**不动**。

## Tests

`packages/aave-fetcher/tests/borrowInfoMissingKey.test.ts`，6 例：

1. 键缺失 ⇒ `borrowDisabled === true`，且九个借入侧字段全部 `undefined`（回归本体）
2. 键缺失与 `borrowInfo: null` **deepEqual**（两种形状同义）
3. `borrowingState: "DISABLED"` 仍保留借入侧数字（状态标记 ≠ 数据缺失）
4. 正常可借为对照：`utilizationPct 50` / `borrowApy 0.03` / 九个字段齐全
5. `borrowCap.amount.value === "1"` 仍判禁用（既有语义未受影响）
6. 键缺失 + `isFrozen` ⇒ 保留 `isFrozen`、不产生半套借入侧（对齐线上那 1 条）

**变异验证**：把源码 `git stash` 回退到修复前，仅第 1、2 例变红（`4 pass / 2 fail`），
其余四例是行为不变的对照项 —— 说明这组用例钉住的是契约而不是实现细节。

## Verification

- `npm run test -w @internal/aave-fetcher` → **416 tests / 0 fail**
- `npm run build` → 通过；`npm run test:typecheck -w aave-dashboard-backend` → 通过
- `npm run lint` → **0 error / 289 warning**（与基线一致，未新增）
- `npm run check:test-naming` → 119 files OK

## Residual risks

- `markets` 参数仍是 `any[]`（票面明确 out of scope）：本修复只让「键缺失」不再产生
  矛盾记录，不阻止别的字段继续无声缺席。给入参加类型是独立的一次改动。
- 键缺失至今**没有线上样本**，所以第 1 例的输入形状来自 GraphQL 可空性推断 + 手工构造，
  不是抓到的真实响应。
- 不动 V4 路径：`v4-*` 的借入侧由 spoke/hub 两个来源拼装，判据不同。
- 不对 `protocolFee` 做同类改动：「缺席 = 0」是 AAV-1350 的既定契约
  （`marketsApiSerialize.ts:166`，`marketsApiSerialize.test.ts:699` 钉住）。

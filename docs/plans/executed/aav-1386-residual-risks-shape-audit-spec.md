# AAV-1386 — AAV-1379 残余风险收敛：SDK 输入形状的编译期断言 + 运行时审计

> **Status: Executed (2026-11-16)** — 已提交 `railway`。

## Problem

AAV-1379 交付时留下四条残余风险：

1. **`markets` 仍是 `any[]`**：mapper 读取的十几个键没有任何契约，`borrowInfo`
   之外的字段也可以无声缺席，产出静默降级的记录。
2. **「键缺失」无线上样本**：6 个回归用例的输入是手工构造的，没有证据证明
   这个场景真实存在（或不存在）——沉默既可能是「安全」也可能是「没测到」。
3. **V4 路径未审计**：`canBorrow ?? true`、`status?.frozen === true` 等默认
   全部朝**宽松**方向走——键一旦消失，禁用的 reserve 会被静默放开。
4. `protocolFee` 缺席 = 0（AAV-1350 契约，有意不改）。

## 关键证据：为什么键缺失从未在线上出现

用探针向已安装 SDK 的 fragment 类型发问（`tsc --noEmit` 打印推断类型）：

```ts
type V3Reserve = Market["supplyReserves"][number];
// V3Reserve["borrowInfo"] 推断为
// { __typename: "ReserveBorrowInfo"; apy: {...}; ...; borrowCapReached: boolean } | null
```

**`borrowInfo` 是 fragment 里的必填键（至多 nullable），不是 optional。**
GraphQL 对已选择的可空字段永远显式返回 `null`，不会省略键——所以「键缺失」
在当前 SDK 版本下**结构性不可达**，这解释了 441 条样本里为什么从未观察到。

它变得可达只有一条路径：**SDK 升级把字段从 fragment 里删掉或改名**。那正是
需要门禁的地方。

## Solution

新增 `packages/aave-fetcher/src/reserve-shape.ts`，两层收敛，不动 mapper 语义：

### 1. 编译期：键列表 `satisfies keyof` 钉死 SDK fragment

```ts
export const V3_RESERVE_KEYS = [
  "underlyingToken",
  "aToken",
  "vToken",
  "size",
  "supplyInfo",
  "borrowInfo",
  "isFrozen",
  "isPaused",
  "usdExchangeRate",
] as const satisfies readonly (keyof V3Reserve)[];
```

- V3 market 4 键、V3 reserve 9 键（mapper 读取的全部顶层字段）、
  V4 reserve 8 键（`spoke/chain/asset/summary/settings/status/canBorrow/canSupply`）。
- SDK 升级删字段 → `npm run build` 在这个文件红，而不是生产读 `undefined`。
- 已实测：三组键全部通过（即 mapper 读取的键都在 fragment 里声明且必填）。

### 2. 运行时：每轮 fetch 审计实际收到的 payload

`buildV3BaseDataset` 开头、V4 映射循环前各挂一次 `runShapeAudit`：

- **干净**：每进程每 scope 打一行 info
  `🔎 [V3.reserve] reserve shape ok: 441/441 carried … (present-but-null: borrowInfo=18)`
  ——这是「审计确实跑了」的**正向证据**，不是靠沉默自证。
- **漂移**：每个 fetch 周期都 warn，带缺失计数和至多 5 个
  `SYMBOL:address` 样本；warn 永不 dedupe。
- 审计是**纯观察**：`undefined` 值的键算 missing（mapper 读出来就是 undefined）、
  非对象行算全缺、绝不抛错——payload 再烂，映射行为与改动前逐字节一致。

### 3. 四条残余风险的归宿

| 残余风险                  | 处置                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. `any[]` 无契约         | **关闭**：编译期键断言 + 运行时审计。注意这是**观测层**收敛，签名仍 `any[]`（改成 SDK 类型会强迫测试 fixture 变成完整 `Market`，收益不成比例） |
| 2. 键缺失无线上样本       | **关闭**：从「无法证明」变成「每轮自证」——部署后第一轮 fetch 就会打出 shape ok 行；若真的发生键缺失，warn 会带着样本出现在生产日志里           |
| 3. V4 未审计              | **关闭**：V4 与 V3 同一套审计；`canBorrow` 等 8 键已钉进 fragment 类型                                                                         |
| 4. `protocolFee` 缺席 = 0 | **不改**（AAV-1350 契约，`marketsApiSerialize.test.ts` 已钉）                                                                                  |

## Validation

- `reserveShapeAudit.test.ts`：**17 例 / 0 fail**。覆盖：
  - 纯函数（null 与 missing 分开计数、非对象行不抛、样本封顶 5、label 透传）；
  - **接线证明**（本仓反复出现的「文件存在 ≠ 真的在跑」）：真实调用
    `buildV3BaseDataset`，断言 warn 提到 `isFrozen on 1/2` 与 token 样本、
    market 缺 `chain` 落在 `[V3.market]` scope——审计不是死代码；
  - 日志策略（干净每进程一次、漂移每次都打、空 payload 不打）；
  - 键列表运行时快照（防止列表与 mapper 读取集悄悄失同步）。
- **变异验证**（红验证）：
  1. `git stash` 整体回退 `src/` → **3 fail**（全部 wiring 用例红）；
  2. 把 `record[key] === undefined` 判定改成恒 false → **4 fail**（undefined-as-missing
     语义与 nullish 统计的用例红）；
  3. 恢复后 17/17 绿。
- 编译期断言本身：三组 `satisfies` 在 `tsc --noEmit` 下通过（V3 9 键、
  V3 market 4 键、V4 8 键），负向验证靠 build 时 SDK 类型即真相源。
- 门禁：`npm run test -w @internal/aave-fetcher` → **433 tests / 0 fail**；
  `npm run build` → 通过；`npm run lint` → **0 error / 289 warning**
  （与基线持平，一度新增 1 个未用 import warning，已补用例消掉）；
  `check:test-naming` → 120 files OK。

## Out of Scope

- mapper 语义不变：`borrowInfo` 键缺失仍按 AAV-1379 收敛为「无借入侧」，
  V4 宽松默认保留（改成「缺席即禁用」会把真实可借资产藏起来，方向反了）。
- 不把 `markets: any[]` 换成 SDK 类型：测试 fixture 会被迫变成完整 `Market`
  字面量；契约已由键断言承担。
- `protocolFee` 不动（AAV-1350）。

## Residual risks

- **info 行只证明一次**：每进程只打一行 shape ok；若某轮 payload 开始漂移，
  warn 每周期出现（不会漏），但「无 warn」本身对中间周期不再是逐轮证据。
  权衡：逐轮 info 一年约 10 万行日志，不值。
- **编译期断言依赖 SDK 类型与文档一致**：若上游类型与实际返回漂移（类型说有、
  实际没有），运行时审计是兜底——两层是互补，不是冗余。
- **审计只覆盖顶层键**：嵌套路径（`borrowInfo.apy.value`）的缺失仍走
  `?.` 静默降级；数值字段的整块缺失由 AAV-1378 的 API 层原子性断言兜住
  （`ALWAYS_PRESENT` 每条必查、borrow 侧要么整块在要么整块不在）。

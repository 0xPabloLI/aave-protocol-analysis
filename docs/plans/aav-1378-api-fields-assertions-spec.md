# AAV-1378 — 让 API fields 断言真正可执行、且断言对的语义

> **Status: Implemented** — 已推 `railway`；staging 实测 7/7。

## Problem

`backend/tests/apiFieldsVerification.test.ts` 的三条断言只在
`RUN_API_FIELDS_TESTS=true` 时执行，而这个变量**全仓只有 `test-canary.yml` 与
`npm run test:api-fields` 会设**。canary 在 AAV-1376 之前到不了测试阶段，AAV-1376
之后第一次跑到，立刻红了两条（run `43698501475`）：

```
✖ snapshot version is markets-v3
    Expected version 'markets-v3' but got 'snapshot-v3'
✖ new field names present in at least 90% of reserves
    Field 'protocolFee' only present in 85% of reserves (377/441). Expected >= 90%
```

即：这组断言在 CI 里**从未执行过一次**，漂移了没人知道。这是「文件存在 ≠ 真的在跑」
的又一例，只不过这一层是「测试文件在、也会被 glob 到，但环境变量把断言关掉了」。

## 定性：不是数据缺口，是断言口径写错了

最初怀疑「`protocolFee: 0` 被真值判断丢掉」。**这个假设是错的**，实测与仓内外契约都否掉它：

- `aaveapy/src/types/aave.ts:175`：`// Absent protocolFee means 0: the API omits falsy values (AAV-1350)`
- `aaveapy/docs/rate-calculation.md:35`：`protocolFee … **absent = 0** (AAV-1350)`
- `backend/tests/marketsApiSerialize.test.ts:699`：`protocolFee zero is omitted` —— 行为已被单独钉住

所以 `marketsApiSerialize.ts:166` 的真值判断是**有意为之的契约**，不改。

staging 441 条 reserve 实测分布（`/tmp` 单次抓取）：

| 组     | 条数 | 特征                                                                      |
| ------ | ---- | ------------------------------------------------------------------------- |
| 正常   | 377  | borrow 侧齐全，`protocolFee` 存在                                         |
| 部分   | 45   | borrow 侧**除 `protocolFee` 外全齐**，`protocolFee` 恰好为 0 → 按契约省略 |
| 整块缺 | 19   | borrow 侧全无；`borrowDisabled` 18 条为 `true`、1 条 `isFrozen`           |

各组字段覆盖率：

| 字段                                                                                                      | 441 条中占比 |
| --------------------------------------------------------------------------------------------------------- | ------------ |
| `supplied` / `supplyCap` / `baseBorrowRate` / `ltv` / `liquidationThreshold`                              | 100%         |
| `borrowApy` / `borrowCap` / `borrowed` / `liquidity` / `slopes` / `optimalUtilization` / `utilizationPct` | 396 (89.8%)  |
| `protocolFee`                                                                                             | 377 (85.5%)  |

`borrowApy` 等「89.8%」不是漂移：19 条整块无借入侧是 SDK 返回 `borrowInfo: null`（协议
层面关掉了借入），`concurrent-fetch.ts` 的 `isBorrowDisabledByState` 正是这样判定的。
把「supply 侧必有字段」和「borrow 侧条件字段」套同一个 90% 阈值，指标本身就无意义。

## Solution

1. **版本单一真值**：`MARKETS_API_VERSION` 从 `controllers/marketsController.ts` 移到
   `src/types/index.ts`（纯类型模块），`MarketsResponse.snapshot.version` 改为
   `typeof MARKETS_API_VERSION`，controller 从 types 导入并 `export {}` 保持既有引用。
   版本断言改为读常量。
   - 顺带修掉一个隐性缺陷：`marketsVersionBump.test.ts` 原先 `import` controller，会拉起
     `marketsService → @aave/client-v4`，其 `.d.ts` 在 tsx 下单跑解析失败
     （`ERR_MODULE_NOT_FOUND`）。它此前「绿」只是因为在全量里别人先加载了模块。改读
     `types/` 后单跑也绿。
2. **四条语义断言**取代那个 90% 覆盖率：
   - supply 侧（`ALWAYS_PRESENT`）在**每一条** reserve 上都在；
   - borrow 侧（`BORROW_SIDE`）**要么整块在、要么整块不在**（都来自 `borrowInfo`，半块即映射漂移）；
   - 整块不在时必须由协议状态解释（`borrowDisabled` / `isFrozen` / `isPaused` / `isActive === false`），
     否则视为数据缺口；
   - `protocolFee` 存在时必须是 0..100 的有限数（absent 按契约视为 0，不参与存在性断言）。
3. **防复发**：同一文件内加静态守卫 —— 源码里不得出现
   `"markets-vN"` / `"snapshot-vN"` 形式的版本字面量，只能读常量。
4. **单次快照**：五个断言原先各自 `curl` 一次，可能落在不同快照上，且 staging 抖一下只有
   后几条红。改为模块级 lazy 缓存，一次运行一个快照。

## Scenario matrix

| #   | 场景                                                                                       | 期望                       |
| --- | ------------------------------------------------------------------------------------------ | -------------------------- |
| F1  | 实现在版本常量里改名                                                                       | 断言跟随常量，不红         |
| F2  | 测试里写死任一 `*-vN` 版本字面量                                                           | 静态守卫红                 |
| F3  | 某 reserve 缺 `supplied` / `supplyCap` / `baseBorrowRate` / `ltv` / `liquidationThreshold` | 红，列出 `reserveId:field` |
| F4  | borrow 侧只出现一部分                                                                      | 红，点名缺哪几个字段       |
| F5  | 整块无 borrow 侧且无任何协议状态标记                                                       | 红（数据缺口）             |
| F6  | `protocolFee` 存在但越界/非数                                                              | 红                         |
| F7  | `protocolFee` 为 0 且被省略                                                                | 绿（契约）                 |
| F8  | 一次运行里快照被替换                                                                       | 不可能：只抓一次           |

## Validation

- staging 实测（`API_FIELDS_TEST_URL` 指向本地快照 `http://127.0.0.1:8899/m3.json`，
  441 条）：**7 pass / 0 fail**；对真实 `staging-api` 亦为 7/7。
- 红验证：把 `supplyApy` 临时塞进 `ALWAYS_PRESENT` → 精确报
  `132 missing supply-side field(s) out of 441 reserves`，证明断言非恒真。
- `marketsVersionBump.test.ts` 单跑：改前 `ERR_MODULE_NOT_FOUND`，改后 1 pass。
- backend 全量 `557 pass / 0 fail / 7 skip`；`test:typecheck` 通过；`npm run lint` 0 errors；
  `npm run check:quality` exit 0。

## Out of Scope

- 改 `absent = 0` 契约或 `marketsApiSerialize.ts` 的 `protocolFee` 判断 —— 契约是既定事实。
- 改 fetcher 对 `borrowInfo === null` 的处置。
- 把 `RUN_API_FIELDS_TESTS` 接进热路径 CI（会每次 push 打真 API，保持周频 canary）。

## Further Notes

- `RUN_API_FIELDS_TESTS` 这种「环境变量关掉断言」的形态本身就不可发现：测试文件绿、
  覆盖率统计也把它计入跳过。当前唯一能发现它的机制是 canary 真的跑到它 —— 也就是本票
  为什么只能在 AAV-1376 之后才暴露。
- 遗留风险：staging 不可达时这 7 条会全红（单次快照的必然结果）。这是正确行为（数据源
  不可用就是信号），但在 canary 上会与 flaky 混在一起，读数时要先看 `Failed to fetch`。

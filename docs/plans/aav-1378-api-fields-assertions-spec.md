# AAV-1378 — 让 API fields 断言真正可执行、且断言对的语义

> **Status: Implemented, not pushed** — 本地与 staging 各 7/7；待 push + `workflow_dispatch` 补 run 读数。

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

最初怀疑「`protocolFee: 0` 被真值判断丢掉」。**这个假设是错的**，仓内外契约都否掉它：

- `aaveapy/src/types/aave.ts:175`：`// Absent protocolFee means 0: the API omits falsy values (AAV-1350)`
- `aaveapy/docs/rate-calculation.md:35`：`protocolFee … **absent = 0** (AAV-1350)`
- `backend/tests/marketsApiSerialize.test.ts:699`：`protocolFee zero is omitted` —— 行为已被单独钉住

所以 `marketsApiSerialize.ts:166` 的真值判断是**有意为之的契约**，不改。

staging 441 条 reserve 实测分布（2026-11-15 单次抓取）：

| 组     | 条数 | 特征                                                           |
| ------ | ---- | -------------------------------------------------------------- |
| 正常   | 377  | borrow 侧齐全，`protocolFee` 存在                              |
| 部分   | 45   | borrow 侧**除 `protocolFee` 外全齐**；`protocolFee` 按契约省略 |
| 整块缺 | 19   | borrow 侧全无，全部 V3，SDK 侧 `borrowInfo: null`              |

各组字段覆盖率：

| 字段                                                                                                      | 441 条中占比 |
| --------------------------------------------------------------------------------------------------------- | ------------ |
| `supplied` / `supplyCap` / `baseBorrowRate` / `ltv` / `liquidationThreshold`                              | 441 (100%)   |
| `borrowApy` / `borrowCap` / `borrowed` / `liquidity` / `slopes` / `optimalUtilization` / `utilizationPct` | 422 (95.7%)  |
| `protocolFee`                                                                                             | 377 (85.5%)  |

旧阈值只红在 `protocolFee` 一项：borrow 侧 95.7% 本来就过线。也就是说旧断言的错误不是
「把 supply 与 borrow 混算导致 borrow 侧红」，而是**把一个按契约省略的字段当成缺失**；
而 19 条整块无借入侧虽然过了 90%，却不是因为它「够 90%」，而是因为阈值对语义一无所知。

## Solution

1. **版本单一真值**：`MARKETS_API_VERSION` 从 `controllers/marketsController.ts` 移到
   `src/types/index.ts`（纯类型模块），`MarketsResponse.snapshot.version` 改为
   `typeof MARKETS_API_VERSION`，controller 改为普通 import。版本断言读常量。
   - 顺带修掉一个隐性缺陷：`marketsVersionBump.test.ts` 原先 `import` controller，会拉起
     `marketsService → @internal/aave-fetcher → @aave/client-v4`，其 `.d.ts` 在
     `npx tsx --test backend/tests/marketsVersionBump.test.ts` 下单跑报
     `ERR_MODULE_NOT_FOUND`。它此前「绿」只是因为在全量里别人先加载了模块。改读
     `types/` 后单跑也绿。
2. **四条语义断言**取代那个 90% 覆盖率：
   - 必有字段（`ALWAYS_PRESENT`）在**每一条** reserve 上都在；
   - borrow 侧（`BORROW_SIDE`）**要么整块在、要么整块不在**（半块即映射漂移）；
   - **无借入侧的 reserve 数量不得超过基线 19**（`KNOWN_BORROW_SIDE_ABSENT`）；
   - `protocolFee` 存在时必须是 0..100 的有限数（absent 按契约视为 0，不参与存在性断言）。
3. **防复发**：同一文件内加静态守卫 —— 源码里不得出现带引号/反引号的 `<slug>-vN`
   版本字面量，只能读常量。范围限本文件（`marketsVersionBump.test.ts` 故意钉字面量，
   bump 时必须一并改）。
4. **单次快照**：三条 gated 断言原先各自 `curl` 一次，可能落在不同快照上，且 staging
   抖一下只有后几条红。改为模块级 lazy 缓存，一次运行一个快照。
5. **canary 目标对齐**：测试默认打 staging，而 schedule 只在 `main`（= production）上跑。
   `test-canary.yml` 现在按 `GITHUB_REF` 选目标（main → production，其余 → staging），
   否则 railway 先 bump 版本时，周一的 main run 会在完全正确的代码上红。

### 为什么不用「按有无 borrow 侧分组算覆盖率」

票面原话是「borrow 侧 over 有 borrow 侧的 reserve」。要这么做，得先能**独立判定**「有
borrow 侧」，而 API 上唯一的候选判别式 `borrowDisabled` 不成立：实测 441 条里 124 条
**同时**有完整 borrow 侧且 `borrowDisabled: true`（V3 的 `borrowCap === 1` 也会置真），
18 条无 borrow 侧也靠它。用它分组会把 124 条有借入侧的 reserve 归进「无借入侧」。
既然没有独立判据，覆盖率分组只能退化成「用缺失解释缺失」，因此改用**原子性 + 数量基线**
—— 前者抓部分块，后者抓整块静默消失。

## Scenario matrix

| #   | 场景                                                                                       | 期望                                                       |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| F1  | 实现在版本常量里改名                                                                       | 断言跟随常量，不红                                         |
| F2  | 测试里写死带引号的 `<slug>-vN` 版本字面量                                                  | 静态守卫红                                                 |
| F3  | 某 reserve 缺 `supplied` / `supplyCap` / `baseBorrowRate` / `ltv` / `liquidationThreshold` | 红，列出 `reserveId:field`                                 |
| F4  | borrow 侧只出现一部分                                                                      | 红，点名缺哪几个字段                                       |
| F5  | 无借入侧的 reserve 数量超过基线                                                            | 红，列出 reserveId，提示「协议关借入就抬基线，否则是丢块」 |
| F6  | `protocolFee` 存在但越界/非数                                                              | 红                                                         |
| F7  | `protocolFee` 为 0 且被省略                                                                | 绿（契约）                                                 |
| F8  | 一次运行里快照被替换                                                                       | 不可能：`markets()` 只抓一次                               |

## Validation

- staging 快照（`API_FIELDS_TEST_URL` 指向 `http://127.0.0.1:8899/m3.json`，441 条）：
  **7 pass / 0 fail**；对真实 `staging-api` 亦为 7/7。
- 红验证 1：把 `supplyApy` 临时塞进 `ALWAYS_PRESENT` → 精确报
  `132 missing field(s) out of 441 reserves`。
- 红验证 2：把基线临时改成 18 → 精确报
  `19 reserve(s) have no borrow side, up from the recorded 18` 并列出 reserveId。
- 守卫不自匹配：读自身源码跑 `["'\`][a-z][a-z-]*-v\d+["'\`]` 为 false。
- `test-canary.yml` 片段：PyYAML 解析出 9 个 step、`bash -n` 通过；
  `GITHUB_REF=refs/heads/main` → production URL，`refs/heads/railway` → staging URL。
- `marketsVersionBump.test.ts` 单跑：改前 `ERR_MODULE_NOT_FOUND`，改后 1 pass。
- backend 全量 `557 pass / 0 fail / 7 skip`；`test:typecheck` 通过；`npm run lint` 0 errors；
  `npm run check:quality` exit 0。

## Out of Scope

- 改 `absent = 0` 契约或 `marketsApiSerialize.ts` 的 `protocolFee` 判断 —— 契约是既定事实。
- 改 fetcher 对 `borrowInfo === null` 的处置。
- 把 `RUN_API_FIELDS_TESTS` 接进热路径 CI（会每次 push 打真 API，保持周频 canary）。

## Residual risks

- **基线会漂**：新增一个关借入的市场就会让 F5 红。这是有意的（要人确认是协议行为还是
  丢块），代价是周频 canary 偶尔需要抬一次基线。
- **`protocolFee` 定性只到契约层**：三条外部证据证明「缺席 = 0」和「序列化器省略 0」，
  但**没有**证明那 45 条的 upstream `reserveFactor` 真的是 0 —— API 层把 `undefined` 与
  `0` 都省略成同一形状。若某条实为 `undefined`，前端按 0 算会高估 supply APY。要闭合
  这条得在 fetcher 层取证，本票未做。
- **V3 的 `null` 与 `undefined` 仍未区分**：`concurrent-fetch.ts` 把
  `borrowInfo === null` 当作「协议关借入」，但 `borrowInfo` 整个键缺失（`undefined`）走
  的是同一条分支，表现为「有借入侧标记缺失」。区分这两者需要在 fetcher 加计数，另开票。
- staging / production 不可达时这 7 条会全红（单次快照的必然结果）。这是正确行为，但与
  flaky 混在一起，读 canary 时先看 `Failed to fetch`。

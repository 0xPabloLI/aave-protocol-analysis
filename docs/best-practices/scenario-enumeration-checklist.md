# Scenario Enumeration Checklist

> 每次 `grill-with-docs` 阶段逐类检查。产出直接进入 spec 的 **Scenario & Risk Verification Matrix**，矩阵行成为 TDD 测试用例。
>
> 参照 `docs/memory-leak-checklist.md` 模式：AGENTS.md 引用 → 专项 checklist 提供可操作细节。

## 用法

1. Grill 阶段：逐类过一遍"要问的问题"，确保每类都有明确答案。
2. Spec 阶段：将确认的边界场景写入 `Scenario & Risk Verification Matrix`，每行标注风险维度。
3. TDD 阶段：矩阵行 = 测试用例，先写测试（red）再实现（green）。

---

## 1. Null / Undefined / Empty 边界

**要问的问题**：

- 所有 optional 字段为 `undefined` 时行为是否定义？
- 空数组（`[]`）、空 Map（`new Map()`）、空字符串（`""`）是否独立测试？
- `0` vs `null` vs `undefined` 的语义差异是否处理？
- `?? null` 是否吞掉了 `0` / `false` / `""`？

**常见陷阱**：

- `value ?? defaultValue` 在 `value = 0` 时也走 fallback——对数值字段是 bug。
- API 字段 omit `undefined` / 空数组（AGENTS.md 规则），消费方需处理字段缺失。
- `null` 表示"明确无值"（如无债务时 HF = null），`undefined` 表示"未提供"——不可互换。

## 2. 数值精度

**要问的问题**：

- WAD / RAY 转换是否走 `@internal/aave-shared-contracts/units.ts` 统一入口？
- 浮点比较是否用 `|delta| < epsilon` 而非 `===`？
- `bigint` 运算是否安全溢出（如 `2n ** 256n - 1n`）？
- `raw`（base units）vs `value`（human-readable）vs USD 是否区分清楚？

**常见陷阱**：

- `raw === "1"` 是 1 wei（10⁻¹⁸），不是 1 token。`value === 1` 才是 1 whole token。
- `Number(wad) / 1e18` 在大数时丢精度——应拆为 `Number(wad / WAD) + Number(wad % WAD) / Number(WAD)`。
- `max uint256`（无债务）→ `null`，不能当 `Infinity` 或超大数字处理。
- V3 `healthFactorWad` 和 V4 `healthFactor` 都是 WAD 精度，但字段名不同。

## 3. 状态转换

**要问的问题**：

- 组件 mount / unmount 期间的异步操作是否处理（竞态 / 内存泄漏）？
- wallet connect → disconnect → reconnect 的状态流转是否完整？
- mode toggle（APY/APR、Portfolio/Shared）期间的中间态是否有数据残留？
- React Query stale / fetching / error 状态的组合是否覆盖？

**常见陷阱**：

- 异步操作完成后组件已 unmount → setState on unmounted component。
- mode toggle 后旧 mode 的 React Query cache 未清理 → stale data 渲染。
- wallet disconnect 后 on-chain data 未清空 → 残留 HF 显示。

## 4. 并发 / 竞态

**要问的问题**：

- React Query 的竞态是否自动处理（query key 变化时旧 query 自动 cancel）？
- stale data 是否会覆盖 fresh data（staleTime 配置是否合理）？
- 多个并发请求是否共享连接池（`maxSockets` / `maxFreeSockets`）？
- 是否有 AbortController 在组件 unmount 时取消请求？

**常见陷阱**：

- `maxSockets` 限制并发连接，但 `maxFreeSockets` 默认 256 导致空闲 socket 累积泄漏。
- Promise 无 AbortController → 组件 unmount 后请求仍在飞，完成后 setState on unmounted。
- `Promise.all` 中一个 reject 导致整体 fail → 应用 `Promise.allSettled` 做部分降级。

## 5. 失败 / 降级

**要问的问题**：

- RPC / 外部 API 失败时降级路径是否定义？
- 部分失败（如 3 个 pool 中 1 个 RPC 失败）是否保持其余数据？
- 外部 API 的超时 / 429 / 5xx / 网络断开是否分别处理？
- 降级后返回的数据结构是否与非降级一致（消费方无需感知差异）？

**常见陷阱**：

- 降级返回 `undefined`，消费方未处理 → crash。应返回结构一致的数据（字段为 `null`）。
- 部分失败时整体 throw → 应 try-catch per-item，保留成功的部分。
- SDK 失败时 RPC fallback 的数据格式可能与 SDK 不一致（字段名、精度）。
- V4 SDK fallback 到 RPC 时，`"Unknown"` 字段不应写入 stale cache（污染）。

## 6. 跨系统键匹配

> **P7 命名不匹配事件的根因类别。** 两个命名系统的 key 格式不一致导致 Map 查找永远 miss。

**要问的问题**：

- 两个系统的 key 格式（分隔符、大小写、前缀）是否一致？
- key 的大小写敏感性是否处理（`toLowerCase` vs `normalizeAddress`）？
- 命名约定差异是否识别（address-book raw key `MAIN_SPOKE` vs SDK spoke name `Main`）？
- 是否有 canonical key（如链上地址）可绕过命名差异？
- key 构造逻辑是否集中在一处（共享函数），还是散落在多个模块各自实现？

**常见陷阱**：

- `toLowerCase()` 用于地址不够规范——应使用 `normalizeAddress()`（来自 shared-contracts）。
- Map key 的分隔符不一致（`-` vs `:`）→ 查找永远 miss。
- address-book 导出名（`MAIN_SPOKE`）与 SDK 属性名（`Main`）不匹配——用 `spokeAddress` 作为 canonical key。
- 两个模块各自实现"看起来一样"的 key 构造函数 → 隐式不一致。

## 7. 多实体组合

**要问的问题**：

- 单个实体 vs 多个实体行为是否一致？
- V3-only / V4-only / V3+V4 混合是否分别测试？
- 同链多实体 vs 跨链多实体是否测试？
- 多实体时 key 是否碰撞（两个实体生成相同 key）？

**常见陷阱**：

- 单实体测试通过但多实体时 key 碰撞（如只用 chainId 做 key，同链多 pool 冲突）。
- V3+V4 混合时类型判断遗漏（`if (v4Entry)` 但漏了 `else if (v3Entry)`）。
- 多实体排序依赖（reduce 的初始值、reduce 顺序影响结果）。

## 8. 跨 Step 接口契约

> **这是当前体系的最大 gap。** P4→P7 的命名不匹配正是因为 poolKey（P4 产出的接口契约）在 P7 消费时格式不匹配，但 P4 的 grill 阶段从未验证 P7 的消费可行性。

**要问的问题**：

- 当前 step 产出的字段格式，下游 step 能否直接消费？
- 当前 step 定义的 key / ID 构造方式，下游 step 是否用相同逻辑构造查找 key？
- 下游 step 是否依赖当前 step未显式声明的隐式约定（如 naming convention）？
- 如果当前 step 的产出格式变化，哪些下游 step 会 break？

**验证方法**：

1. 在 grill 阶段写出当前 step 的**接口契约**（产出字段名 + 格式 + 示例值）。
2. 模拟下游 step 的消费场景：用当前 step 的产出作为输入，下游 step 能否正确匹配 / 解析？
3. 如果下游 step 尚未设计（如 P4 设计时 P7 还没 spec），先检查 issue triage 中的依赖链，确认下游 step 存在且会消费当前产出。

**典型案例**：

| 接口契约                                | 生产方                    | 消费方                      | 不匹配风险                                       |
| --------------------------------------- | ------------------------- | --------------------------- | ------------------------------------------------ |
| `poolKey` (`${chainId}:${marketName}`)  | P4 `computeHealthFactors` | P7 `useOnchainHealthFactor` | V4 marketName 来源不同（API vs SDK）→ 格式不匹配 |
| `reserveId` (`chainId:spoke:token:hub`) | backend fetcher           | backend onchainDataService  | 分隔符或地址大小写不一致 → Map.get miss          |
| `chainTokenKey` (`chainId:token`)       | fetcher token-price       | brevis distributed-so-far   | 分隔符 `-` vs `:` → tokenPrice 查找 miss         |

## 9. CI/CD 交互

**要问的问题**：

- 本地开发环境 vs Docker 构建环境差异是否考虑（残留文件、路径、权限）？
- 环境变量存在 vs 缺失时的行为是否定义？
- pre-commit / pre-push hook 的 auto-fix 是否会改变预期行为？
- CI 的 `sh -c`（无 globstar）与本地 zsh 行为差异？

**常见陷阱**：

- 本地残留 `dist/` 目录掩盖 ENOENT——Docker 构建时目录不存在 → fail。
- `tests/**/*.test.ts` 在 CI 的 `sh -c` 中不展开——用 `tests/*.test.ts`。
- hook auto-fix 修改文件后 commit 被 amend，需重新 push。
- 环境变量缺失时 fallback 到默认值，但默认值在 production 不安全。

---

## DeFi 专项（按需检查）

> 以下场景与 Aave 协议特性相关，涉及链上数据 / 合约交互时检查。

### D1. 链上数值边界

- `max uint256`（`2^256 - 1`）→ 表示"无限"（如无债务时 HF）→ 转为 `null`，不可当数值处理。
- `0` 值的语义：`ltv = 0` 表示 frozen（V3 合约联动），不是"未设置"。
- RAY（1e27）vs WAD（1e18）精度混用 → 转换必须走 `units.ts`。
- `decimals` 差异（6 vs 18）：`raw` 值不可直接比较。

### D2. V3 vs V4 语义差异

- V3 `baseLTVasCollateral` ≠ `liquidationThreshold`（有安全缓冲），V4 `collateralFactor` = 两者同值（无缓冲）。
- V3 Pool = 一个 market，V4 Spoke = 一个 market（但 Spoke 可连多个 Hub）。
- V3 `healthFactorWad` vs V4 `healthFactor`——都是 WAD 精度但字段名不同。
- V4 仓位隔离边界是 per-Spoke，V3 是 per-Pool——跨 Spoke/Pool 的 collateral 不可互相对冲。

### D3. 合约状态联动

- V3 frozen → `ltv = 0`（合约自动联动），`liquidationThreshold` 不变。
- V4 paused → `isActive: false`（API 输出），但 on-chain 数据仍可读。
- supplyCap disabled（`raw === "0"` 或 `type(uint256).max`）→ 无上限，不是 cap = 0。

---

## 检查清单速查（Grill 阶段快速过一遍）

```
□ 1. Null / Undefined / Empty 边界
□ 2. 数值精度（units.ts 统一入口）
□ 3. 状态转换（mount/unmount/connect/disconnect/toggle）
□ 4. 并发 / 竞态（React Query / AbortController / 连接池）
□ 5. 失败 / 降级（RPC fail / 部分失败 / 超时 / 429）
□ 6. 跨系统键匹配（canonical key / normalizeAddress / 命名差异）
□ 7. 多实体组合（V3/V4/混合 / 多实体 key 碰撞）
□ 8. 跨 Step 接口契约（产出格式 → 下游消费可行性）
□ 9. CI/CD 交互（Docker / env / hook / globstar）
□ D1. 链上数值边界（max uint256 / 0 语义 / RAY vs WAD）
□ D2. V3 vs V4 语义差异（LTV vs collateralFactor / Pool vs Spoke）
□ D3. 合约状态联动（frozen / paused / cap disabled）
```

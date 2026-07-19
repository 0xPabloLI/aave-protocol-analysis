# ADR-0036: LLM Offset Symbol Normalization — 碰撞返回全部 + 等价组 + A2 Skip

## 状态

Proposed

## 上下文

Merkl net-position detector 的 LLM fallback path（`detectNetPositionConstraint` Layer 3）用 exact case-sensitive `symbolLookup` 解析 LLM 返回的 `offsetTokenSymbols`。当 LLM 返回的 symbol 与市场 symbol 存在 case 差异（`usde` vs `USDe`）或 Unicode↔ASCII 差异（`'USDT'` vs `USD₮0`）时，exact 查找 miss → 整个 constraint 被 silent drop → reward APR 被高估。

原 spec 草案提出三层 resolver（exact → CI → alias）+ `AMBIGUOUS` sentinel（碰撞时 fail-safe）。Grill with Docs 过程中发现多个需要重新决策的设计点。

## 决策

### 1. 碰撞返回全部，不 fail-safe

放弃 `AMBIGUOUS` sentinel。当多个 token address 共享同一 `chainId:symbol`（如 Arbitrum 上 native USDC + bridged USDC）或同一 `chainId:lower(symbol)` 时，resolver 返回**所有**匹配的 address。

**理由**：下游 net-position 计算 `net = source - Σ(offset positions)` + `Math.max(0, net)`，对 offset over-inclusion 是保守的（用户无仓位 → 贡献 0；有仓位 → 多减 → net 更小 → reward 更小）。fail-safe 反而更危险——drop 整个 constraint 意味着全额仓位 × APR（最大高估）。

### 2. 等价组（双向）取代单向 alias

用 `SYMBOL_EQUIV_GROUPS: string[][]`（如 `[['USDT', 'USD₮0', 'USD₮']]`）替代单向 `ALIAS[key] → target`。组内任一 symbol 都可以解析到组内其他 symbol。

**理由**：LLM 可能在任一方向 ASCII 化 Unicode（`USD₮0`→`USDT` 或 `USDT`→`USD₮0`），单向 alias 只覆盖一个方向。等价组实现双向归一化。

**安全性**：组内成员两两不共链（实测：`USDT` 在 {1,56,59144,1868,324,10}、`USD₮0` 在 {42161,57073,196}、`USD₮` 在 {42220}），任一 chain 上最多存在一个组内成员，无歧义。offset 解析是 chain-scoped 的（`opp.chainId` 锁定），不会跨链误映射。

### 3. A2 Skip + Warn（非 fail-fast）

当某个 LLM 返回的 symbol 解析出 0 个 address 时，`logger.warn(...)` + `continue`（跳过该 symbol，继续构建 constraint），而非 `return null`（drop 整个 constraint）。

**理由**：fail-fast 反而更高估——drop 整个 constraint = 全额仓位 × APR（最大高估）；skip 一个 symbol = 部分应用 offset = 轻微高估。warn 提供可观测性，用于调查哪些 symbol 被拒绝。

### 4. 显式添加 self reserveId（LLM path 对齐 L0）

LLM path 在 symbol 循环后显式将 `oppReserveId` 加入 `offsetReserveIds`（通过 `seen` 去重）。

**理由**：L0 (`extractNetPositionConstraint`) 一直有 "always include self" 逻辑，但 LLM path 依赖 LLM 自然返回 source symbol。实测 13/13 NET opportunity message 都在 offset 列表里包含 source token（`X supply minus X, ... borrows`），显式添加与 message 语义一致，且修复 LLM 漏返 source symbol 的 pre-existing 风险。

### 5. 独立模块 `merkl-symbol-resolver.ts`

新建 `packages/aave-fetcher/src/merkl-symbol-resolver.ts`，包含等价组常量、CI map builder、resolver helper。不放入已 2351 行的 `merkl-api.ts`。

## 考虑过的选项

| 决策       | 选项                           | 拒绝原因                                               |
| ---------- | ------------------------------ | ------------------------------------------------------ |
| 碰撞策略   | `AMBIGUOUS` sentinel fail-safe | 下游消费保证 over-inclusion 保守，fail-safe 反而更高估 |
| Alias 机制 | 单向 `ALIAS[key] → target`     | LLM 可能任一方向犯错，单向只覆盖一半                   |
| 失败处理   | fail-fast `return null`        | drop 整个 constraint = 最大高估，比 skip 更不安全      |
| 架构       | 合并为两层（等价组吸收 CI）    | 丢失 exact fast-path 防御冗余，测试边界模糊            |
| 模块放置   | 放入 `merkl-api.ts`            | 文件已 2351 行，继续膨胀影响可维护性                   |

## 后果

- `symbolLookupCI: Map<string, string[]>` 新增运行时数据结构（每 cron cycle 构建一次，~385 entries，内存可忽略）
- `detectNetPositionConstraint` 签名扩展 2 个参数（`symbolLookupCI`, `equivLookup`）
- 等价组表是唯一可能引入 wrong offset 的地方——保持最小（1 组 3 成员），每条目测试，两两不共链验证
- LLM path 行为变化：从"任一 symbol 失败则全 drop"变为"skip 失败 symbol + 保留 sourceSide + 显式 self"——更精确但与旧行为不同，需 staging 验证
- 当前生产数据 L0 捕获 100% NET opps，LLM path 极少触发——此变更是前瞻性防御

## Related

- Spec: `docs/plans/2026-07-19-llm-offset-symbol-normalization.md`
- ADR-0023: netPositionConstraint 检测架构（五层）
- Grill with Docs session: 2026-07-19

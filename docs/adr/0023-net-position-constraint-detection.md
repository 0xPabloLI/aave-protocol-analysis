# ADR-0023: netPositionConstraint 三层检测架构

Date: 2026-05-29

## Status

Accepted

## Related Issues

- [AAV-444](https://linear.app/aaveapy/issue/AAV-444) — 大模型解析 Merkl Opportunities 时的 hardcoded rules fallback（本 ADR 的 Layer 1 硬编码规则即为此 fallback 的实现）

## Context

Merkl 机会的 `netPositionConstraint` 字段标识净头寸方向（supply/borrow）和抵消 reserve IDs。该字段决定了前端如何展示净 APY（supply APR - borrow APR of offset positions）。

当前实现有三层检测逻辑，但存在两个实现缺陷：

1. **~~Layer 2（缓存）是死代码~~ → ✅ 已修复**：`fetchMarketsData` 签名已加 `cachedConstraints` 参数，穿透到 `enrichDatasetWithIncentiveData` → `detectNetPositionConstraint(opp, ..., cachedConstraints?.get(opp.opportunityLink), llmFn)`。同时修复了 `NetPositionConstraint` 未从 `@internal/aave-fetcher` re-export 导致 backend import 编译失败的问题
2. **~~Layer 3（LLM fallback）OpenRouter 链路不可达~~ → ✅ 已修复**：`callLlmWithFallback(prompt, llmConfig, openrouterConfig)` 现在传入第三个参数 `openrouterConfig`（从 `OPENROUTER_API_KEY` 构建），`llmFn` guard 条件改为 `(llmConfig || openrouterConfig)`

此外，用户提出若干架构改进方向需记录。

## Decision

三层检测架构正式化为以下契约：

```
detectNetPositionConstraint(opp, sourceTokenAddress, oppReserveId, reserveIdSet, symbolLookup, cachedConstraint?, llmFn?)
    │
    ├─ Layer 1: extractNetPositionConstraint()     ← 确定性规则
    │    触发条件: opportunityType.startsWith('AAVE_NET_')
    │    输入: opp.offsetTokenAddresses → resolveOffsetReserveIds
    │    输出: { sourceSide, offsetReserveIds }
    │    命中率: 17/17 AAVE_NET_* = 100%（线上实测 2026-05-29）
    │
    ├─ Layer 2: cachedConstraint                    ← 快照缓存（当前死代码）
    │    触发条件: Layer 1 返回 null 且 cachedConstraint 非空
    │    输入: 上一次快照的同机会 constraint
    │    输出: 直接返回缓存值
    │    当前状态: ⚠️ 死代码 — fetchMarketsData 签名不接受 cachedConstraints
    │
    ├─ Layer 3: llmFn() → callLlmWithFallback()    ← LLM 两层 fallback
    │    触发条件: Layer 1 + Layer 2 均未命中且 llmFn 非空
    │    输入: buildLlmPrompt({ type, action, description, tokenSymbols })
    │    链路: primaryConfig (LLM_FALLBACK_MODELS) → openrouterConfig (free models)
    │    输出: { sourceSide, offsetTokenSymbols } → resolveOffsetReserveIds
    │    当前缺陷: ⚠️ openrouterConfig 未传入，OpenRouter 链路不可达
    │
    └─ fallback: return null
         含义: 该机会无 net position constraint（如 AAVE_V4_HUB_SUPPLY, AAAVE_SUPPLY）
```

### Layer 4 删除决策（已完成）

此前存在 Layer 4 heuristic（`detectNetPositionConstraintHeuristic`），基于 `opportunityType` + `campaignType` 启发式推导。决策：**删除**。理由：

- Layer 1 覆盖率 100%（17/17 AAVE_NET_* 全部命中）
- 9 个无 constraint 机会均非 net position 类型，启发式推导语义不正确
- 启发式结果无法验证，引入错误风险

删除 commit: `b0fe98d`，三个调用入口改为 `return null`。

### 两层大模型链路设计

```
buildModelChain(primaryConfig?, openrouterConfig?, fetchFn)
    │
    ├─ 链路 A: primaryConfig + LLM_FALLBACK_MODELS
    │    当前: LLM_FALLBACK_MODELS = [] (空)
    │    用途: 预配置的付费模型列表
    │
    └─ 链路 B: openrouterConfig + fetchOpenRouterFreeModels()
         当前: 不可达（openrouterConfig 未传入）
         用途: 动态获取 OpenRouter free models
         环境变量: OPENROUTER_API_KEY → baseUrl=https://openrouter.ai/api/v1
```

**设计意图**：链路 A 优先（付费模型更可靠），链路 B 兜底（free models 零成本但限速）。

**当前实际**：链路 A 因 `LLM_FALLBACK_MODELS=[]` 也不走。两条链路均不生效，Layer 3 仅在 `primaryConfig` 有值时走一个空模型列表。

### 线上数据（2026-05-29）

| 类别 | 数量 | 有 constraint | 无 constraint |
|------|------|--------------|--------------|
| 全部 Merkl 机会 | 31 | 22 | 9 |
| AAVE_NET_LENDING | 13 | 13 | 0 |
| AAVE_NET_BORROWING | 4 | 4 | 0 |
| AAVE_V4_HUB_SUPPLY | 8 | 0 | 8 |
| AAAVE_SUPPLY | 1 | 0 | 1 |
| MULTILOG_DUTCH | 5 | 5 | 0 |

Layer 1 对 `AAVE_NET_*` 的覆盖率：100%（17/17）。

## Known Defects

### Defect 1: Layer 2 死代码 ✅ 已修复

**原位置**：
- `packages/aave-fetcher/src/index.ts`: `fetchMarketsData` 签名只接受 `{v4Fatal?}`
- `packages/aave-fetcher/src/index.ts`: `cachedConstraint` 硬编码 `undefined`
- `backend/src/services/marketsService.ts`: 传了 `cachedConstraints` 但被 TS 静默忽略（弱类型 `options?`）

**原影响**：每个机会每次刷新都从 Layer 1 开始，无法复用上一快照的结果。当 Layer 1 因 Merkl 数据变化暂时返回 null 时，constraint 丢失而非降级到缓存。

**修复内容**：
1. `fetchMarketsData` 签名新增 `cachedConstraints?` 参数
2. `fetchMarketsData` 内部调用 `enrichDatasetWithIncentiveData(..., options?.cachedConstraints)` 传入第 5 参数
3. CLI 入口 `runMarketsFetcher` 调用时传 `undefined`

**审查发现**：commit `c7a6305` 修改了签名但遗漏了内部调用穿透，Layer 2 仍为死代码。后续在代码审查中捕获并修复。

### Defect 2: Layer 3 OpenRouter 链路不可达 ✅ 已修复

**原位置**：
- `packages/aave-fetcher/src/index.ts` L505-507: `llmConfig` 来自 `LLM_API_KEY`/`LLM_BASE_URL`
- `packages/aave-fetcher/src/index.ts` L538: `callLlmWithFallback(prompt, llmConfig)` — 只传 `primaryConfig`，未传 `openrouterConfig`

**影响**：
1. 若 `LLM_API_KEY` 未设置，`llmConfig` = undefined，`llmFn` = undefined，**Layer 3 完全不触发**
2. 即使 `LLM_API_KEY` 有值，`LLM_FALLBACK_MODELS=[]`，链路 A 也是空，只走空循环后返回 null
3. OpenRouter free models 链路（`OPENROUTER_API_KEY`）永远不被调用

**线上环境变量状态**：
- `OPENROUTER_API_KEY` ✅ 已部署到 Railway
- `LLM_API_KEY` / `LLM_BASE_URL` ❌ 未部署

**修复方向**：
1. 从 `OPENROUTER_API_KEY` 构建 `openrouterConfig`
2. `callLlmWithFallback(prompt, primaryConfig, openrouterConfig)` 传入第三个参数
3. 或者：统一为一套环境变量，不再区分 `LLM_*` / `OPENROUTER_*`

**修复内容**：已在 `c7a6305` 中实现方向 1+2。注意：Layer 3 仅在 `OPENROUTER_API_KEY` 有值时真正可达（`LLM_FALLBACK_MODELS=[]`，primary 链路为空），线上已部署此 key。

## Open Questions

### Q1: Layer 1 只匹配 opportunityType，不匹配 message/description

**现状**：`extractNetPositionConstraint` L1383 `if (!type.startsWith('AAVE_NET_')) return null`。

**风险**：若 Merkl 新增一种 net position 机会但 `opportunityType` 不以 `AAVE_NET_` 开头，Layer 1 不会命中。需依赖 Layer 3 LLM 或手动注册。

**倾向**：当前覆盖率为 100%，暂不改。若未来出现漏匹配，优先在 Layer 1 中扩展前缀白名单。

### Q2: Layer 3 能否 cross-check Layer 1 结果

**方案**：Layer 1 命中后，额外调 LLM 验证 `offsetTokenSymbols` 是否与 `offsetReserveIds` 对应。

**代价**：每个 AAVE_NET 机会多一次 LLM 调用（17 次/刷新），增加延迟和 token 成本。

**倾向**：暂不实施。Layer 1 基于确定性规则（token address → reserveId），无歧义。LLM cross-check 仅在规则可能误匹配时有价值，当前无此场景。

### Q3: 9 个无 constraint 的非 AAVE_NET 机会是否应走 Layer 3

**现状**：8 个 `AAVE_V4_HUB_SUPPLY` + 1 个 `AAAVE_SUPPLY` + 1 个 `MULTILOG_DUTCH` 无 constraint，且 Layer 1 不匹配（非 `AAVE_NET_*`）。

**分析**：
- `AAVE_V4_HUB_SUPPLY`：Hub 级别的 supply 机会，本身不是净头寸概念（无 borrow 侧抵消）
- `AAAVE_SUPPLY`：同上，单一 supply 机会
- `MULTILOG_DUTCH`：5 个中有 5 个已有 constraint（通过 Layer 1 命中），1 个无 constraint 的可能是数据缺失

**倾向**：`AAVE_V4_HUB_SUPPLY` 和 `AAAVE_SUPPLY` 语义上就不是 net position，走 LLM 只会返回 null。`MULTILOG_DUTCH` 缺失 constraint 的情况值得观察，暂不主动送 LLM。

## Alternatives Considered

### A. 保持 Layer 4 heuristic

- Pro：覆盖 Layer 1 不命中的场景
- Con：语义不正确、无验证、已删除（commit b0fe98d）
- Rejected

### B. Layer 1 匹配 message/description 而非仅 opportunityType

- Pro：更灵活
- Con：message/description 为自然语言，匹配规则脆弱且难测试
- Rejected：opportunityType 是 Merkl 官方结构化字段，更可靠

### C. 统一环境变量（只用 OPENROUTER_API_KEY，废弃 LLM_API_KEY/LLM_BASE_URL）

- Pro：一套配置、一条链路
- Con：失去 primaryConfig 路径（付费模型直连，不走 OpenRouter 路由）
- 可选：当前项目只用 OpenRouter free 路径，统一可行

### D. 当前决策（三层 + 修复两个缺陷 + 统一为 OPENROUTER 路径）

- Accepted

## Consequences

- **Positive**：三层架构职责清晰，Layer 1 覆盖率 100%，无需 Layer 4 启发式
- **Positive**：修复 Defect 2 后，Layer 3 OpenRouter free models 链路可达，为未来非 `AAVE_NET_*` 类型提供 LLM 兜底能力
- **Positive**：修复 Defect 1 后，缓存链路可用，减少 LLM 调用频次
- **Negative**：Layer 2 缓存修复需改 `fetchMarketsData` 签名，影响面较广
- **Negative**：Layer 3 LLM 调用增加延迟（最坏 60s timeout），仅在 Layer 1 未命中时触发
- **Negative**：OpenRouter free models 有 rate limit，大量机会同时走 Layer 3 时可能触发限速

## References

- ADR-0021: Three-Layer V4 Fallback（类似三层降级模式）
- `packages/aave-fetcher/src/merkl-api.ts`: `detectNetPositionConstraint` L1335-1374, `extractNetPositionConstraint` L1376-1418
- `packages/aave-fetcher/src/merklLlmClient.ts`: `buildModelChain` L47-65, `callLlmWithFallback` L183-237
- `packages/aave-fetcher/src/index.ts`: Layer 3 调用处 L505-540
- 删除 Layer 4 commit: `b0fe98d`

# ADR-0023: netPositionConstraint 检测架构

Date: 2026-05-29 · Updated: 2026-06-22

## Status

Accepted

## Related Issues

- [AAV-444](https://linear.app/aaveapy/issue/AAV-444) — hardcoded rules fallback
- [AAV-895](https://linear.app/aaveapy/issue/AAV-895) — Borrow ETH cbETH cross-asset offset

## Context

Merkl 机会的 `netPositionConstraint` 字段标识净头寸方向（supply/borrow）和抵消 reserve IDs。

## Decision

五层检测架构：

```
detectNetPositionConstraint(opp, sourceTokenAddress, oppReserveId, reserveIdSet, symbolLookup, cachedConstraint?, llmFn?)
    │
    ├─ Layer 0: extractNetPositionConstraint()     ← 确定性规则（类型匹配）
    │    触发条件: opportunityType.startsWith('AAVE_NET_') 或 distributionType ∈ NET_DISTRIBUTION_TYPES
    │    输入: opp.offsetTokenAddresses → resolveOffsetReserveIds
    │    输出: { sourceSide, offsetReserveIds }（always include self reserveId）
    │    命中率: 20/20 AAVE_NET_* = 100%（线上实测 2026-06-16）
    │
    ├─ Layer 0.5: composedNetPosition()            ← 确定性规则（composedCampaignsCompute）
    │    触发条件: composedCampaignsCompute === '1-2'
    │    语义: 同资产 supply-borrow 对冲 = net position
    │    side 推断: action=LEND → supply, action=BORROW → borrow
    │    offset: 从子 campaign 的 underlyingToken 提取 → resolveOffsetReserveIds + always include self
    │    不触发: compute 为 min/max/+ 等非减法类型
    │    参考: ADR-0030 Mode 2, AAV-948
    │
    ├─ Layer 1: looping 排除                        ← 确定性规则（关键词排除）
    │    触发条件: name/description 包含 "looping"
    │    输出: return null（looping 不是 net position）
    │    命中: 4/34 opps
    │
    ├─ Layer 2: cachedConstraint                    ← 快照缓存
    │    触发条件: Layer 0 + Layer 0.5 + Layer 1 均未命中且 cachedConstraint 非空
    │
    ├─ Layer 3: llmFn() → callLlmWithFallback()    ← LLM 两层 fallback
    │    返回类型: LlmOutcome = { tag: 'result', value } | { tag: 'unavailable' }
    │    模型链: 硬编码列表优先 → 动态获取模型追加（去重）
    │    不可用条件: 所有模型 429/超时/无 config → tag: 'unavailable'
    │
    ├─ Layer 4: regexNetPositionFallback()          ← 正则 fallback
    │    触发条件: Layer 3 返回 tag: 'unavailable'（LLM 不可用）
    │    不触发: LLM 返回 tag: 'result' + value: null（LLM 明确判定无 NPC）
    │    规则: net supply/borrow 关键词、action-only 匹配
    │    输出: { sourceSide, offsetReserveIds: [] }（保守，无 offset 映射）
    │
    └─ fallback: return null
```

### Layer 0.5 设计依据

`1-2` compute 的 composed campaign 天然是 net position：
- `1-2` = Sub[1] APR − Sub[2] APR = 同一资产 supply 侧激励 − borrow 侧激励 = net position
- Merkl 官方文档确认："reward based on net lending position (lending minus borrowing)"
- 与 `min(1,2)` 本质不同：`min` 是跨资产配对约束（如 cbETH supply + ETH borrow 取较小值），不是同资产对冲

**`min(1,2)` 不纳入 L0.5**：当前所有 `min(1,2)` 案例都是跨资产配对（sUSDe/USDe looping ×3, cbETH/ETH ×1），非同资产 net offset。

**层级顺序说明**：Layer 0（类型匹配）→ Layer 0.5（composed compute）→ Layer 1（looping 排除），确定性结构化规则优先于启发式关键词。

**Layer 4 设计原则**：
- 只在 LLM 完全不可用时 fallback，不否决 LLM 的判定
- 宁可漏判也不误判——只匹配 "net supply/borrow" 等明确模式
- 返回 `offsetReserveIds: []`（无法像 LLM 那样映射 symbol → reserveId）

### Merkl Campaign 数据结构差异（关键参考）

不同 `opportunityType` / `distributionType` 的 campaign `params` 结构完全不同：

| 字段 | AAVE_NET_\* | AAVE_SUPPLY | MULTILOG_DUTCH (MAX_REWARD) | AAVE_V4_HUB_SUPPLY | AAVE_V4_SPOKE_SUPPLY |
|---|---|---|---|---|---|
| params.tokens | ✅ 100% 有，含 underlyingToken/underlyingSymbol | ❌ 不存在 | ❌ 不存在 | ❌ 不存在 | ❌ 不存在 |
| params.hooks | ✅ 但为空数组 | ✅ hookType:14 + borrowBytesLike | ❌ 空 | ❌ 空 | ❌ 空 |
| params.targetToken | ❌ | ✅ (aToken 地址) | ✅ (aToken 或 vToken 地址) | ✅ (underlying 地址) | ❌ |
| distributionSettings.side | ❌ | ❌ | ❌ | ✅ "supply" | ❌ |

### targetToken → side 推断

`distributionSettings.targetToken` 指向 Merkl 计算 score 用的 token（不是 underlying），可推断 side：
- targetToken = aToken → supply side（如 USDtb: `0xEc4e...ccc8` = aEthUSDtb）
- targetToken = vToken → borrow side（如 USDC Horizon: `0x4139...0FC7` = variableDebtHorUSDC）
- AAVE_V4_NET_APR 直接提供 `side` 字段

### AAVE_V4_NET_APR 语义说明

AAVE_V4_NET_APR 是 Merkl 的 **Target Total APR** distribution type，含义：
- 保证用户获得 target APR = max(target - native APR, 0) + native APR
- Merkl 付差价（当 native yield 低于 target 时），不付超额（当 native yield 已达标）
- 与 supply-borrow 对冲是**正交概念**：一个 opp 可以既是 net position 又使用 Target Total APR
- `distributionSettings.mode: "MAX_APR"` 是 TARGET_TOTAL_APR 的一种 **dilutive mode**，不是"规范化"
- Merkl API **没有** `offsetTokenAddresses` 字段

来源：[Merkl Distribution Types 文档](https://docs.merkl.xyz/merkl-mechanisms/distributions)

### Merkl API distributionType 数据源

`distributionType` 在 Merkl API 中的实际位置：
- **campaign/breakdown 级别**有值（`campaign.distributionType`、`breakdown.distributionType`）
- **opp 顶层**始终为空字符串（`opp.distributionType` 不可用）

提取策略：
- **opp 级别代表值**：从 breakdown 取第一个非空值 → `firstDistributionType`（line 1478-1479），设置到 `MerklOpportunityData.distributionType`（line 1561）
- **campaignDetailsCache 构建**：必须从 `campaign.distributionType` 取值（line 974、1008、1258、1341、1352）
- **历史 bug**：`processMerklData` 中 line 1258/1341/1352 曾误用 `opp.distributionType`（始终为空），导致 amount variant campaign 无法识别，APR 计算走错分支（AAV-991）

### LLM 空内容处理

`callLlmWithFallback` 中 `llmAnswered` 标志的逻辑：
- `parseLlmResponse` 返回有效结果 → `llmAnswered = true` → 返回 `{ tag: 'result', value: parsed }`
- LLM 明确返回 null（`raw.trim() === 'null'`） → `llmAnswered = true` → 返回 `{ tag: 'result', value: null }`
- 未解析内容 → `llmAnswered` 保持 false → 视为 unanswered，继续尝试下一个模型
- 模型链全部耗尽后：`llmAnswered = true` → 返回 `{ tag: 'result', value: null }`；`llmAnswered = false` → 返回 `{ tag: 'unavailable' }`

### LLM 模型链路设计

```
buildModelChain(primaryConfig?, fetchFn)
    │
    ├─ 硬编码优先（立即可用，无网络请求）
    │    LLM_FALLBACK_MODELS (12)
    │
    └─ 动态获取追加（去重）
         └─ fetchAvailableModels(baseUrl, apiKey) → primary models
```

**callLlmWithFallback 返回 LlmOutcome**：
- `{ tag: 'result', value: LlmAnalysisResult }` — LLM 返回了有效结果
- `{ tag: 'result', value: null }` — LLM 明确判定不是 net position
- `{ tag: 'unavailable' }` — 所有模型不可用（429/超时/无 config）

**日志**：callLlmWithFallback 内置结构化日志（[LLM] 前缀），debug 级别记录模型链/HTTP 状态/重试，info 级别记录最终 outcome。

### 非 NET opp 分类（2026-06-21 更新）

| # | name | type | chain | dt | L0/L0.5 命中? | 备注 |
|---|---|---|---|---|---|---|
| 1 | Borrow USDT0 Plasma | MULTILOG_DUTCH | 9745 | DUTCH_AUCTION | **L0.5** (1-2 compute) | net borrow |
| 2 | Supply USDG V4 Hub | AAVE_V4_HUB_SUPPLY | 1 | AAVE_V4_NET_APR | **L0** (NET_DISTRIBUTION_TYPES) | ✅ 已命中 |
| 3 | Supply USDG V4 Spoke | AAVE_V4_SPOKE_SUPPLY | 1 | DUTCH_AUCTION | 未命中 | — |
| 4 | Supply frxUSD V4 Hub | AAVE_V4_HUB_SUPPLY | 1 | AAVE_V4_NET_APR | **L0** (NET_DISTRIBUTION_TYPES) | ✅ 已命中 |
| 5 | Supply frxUSD V4 Spoke | AAVE_V4_SPOKE_SUPPLY | 1 | DUTCH_AUCTION | 未命中 | — |
| 6 | Lend USDtb | AAVE_SUPPLY | 1 | MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE | 未命中 | hookType:14, LLM判定 supply |
| 7 | Borrow ETH cbETH | MULTILOG_DUTCH | 8453 | DUTCH_AUCTION | 未命中 | min(1,2) 跨资产配对，非 net position |
| 8 | Borrow USDC Horizon | MULTILOG_DUTCH | 1 | MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE | **L0.5** (1-2 compute) | net borrow |

**L0.5 新增后**：#1 (Borrow USDT0) 和 #8 (Borrow USDC Horizon) 将被 L0.5 结构化规则捕获，不再依赖 LLM/regex。

## Changelog

### 2026-06-22 Session
- **distributionType 数据源记录**：opp 顶层始终为空，campaign/breakdown 级别有值；提取策略文档化
- **LLM 空内容处理文档化**：`llmAnswered` 仅在成功解析或明确返回 null 时设 true
- **OpenRouter 移除**：`buildModelChain` 只用 `primaryConfig`，删除 `OPENROUTER_FREE_MODELS_FALLBACK` 和 `fetchOpenRouterFreeModels()` 引用
- **V4 HUB_SUPPLY 理解修正**：`MAX_APR` 是 dilutive mode 不是"规范化"；Merkl API 没有 `offsetTokenAddresses`
- **AAV-991 bug fix**：`processMerklData` 中 3 处 `opp.distributionType` → `campaign.distributionType`

### 2026-06-21 Session
- **Layer 0.5 新增**：composed `1-2` compute 作为确定性 net position 规则
- **L0/L0.5 顺序**：类型匹配 → composed compute → looping 排除
- **修正表格**：#2 (USDG V4 Hub) 和 #4 (frxUSD V4 Hub) 已被 L0 `NET_DISTRIBUTION_TYPES` 命中，不应列为"未命中"
- **#1 (Borrow USDT0) 和 #8 (Borrow USDC Horizon)** 将被 L0.5 结构化规则捕获
- **cbETH/ETH min(1,2)** 确认为跨资产配对 incentive，不是 net position，不纳入 L0.5
- **regexNetPositionFallback offsetReserveIds bug**：regex 分支返回 `[]` 但未 include self reserveId（L0 有 "always include self" 但 L0 不触发此路径）

### 2026-06-16 Session
- **L0/L1 顺序对调**：类型匹配优先于 looping 排除（确定性优先于启发式）
- **L1670 isNetType 死代码清理**：删除 `isNetType`/`sourceAddrLower` 变量和永假条件分支
- **Layer 4 正则 fallback**：`regexNetPositionFallback` 在 LLM 不可用时提供保守关键词匹配
- **LlmOutcome 类型**：区分 "LLM 返回 null" 和 "LLM 不可用"
- **硬编码模型优先**：buildModelChain 先放硬编码模型，动态获取模型追加（去重）
- **LLM 结构化日志**：callLlmWithFallback 内置 `[LLM]` 前缀日志
- **AAVE_V4_NET_APR 语义研究**：确认是 Target Total APR（APR cap/boost），与 net position 正交

## Open Questions

### Q1: AAVE_V4_HUB_SUPPLY 的 NPC offset

Hub Supply 的 distributionType 是 AAVE_V4_NET_APR（Target Total APR），同时也可以是 net position。但它没有 offsetTokenAddresses，且 V4 reserves 不在当前 staging API 中，无法从 reserveIdSet 找到 offset reserve。

### Q2: V4 Hub-Spoke parent-child 机制

Hub (parent) + Spoke (child) 关系：Hub 有 AAVE_V4_NET_APR，Spoke 有 DUTCH_AUCTION。"Parent and child rewards are not cumulative"。用户存入 Spoke 时的 APR 计算逻辑待研究。

### Q3: Borrow ETH cbETH cross-asset offset

[AAV-895](https://linear.app/aaveapy/issue/AAV-895) — cbETH/ETH 的 `min(1,2)` 是跨资产配对 incentive（不是同资产 net offset），不纳入 L0.5。0.823x discount 反映 cbETH 相对 ETH 的折价率。

## References

- `packages/aave-fetcher/src/merkl-api.ts`: `detectNetPositionConstraint`, `extractNetPositionConstraint`, `extractOffsetTokenAddresses`, `resolveOffsetReserveIds`, `regexNetPositionFallback`
- `packages/aave-fetcher/src/merklLlmClient.ts`: `LlmOutcome`, `fetchAvailableModels`, `buildModelChain`, `callLlmWithFallback`
- `packages/aave-fetcher/src/index.ts`: Layer 3 调用处

# ADR-0023: netPositionConstraint 检测架构

Date: 2026-05-29 · Updated: 2026-06-16

## Status

Accepted

## Related Issues

- [AAV-444](https://linear.app/aaveapy/issue/AAV-444) — hardcoded rules fallback
- [AAV-895](https://linear.app/aaveapy/issue/AAV-895) — Borrow ETH cbETH cross-asset offset

## Context

Merkl 机会的 `netPositionConstraint` 字段标识净头寸方向（supply/borrow）和抵消 reserve IDs。

## Decision

四层检测架构：

```
detectNetPositionConstraint(opp, sourceTokenAddress, oppReserveId, reserveIdSet, symbolLookup, cachedConstraint?, llmFn?)
    │
    ├─ Layer 0: extractNetPositionConstraint()     ← 确定性规则（类型匹配）
    │    触发条件: opportunityType.startsWith('AAVE_NET_')
    │    输入: opp.offsetTokenAddresses → resolveOffsetReserveIds
    │    输出: { sourceSide, offsetReserveIds }
    │    命中率: 20/20 AAVE_NET_* = 100%（线上实测 2026-06-16）
    │
    ├─ Layer 1: looping 排除                        ← 确定性规则（关键词排除）
    │    触发条件: name/description 包含 "looping"
    │    输出: return null（looping 不是 net position）
    │    命中: 4/34 opps
    │
    ├─ Layer 2: cachedConstraint                    ← 快照缓存
    │    触发条件: Layer 0 + Layer 1 均未命中且 cachedConstraint 非空
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

**层级顺序说明**：Layer 0（类型匹配）优先于 Layer 1（looping 排除），因为类型匹配是确定性结构化规则，looping 排除是启发式关键词。类型匹配覆盖率 100%。

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

来源：[Merkl Distribution Types 文档](https://docs.merkl.xyz/merkl-mechanisms/distributions)

### LLM 模型链路设计

```
buildModelChain(primaryConfig?, openrouterConfig?, fetchFn)
    │
    ├─ 硬编码优先（立即可用，无网络请求）
    │    LLM_FALLBACK_MODELS (12) + OPENROUTER_FREE_MODELS_FALLBACK (20)
    │
    └─ 动态获取追加（去重）
         ├─ fetchAvailableModels(baseUrl, apiKey) → primary models
         └─ fetchOpenRouterFreeModels() → openrouter free models
```

**callLlmWithFallback 返回 LlmOutcome**：
- `{ tag: 'result', value: LlmAnalysisResult }` — LLM 返回了有效结果
- `{ tag: 'result', value: null }` — LLM 明确判定不是 net position
- `{ tag: 'unavailable' }` — 所有模型不可用（429/超时/无 config）

**日志**：callLlmWithFallback 内置结构化日志（[LLM] 前缀），debug 级别记录模型链/HTTP 状态/重试，info 级别记录最终 outcome。

### 8 个非 NET opp（L0/L1 未命中，2026-06-16）

| # | name | type | chain | dt | hooks | targetToken | side | link |
|---|---|---|---|---|---|---|---|---|
| 1 | Borrow USDT0 Plasma | MULTILOG_DUTCH | 9745 | DUTCH_AUCTION | N | - | - | [link](https://app.merkl.xyz/opportunity/9745/0xF5F05bc52587C14C51a0E04e73c0d91a3ef1924d) |
| 2 | Supply USDG V4 Hub | AAVE_V4_HUB_SUPPLY | 1 | AAVE_V4_NET_APR | N | underlying | supply | [link](https://app.merkl.xyz/opportunity/1/0x44E12914eBFB4e4b5bcB4afb359eCca7D51e5E8a) |
| 3 | Supply USDG V4 Spoke | AAVE_V4_SPOKE_SUPPLY | 1 | DUTCH_AUCTION | N | - | - | [link](https://app.merkl.xyz/opportunity/1/0xD8f06A54813A9549B88dB72798343376A89Eeb37) |
| 4 | Supply frxUSD V4 Hub | AAVE_V4_HUB_SUPPLY | 1 | AAVE_V4_NET_APR | N | underlying | supply | [link](https://app.merkl.xyz/opportunity/1/0x92695585cCac2945Ae3019c9b19a754E0402979b) |
| 5 | Supply frxUSD V4 Spoke | AAVE_V4_SPOKE_SUPPLY | 1 | DUTCH_AUCTION | N | - | - | [link](https://app.merkl.xyz/opportunity/1/0xE23606E9243f4ED370B15f0Fa159fB381Cc81834) |
| 6 | Lend USDtb | AAVE_SUPPLY | 1 | MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE | Y (hookType:14) | aToken(USDtb) | - | [link](https://app.merkl.xyz/opportunity/1/0xEc4ef66D4fCeEba34aBB4dE69dB391Bc5476ccc8BORROW_BL) |
| 7 | Borrow ETH cbETH | MULTILOG_DUTCH | 8453 | DUTCH_AUCTION | N | - | - | [link](https://app.merkl.xyz/opportunity/8453/0xCBE5a66D821FC9364544b0156D26ECb5e4B58A0a) |
| 8 | Borrow USDC Horizon | MULTILOG_DUTCH | 1 | MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE | N | vToken(USDC) | - | [link](https://app.merkl.xyz/opportunity/1/0x46C636D606F1352b6B5d90BE8bd04a848245C728) |

## Changelog

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

[AAV-895](https://linear.app/aaveapy/issue/AAV-895) — 非 AAVE_NET_ 类型但需要 net constraint，offset 是不同资产（cbETH supply offset ETH borrow）。需专用公式。

## References

- `packages/aave-fetcher/src/merkl-api.ts`: `detectNetPositionConstraint`, `extractNetPositionConstraint`, `extractOffsetTokenAddresses`, `resolveOffsetReserveIds`, `regexNetPositionFallback`
- `packages/aave-fetcher/src/merklLlmClient.ts`: `LlmOutcome`, `fetchAvailableModels`, `buildModelChain`, `callLlmWithFallback`
- `packages/aave-fetcher/src/index.ts`: Layer 3 调用处

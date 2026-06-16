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
    │    命中率: 21/21 AAVE_NET_* = 100%（线上实测 2026-06-16）
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
    │    链路: fetchAvailableModels(primary baseUrl) → fetchOpenRouterFreeModels()
    │    硬编码 fallback: LLM_FALLBACK_MODELS (12) + OPENROUTER_FREE_MODELS_FALLBACK (20)
    │
    └─ fallback: return null
```

**层级顺序说明**：Layer 0（类型匹配）优先于 Layer 1（looping 排除），因为类型匹配是确定性结构化规则，looping 排除是启发式关键词。类型匹配覆盖率 100%。

### Merkl Campaign 数据结构差异（关键参考）

不同 `opportunityType` / `distributionType` 的 campaign `params` 结构完全不同：

| 字段 | AAVE_NET_\* | AAVE_SUPPLY | MULTILOG_DUTCH (MAX_REWARD) | AAVE_V4_HUB_SUPPLY | AAVE_V4_SPOKE_SUPPLY |
|---|---|---|---|---|---|
| params.tokens | ✅ 100% 有，含 underlyingToken/underlyingSymbol | ❌ 不存在 | ❌ 不存在 | ❌ 不存在 | ❌ 不存在 |
| params.hooks | ✅ 但为空数组 | ✅ hookType:14 + borrowBytesLike | ❌ 空 | ❌ 空 | ❌ 空 |
| params.targetToken | ❌ | ✅ (aToken 地址) | ✅ (aToken 或 vToken 地址) | ✅ (underlying 地址) | ❌ |
| distributionSettings.side | ❌ | ❌ | ❌ | ✅ "supply" | ❌ |
| params.borrowTokens | ✅ | ❌ | ❌ | ❌ | ❌ |
| params.lendingToken | ✅ | ❌ | ❌ | ❌ | ❌ |

**params.tokens 路径**：`opp.campaigns[].params.tokens` — 仅 AAVE_NET_\* 类型有此字段。
**params.hooks 路径**：`opp.campaigns[].params.hooks` — 仅 AAVE_SUPPLY 类型有 hookType:14 + borrowBytesLike。
**distributionSettings 路径**：`opp.campaigns[].params.distributionMethodParameters.distributionSettings`

### targetToken → side 推断

`distributionSettings.targetToken` 指向 Merkl 计算 score 用的 token（不是 underlying），可推断 side：
- targetToken = aToken → supply side（如 USDtb: `0xEc4e...ccc8` = aEthUSDtb）
- targetToken = vToken → borrow side（如 USDC Horizon: `0x4139...0FC7` = variableDebtHorUSDC）
- AAVE_V4_NET_APR 直接提供 `side` 字段

### extractOffsetTokenAddresses 提取逻辑

从 `params.tokens[]` 取 `underlyingToken` 地址（非 tokenAddress、非 aToken/vToken 地址），去重后通过 `resolveOffsetReserveIds` 映射到 reserveId。

**AAVE_NET opps 的 params.tokens 总是包含自身 underlying token**（按 `underlyingSymbol` 匹配），这是正确的——net position 的 offset 包含自身（"USDT0 supply minus USDT0 borrows"）。

### resolveOffsetReserveIds 匹配逻辑

取 `oppReserveId` 的前两段（`chainId:poolAddress`）作为 prefix，拼接 offset token address，在 reserveIdSet 中查找。使用 pool prefix 而非 chainId+address 是因为 **offset 限定在同一 pool 内**（net position 是同一市场内的 supply-borrow 抵消）。

v3: 精确匹配 `{prefix}:{tokenAddr}`
v4: 前缀匹配 `{prefix}:{tokenAddr}:`（第四段是 hubAddress）

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

### LLM 模型链路设计

```
buildModelChain(primaryConfig?, openrouterConfig?, fetchFn)
    │
    ├─ 链路 A: primaryConfig + fetchAvailableModels(baseUrl, apiKey)
    │    从 {baseUrl}/models 动态获取可用模型列表
    │    失败时 fallback 到硬编码 LLM_FALLBACK_MODELS (12 个)
    │
    └─ 链路 B: openrouterConfig + fetchOpenRouterFreeModels()
         从 OpenRouter /models 获取 free 模型，按 context_length 降序取前 20
         失败时 fallback 到 OPENROUTER_FREE_MODELS_FALLBACK (20 个)
```

**LLM_FALLBACK_MODELS** (硬编码 fallback)：claude-haiku-4.5, claude-sonnet-4.6, grok-4.20-fast, gpt-5.4, qwen3.5-397b, deepseek-v4-flash, kimi-k2.6, deepseek-v4-pro, gpt-5.2, qwen3.5-397b-a17b, openrouter/free, nematron-3-super-120b

**OPENROUTER_FREE_MODELS_FALLBACK** (硬编码 fallback)：deepseek/deepseek-v4-flash:free 等 20 个 OpenRouter free 模型

## Known Defects

### Defect 1: Layer 2 死代码 ✅ 已修复

### Defect 2: Layer 3 OpenRouter 链路不可达 ✅ 已修复

### Defect 3: LLM_FALLBACK_MODELS 被误清空 ✅ 已修复

### Defect 4: LLM 失败时无 Layer 4 fallback（待修复）

**现状**：LLM 返回 null 或失败（429/超时）时，`detectNetPositionConstraint` 直接 `return null`，不区分 "LLM 判定无 net position" 和 "LLM 不可用"。

**修复方向**：
1. `llmFn` 返回结构需区分 "LLM 成功返回 null" 和 "LLM 失败"
2. LLM 失败时 fallback 到 Layer 4 正则（基于 description 关键词）
3. 正则比 LLM 更保守——宁可漏判也不误判

### 已清理：L1670 isNetType 死代码 ✅

**原代码**：`if (!isNetType && info.address.toLowerCase() === sourceAddrLower) continue;`
**原因**：`extractNetPositionConstraint` 入口 `if (!type.startsWith('AAVE_NET_')) return null` 保证 type 一定是 AAVE_NET_ 前缀，而现有 AAVE_NET_ 子类型只有 LENDING 和 BORROWING，`isNetType` 恒为 true。
**清理**：commit `c9fcf02` 后，删除 `isNetType` 变量和 L1670 条件分支。

## Open Questions

### Q1: AAVE_V4_HUB_SUPPLY / AAVE_V4_SPOKE_SUPPLY 的 parent-child 关系

V4 Hub (parent) + V4 Spoke (child) 是 Merkl 的 parent-child opportunity 机制。Hub 的 distributionType 为 AAVE_V4_NET_APR（target total APR），Spoke 的 distributionType 为 DUTCH_AUCTION。用户存入 Spoke 时自动跟随 Hub 的 APR 计算，但 parent-child rewards 不叠加。

核心疑问：用户存入符合 child opportunity 的 Spoke 时，是否自动走 child 的 APR？能否选择 parent 的 APR？待查 Merkl 官方文档和 Aave V4 SDK。

### Q2: Borrow ETH cbETH cross-asset offset

[AAV-895](https://linear.app/aaveapy/issue/AAV-895) — 非 AAVE_NET_ 类型但需要 net constraint，offset 是不同资产（cbETH supply offset ETH borrow）。需专用公式。

## References

- `packages/aave-fetcher/src/merkl-api.ts`: `detectNetPositionConstraint`, `extractNetPositionConstraint`, `extractOffsetTokenAddresses`, `resolveOffsetReserveIds`
- `packages/aave-fetcher/src/merklLlmClient.ts`: `fetchAvailableModels`, `buildModelChain`, `callLlmWithFallback`
- `packages/aave-fetcher/src/index.ts`: Layer 3 调用处

# Handoff: Merkl NPC Offset Matching Bug + AAVE_V4_SPOKE_SUPPLY 调查

## 当前 Commit

`165fade` — fix(merkl): distributionType from breakdown level, LLM unparseable=fallback, remove OpenRouter

## 已完成

1. ✅ distributionType 从 breakdown 级别提取（`rewardBreakdown.distributionType`）替代 opp 顶层
2. ✅ LLM 空内容视为未回答（`llmAnswered` 只在成功解析后设 true）
3. ✅ OpenRouter 免费模型删除
4. ✅ Code review 修复 C1: `merklPointsFieldsFromBreakdownValue` 中的 `opp.distributionType` → `rewardBreakdown.distributionType`

## 待修复 Bug（高优先级）

### BUG-1: `tokenAddrToReserveId` 反查 Map 的 key 冲突问题

**文件**: `packages/aave-fetcher/src/merkl-api.ts:1360-1376`

**问题**: `tokenAddrToReserveId` 用 `chainTokenKey(chainId, address)` 即 `chainId:address` 作为 key。但同一个 `chainId:address` 可能对应**多个** reserveId：

- **V3**: 不同 pool 中同一个 token → `1:0xabc` 可能映射到 `1:poolA:0xabc` 和 `1:poolB:0xabc`
- **V4**: 同一个 spoke 下不同 hub 的同一个 token → `1:0xabc` 可能映射到 `1:spoke1:0xabc:hubA` 和 `1:spoke1:0xabc:hubB`
- **V3 vs V4**: 同一个 chainId 下同一个 underlying token 可能同时存在于 V3 pool 和 V4 spoke

当前代码用 `if (!tokenAddrToReserveId.has(key))` 只保留第一个映射，后续的 reserveId 被丢弃。

**影响**:
1. `processMerklData` 中 `oppReserveId = tokenAddrToReserveId.get(...)` 只能拿到一个 reserveId，可能拿错
2. 如果 Merkl opp 的 `explorerAddress` 指向的 token 在多个 reserve 中存在，只能匹配第一个
3. `extractOffsetTokenAddresses` 依赖 `oppReserveId` 来限定 offset 搜索范围，拿错 oppReserveId 就会限定错范围

**用户原话**: "从一开始那个tokenaddrtoreserveid好像就是不对的，因为chainid address可能会map到多个reserveid"

**调研方向**:
- 看 Aave Interface 前端是怎么做 Merkl opp → reserve 匹配的
- 考虑是否需要把 `tokenAddrToReserveId` 从 `Map<string, string>` 改为 `Map<string, string[]>`
- 或者在匹配时使用更多上下文（如 opp 的 type/pool 信息）来消歧

**调研 Aave Interface 前端匹配机制（已完成）**:

源码：`aave/interface` 仓库，`src/hooks/useMerklIncentives.ts`

### Aave Interface 的匹配方式

核心过滤逻辑（第 172-177 行）：
```typescript
const opportunities = merklOpportunities.filter(
  (opportunitiy) =>
    rewardedAsset &&
    opportunitiy.explorerAddress.toLowerCase() === rewardedAsset.toLowerCase() &&
    protocolAction &&
    checkOpportunityAction(opportunitiy.action, protocolAction) &&
    opportunitiy.chainId === currentChainId
);
```

匹配维度：`explorerAddress === rewardedAsset`（underlying token 地址）+ `chainId` + `action`

**关键发现**：Aave Interface **不做 reserveId 级别的匹配，也没有 pool/spoke/hub 维度的消歧**。它依赖单 market UI 上下文隐式消歧。

**Aave Interface 没有 offset token / NPC 概念**——只做 APR 叠加，不做 NPC 判断。

### AaveChan 白名单机制

`AaveChan/aave-merkl-token-whitelist` 提供 `whitelistedRewardTokens`（所有 V3 market 的 UNDERLYING + A_TOKEN）和 `additionalIncentiveInfo`（按 A_TOKEN 地址索引）。

### 为什么 Aave Interface 不需要精确匹配

单 market 前端，用户同一时间只看一个 market，同一 chainId + underlying token 在不同 market 的 reserve 不会同时出现。

### 对我们后端的影响

Aave Interface 的方案对我们**不适用**：我们是全市场聚合，所有 market 的 reserves 同时存在。

---

### 实际 Merkl API 数据分析（2026-06-22 快照）

共 27 个 LIVE opp，类型分布：AAVE_NET_LENDING(7), MULTILOG_DUTCH(6), AAVE_NET_BORROWING(6), AAVE_SUPPLY(2), AAVE_V4_HUB_SUPPLY(2), AAVE_V4_SPOKE_SUPPLY(2), ERC20_MAPPING(1), ERC20LOGPROCESSOR(1)

#### V3 匹配情况

当前 V3 opp 中 `chainId + explorerAddress` **没有 1:N 冲突**。但用户指出：Lido/EtherFi/Horizon 等独立 market 也有 campaign。

Horizon opp 的 `explorerAddress` 是 **aToken 地址**。

**实测数据（2026-06-22 验证，已修正）**：
- Merkl Horizon RLUSD opp `explorerAddress` = `0xE3190143Eb552456F88464662f0c0C4aC67A77eB`
- opp `tokens[0].symbol` = `aHorRwaRLUSD`，`tokens[0].address` = `0xE3190143...`（与 explorerAddress 相同）
- 我们 Horizon RLUSD reserve：
  - `reserveId` = `1:0xae05cd22df81871bc7cc2a04becfb516bfe332c8:0x8292bb45bf1ee4d140127049757c2e0ff06317ed`
  - `tokenAddress` = `0x8292bb45bf1ee4d140127049757c2e0ff06317ed`（RLUSD underlying）
  - `aTokenAddress` = `0xe3190143eb552456f88464662f0c0c4ac67a77eb`（= opp 的 explorerAddress！）

**之前 handoff 的错误描述已修正**：`0xE3190143...` **不是**"另一个 reserve（USDC）的 aToken"，它就是 RLUSD reserve **自身**的 aTokenAddress。用户纠正了这一点。

**当前 `tokenAddrToReserveId` 对 Horizon opp 的匹配是正确的**——`tokenAddrToReserveId` 注册了每个 reserve 的 `tokenAddress`、`aTokenAddress`、`vTokenAddress`，所以通过 aTokenAddress `0xE3190143...` 可以正确匹配到 RLUSD reserve。

**路径 B 同样正确**：`findMatchingMerklOpportunities` 会将 `item.aTokenAddress` 加入 `tokenAddressesToCheck`，Horizon opp 的 `explorerAddress` 匹配到 aTokenAddress 索引条目，进而匹配到正确的 RLUSD reserve。

**V3 结论**：当前数据下，V3 的匹配机制（`tokenAddrToReserveId` 注册 tokenAddress + aTokenAddress + vTokenAddress）可以正确匹配所有 V3 opp，包括 Horizon。暂无实际 bug。但设计上脆弱——如果未来同一 chainId 同一地址在不同 pool 中被注册为不同类型的 token（如 aToken 和 vToken 地址相同），可能出问题。

#### V4 匹配情况（关键！）

**V4 HUB_SUPPLY opp**：
- `explorerAddress` = spoke 侧 underlying token 地址（= 我们 reserve 的 `tokenAddress`，= `tokens[0].address`）
- campaign `distributionSettings` 有：`hubAddress` + `targetToken` + `mode` + `targetAPR`
- **没有 spokeAddress**
- opp 的 `tokens[0].address` = spoke 侧 underlying token 地址

**`ds.targetToken` 的含义（2026-06-22 验证，已修正）**：

实测数据（来自 Merkl API campaign 的 `params.distributionMethodParameters.distributionSettings`）：

USDG HUB_SUPPLY campaign:
- `underlyingToken` (params) = `0xe343167631d89B6Ffc58B88d6b7fB0228795491D` (USDG spoke 侧)
- `ds.targetToken` = `0x44E12914eBFB4e4b5bcB4afb359eCca7D51e5E8a`
- `opp.identifier` = `0x44E12914eBFB4e4b5bcB4afb359eCca7D51e5E8a`（= ds.targetToken！）
- `ds.hubAddress` = `0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9` (Core Hub)
- `assetId` = `8` (Hub 上的 asset 数字 ID)

frxUSD HUB_SUPPLY campaign:
- `underlyingToken` (params) = `0xCAcd6fd266aF91b8AeD52aCCc382b4e165586E29` (frxUSD spoke 侧)
- `ds.targetToken` = `0x92695585cCac2945Ae3019c9b19a754E0402979b`
- `opp.identifier` = `0x92695585cCac2945Ae3019c9b19a754E0402979b`（= ds.targetToken！）
- `ds.hubAddress` = `0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9` (Core Hub)
- `assetId` = `9`

**结论**：`ds.targetToken` **不是** Hub 合约上的 token 地址（Hub 用 `assetId` 数字标识资产）。`ds.targetToken` = `opp.identifier`，是 Merkl 系统中 Hub asset 的内部标识符。之前描述为"Hub 侧 token 地址"不准确。

- 匹配 reserve 应该用 `explorerAddress`（= underlyingToken = 我们 reserve 的 `tokenAddress`），不用 `ds.targetToken`
- `ds.hubAddress` 是真正有用的消歧维度

**V4 SPOKE_SUPPLY opp（2026-06-22 验证，已修正）**：

实测数据（来自 Merkl API campaign 的 `params`）：

USDG SPOKE_SUPPLY:
- `explorerAddress` = `0x94e7A5dCbE816e498b89aB752661904E2F56c485` (Main Spoke 合约地址)
- `tokens[0].address` = `0xe343167631d89B6Ffc58B88d6b7fB0228795491D` (USDG underlying token)
- `params.spokeAddress` = `0x94e7A5dCbE816e498b89aB752661904E2F56c485` (= explorerAddress)
- `params.hubAddress` = `0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9` (Core Hub)
- `params.underlyingToken` = `0xe343167631d89B6Ffc58B88d6b7fB0228795491D` (USDG)

frxUSD SPOKE_SUPPLY:
- `explorerAddress` = `0x94e7A5dCbE816e498b89aB752661904E2F56c485` (同一个 Main Spoke)
- `tokens[0].address` = `0xCAcd6fd266aF91b8AeD52aCCc382b4e165586E29` (frxUSD underlying token)
- `params.spokeAddress` = `0x94e7A5dCbE816e498b89aB752661904E2F56c485`
- `params.hubAddress` = `0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9` (Core Hub)
- `params.underlyingToken` = `0xCAcd6fd266aF91b8AeD52aCCc382b4e165586E29` (frxUSD)

**SPOKE_SUPPLY 有完整 4 维度**：chainId + spokeAddress + underlyingToken + hubAddress = 可以精确定位 V4 reserve！

之前描述"SPOKE_SUPPLY 缺 targetToken"不准确。SPOKE_SUPPLY 的 `explorerAddress` 是 spoke 合约地址，但 underlying token 在 `tokens[0].address` 和 `params.underlyingToken` 中都有。

**但 SPOKE_SUPPLY 已被 ADR-0030 跳过，暂不影响。**

**V4 匹配缺失维度总结（已修正）**：

| opp type | explorerAddress | 有 hubAddress? | 有 spokeAddress? | 有 underlyingToken? | 能否精确定位 reserve? |
|---|---|---|---|---|---|
| HUB_SUPPLY | underlying token | ✅ (ds.hubAddress) | ❌ | ✅ (params.underlyingToken = explorerAddress) | ❌ 缺 spokeAddress |
| SPOKE_SUPPLY | spoke 合约 | ✅ (params.hubAddress) | ✅ (params.spokeAddress) | ✅ (params.underlyingToken + tokens[0].address) | ✅ 全部 4 维度 |

**我们 reserveId 需要的维度**：`chainId:spokeAddress:tokenAddress:hubAddress`

HUB_SUPPLY 缺少 spokeAddress，SPOKE_SUPPLY 缺少 targetToken（但 explorerAddress 是 spoke 不是 token）。

**spokeHubTopology 不可用的原因**（用户指出）：
1. spokeHubTopology 是 1:N 的（一个 spoke 可以连多个 hub）
2. 即使知道了 spoke 对应哪些 hub，也不知道这个 campaign 对应哪个 hub
3. 但 HUB_SUPPLY 的 `ds.hubAddress` 已经提供了 hub 地址，所以关键缺失的是 spokeAddress

**可能的 V4 匹配路径**：

HUB_SUPPLY：`chainId` + `ds.hubAddress` + `explorerAddress`(=tokenAddress) = 3/4 维度，缺 `spokeAddress`

**关键假设**（已证伪）：同一个 Hub 的同一个 underlying token 在同一 chainId 下通常只存在于一个 spoke。

**实际数据**（来自 `v3v4-enriched-full.json`，355 个 reserves）：同一 hub + 同一 underlying token 在多个 spoke 上存在，1:N 是**常态**而非例外：
- USDG 在 Core Hub 上有 3 个 spoke（Gold/Forex/Main）
- USDC 在 Core Hub 上有 5 个 spoke
- USDT 在 Core Hub 上有 5 个 spoke
- WETH 在 Core Hub 上有 4 个 spoke
- 共有 **16 组** `chainId + tokenAddress + hubAddress` 存在 1:N（2~5 个 spoke）

**结论**：`chainId + hubAddress + targetToken` 无法唯一定位 V4 reserve。HUB_SUPPLY opp 缺少 `spokeAddress` 是**根本性的信息缺失**。

**关键发现：HUB_SUPPLY 的 `explorerAddress` ≠ `ds.targetToken`**：
- `explorerAddress` = spoke 侧的 underlying token 地址 = 我们 reserve 的 `tokenAddress`
- `ds.targetToken` = Hub 侧的 token 地址（同一个资产在 Hub 和 Spoke 上地址不同）
- 匹配 reserve 应该用 `explorerAddress`（= tokenAddress），不是 `ds.targetToken`

SPOKE_SUPPLY：`chainId` + `params.hubAddress` + `params.spokeAddress` = 3/4 维度，缺 `tokenAddress`
→ SPOKE_SUPPLY 的 `explorerAddress` 是 spoke 合约，不是 token
→ 但 SPOKE_SUPPLY 已经被我们跳过（ADR-0030: Skip V4 Spoke opp），所以不需要匹配

### BUG-2: `resolveOffsetReserveIds` 用 pool/spoke 前缀限定可能不正确

**文件**: `packages/aave-fetcher/src/merkl-api.ts:212-236`

**问题**: `resolveOffsetReserveIds` 用 `extractPoolSpokePrefix(oppReserveId)` 取前两段（`chainId:poolOrSpokeAddress`），然后在 `reserveIdSet` 中用 `startsWith(prefix + ':' + offsetAddr)` 匹配。

- **V3**: prefix = `chainId:poolAddress`，candidate = `chainId:poolAddress:offsetTokenAddr` — 这是精确匹配，没问题
- **V4**: prefix = `chainId:spokeAddress`，base = `chainId:spokeAddress:offsetTokenAddr`，然后匹配所有 `startsWith(base + ':')` — 这会匹配到**同一 spoke 下所有 hub 的同一个 token**

**具体问题**: V4 reserveId 格式是 `chainId:spokeAddress:tokenAddress:hubAddress`。如果同一个 spoke 连了多个 hub，同一个 token 在不同 hub 下是不同的 reserve。用 `startsWith` 会把所有 hub 的 reserve 都匹配上，无法区分。

**另一个问题**: 有些 campaign 明确要求跨 pool 也算 offset，当前严格限定同 pool/spoke 会漏掉跨 pool 的 offset。但 campaign 数据中没有 message/description 可以判断。

**调研方向**:
- 看 Aave Interface 前端如何处理 V4 hub/spoke offset 匹配
- 是否需要从 Merkl campaign 的 `distributionSettings.hubAddress` 提取 hub 信息来精确定位
- 考虑跨 pool offset 的场景

### BUG-3: `opp.distributionType` 其他引用点未同步修复

**文件**: `packages/aave-fetcher/src/merkl-api.ts`

**问题**: Code review 发现以下行仍然使用 `opp.distributionType`（始终为空）：

- **1214 行**: `normalizeForecastCampaignTypeLite({ distributionType: opp.distributionType })` — campaign 类型识别可能失效
- **1297 行**: 同上
- **1308 行**: `resolveCampaignApr(campaign, opp.distributionType, ...)` — APR 解析可能走错分支

这些在 `campaignDetailsCache` 构建阶段（`buildForecastCampaignMetaLiteMap` 调用链），此时还没有 `rewardBreakdown` 可用。需要从 `campaign` 对象获取 `distributionType`。

- **1696 行**: `NET_DISTRIBUTION_TYPES.has(opp.distributionType.toUpperCase())` — 这个在 `extractNetPositionConstraint` 中，已通过本次修复从 `MerklOpportunityData.distributionType` 读取，是正确的。

**注意**: 1214/1297/1308 行的 `opp` 是原始 `MerklOpportunity` 类型（API 返回的），不是我们构建的 `MerklOpportunityData`。需要确认 Merkl API 的 opp 对象上 `distributionType` 是否真的为空，还是仅在某些情况下为空。

## 待调查问题

### AAVE_V4_SPOKE_SUPPLY 没有被 API 输出

Merkl API 返回的 opp 中，AAVE_V4_SPOKE_SUPPLY 类型的 opp 没有出现在我们的处理结果中。可能原因：

1. Merkl API 本身没有返回这类 opp
2. 我们的过滤逻辑（`protocolVersion` 匹配、`explorerAddress` 检查等）把它过滤掉了
3. opp 的 `distributionType` 是 `DUTCH_AUCTION`（不是 `AAVE_V4_NET_APR`），可能走了不同的处理路径

**调研步骤**:
- 直接调 Merkl API `https://api.merkl.xyz/v4/opportunities?mainProtocolId=aave,tydro&status=LIVE&campaigns=true&items=100` 搜索 `AAVE_V4_SPOKE_SUPPLY`
- 检查 `deriveProtocolVersion` 是否正确处理了 `AAVE_V4_SPOKE_SUPPLY` type
- 检查 `processMerklData` 的过滤逻辑是否把它过滤掉了

### Parent/child opportunity 机制

用户之前给过一段关于 parent-child opportunity 关系的疑问文字。Merkl API 中，某些 opp 可能是其他 opp 的子 opp（例如 HUB_SUPPLY 和 SPOKE_SUPPLY 的关系）。需要：

1. 找到用户之前的描述
2. 调研 Merkl API 中 parent/child 的数据结构
3. 确认我们的处理逻辑是否正确处理了这种关系

## 关键数据结构参考

### Merkl API opp 的 campaign 结构（V4 HUB_SUPPLY 例子）

```json
{
  "distributionType": "AAVE_V4_NET_APR",  // ← 在 campaign 级别，不在 opp 顶层
  "distributionSettings": {
    "side": "supply",
    "targetToken": "0x...",  // underlying token 地址
    "hubAddress": "0x...",   // hub 地址
    "mode": "MAX_APR"        // 这是 TARGET_TOTAL_APR 的一种 dilutive mode，不是"规范化"
  },
  // Merkl API 没有 offsetTokenAddresses 字段 — 不用浪费资源去找
  "params": {
    "tokens": []  // 空，没有 token 列表
  }
}
```

### V3 vs V4 reserveId 格式

- **V3**: `chainId:poolAddress:tokenAddress`（3段）
- **V4**: `chainId:spokeAddress:tokenAddress:hubAddress`（4段）

### findMatchingMerklOpportunities 匹配机制

**文件**: `packages/aave-fetcher/src/merkl-api.ts:1747-1794`

匹配逻辑：
1. 输入：一个 reserve（`item`，有 `chainId`, `tokenAddress`, `aTokenAddress`, `vTokenAddress`）+ `merklData` 索引 + `protocolVersion`
2. 构建 `tokenAddressesToCheck` 列表：`[tokenAddress, aTokenAddress, vTokenAddress]`（全部 lowercase）
3. 对每个 tokenAddr，构建 indexKey = `chainId-tokenAddr`
4. 从 `merklData[indexKey]` 获取匹配的 opp 列表
5. 过滤：`opp.protocolVersion === protocolVersion`（V3 reserve 只匹配 V3 opp，V4 只匹配 V4）
6. 返回去重后的匹配 opp 列表

**问题**:
- `merklData` 的 key 是 `chainId-explorerAddress`（在 `processMerklData` 中构建）
- `findMatchingMerklOpportunities` 的 key 也是 `chainId-tokenAddr`
- 两者都用 `chainId:address` 格式，**不包含 pool/spoke/hub 信息**
- 同一个 underlying token 在不同 pool/spoke 下的 opp 都会匹配到同一个 key 下
- 唯一的消歧手段是 `protocolVersion` 过滤（V3 vs V4），但无法区分同一 chainId+tokenAddress 下不同 V3 pool 或不同 V4 hub

### 两路径对比

**路径 A** — `processMerklData` 中（构建索引时）：
```
baseDataset → 遍历每个 reserve 的 tokenAddress/aTokenAddress/vTokenAddress/spokeAddress
  → 构建 tokenAddrToReserveId: Map<chainId:address, reserveId>  ← 只保留第一个！
  → Merkl opp 的 explorerAddress → tokenAddrToReserveId.get(chainId:explorerAddress) → oppReserveId
  → extractOffsetTokenAddresses(opp, oppReserveId, reserveIdSet) → offsetTokenAddresses 写入 MerklOpportunityData
```

**路径 B** — `enrichDatasetWithIncentiveData` 中（使用索引时）：
```
遍历 baseDataset 的每个 reserve (item)
  → findMatchingMerklOpportunities(item, merklData, reserveProtocolVersion) → matchedOpportunities
  → detectNetPositionConstraint(opp, item.tokenAddress, item.reserveId, ...)
    → item.reserveId 直接传入作为 oppReserveId（不是从 Merkl 反查的）
```

路径 B 的 `item.reserveId` 是**当前正在被 enrich 的 reserve** 的 ID。同一个 token address 在不同 pool/spoke/hub 下会有不同 reserveId，所以不是简单的全局反查，`resolveOffsetReserveIds` 用 oppReserveId 的 pool/spoke 前缀限定范围。

**但路径 A 的 `tokenAddrToReserveId` 只存了一个 reserveId**，如果 opp 的 explorerAddress 对应的 token 在多个 reserve 中存在，路径 A 会拿到错误的 oppReserveId。

## 修正用户对 V4 HUB_SUPPLY campaign 的理解

之前的 handoff 写了：
> `distributionSettings.mode: "MAX_APR" → 规范化为 TARGET_TOTAL_APR`

这是不正确的。用户纠正：
- `MAX_APR` 不是"规范化为" TARGET_TOTAL_APR，而是 TARGET_TOTAL_APR 这种 distribution type 的一种 **dilutive mode**
- Merkl API **没有** `offsetTokenAddresses` 字段 — 不用浪费资源去找

## 下一步建议

1. **BUG-1 (tokenAddrToReserveId 冲突)**: 最高优先级。见下方解决方案
2. **BUG-2 (resolveOffsetReserveIds 前缀匹配)**: 与 BUG-1 相关。V4 hub 维度需要考虑
3. **BUG-3 (opp.distributionType 其他引用)**: 中等优先级，确认 1214/1297/1308 行的实际影响
4. **AAVE_V4_SPOKE_SUPPLY 调查**: 中等优先级
5. **Parent/child opportunity**: 低优先级，待用户确认

## 解决方案设计

### BUG-1 分层分析

#### V3 层：`chainId + explorerAddress` 当前实际是 1:1

当前 Merkl API 的 V3 opp 中没有 `chainId + explorerAddress` 的 1:N 冲突。Horizon 等独立 market 的 opp 用包装合约地址，不会和 Main Pool 的 underlying token 地址冲突。

**V3 的 `tokenAddrToReserveId` 在当前数据下实际上不会出 bug**——因为 Merkl 的 opp → address 映射是 1:1。但如果未来同一 token 在 Main Pool 和 Lido Pool 都出现 Merkl campaign，就会有问题。

**V3 结论**：`tokenAddrToReserveId` 在 V3 下**暂无实际 bug**，但设计上脆弱。建议在修复 V4 时一并重构，不单独处理。

#### V4 层：`chainId + explorerAddress` 是 1:N，且无法从 opp 直接获取完整 reserveId

**核心矛盾**：V4 HUB_SUPPLY opp 缺少 `spokeAddress`。

HUB_SUPPLY 有：`chainId` + `ds.hubAddress` + `explorerAddress`(=tokenAddress) = 3/4 维度
我们 reserveId 需要：`chainId:spokeAddress:tokenAddress:hubAddress` = 4 维度

**假设"同一 hub 同一 token 只在一个 spoke"已证伪**：实测数据中 16 组存在 2~5 个 spoke 的 1:N。V4 1:N 是**常态**。

`ds.targetToken` ≠ `explorerAddress`（2026-06-22 修正）：
- `explorerAddress` = spoke 侧 underlying token = 我们 reserve 的 `tokenAddress`
- `ds.targetToken` = Merkl 系统的 Hub asset identifier（= `opp.identifier`），不是 Hub 合约上的 token 地址
- Hub 合约用 `assetId`（数字，如 `8`=USDG, `9`=frxUSD）标识资产，不用 ERC20 地址
- 匹配 reserve 应用 `explorerAddress`，不是 `ds.targetToken`

#### V4 层：spokeHubTopology 不可用（用户已指出）

spokeHubTopology 是 1:N 的（一个 spoke 连多个 hub），知道了 spoke 对应哪些 hub 也不能确定 campaign 对应哪个 spoke。但 HUB_SUPPLY 的 `ds.hubAddress` 已经提供了 hub，所以不需要从 topology 反查 hub。

### BUG-1 + BUG-2 统一解决方案：路径 A 仍是最优

**核心思路不变**：删除路径 A 的 `tokenAddrToReserveId` 反查，offset 移到路径 B（`enrichDatasetWithIncentiveData`），用 `item.reserveId` 精确匹配。

#### V3 offset 在路径 B 中的处理

- `item.reserveId` = `chainId:poolAddress:tokenAddress`（精确）
- `resolveOffsetReserveIds(item.reserveId, offsetAddr, reserveIdSet)` → V3 分支精确匹配 ✅

#### V4 offset 在路径 B 中的处理

- `item.reserveId` = `chainId:spokeAddress:tokenAddress:hubAddress`（精确 4 段）
- `resolveOffsetReserveIds` 的 V4 分支用 `startsWith(base + ':')` 匹配同一 spoke 下所有 hub → **BUG-2 仍需修复**
- 修复：V4 分支改为**精确匹配**（完整 4 段），而非 prefix match

#### V4 HUB_SUPPLY opp 匹配 reserve 的问题（路径 B `findMatchingMerklOpportunities`）

路径 B 中，`findMatchingMerklOpportunities` 用 `chainId + explorerAddress` 做索引查找：
- HUB_SUPPLY 的 `explorerAddress` = spoke 侧 underlying token 地址
- 同一个 underlying token 在不同 spoke 下有不同 reserve，但 opp 会被索引到同一个 key 下
- 路径 B 中 `opp.protocolVersion === protocolVersion` 可以区分 V3/V4
- 但无法区分 V4 同一 chainId 同一 token 在不同 spoke 下的 reserve

**然而**：路径 B 的调用方式是遍历 `baseDataset` 的每个 reserve，对每个 reserve 用 `findMatchingMerklOpportunities(item, merklData)` 获取匹配的 opp 列表。这意味着：
- V4 reserve `chainId:spoke1:tokenA:hub1` 会匹配到所有 `explorerAddress = tokenA` 的 V4 opp
- V4 reserve `chainId:spoke2:tokenA:hub1` 也会匹配到相同的 opp

**这是正确行为吗？** 如果同一个 underlying token 在两个不同 spoke 上都有 reserve，而 Merkl 只有一个 HUB_SUPPLY opp（因为 Hub 是统一的），那**所有这些 reserve 都应该拿到这个 opp 的 incentive**。这就是 Aave Interface 的做法——所有 reserve 都拿到同一个 Merkl APR。

**但这里有个微妙问题**：同一个 Hub 的同一个 token 在 5 个 spoke 上都有 reserve，但 Merkl 的 HUB_SUPPLY opp 只有一个 APR 值。这个 APR 是该 token 在 Hub 层面的统一 APR，还是特定于某个 spoke？

从 Merkl 的角度：HUB_SUPPLY 是针对 Hub 层面的，APR 是该 Hub 上这个 token 的统一 supply rate。所有连接到这个 Hub 的 spoke 上的同一 token reserve 都共享这个 APR。所以**所有匹配到的 reserve 都拿到相同 APR 是正确的**。

**但 NPC/offset 信息是 per-reserve 的**：同一个 Hub 下的同一 token，不同 spoke 的 offset token 不同。所以 offset/NPC 需要用 `item.reserveId` 精确限定。

### 实施步骤

1. **删除路径 A 的 `tokenAddrToReserveId`**（消除 bug 源头）
2. **`MerklOpportunityData.offsetTokenAddresses` 字段移除**（它是 per-reserve 的，不是 per-opp 的）
3. **在路径 B 的 enrich 循环中**，对每个匹配的 opp 计算 offset：
   - 调用 `extractOffsetTokenAddresses(opp, item.reserveId, reserveIdSet, offsetLevel)`
   - 将结果写入 item 级别的字段
4. **修复 `resolveOffsetReserveIds` 的 V4 分支**：改为精确匹配（完整 4 段），而非 `startsWith`
5. **V3 不需要额外处理**——当前 1:1，路径 B 的 `item.reserveId` 精确匹配足够

### 待讨论：V4 HUB_SUPPLY 的 hubAddress 过滤

当前 `findMatchingMerklOpportunities` 不检查 `hubAddress`。如果同一个 token 在不同 hub 上都有 HUB_SUPPLY opp（如 Core Hub 和 Prime Hub），那同一个 reserve 会匹配到所有 hub 的 opp。但我们的 reserveId 包含 hubAddress，所以可以进一步过滤：

**可选增强**：在 `findMatchingMerklOpportunities` 中，对 V4 opp 增加 `ds.hubAddress === item.hubAddress` 过滤，确保只匹配同一个 hub 的 opp。需要从 opp 的 campaign 中提取 hubAddress。

---

## 2026-06-22 验证结论（修正 3 个错误描述）

### Q1: V3 Horizon opp 的 explorerAddress ✅ 已验证

**之前错误**：handoff 写"Horizon opp 的 `explorerAddress=0xE3190143...` 是另一个 reserve（USDC）的 aTokenAddress"

**实际**：`0xE3190143...` 就是 RLUSD reserve **自身**的 `aTokenAddress`（symbol=aHorRwaRLUSD）。通过 aTokenAddress 可以正确匹配到 RLUSD reserve。

**V3 结论更新**：V3 匹配机制在当前数据下工作正确。`tokenAddrToReserveId` 注册了 tokenAddress + aTokenAddress + vTokenAddress，Horizon opp 通过 aTokenAddress 匹配正确。

### Q2: V4 HUB_SUPPLY 的 ds.targetToken ✅ 已验证

**之前错误**：handoff 写"ds.targetToken = Hub 侧 token 地址（V4 Hub 有自己的 token 映射，同一资产在 Hub 和 Spoke 上地址不同）"

**实际**：`ds.targetToken` = `opp.identifier`，是 Merkl 系统的 Hub asset 内部标识符，不是 Hub 合约上的 token 地址。Hub 合约用 `assetId`（数字）标识资产。

**对匹配的影响**：`ds.targetToken` 对我们没有用。匹配 reserve 用 `explorerAddress`（= underlyingToken）+ `ds.hubAddress`（消歧）。

### Q3: V4 SPOKE_SUPPLY 的信息完整性 ✅ 已验证

**之前错误**：handoff 写"SPOKE_SUPPLY 缺 targetToken"，表格中标注 spokeAddress ✅ 但 targetToken ❌

**实际**：SPOKE_SUPPLY 有**完整 4 维度**：
- `explorerAddress` = spoke 合约地址
- `params.spokeAddress` = spoke 合约地址
- `params.hubAddress` = hub 地址
- `params.underlyingToken` / `tokens[0].address` = underlying token 地址

SPOKE_SUPPLY 可以精确定位 V4 reserve。之前描述"缺 targetToken"不准确——SPOKE_SUPPLY 不需要 ds.targetToken，它有 underlyingToken。

### 最终匹配语义确认（用户确认 2026-06-22）

| opp 类型 | 匹配维度 | 匹配关系 | 说明 |
|---|---|---|---|
| V3 (NET_LENDING/SUPPLY 等) | `chainId` + `explorerAddress` → tokenAddr/aTokenAddr/vTokenAddr | 1:1 | 当前数据下无冲突 |
| V4 SPOKE_SUPPLY | `chainId` + `spokeAddress` + `underlyingToken` + `hubAddress` | 1:1 | 完整 4 维度，但 ADR-0030 已跳过 |
| V4 HUB_SUPPLY | `chainId` + `ds.hubAddress` + `explorerAddress`(=tokenAddress) | **1:N (正确行为)** | Hub 层 APR 统一覆盖所有 spoke 的 reserve |

**HUB_SUPPLY 的 1:N 不是 bug**——Hub 层 APR 是统一的，同 hub、同 token、同 chainId 下所有 spoke 的 reserve 都应该匹配到这个 opp。这是 Hub 机制的固有语义。

---

## 2026-06-22 Offset 跨 Reserve 语义调研

### 用户提出的核心问题

1. USDtb opp（跨 reserve NPC）的 campaign 参数中，有没有特殊参数能看出它是跨 reserve 的？
2. V4 HUB_SUPPLY 如果对 reserve 是 1:N，offset token 是不是也应该在 hub 内跨 reserve？
3. 跨 reserve campaign opp 的共性规律？
4. 其他 offset 是否默认 per-reserve？

### Merkl NPC 机制：`params.hooks` 中的 `hookType=14`

Merkl campaign 的 `params.hooks` 数组中，`hookType=14` 就是 NPC（Net Position Constraint）hook。

**USDtb AAVE_SUPPLY opp 的 NPC hooks 实测数据**：
```
hookType=14, protocol=2 (EtherFi), borrowBytesLike=[vToken地址]  ← 1 个
hookType=14, protocol=1 (Lido), borrowBytesLike=[vToken地址x2]   ← 2 个
hookType=14, protocol=0 (Main V3), borrowBytesLike=[32字节hashx3] ← 3 个（hash 格式！）
hookType=14, protocol=3 (Horizon), borrowBytesLike=[地址x5]      ← 5 个
```

**`protocol` 编号对应 Aave market**：
- 0 = V3 Main Pool
- 1 = Lido Market
- 2 = EtherFi Market
- 3 = Horizon Market

**`borrowBytesLike` 内容**：
- 对于 protocol 1/2/3：20 字节 ERC20 地址（vToken/debt token 地址）
- 对于 protocol 0 (V3 Main)：32 字节 keccak256 hash（不是地址！可能是 pool 地址的 hash 或 campaign encoding hash）
- 验证：protocol 2 的 `0xeA85a065F87FE28Aa8Fbf0D6C7deC472b106252C` = Main pool USDtb 的 vTokenAddress

**跨 reserve NPC 的判据**：`hookType=14` 的 hooks 中有**多个 protocol 值** → 该 opp 的 NPC 跨多个 Aave market（跨 reserve）。

### 三类 Offset 语义

#### 1. 同 Pool 内的 Net Position（AAVE_NET_LENDING/BORROWING）

**offset 来源**：`params.tokens` 数组同时包含 aToken 和 vToken/debt token
**offset 范围**：**per-reserve**（同一 pool 内，supply 减 borrow）
**NPC hooks**：无（hooks=0）
**实例**：USDm on MegaEth — params.tokens 有 aToken + variableDebtToken

```json
"tokens": [
  {"symbol": "aMegUSDm", "tokenAddress": "0x5dF828...", "underlyingToken": "0xFAfDdb..."},
  {"symbol": "variableDebtMegUSDm", "tokenAddress": "0x6B408d...", "underlyingToken": "0xFAfDdb..."}
]
```

**当前代码处理**：`extractOffsetTokenAddresses` 读取 `campaign.params.tokens`，获取 vToken 地址 → `resolveOffsetReserveIds` 在同 pool 内匹配 → ✅ 正确

#### 2. 跨 Market 的 Net Position（AAVE_SUPPLY + cross-protocol NPC hooks）

**offset 来源**：`params.hooks[hookType=14].borrowBytesLike` 中跨多个 protocol 的 vToken 地址
**offset 范围**：**跨 reserve**（同 chainId 同 token，但跨多个 Aave market）
**NPC hooks**：有，且多个 protocol 值
**实例**：USDtb on Ethereum — description: "Borrowers of USDtb on any Ethereum-based market or protocol are not eligible for rewards"

**跨 reserve 的含义**：
- 供给端：只在 Main pool 有 USDtb 供给 reserve（1 个 reserve）
- 抵消端：用户在 Main/Lido/EtherFi/Horizon 任一 market 借 USDtb 都会失去奖励
- 所以 offset 是**跨 reserve**的——需要检查用户在**所有** Aave market 上的 USDtb borrow

**当前代码处理**：`extractOffsetTokenAddresses` 读 `params.tokens`，但 USDtb opp 的 `params.tokens` 为空！NPC hooks 中的 borrowBytesLike **没有被当前代码处理**。这意味着：
- 路径 A：`offsetTokenAddresses` 为空 → 没有识别到 offset
- 路径 B：`extractNetPositionConstraint` 依赖 `opp.offsetTokenAddresses` → 为空 → 没有识别到 NPC
- 但 `distributionType=MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE` 不是 NET 类型 → L0 层直接跳过
- LLM 层可能识别出"borrowers not eligible"，但 `offsetTokenSymbols` 无法解析 hooks 中的地址

**结论**：USDtb opp 的 NPC 跨 reserve 语义在当前代码中**没有被处理**。但这是个 bug 还是 feature 取决于前端是否需要这个信息。

#### 3. V4 Hub 层面的 Net Position（AAVE_V4_HUB_SUPPLY）

**offset 来源**：无（hooks=0，无 params.tokens）
**offset 范围**：**hub 内跨 reserve**（Hub 层面的 net position = 同 hub 同 token 下所有 spoke 的 supply - borrow）
**NPC hooks**：无
**distributionType**：`AAVE_V4_NET_APR`，`ds.side=supply`
**实例**：USDG/frxUSD on Core Hub

**Hub 层 NPC 的语义**：
- HUB_SUPPLY 是针对 Hub 统一的 net supply APR
- 抵消端是同 Hub 上同一 token 的 borrow（跨所有 spoke）
- 所以 offset 应该是：同 chainId + 同 hubAddress + 同 tokenAddress 的**所有 borrow reserve**

**但 Merkl 没有显式指定 offset**——没有 hooks，没有 tokens，只有 `ds.side=supply`。这暗示 Merkl 在链上计算时自动处理了 Hub 层的 net position，不需要 campaign 创建者指定。

**当前代码处理**：`extractNetPositionConstraint` 检测到 `AAVE_V4_NET_APR` → `isNetDistribution=true` → sourceSide=supply → 但 `offsetTokenAddresses` 为空 → offsetReserveIds 只有 oppReserveId 自身。

### 跨 Reserve Offset 的共性规律

| 维度 | 同 Pool (AAVE_NET_*) | 跨 Market (AAVE_SUPPLY+NPC hooks) | V4 Hub (AAVE_V4_HUB_SUPPLY) |
|---|---|---|---|
| offset 来源 | `params.tokens` | `params.hooks[hookType=14].borrowBytesLike` | 无显式指定 |
| offset 范围 | per-reserve | 跨 reserve（跨 market） | hub 内跨 reserve（跨 spoke） |
| NPC hooks | 无 | 有，多 protocol | 无 |
| distributionType | AAVE_NET_APR / 其他 | 各种（非 NET 类型也可能有 NPC） | AAVE_V4_NET_APR |
| 当前代码支持 | ✅ | ❌ 未处理 hooks | ⚠️ 部分处理（缺跨 spoke offset） |

**共性规律**：
1. **有 `hookType=14` hooks → 有 NPC**，`protocol` 数量决定 offset 范围
2. **`AAVE_V4_NET_APR` → Hub 层 NPC**，offset 在 hub 内跨 spoke
3. **`AAVE_NET_APR` + 无 hooks → 同 pool NPC**，offset per-reserve
4. **跨 reserve 的关键信号**：hooks 中多 protocol 值（V3 跨 market）或 V4 hub 语义（hub 内跨 spoke）

### 默认 Offset 是否 Per-Reserve？

**是的，默认是 per-reserve**：

- 27 个 LIVE opp 中，只有 **1 个**（USDtb）是跨 market 的 NPC
- 2 个 V4 HUB_SUPPLY 是 hub 内跨 spoke（这是 V4 的固有语义，不是例外）
- 其余 24 个 opp 的 offset 都是 per-reserve（同 pool/spoke 内）
- AAVE_NET_LENDING/BORROWING（13+8=21 个）全部是同 pool 内的 net position，offset per-reserve
- DUTCH_AUCTION 等没有 NPC，offset 不适用

**例外**：跨 reserve NPC 只出现在 AAVE_SUPPLY 类型（非 NET 前缀），通过 `hookType=14` hooks 显式指定。这说明 Merkl 设计上"默认 per-reserve，跨 reserve 需要显式声明"。

### 对 `resolveOffsetReserveIds` 的影响

当前 `resolveOffsetReserveIds` 的 V4 分支：
- `offsetLevel='hub'`：精确匹配（完整 4 段 reserveId）→ per-reserve
- `offsetLevel='spoke'`：`startsWith(base + ':')` → 匹配同 spoke 下所有 hub → 跨 hub

**需要新增**：`offsetLevel='hub-cross-spoke'` → 匹配同 hub 同 token 下所有 spoke → V4 hub 内跨 reserve offset

或者更简单的方案：对于 V4 HUB_SUPPLY，offset 搜索范围改为 `chainId + hubAddress + tokenAddress` 前缀匹配（不限定 spokeAddress）。

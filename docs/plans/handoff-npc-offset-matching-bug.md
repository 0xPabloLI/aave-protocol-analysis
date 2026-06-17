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

**调研 Aave Interface 前端匹配机制（待执行）**:

需要查阅 Aave Interface 开源代码（`aave/interface` 仓库），重点关注：

1. **Merkl incentive 数据获取与匹配**：搜索关键词 `merkl`、`incentive`、`opportunity`，找到前端如何获取 Merkl 数据并关联到 reserve
2. **匹配维度**：前端是用什么维度做 opp → reserve 关联的？是仅用 `chainId + tokenAddress`，还是会用到 pool address / hub address / spoke address 等更多维度？
3. **V4 hub 消歧**：V4 场景下同一 spoke 同一 token 在不同 hub 的 reserve，前端如何区分？是否有使用 `distributionSettings.hubAddress` 来消歧？
4. **offset token 处理**：前端是否有 offset token 的概念？如果有，如何处理跨 pool/hub 的 offset 匹配？
5. **核心入口文件**（推测）：`src/ui-config/reserves/reserves.ts`、`src/hooks/useIncentives.ts` 或类似命名

关键问题：Aave Interface 前端可能根本不做 `reserveId` 级别的精确匹配——它可能直接用 Merkl opp 的 `explorerAddress` 和 reserve 的 underlying/aToken/vToken 做地址级匹配，然后依赖 UI 上下文（当前选中的 market/pool）来隐式消歧。这种方式不需要全局反查 Map。

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

1. **BUG-1 (tokenAddrToReserveId 冲突)**: 最高优先级。调研 Aave Interface 前端如何做 Merkl opp → reserve 匹配，考虑是否需要多值 Map 或更精确的消歧逻辑
2. **BUG-2 (resolveOffsetReserveIds 前缀匹配)**: 与 BUG-1 相关。V4 hub 维度需要考虑
3. **BUG-3 (opp.distributionType 其他引用)**: 中等优先级，确认 1214/1297/1308 行的实际影响
4. **AAVE_V4_SPOKE_SUPPLY 调查**: 中等优先级
5. **Parent/child opportunity**: 低优先级，待用户确认

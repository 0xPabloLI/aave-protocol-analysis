# Handoff: Merkl Index 优化 — Slice 2+3 方向文档

## 当前 Commit

`1d5cbfc` — Slice 1 地址类型驱动匹配 + AAV-906 hub-aware offset

## 已完成

1. ✅ Slice 1 (AAV-925): 地址类型驱动匹配 — V3 查 aToken/vToken, V4 查 underlying/spokeAddress
2. ✅ AAV-908: spokeAddress 加入 V4 查询列表
3. ✅ AAV-906: `resolveOffsetReserveIds` 支持 `offsetLevel` 参数
   - `offsetLevel='hub'`: 精确匹配 4-segment reserveId
   - `offsetLevel='spoke'`: 3-segment 前缀匹配（跨 hub）
   - V3 路径不受影响
4. ✅ 调用方推断 offsetLevel: `opp.type.includes('SPOKE_SUPPLY') ? 'spoke' : 'hub'`

**⚠️ 需修正**: 当前默认 offsetLevel 是 `'hub'`，但合约层 collateral 按 spoke 隔离，offset 语义应默认为 `'spoke'`。Slice 2/3 执行时需将默认值改为 `'spoke'`。详见下方"Offset Level 默认值修正"章节。

## BorrowBL 调查结论

### 数据事实

5 个 Merkl opportunity 包含 `BORROW_BL`（仅在 `identifier` 字段，不在 `opportunityType` 中）：

| Chain | Token | opportunityType | action | offset tokens |
|---|---|---|---|---|
| Ethereum | USDtb | `AAVE_SUPPLY` | LEND | 无 |
| Ethereum | USDe | `MULTILOG_DUTCH` | LEND | 无 |
| Plasma | USDe | `MULTILOG_DUTCH` | LEND | 无 |
| Mantle | USDe | `MULTILOG_DUTCH` | LEND | 无 |
| MegaETH | USDe | `AAVE_SUPPLY` | LEND | 无 |

- **所有 BORROW_BL opp 都没有 offset tokens**
- **不存在 SUPPLY_BL** — 0 个 borrow opportunity 带 `_BL` 后缀
- **BORROW_BL 只影响 supply 侧 incentive** — 有 borrow position → 该 supply incentive 归零

### BORROW_BL 语义

- `BORROW_BL` 出现在 Merkl `identifier` 字段（格式: `{explorerAddress}BORROW_BL`），不在 `opportunityType` 中
- 语义：**只要用户有 borrow position，整个 incentive 归零** — 比 NET 更严格
  - NET: borrow 量抵消 supply 量（按比例）
  - BORROW_BL: 存在 borrow → 奖励归零（二元排除）

### Merkl Hooks 详解（BORROW_BL 的实现机制）

**hookType=14** = 借款黑名单排除。共发现 4 个 protocol 级别：

| hookType | protocol | borrowBytesLike 内容 | 含义 | 出现 opp |
|---|---|---|---|---|
| 14 | 0 | 64 字节 hash（3 个） | 未知 position identifier | 仅 USDtb |
| 14 | 1 | 地址（2 个） | 跨市场 vToken | 仅 USDtb |
| 14 | 2 | **vToken 地址（1 个）** | Aave V3 vToken | 全部 5 个 opp |
| 14 | 3 | 地址（5 个） | 多资产 vToken | 仅 USDtb |

**protocol=2 是最常见模式**，borrowBytesLike 中是 Aave V3 的 variableDebtToken 地址。USDtb 最复杂，跨 4 个 protocol 排除 11 个地址/hash。

**hookType=17** = 健康因子门槛（仅 USDe/sUSDe opp），`healthFactorThreshold=2.5`，用户 HF 必须 >= 2.5 才有资格。

**注意**: hookType 的含义是**逆向推断**的，没有 Merkl 官方文档定义。protocol 字段的具体语义也未公开。

### BORROW_BL 与 NET 的区别

| | NET | BORROW_BL |
|---|---|---|
| 效果 | 按比例抵消 | 二元排除 |
| offset tokens | 有（`params.tokens`） | 无 |
| hooks | 无 | hookType=14 |
| 代码处理 | `extractNetPositionConstraint` | 未处理 |
| 适用的 incentive 侧 | supply | supply |
| 是否应生成 NPC | 是 | 否（语义不同） |

**BORROW_BL 不等同于 NET**。建议：
- 前端 simulation 中：用户有 borrow position → 对应 supply incentive 直接归零
- 不复用 `netPositionConstraint`，建议新增独立字段（如 `borrowBlacklist: boolean`）
- 单独开 issue 追踪

## V4 Collateral 隔离规则（已验证 → 结论性）

### 核心结论：Spoke 是隔离边界，Hub 不是

| 场景 | 能否用 collateral 借款？ | 原因 |
|---|---|---|
| SpokeA supply → SpokeB borrow | **不能** | `_userPositions` 和 `_positionStatus` 按 Spoke 存储 |
| 同 Spoke 内 hub1 supply → hub2 borrow | **能** | `_processUserAccountData` 不区分 Hub |
| 同 Spoke 同 Hub 不同 assetId | **能** | 最基本场景 |

源码：
- `SpokeStorage.sol:28-33` — storage 按 Spoke 隔离
- `Spoke.sol:718-767` — HF 计算遍历 `_positionStatus`，不按 Hub 分组
- `Spoke.MultipleHub.t.sol:90` — 测试：hub1 collateral → hub2 borrow 成功

文档：`aaveapy-doc/hub-spoke-position-isolation.md`

### 推论：offset level 默认应为 spoke

因为合约层 collateral 按 spoke 维度计算（跨 hub 但不跨 spoke），offset token 的匹配也应在 spoke 维度。**`resolveOffsetReserveIds` 的默认值应从 `'hub'` 改为 `'spoke'`。**

## Offset Level 默认值修正

当前实现中 `resolveOffsetReserveIds` 默认 `offsetLevel='hub'`，需修正为 `'spoke'`：

**需修改的函数签名**（默认值 `'hub'` → `'spoke'`）：
1. `resolveOffsetReserveIds(oppReserveId, offsetTokenAddress, reserveIdSet, offsetLevel='hub')` → `'spoke'`
2. `extractOffsetTokenAddresses(opp, oppReserveId, reserveIdSet, offsetLevel='hub')` → `'spoke'`
3. `extractNetPositionConstraint(opp, sourceTokenAddress, oppReserveId, reserveIdSet, offsetLevel='hub')` → `'spoke'`
4. `detectNetPositionConstraint(opp, ..., offsetLevel='hub')` → `'spoke'`

**调用方需同步修正**：
- `processMerklData` 中：不再需要 `opp.type.includes('SPOKE_SUPPLY') ? 'spoke' : 'hub'`，统一默认 `'spoke'`
- `enrichDatasetWithIncentiveData` 中：同上

**测试影响**：
- `resolveOffsetReserveIds-hub-aware.test.ts` 中 "V4 default" 测试需更新期望值
- `netPositionConstraint.test.ts` 中 V4 默认场景测试需更新
- `detectNetPositionConstraint.test.ts` 中 V4 默认场景测试需更新

**注意**：V3 路径不受 offsetLevel 影响（始终用 pool prefix 匹配），所以改默认值对 V3 无影响。

## HUB_SUPPLY vs SPOKE_SUPPLY 的地址可用性

| Campaign 类型 | `params.hubAddress` | `params.spokeAddress` | 能否唯一锚定 reserveId |
|---|---|---|---|
| HUB_SUPPLY (parent) | ✅ 有 | ❌ 无 | ❌ 不能 — 缺 spokeAddress，同一 hub+token 可对应多个 spoke |
| SPOKE_SUPPLY (child) | ✅ 有 | ✅ 有 | ✅ 能 — hubAddress + spokeAddress + underlying → 唯一 reserveId |

### HUB_SUPPLY campaign 跨 Spoke 的语义

HUB_SUPPLY opp 的 `explorerAddress` 是 underlying token，params 中有 `hubAddress` 但无 `spokeAddress`。
这意味着该 campaign 覆盖**该 hub 下所有 spoke 中的该 token reserve**。
在 Slice 2 重构时，HUB_SUPPLY opp 应映射到该 hub+token 下的**所有** reserveId。

## Slice 2+3 优化方向

### 当前问题：两阶段匹配

```
processMerklData:  opp.explorerAddress → merklData[chainId-explorerAddress] = MerklOpportunityData[]
enrichDataset:     reserve 地址 → 查 merklData → 匹配 opp
```

问题：
1. **索引 key 不精确**: `chainId-underlying` 在 V4 多 hub 场景下不唯一
2. **重复匹配逻辑**: index-building 和 matching 各做一遍
3. **offset token 与 opp 匹配割裂**: offset tokens 在 processMerklData 时可匹配，但到 enrichDataset 才消费
4. **HUB_SUPPLY opp 无法精确指向 reserve**: 缺 spokeAddress，同一 key 下汇聚多个 opp

### 最佳实践方向：按 reserveId 索引

```
当前: merklData[chainId-explorerAddress] → MerklOpportunityData[]
优化: merklData[reserveId] → MerklOpportunityData[]
```

### 实现步骤（无歧义，可直接执行）

#### Step 1: tokenAddrToReserveId 改为多值映射

文件：`packages/aave-fetcher/src/merkl-api.ts:1360-1382`

```typescript
// 当前 (Map<string, string>)
const tokenAddrToReserveId = new Map<string, string>();
// ...
if (!tokenAddrToReserveId.has(key)) tokenAddrToReserveId.set(key, reserveId);

// 改为 (Map<string, string[]>)
const tokenAddrToReserveId = new Map<string, string[]>();
// ...
const existing = tokenAddrToReserveId.get(key) ?? [];
if (!existing.includes(reserveId)) {
  existing.push(reserveId);
  tokenAddrToReserveId.set(key, existing);
}
```

填充逻辑（L1360-1382）改为对 4 种地址类型都 push：
- `tokenAddress` → `chainTokenKey(chainId, tokenAddress.toLowerCase())`
- `aTokenAddress` → `chainTokenKey(chainId, aTokenAddress.toLowerCase())`
- `vTokenAddress` → `chainTokenKey(chainId, vTokenAddress.toLowerCase())`
- `spokeAddress` → `chainTokenKey(chainId, spokeAddress.toLowerCase())`

#### Step 2: processMerklData 中 opp → reserveId(s) 映射

替换当前 `oppReserveId = tokenAddrToReserveId.get(...)` 单值取法：

```typescript
// 当前
const oppReserveId = tokenAddrToReserveId.get(chainTokenKey(opp.chainId, explorerAddress));

// 改为
const candidateReserveIds = tokenAddrToReserveId.get(chainTokenKey(opp.chainId, explorerAddress)) ?? [];
// HUB_SUPPLY: 用 hubAddress 过滤，保留第 4 段匹配的 reserveId
// SPOKE_SUPPLY: hubAddress + spokeAddress 唯一确定
// V3: 只有 1 个候选（pool prefix 已消歧）
const matchedReserveIds = filterByCampaignContext(candidateReserveIds, opp);
```

`filterByCampaignContext` 逻辑：
- V3 opp（3-segment reserveId）：直接返回候选（pool prefix 已消歧，通常 1 个）
- V4 HUB_SUPPLY opp：从 `campaign.params.hubAddress` 取 hub 地址，过滤第 4 段匹配的 reserveId
- V4 SPOKE_SUPPLY opp：从 `campaign.params.hubAddress` + `campaign.params.spokeAddress` 精确匹配

#### Step 3: 索引 key 从 chainId-explorerAddress 改为 reserveId

```typescript
// 当前
const indexKey = `${opp.chainId}-${explorerAddress}`;
merklData[indexKey]!.push(opportunityData);

// 改为
for (const reserveId of matchedReserveIds) {
  if (!merklData[reserveId]) merklData[reserveId] = [];
  merklData[reserveId]!.push(opportunityData);
}
```

`merklData` 类型从 `Record<string, MerklOpportunityData[]>` 不变，只是 key 语义变了。

#### Step 4: offset token 在索引构建时匹配

在 processMerklData 中，已知每个 matchedReserveId，直接调用 `resolveOffsetReserveIds`：
- offsetLevel 统一用 `'spoke'`（默认值修正后）
- `OffsetTokenInfo.reserveId` 在此处填入，无需等到 enrichDataset

#### Step 5: enrichDataset 简化

```typescript
// 当前
const matchedOpps = findMatchingMerklOpportunities(item, merklData);

// 改为
const matchedOpps = merklData[item.reserveId] ?? [];
```

`findMatchingMerklOpportunities` 函数可能不再需要。如果保留，签名和逻辑需大幅简化。

### 向后兼容性

- `merklData` 的 key 从 `chainId-explorerAddress` 变为 `reserveId`
- `findMatchingMerklOpportunities` 签名可能改变或删除
- 下游消费方（`enrichDatasetWithIncentiveData`）需适配
- `tokenAddrToReserveId` 值类型从 `string` 变为 `string[]`

### 风险点

1. **HUB_SUPPLY 跨 spoke 展开**: 一个 opp 映射到 N 个 reserveId，需确保同一 campaign 在同一 reserve 下不重复
2. **deriveProtocolVersion 保留**: index-building path 仍需 `deriveProtocolVersion` 和 `buildProtocolVersionLookup`，不可删除
3. **BorrowBL 处理**: 当前不处理，建议单独开 issue（独立于 Slice 2/3）

## Linear Issues

- AAV-924: PRD（需更新 discoveries）
- AAV-925: Slice 1 ✅
- AAV-926: Slice 2 — V4 HUB_SUPPLY index key hub 维度
- AAV-927: Slice 3 — tokenAddrToReserveId 多值映射
- AAV-928: Slice 4 — 清理 deriveProtocolVersion 后置过滤
- AAV-906: hub-aware offset ✅
- AAV-908: spokeAddress in query ✅
- AAV-905: 多值映射（Slice 3 范畴）
- AAV-921: NPC offset hub-aware（AAV-906 已覆盖核心）

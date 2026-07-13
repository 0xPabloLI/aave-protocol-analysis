# 开发方案：AAV-134+358 [Architecture] V4 标识符体系整体优化

## 1. Issue 概述

合并 AAV-134（V4 合约地址传递优化）和 AAV-358（V4 reserveId 格式统一）。

核心问题：V4 reserveId/onchainKey 的第四段 `hubName` 存在值域不一致——SDK 侧用 human-readable name（"Core"/"Prime"/"Plus"），address-book 侧用 key（"CORE_HUB"/"PRIME_HUB"/"PLUS_HUB"），导致 marketsService 需要 `SDK_HUB_TO_HUBKEY` fallback 映射桥接。如果 SDK 新增 hub 但映射表未更新，会静默 lookup miss。

方案：reserveId/onchainKey 第四段统一改为 `hubAddress`（链上合约地址），两边数据源天然一致，彻底消除映射表。同时 API 去除 `hubAddress` 和 `spokeAddress` 字段（可从 reserveId 解析），保留 name/id 字段供前端显示。

## 2. 当前状态

- AAV-358 reserveId 格式改 address-based 已完成 ✅，但 hubName 值域不一致遗留
- AAV-134 后端地址传递策略评估，结论维持现状，但 reserveId 第四段变更后需重新评估

## 3. 问题分析

### 3.1 hubName 值域不一致

| 数据源 | reserveId/onchainKey 第四段 | 值域 |
|--------|---------------------------|------|
| v4-fetcher（SDK） | `r.asset.hub.name` | "Core", "Prime", "Plus" |
| onchainDataService（address-book） | `V4SpokeConfig.hubName` (= hubKey) | "CORE_HUB", "PRIME_HUB", "PLUS_HUB" |

结果：`onchainMap.get(reserve.reserveId)` 无法直接命中，需要 `SDK_HUB_TO_HUBKEY` 运行时映射。

### 3.2 fallback 的脆弱性

```typescript
// marketsService.ts:289-293
const SDK_HUB_TO_HUBKEY: Record<string, string> = {
  Core: 'CORE_HUB',
  Prime: 'PRIME_HUB',
  Plus: 'PLUS_HUB',
};
```

如果 SDK 新增 hub name（如 "Mega"）但此映射表未更新，该 hub 的 V4 reserve 会静默缺少 onchain 数据（deficit、利率模型参数）。

### 3.3 hubAddress 天然一致

SDK 和 address-book 都包含同一个 Hub 合约的链上地址：
- SDK: `r.asset.hub.address` = `"0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9"`
- address-book: `AaveAddressBook.HUBS.CORE_HUB` = `"0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9"`

用 hubAddress 作为 reserveId 第四段，两边数据源无需映射即可一致。

### 3.4 API 字段冗余

当前 API 返回 `hubAddress` 和 `spokeAddress`，而这两个值已编码在 reserveId 中：
- V4 reserveId = `{chainId}:{spokeAddress}:{tokenAddress}:{hubAddress}`
- 第二段 = spokeAddress，第四段 = hubAddress

前端可从 reserveId 解析获取，API 无需重复传输。

## 4. 方案

### 4.1 reserveId/onchainKey 格式变更

| 版本 | 新 reserveId | 段数 | 示例 |
|------|-------------|------|------|
| V3 | `${chainId}:${poolAddress}:${tokenAddr}` | 3 | `1:0x87870bca...:0xbe989514...` |
| V4 | `${chainId}:${spokeAddress}:${tokenAddr}:${hubAddress}` | 4 | `1:0x1234...7890:0xa0b8...eb48:0xCca8...26c9` |

变更点：V4 第四段从 hubName（"Core"）改为 hubAddress（"0xCca8...26c9"）。

### 4.2 onchainKey 同步变更

onchainKey 也改为 `${chainId}:${spokeAddress}:${tokenAddr}:${hubAddress}`，和 reserveId 完全一致。

onchainDataService 当前 V4_SPOKE_CONFIGS 中 hubName = hubKey（"CORE_HUB"），需改为 hubAddress。

### 4.3 消除 SDK_HUB_TO_HUBKEY fallback

marketsService 中删除：
- `SDK_HUB_TO_HUBKEY` 映射表
- V4 fallback lookup 逻辑

直接 `onchainMap.get(reserve.reserveId)` 即可命中。

### 4.4 API 字段调整

| 字段 | 当前 | 变更后 | 原因 |
|------|------|--------|------|
| hubAddress | 返回 | **去除** | reserveId 第四段可解析 |
| spokeAddress | 返回 | **去除** | reserveId 第二段可解析 |
| hubName | 返回 | 保留 | 前端显示用，无法从 reserveId 解析 |
| hubId | 返回 | 保留 | 前端需要 |
| spokeName | 返回 | 保留 | 前端显示用 |
| spokeId | 返回 | 保留 | 前端需要 |

### 4.5 RuntimeReserveData 类型变更

- `hubAddress?` 字段保留在类型中（v4-fetcher 仍赋值），但从 `PASSTHROUGH_FIELDS` 移除（不输出到 API）
- `spokeAddress?` 同理

### 4.6 前端同步

前端从 reserveId 解析字段时：
- 3 段 = V3: `[chainId, poolAddress, tokenAddress]`
- 4 段 = V4: `[chainId, spokeAddress, tokenAddress, hubAddress]`

第四段从 hubName（"Core"）变为 hubAddress（"0xCca8...26c9"），前端解析逻辑需适配。

## 5. 改动范围

### 后端

| 文件 | 改动 |
|------|------|
| `packages/aave-fetcher/src/v4-fetcher.ts` | reserveId 第四段从 `hub.name` 改为 `hub.address`（toLowerCase） |
| `backend/src/services/onchainDataService.ts` | V4SpokeConfig.hubName 改为 hubAddress；onchainKey 第四段改为 hubAddress；v4SpokeCache key 改为 `${spokeAddress}:${hubAddress}` |
| `backend/src/services/marketsService.ts` | 删除 `SDK_HUB_TO_HUBKEY` 映射表和 V4 fallback lookup |
| `backend/src/services/marketsApiSerialize.ts` | 从 `PASSTHROUGH_FIELDS` 移除 `hubAddress` 和 `spokeAddress` |
| `backend/src/services/oracleService.ts` | V4SpokeConfig.hubName 改为 hubAddress（如适用） |

### 前端

- reserveId 解析逻辑更新（V4 第四段现在是 hubAddress）
- 不再依赖 API 的 hubAddress/spokeAddress 字段，改为从 reserveId 解析

### DB

- reserveId 格式变更 → 历史快照中所有 V4 reserveId 失效
- 写迁移脚本处理历史数据

### RuntimeReserveData 类型

- `hubAddress?` / `spokeAddress?` 保留在类型中，但从 API 序列化排除

## 6. 验收标准

- V4 reserveId 格式为 `${chainId}:${spokeAddress}:${tokenAddr}:${hubAddress}`（4 段，address-based）
- onchainKey 和 reserveId 格式完全一致，直接匹配（无 fallback lookup）
- 删除 `SDK_HUB_TO_HUBKEY` 映射表
- API 不返回 `hubAddress` 和 `spokeAddress` 字段
- API 继续返回 `hubId`、`hubName`、`spokeId`、`spokeName`
- 所有测试通过
- 前端同步更新
- DB 迁移脚本已验证

## 7. 执行顺序

1. 改 `v4-fetcher.ts` 的 reserveId 第四段（hubName → hubAddress）
2. 改 `onchainDataService.ts` 的 V4SpokeConfig 和 onchainKey 第四段
3. 改 `oracleService.ts` 的 V4SpokeConfig（如适用）
4. 删除 `marketsService.ts` 的 SDK_HUB_TO_HUBKEY 和 fallback
5. 改 `marketsApiSerialize.ts` 移除 hubAddress/spokeAddress
6. 更新后端测试
7. 写 DB 迁移脚本
8. 构建验证
9. 前端同步

## 8. 复杂度评估

- Medium（格式替换 + 映射表删除 + 序列化调整，逻辑不变，但改动文件多且需前后端同步）

## 9. 关联 Issue

- AAV-134（V4 合约地址传递优化）→ 合并入本 issue
- AAV-358（V4 reserveId 格式统一）→ 合并入本 issue
- AAV-498（V4_SPOKE_TO_HUB 动态化）→ 前置发现，不在本 issue 范围内

## 10. 附带发现

SDK 的 `spoke.connectedHubs` 已包含完整的 spoke→hub 拓扑关系（包括 hub.name、hub.address），可替代硬编码的 `V4_SPOKE_TO_HUB`。此优化记录在 AAV-498 中，不在本 issue 范围内。

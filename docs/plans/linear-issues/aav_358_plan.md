# 开发方案 - AAV-358 优化 V4 Reserve ID 格式

## 1. Issue 概述
V4 reserveId 当前使用 name-based 格式 `${marketName}:${chainId}:${tokenAddr}:${hubName}`（4 段），和 V3 的 address-based 格式不一致。参考 V3 的改动（commit `8181f1a`），将 V4 reserveId 改为 address-based 格式。

## 2. 当前状态
- **待实现**
- Linear: AAV-358

## 3. 问题分析

### 3.1 V3 改动回顾（commit `8181f1a`）
- V3 reserveId: `${marketName}:${chainId}:${tokenAddr}` → `${chainId}:${poolAddress}:${tokenAddr}`
- 效果：删除 `POOL_KEY_TO_SDK_MARKET_NAME` 映射表，net -76 行，onchain key 和 reserveId 格式统一

### 3.2 V4 当前格式
- reserveId = `${marketName}:${chainId}:${tokenAddr}:${hubName}`（4 段）
  - 例：`AaveV4Main:1:0xa0b8...eb48:CORE_HUB`
- onchain key = `${chainId}:${hubName}:${spokeAddress}:${tokenAddr}`（4 段，顺序不同）
  - 例：`1:CORE_HUB:0x1234...7890:0xa0b8...eb48`
- **两者格式不一致**，需要 marketsService fallback lookup

### 3.3 hubName 是否必要？

commit `c4a083e` 添加 hubName 的理由是"multi-hub 市场中同一 token 可能出现在多个 hub"。但：
- 每个 spoke 只属于一个 hub（`V4_SPOKE_TO_HUB` 是 1:1 映射）
- 不同 spoke 的 marketName 已唯一（`AaveV4Bluechip` ≠ `AaveV4Lombard`）
- 同一 token 在不同 spoke → marketName 不同 → reserveId 已唯一

**结论：hubName 在 reserveId 中是冗余的。** 当初添加 hubName 是因为 marketName-based 格式下需要额外区分，但 address-based 格式下 spokeAddress 天然唯一，不需要 hubName。

### 3.4 冗余映射表
- `V4_SPOKE_NAME_MAP`（10 行）：spokeKey → spokeName，仅用于构造 marketName
- `V4_SPOKE_TO_HUB`（10 行）：spokeKey → hubKey，用于找 hubAddress（**仍需保留，但仅内部使用**）
- `SPOKE_NAME_MAP`（oracleService，11 行）：同 `V4_SPOKE_NAME_MAP`，可删除

## 4. 方案

### 4.1 新格式

| 版本 | 新 reserveId | 段数 | 示例 |
|------|-------------|------|------|
| V3 | `${chainId}:${poolAddress}:${tokenAddr}` | 3 | `1:0x87870bca...:0xbe989514...` |
| V4 | `${chainId}:${spokeAddress}:${tokenAddr}` | 3 | `1:0x1234...7890:0xa0b8...eb48` |

**V3 用 poolAddress，V4 用 spokeAddress，完全对称。**

### 4.2 onchain key 统一

onchain key 也改为 `${chainId}:${spokeAddress}:${tokenAddr}`，和 reserveId 完全一致，**消除 fallback lookup**。

### 4.3 可删除
- `V4_SPOKE_NAME_MAP` — onchainDataService 中不再需要
- `SPOKE_NAME_MAP` — oracleService 中不再需要
- `marketName` 字段构造 — `AaveV4${spokeName.replace(/\s+/g, '')}` 不再需要
- marketsService V4 fallback lookup — 直接 `onchainMap.get(reserve.reserveId)`

### 4.4 需保留
- `V4_SPOKE_TO_HUB` — onchainDataService 内部仍需 spoke→hub 映射来获取 hubAddress（`getSpokeDeficitRay(assetId, spoke)` 需要 hub 合约）
- `hubName` 作为 `RuntimeReserveData` 的可选字段 — 前端展示可能仍需要，但不在 reserveId 中

## 5. 改动范围

### 后端
| 文件 | 改动 |
|------|------|
| `packages/aave-fetcher/src/v4-fetcher.ts` | reserveId 从 `${marketName}:${chainId}:${token}:${hubName}` → `${chainId}:${spokeAddress}:${token}` |
| `backend/src/services/onchainDataService.ts` | onchain key 从 `${chainId}:${hubName}:${spoke}:${token}` → `${chainId}:${spoke}:${token}`；删除 `V4_SPOKE_NAME_MAP` |
| `backend/src/services/marketsService.ts` | 删除 V4 fallback lookup，直接 `onchainMap.get(reserve.reserveId)` |
| `backend/src/services/oracleService.ts` | 删除 `SPOKE_NAME_MAP`，spoke 配置不再依赖 spokeName |
| `backend/tests/onchainDataService.test.ts` | 更新 key 格式为 3 段 |

### 前端
- 所有使用 reserveId 做 Map key/查找/显示的地方需同步更新
- reserveId 作为标识符，格式变化不影响语义，但前端解析逻辑（如 split(':')）需适配

### DB
- reserveId 格式变更 → 历史快照中所有 V4 reserveId 失效
- **可接受**：V3 改时同样处理，DB 是 archive 非 source of truth
- 新格式 3 段 vs 旧 4 段，可通过段数区分 V4 新旧数据

### RuntimeReserveData 类型
- `hubName?` 和 `spokeAddress?` 保留为可选字段（前端展示用），不参与 reserveId 构造

## 6. 验收标准
- V4 reserveId 格式为 `${chainId}:${spokeAddress}:${tokenAddr}`（3 段）
- onchain key 和 reserveId 格式一致，直接匹配（无 fallback lookup）
- 删除 `V4_SPOKE_NAME_MAP` 和 oracleService 的 `SPOKE_NAME_MAP`
- `V4_SPOKE_TO_HUB` 保留（内部使用）
- 所有测试通过
- 前端同步更新

## 7. 执行顺序
1. 改 `v4-fetcher.ts` 的 reserveId 构造
2. 改 `onchainDataService.ts` 的 onchain key 格式 + 删除 `V4_SPOKE_NAME_MAP`
3. 改 `marketsService.ts` 删除 fallback lookup
4. 改 `oracleService.ts` 删除 `SPOKE_NAME_MAP`
5. 更新测试
6. 构建验证
7. 前端同步

## 8. 复杂度评估
- Medium（主要是格式替换 + 映射表删除，逻辑不变）

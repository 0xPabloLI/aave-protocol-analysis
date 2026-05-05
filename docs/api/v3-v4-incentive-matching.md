# V3/V4 Incentive 匹配问题分析

**文档版本**: 2026-04-23  
**状态**: 待解决（分析完成，等待外部平台 V4 支持后实施）

---

## 1. 问题背景

系统从三个外部源获取 incentive 数据（Merit、Merkl、Brevis），然后在 `enrichDatasetWithIncentiveData()` 中匹配到对应的 reserve。当 V4 上线后，**同一链上同一 token 可能同时存在于 V3 和 V4 market**，需要将 incentive 正确匹配到对应版本的 market。

核心问题：**三个外部源都不显式返回协议版本（v3/v4）**。

---

## 2. 各 incentive 源的匹配机制与 V3/V4 区分能力

### 2.1 Merit

| 项目 | 详情 |
|------|------|
| **API** | `https://apps.aavechan.com/api/merit/aprs` |
| **key 格式** | `{chain}-{action}-{token}`，如 `ethereum-supply-weth` |
| **匹配方式** | `getMeritDataFromMarket()` 用 `marketName` → `chainKey` 映射 + `tokenSymbol` |
| **V3/V4 区分** | ❌ key 中无版本信息 |

**分析**：Merit raw key 只有 chain + action + token，无法区分同链同 token 的 V3/V4。如果 V4 上线 Merit，除非 Aave 团队在 key 中加版本标识（如 `ethereum-v4-supply-weth`），否则无法区分。

**当前风险**：低。目前 Merit API 返回的所有 key 均对应 V3 markets（截至 2026-04-23 验证，无任何 V4 相关 key）。但这只是因为 V4 尚未上线 Merit，而非 Merit 设计上只支持 V3。

### 2.2 Merkl

| 项目 | 详情 |
|------|------|
| **API** | `https://api.merkl.xyz/v4/opportunities?mainProtocolId=aave` |
| **匹配方式** | `findMatchingMerklOpportunities()` 用 `chainId` + `explorerAddress`（与 reserve 的 `tokenAddress`/`aTokenAddress`/`vTokenAddress` 匹配） |
| **V3/V4 区分** | ⚠️ 部分可行 |

**分析**：

- 已验证的数据中，`explorerAddress` 对于 LEND 类型通常是 **aToken 地址**，BORROW 类型是 **vToken 地址**——因为 V3 和 V4 的 aToken/vToken 地址不同，理论上可以天然区分
- **但存在不确定性**：
  1. 部分 opportunity 的 `explorerAddress` 为空（如 "looping required" 类型），此时退回用 `identifier` 匹配
  2. V4 可能不存在传统 aToken 概念，届时 `explorerAddress` 会是什么尚未可知
  3. 目前数据中**没有任何 V4 的 Merkl opportunity**，无法实际验证

**当前匹配逻辑对 Ethereum mainnet 的特殊处理**：chainId=1 时用 `{marketName}-{chainId}-{explorerAddress}` 作为索引 key，其他链用 `{chainId}-{explorerAddress}`。这意味着 Ethereum 上如果 `explorerAddress` 是 aToken，已经能通过不同 aToken 地址自动区分市场。

### 2.3 Brevis

| 项目 | 详情 |
|------|------|
| **API** | gRPC (`brevis-campaign.uw.r.appspot.com`) |
| **匹配方式** | `fetchBrevisAprs()` 用 `{chainId}-{tokenAddress}`（underlying token 地址）索引 |
| **V3/V4 区分** | ❌ 当前索引方式丢弃了版本信息 |

**分析**：

- Brevis 的 `protocol` 对象包含 `id`（pool 合约地址）和 `name`（如 `"Lend or Borrow USDC from Aave on Linea"`），**pool 地址天然能区分 V3/V4**
- 但当前代码在构建索引时只用了 `{chainId}-{tokenAddress}`（underlying），**丢弃了 `protocol.id`**
- 如果同链同 token 在 V3 和 V4 都有 Brevis campaign，当前逻辑会**合并到同一个 index entry**，导致两个版本的 reserve 获得相同的 Brevis incentive

---

## 3. 当前数据验证结果（2026-04-23）

| 源 | 是否有 V4 数据 | 验证方式 |
|---|---|---|
| Merit | ❌ 无 | 检查所有 `rawAPRs` keys，无 V4 标识 |
| Merkl | ❌ 无 | 检查所有 `rawOpportunities`，`protocol.id` 均为 `aave`，name 无 V4 相关 |
| Brevis | ❌ 无 | 仅 1 个 Aave protocol（Linea），name 中无版本标识 |

**结论：目前不存在实际的 V3/V4 错配问题，因为外部源尚未提供 V4 incentive 数据。**

---

## 4. V4 上线后的预期风险

| 风险等级 | 源 | 场景 | 影响 |
|----------|---|------|------|
| 🔴 高 | Brevis | 同链同 token 在 V3+V4 都有 campaign | 两个 reserve 获得相同 incentive（重复） |
| 🟡 中 | Merit | V4 campaign 使用相同 key 格式 | V4 incentive 被错配到 V3 market（或反之） |
| 🟢 低 | Merkl | V4 使用不同的 aToken/合约地址 | 可能自动区分；但需验证 V4 的 `explorerAddress` 填什么 |

---

## 5. 建议改进方案

### 5.1 短期（V4 incentive 上线前）

- 不做代码变更，避免过度设计
- 持续监控三个源的 API 响应，观察 V4 数据何时出现

### 5.2 中期（V4 incentive 开始出现时）

1. **给 `RuntimeReserveData` 加 `protocolVersion` 字段**（`'v3' | 'v4'`）
   - `buildV3BaseDataset()` 填 `'v3'`
   - `v4-fetcher.ts` 填 `'v4'`
   - 经过 `pruneReserveForRuntime()` 传递到 backend

2. **Brevis 索引改进**（优先级最高）
   - 索引 key 从 `{chainId}-{tokenAddress}` 改为 `{chainId}-{protocolId}-{tokenAddress}`
   - 匹配时用 reserve 的 pool 地址对应 Brevis `protocol.id`

3. **Merit 观察**
   - 等 V4 campaign 出现后，分析 key 格式是否有变化
   - 如有版本标识，更新 `getMeritDataFromMarket()` 的 chainKey 映射

4. **Merkl 验证**
   - V4 opportunity 出现后，检查 `explorerAddress` 填的是什么地址
   - 如需调整匹配逻辑，更新 `findMatchingMerklOpportunities()`

---

## 6. 相关代码位置

| 功能 | 文件 | 函数 |
|------|------|------|
| Incentive enrichment 主逻辑 | `src/index.ts` | `enrichDatasetWithIncentiveData()` |
| Merit 匹配 | `src/merit-api.ts` | `getMeritDataFromMarket()` |
| Merkl 匹配 | `src/merkl-api.ts` | `findMatchingMerklOpportunities()` |
| Brevis 索引构建 | `src/brevis-api.ts` | `fetchBrevisAprs()` 内部 |
| V4 数据获取 | `src/v4-fetcher.ts` | `fetchAaveV4Reserves()` |
| 统一数据集 | `src/index.ts` | `buildMarketsBaseDataset()` |

---

## 7. 相关文档

- API 总览：`docs/api/api-documentation.md`
- Brevis 补充：`docs/api/brevis-supplement.md`
- 前端同步变更：`docs/api/FRONTEND-SYNC-CHANGES.md`
- 缓存架构：`docs/merkl-merit-cache-architecture.md`

# 开发方案 - AAV-170 后端 onchain RPC 数据获取支持 V4 deficit

## 1. Issue 概述
后端需要增强 onchain RPC 数据获取逻辑，使其支持 Aave V4 的 deficit 数据获取。目前 V4 SDK 不直接返回 deficit 字段，需通过后端调用链上 RPC 接口补充该数据，保证后端 API 能完整返回 V4 市场的 deficit 信息。

## 2. 当前状态
- **已完成** ✓
- 实现于 `backend/src/services/onchainDataService.ts`
- V4 deficit 通过 `Hub.getSpokeDeficitRay(assetId, spoke)` per-spoke 分量链上 RPC 获取（语义对齐 V3 `reserve.deficit`）
- Multicall3 批量优化：~94 serial RPC → ~16 batch calls

## 3. 实现详情

### 3.1 V4 deficit 获取路径
V4 没有 `UiPoolDataProvider.getReservesHumanized()`，采用直接合约调用：

1. 遍历 address-book 中 `AaveV4*` 导出，自动发现 Spoke 和 Hub 地址
2. **Hub asset mapping**（Multicall3 batch）：`getAssetCount()` + N × `getAsset(assetId)` → underlying→assetId 映射
3. **Per-spoke deficit**（Multicall3 batch）：`getSpokeDeficitRay(assetId, spoke)` → RAY→token units 转换
4. 以 V4 onchain key 格式 (`{chainId}:{spokeAddress}:{tokenAddr}:{hubName}`) 缓存

### 3.2 关键设计
- **Per-spoke deficit**：使用 `getSpokeDeficitRay(assetId, spoke)` 而非 `getAssetDeficitRay(assetId)`，因为 per-spoke 和 V3 `reserve.deficit` 语义对齐
- **Hub mapping 缓存**：`hubAssetMapping` 跨 Spoke 共享（同一 Hub 只构建一次）
- **Multicall3 批量化**：每个 Hub 2 batch + 每个 Spoke 1 batch，总计 ~16 RPC calls
- **Serial fallback**：Multicall3 失败时回退逐个调用，保证可靠性
- **Spoke→Hub 映射**：`V4_SPOKE_TO_HUB` 硬编码（address-book 结构决定，仅 3 个 Hub，变化频率低）

### 3.3 Match 机制
- **V3 onchain key** = `${chainId}:${poolAddress}:${tokenAddr}` — 直接匹配 `reserve.reserveId`（V3 reserveId 格式相同）
- **V4 onchain key** = `${chainId}:${spokeAddress}:${tokenAddr}:${hubName}` — address-based，直接匹配 `reserve.reserveId`（AAV-358 统一后无 fallback）

### 3.4 数据流
```
Cron → refreshOnchainCache()
  → V3: UiPoolDataProvider.getReservesHumanized() (existing, 1 call per pool)
  → V4: Multicall3 aggregate3()
       → Round 1: getAssetCount + N×getAsset → hubAssetMapping (2 batches per Hub)
       → Round 2: N×getSpokeDeficitRay → per-spoke deficit (1 batch per Spoke)
  → poolCache (V3) + v4SpokeCache (V4)
  → getOnchainDataFromCache() → marketsService.merge
    → reserve.deficit = onchainData.deficit (而非默认 '0')
```

## 4. 验收标准
- ✅ 后端 `/api/markets` 接口返回的 V4 市场数据包含 deficit 字段（非默认 '0'）
- ✅ 单元测试覆盖 RAY 转换、onchain key 格式、Spoke→Hub 映射完整性、Multicall3 ABI 编解码
- ✅ 构建和测试通过

## 5. 后续
- Oracle Service 改运行时消费 address-book + 遍历合并 → `docs/plans/address-book-runtime-refactor.md`

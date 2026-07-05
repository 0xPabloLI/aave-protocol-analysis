# Memory Leak Prevention Checklist

每次涉及内存相关开发时（新增/修改 cache、Map、Set、长期存活的闭包、长连接、浏览器实例等），必须逐条检查。

## Cache 设计三原则

1. **Domain 层**：cache 只存业务需要的精简数据，不存 raw API 响应或 debug 用的完整对象。Debug 需求应独立处理（写文件后释放，不存入 cache）。
2. **TTL / Shrink 层**：处理"key 再也不该存在了"的场景。两种方式：
   - **TTL 过期淘汰**：key 活了太久就删（如价格 10min 过期、provider 30min 未用就回收）。适合"数据会变旧"的 cache。
   - **Shrink-by-active-set**：不在当前业务实体集合中的 key 删除（如 reserve 下线了、campaign 结束了、RPC 全挂了）。适合"key 生命周期跟随业务实体"的 cache。
3. **Size 层**（max entries + FIFO overflow）：所有 cache 必须有 max entries 上限，超限时按 FIFO（插入序）删最老的条目。这是最后一道兜底，防未知泄漏或 TTL/shrink 不够激进的场景。上限值应基于 domain 知识设定（如 chain 数量 ~20、campaign 数量 ~500）。

> **注意**：FIFO overflow 是 Size 层的执行方式，不是独立的 shrink 策略。Shrink 是业务驱动的删除（key 不该存在了），FIFO overflow 是数量驱动的删除（太多了）。

## 全量 Cache 三段守护清单

> **用法**：每次新增/修改 cache 时，先在表中找到对应条目（或新增一行），逐项确认三段守护是否完整。缺失的必须补上，不需要的必须在"不需要理由"列写明原因。

### 图例

- ✅ = 已有且充分
- ⚠️ = 缺失，需要补
- ➖ = 不适用（附理由）
- **结论**：🟢 三段完整 | 🟡 可接受（缺项有理由） | 🔴 需补强

### backend/src/

| # | 文件 | 变量 | 类型 | Domain | TTL | Max | Shrink | 结论 | 不需要理由 |
|---|------|------|------|--------|-----|-----|--------|------|-----------|
| 1 | merklForecastService | `metricsCache` | Map | ✅(已删raw) | ✅(10min~6h) | ✅(500) | ✅(pruneMetricsCache) | 🟢 | |
| 2 | merklForecastService | `zeroBaselineFirstSeenAt` | Map | ✅ | ➖(语义是"首次出现时间") | ✅(500) | ✅(FIFO overflow) | 🟢 | |
| 3 | merklForecastService | `inFlight` | Map | ✅ | ➖(Promise完成即删) | ➖(并发有限) | ➖(Promise自删) | 🟢 | 短生命周期，fetch完即delete，并发受下游限流控制 |
| 4 | merklForecastService | `campaignOpportunityCache` | 单条 | ✅ | ✅(hardTTL) | ➖(单条) | ✅(替换) | 🟢 | |
| 5 | onchainDataService | `POOL_CONFIGS` | Map | ✅ | ➖(静态初始化) | ➖(V3配置数量) | ➖(运行时不变) | 🟢 | 从V3_ENTRIES静态构建，数量=pool数(~20)，运行时不变 |
| 6 | onchainDataService | `poolCache` | Map | ✅ | ✅(30min) | ✅(50) | ✅(cron覆盖+FIFO overflow) | 🟢 | |
| 7 | onchainDataService | `v4SpokeCache` | Map | ✅ | ✅(30min) | ✅(80) | ✅(cron覆盖+FIFO overflow) | 🟢 | |
| 8 | onchainDataService | `cachedHubMapping` | Map | ✅ | ✅(10min,整体置null) | ➖(hub数≤V4_SPOKE_CONFIGS,~20) | ✅(TTL过期整体重建) | 🟢 | 外层条目数由 V4_SPOKE_CONFIGS(~20 hub) 天然限定；MAX_HUB_ASSET_COUNT=200 是单个 hub 的 multicall 防护(非Map.size上限) |
| 9 | oracleService | `cachedSnapshot` | 单条 | ✅ | ✅(cron每分钟) | ➖(单条) | ✅(替换) | 🟢 | |
| 10 | oracleService | `leanPriceCache` | Map | ✅ | ✅(cron整量替换) | ✅(500) | ✅(整量替换+FIFO overflow) | 🟢 | |
| 11 | oracleService | `V4_RESERVE_TOKEN_CACHE` | Map | ✅ | ✅(1h+2h惰性删) | ✅(100) | ✅(2×TTL惰性删+FIFO overflow) | 🟢 | |
| 12 | persistenceService | `marketRowHashes` | Map | ✅ | ➖(key跟reserve走) | ✅(500) | ✅(shrinkHashMaps+FIFO) | 🟢 | |
| 13 | persistenceService | `marketConfigHashes` | Map | ✅ | ➖(key跟reserve走) | ✅(500) | ✅(shrinkHashMaps+FIFO) | 🟢 | |
| 14 | persistenceService | `oraclePriceHashes` | Map | ✅ | ➖(key跟reserve走) | ✅(2000) | ✅(shrinkOraclePriceHashes+FIFO) | 🟢 | |
| 15 | marketsService | `snapshot` | 单条 | ✅ | ✅(cron每分钟) | ➖(单条) | ✅(替换) | 🟢 | |
| 16 | marketsService | `staleV3Data` / `staleV4Data` | 数组 | ✅ | ✅(hardTtlMs) | ➖(数组=一轮reserve数) | ✅(整量替换) | 🟢 | |
| 17 | addressBookRegistry | `V3_ENTRIES` / `V4_SPOKE_ENTRIES` | readonly数组 | ✅ | ➖(静态) | ➖(拓扑决定) | ➖(运行时不变) | 🟢 | 静态配置，数量=链上pool/spoke数，运行时不变 |
| 18 | merklCampaignAccessService | `snapshot` | 单条 | ✅ | ✅(cron替换) | ➖(单条) | ✅(替换) | 🟢 | |
| 19 | merklForecastController | `snapshotCache` | 单条 | ✅ | ✅(hardTTL) | ➖(单条) | ✅(替换) | 🟢 | |
| 20 | brevisForecastService | `entries` | Map | ✅ | ✅(cron替换) | ➖(=campaign数) | ✅(替换) | 🟢 | 跟 markets 1m cron 写入，无独立 snapshot；getBrevisForecastItems() 实时从 markets snapshot 读 endTimestamp |
| 21 | coingeckoController | `cachedResponse` / `cachedFdvResponse` | 单条 | ✅ | ✅(hardTtlMs) | ➖(单条) | ✅(替换) | 🟢 | |
| 22 | seoController | `batchRateMap` | Map | ✅ | ✅(60s窗口清理) | ⚠️(无max) | ✅(setInterval删过期) | 🟡 | key=IP，窗口内理论无限，但60s清理保证短期不累积；单实例QPS低，实际IP并发<100 |
| 23 | rateLimit | `store` | Map | ✅ | ✅(windowMs) | ⚠️(无max) | ✅(setInterval删过期) | 🟡 | 同上，IP限流场景，窗口清理足够 |
| 24 | marketsApiSerialize | `_cachedFingerprint` | 单条 | ✅ | ➖(schema不变则永久有效) | ➖(单条) | ➖(计算后不变) | 🟢 | 纯计算结果的fingerprint，schema不变则永远有效 |
| 25 | dbPool | `pool` | 单例PG Pool | ✅ | ➖(进程生命周期,pg自带连接复用) | ✅(max=3) | ➖(单例,进程退出释放) | 🟢 | 长连接池;max=3(每SSL conn ~5-10MB),已从5优化到3;POOL_BACKOFF_MS 60s防DB挂掉时socket堆积 |
| 26 | gscService | `cachedClient` | 单例 | ✅ | ➖(懒加载后永久) | ➖(单条) | ➖(单例) | 🟢 | googleapis JWT+Webmasters client,单实例从不累积 |
| 26b | server.ts (undici) | `globalDispatcher` | 全局单例 | ✅ | ✅(keepAliveTimeout=30s) | ✅(connections=10/host) | ✅(连接超时自动关闭) | 🟢 | 限制undici TLS连接池;之前默认无限制导致native memory(OpenSSL缓冲区)持续累积~14MB/h |
| 26c | server.ts (防御性) | `https.globalAgent` / `http.globalAgent` | 全局Agent | ✅ | ✅(keepAlive自动) | ✅(maxSockets=10, maxFreeSockets=2) | ✅(free池≤2/host,自动淘汰) | 🟢 | 防御性：node-fetch已移除(AAV-1064)，所有HTTP走undici单通道;此限制作为安全网防止transitive依赖通过http/https模块泄漏 |

### packages/aave-fetcher/src/

| # | 文件 | 变量 | 类型 | Domain | TTL | Max | Shrink | 结论 | 不需要理由 |
|---|------|------|------|--------|-----|-----|--------|------|-----------|
| 27 | merit-api | `roundEstimateCache` | Map | ✅ | ✅(48h) | ✅(200) | ✅(TTL+FIFO) | 🟢 | |
| 28 | merit-api | `campaignMetadataMemoryCache` | Record | ✅ | ➖(key跟campaign走) | ✅(500) | ✅(shrinkCampaignMetadataCache+FIFO) | 🟢 | |
| 29 | merit-api | `meritCurrentBlockNumberCache` | Map | ✅ | ✅(60s) | ✅(50) | ✅(TTL+FIFO) | 🟢 | |
| 30 | merit-api | `discoveredRedirectAliases` | Map | ✅ | ⚠️(无TTL) | ⚠️(无max) | ✅(fetchMeritData清空) | 🟡 | fetchMeritData开头clear()，每轮cron(~5min)清空；redirect数量有限(几十) |
| 31 | token-price-resolver | `tokenPriceResolveCache` | Map | ✅ | ✅(24h/5min) | ✅(2000) | ✅(TTL+FIFO) | 🟢 | |
| 32 | token-price-resolver | `tokenPriceResolveInFlight` | Map | ✅ | ➖(Promise完成即删) | ➖(并发有限) | ➖(Promise自删) | 🟢 | 短生命周期，同#3 |
| 33 | token-price-resolver | `coingeckoPlatformCache` | 单条+Map | ✅ | ✅(24h) | ➖(Map=chainId数) | ✅(整量替换) | 🟢 | 内含Map按chainId，数量=链数(~20) |
| 34 | merklLlmClient | `primaryModelsCache` | 单条 | ✅ | ➖(fetch后永久缓存) | ➖(单条) | ➖(有resetPrimaryModelsCache hook) | 🟢 | 模型列表，数量有限且稳定 |
| 35 | merkl-api | `_merklState` | 单例对象 | ✅ | ➖(cron替换) | ➖(单条) | ✅(替换) | 🟢 | lastSuccessfulSnapshot 仅保留 index+processedData+forecastMeta+liveOpportunityCount;rawOpportunities 已移除(见泄漏记录#20) |
| 36 | cloudflare-browser | `workerDisabledResolvers` | Set | ✅ | ➖(Promise自删) | ➖(并发有限) | ✅(resolve后自删除) | 🟢 | 已从Array改为Set，resolve后自删除 |
| 37 | brevis-distributed-so-far | `chainCallCache` | Map | ✅ | ✅(1h TTL+2h惰性删) | ✅(100) | ✅(pruneCache+FIFO) | 🟢 | tokenCumulativeRewards约4h变一次，1h TTL足够 |
| 37b | v4-fetcher | `v4Client` (GqlClient.queryRegistry) | Map(内嵌) | ✅ | ➖(per-fetch短生命周期) | ➖(client GC即释放) | ➖(per-fetch重建) | 🟢 | per-fetch创建,非singleton;queryRegistry随client实例GC;cache:false+batch:false禁用graphcache和batchFetchExchange;V3 AaveClient不继承GqlClient无此问题 |

### packages/aave-rpc-infra/src/

| # | 文件 | 变量 | 类型 | Domain | TTL | Max | Shrink | 结论 | 不需要理由 |
|---|------|------|------|--------|-----|-----|--------|------|-----------|
| 38 | index (ProviderPool) | `providerByKey` | Map | ✅ | ✅(providerTtlMs=30min) | ✅(150) | ✅(pruneStaleProviders+FIFO overflow) | 🟢 | max=150 ≥ DynamicRpcCache.max(50) × 每chain平均URL数(~3)；FIFO overflow 保留内联（需联动删 endpointHealthByKey + providerLastUsedAt） |
| 39 | index (ProviderPool) | `endpointHealthByKey` | Map | ✅ | ✅(随provider) | ✅(150) | ✅(随pruneStaleProviders) | 🟢 | 同上，与providerByKey一一对应 |
| 40 | index (ProviderPool) | `providerLastUsedAt` | Map | ✅ | ✅(providerTtlMs=30min) | ✅(150) | ✅(随pruneStaleProviders) | 🟢 | 同上 |
| 41 | index (ProviderPool) | `viemChainCache` | 单条 | ✅ | ➖(lazy init后永久) | ➖(单条) | ➖(不变) | 🟢 | |
| 42 | dynamicRpcCache | `cache` | Map | ✅ | ✅(shrink: invalidate由ProviderPool health检测驱动) | ✅(50) | ✅(FIFO overflow) | 🟢 | key=chainId(~20)，domain严格有界；TTL不需要：URL列表是静态元数据不会变旧，失效靠ProviderPool检测到所有suppressed时主动invalidate(shrink层)；FIFO overflow是Size层兜底 |

### packages/aave-shared-contracts/src/ + aave-shared-config/src/

无持久化内存缓存。

---

### 🟢 已补强的 Cache（从 🟡 升级到 🟢，commit `pending`）

| # | 变量 | 补了什么 | 补法 |
|---|------|---------|------|
| 6 | `poolCache` | max entries | max 50 (V3 pool 数 ~20) |
| 7 | `v4SpokeCache` | max entries | max 80 (V4 spoke 数 ~40) |
| 10 | `leanPriceCache` | max entries | max 500 (token 总数 ~300) |
| 11 | `V4_RESERVE_TOKEN_CACHE` | max entries | max 100 (V4 spoke 数 ~40) |
| 38-40 | `providerByKey` 等 3 个 | max entries | max 150 (≥ DynamicRpcCache.max × 每chain平均URL数) |
| 42 | `DynamicRpcCache.cache` | max entries + shrink | max 50 (chainId 数 ~20，留 2.5× 余量)；shrink=invalidate(由ProviderPool health驱动) |

### 🟡 可接受不补的 Cache（🟡 保持）

| # | 变量 | 缺项不补的理由 |
|---|------|--------------|
| 21 | `batchRateMap` | key=IP，窗口清理足够；单实例QPS低，实际并发IP<100；加max可能误杀合法请求 |
| 22 | `rateLimit store` | 同上，rate limit 场景加 max entries 可能导致合法请求被拒 |

---

## 逐项检查清单

### 新增/修改 Cache 时

- [ ] 是否只存业务需要的最小数据？（不存 raw、不存 debug 数据）
- [ ] 是否有 TTL 过期淘汰？或 key 跟随业务实体时是否有 shrink-by-active-set？
- [ ] 是否有 max entries 上限？（兜底防线）
- [ ] Eviction 逻辑是否在 cache 自身职责内？（不应嵌在业务代码里）
- [ ] 新条目是否覆盖同 key 旧条目？（Map.set 天然如此，确认没有 append-only 模式）
- [ ] 是否已在上面的全量清单中登记？（未登记的 cache 必须补登）

### 新增/修改闭包/Promise 时

- [ ] resolve/reject 函数是否在 Promise 完成后被释放？（避免闭包泄漏）
- [ ] Array 存储 resolver 时，删除是否靠索引？→ 优先用 Set + 自删除
- [ ] setTimeout/setInterval 回调是否引用了大对象？→ 用完置 null
- [ ] AbortController 是否在超时/取消后清理？

### 新增/修改长连接/外部资源时

- [ ] HTTP fetch 是否有超时 + AbortController？（dangling socket 泄漏）
- [ ] 数据库连接池大小是否合理？（每个 SSL 连接 5-10MB native memory）
- [ ] Puppeteer/browser 实例是否在空闲后关闭？
- [ ] Provider/连接是否在不再使用时淘汰？（TTL + 定时清理）

### 新增/修改 Hash/索引 时

- [ ] Hash map 的 key 构建逻辑是否提取成命名函数？（禁止两处独立内联字符串模板——曾发生 `reserveId` vs `chainId|tokenAddr|configId` 格式不匹配导致 shrink 失效）
- [ ] 是否有对应测试验证 shrink 逻辑正确工作？

### Key Format 唯一来源原则

Map/Set 的 key 必须通过**命名函数**构建，禁止内联字符串模板。所有 key 构建函数定义在 `packages/aave-shared-contracts/src/keys.ts`，是唯一来源。

### FIFO Overflow 工具函数 (`fifoEvict`)

所有单 Map 的 FIFO overflow 逻辑统一调用 `fifoEvict(map, maxEntries)`（定义在 `@internal/aave-shared-contracts`）。该函数按 Map 插入序删除最旧条目，直到 `map.size <= maxEntries`。

**例外**：ProviderPool 的 `cleanupStaleProviders` 中 FIFO overflow 涉及 3 个 Map 联动删除（providerByKey + endpointHealthByKey + providerLastUsedAt），保留内联 while-loop 实现。

```ts
// ❌ 危险：两处独立内联，格式可能不一致
map.set(`${r.chainId}|${r.tokenAddress}|${r.configId}`, hash);
for (const key of map.keys()) { /* 期望 key 是 chainId|tokenAddr|configId 格式，但无编译时保证 */ }

// ✅ 安全：命名函数是唯一来源
import { oraclePriceKey } from '@internal/aave-shared-contracts';
map.set(oraclePriceKey(r.chainId, r.tokenAddress, r.configId), hash);
```

**原理**：TypeScript 无法检查两处内联字符串模板的格式一致性。命名函数确保格式定义只有一份代码，编译器能检查参数类型。

**已提取的 key 函数**（`shared-contracts/keys.ts`）：

| 函数 | 格式 | 用途 |
|------|------|------|
| `normalizeAddress` | `addr.toLowerCase().trim()` | 地址标准化 |
| `spokeKey` | `chainId:spokeAddress` | V4 spoke 查找 |
| `chainTokenKey` | `chainId:tokenAddress` | token 查找（V3 aToken/vToken） |
| `v3PriceKey` | `chainId:tokenAddress` | V3 oracle price cache |
| `v4PriceKey` | `chainId:spokeAddress:tokenAddress` | V4 oracle price cache |
| `v4SpokeCacheKey` | `spokeAddress:hubAddress` | V4 spoke-hub 对 |
| `v3OnchainKey` | `chainId:poolAddress:tokenAddress` | V3 onchain 数据 |
| `v4OnchainKey` | `chainId:spokeAddress:tokenAddress:hubAddress` | V4 onchain 数据 |
| `topologySortKey` | `chainId:spokeAddress:hubAddress` | 拓扑去重 |
| `v4ReserveId` | `chainId:spokeAddress:tokenAddress:hubAddress` | V4 reserve ID |
| `aaveProReserveId` | `chainId:spokeAddress:underlying:hubAddress:hubName` | Aave Pro reserve ID |
| `chainSymbolKey` | `chainId:symbol` | symbol 查找 |

> **地址 normalize 约定**：所有 key 函数中的地址类型参数（spokeAddress, hubAddress, poolAddress, tokenAddress, underlying）均通过 `normalizeAddress()` 标准化。非地址参数（symbol, hubName）不 normalize。

> **注意**：`spokeKey` 和 `chainTokenKey` 输出格式相同（`chainId:address`），但语义不同：spokeAddress 是 V4 spoke 合约地址，tokenAddress 是 V3 aToken/vToken 合约地址。实践中两者不会重叠。

## 已知泄漏源与修复记录

| 泄漏源 | 根因 | 修复 | Commit |
|--------|------|------|--------|
| `metricsCache` raw 保留 | cache 存了完整 API 响应（11-47MB/条） | 删除 `MetricsCacheEntry.raw`，fetch 完立即写 debug 文件 | `0437905` |
| `metricsCache` 无界增长 | Map 只写不删 | TTL 过期删 + max 500 条 | `bf88358` |
| `workerDisabledResolvers` 累积 | Array.splice 索引错位导致删不掉 resolver | Array → Set + resolver 自删除 | `bf88358` |
| `meritCurrentBlockNumberCache` 无界 | Map 只写不删 | TTL 60s + max 50 条 | `1b3368f` |
| `discoveredRedirectAliases` 累积 | 运行时累积，无清理 | 每次 fetchMeritData 清空 | `1b3368f` |
| `oraclePriceHashes` shrink 失效 | key 格式不匹配（reserveId vs chainId\|tokenAddr\|configId） | 修 key 格式 + shrinkOraclePriceHashes | `1b3368f` |
| `V4_RESERVE_TOKEN_CACHE` 无 eviction | 只有 TTL 检查，无过期删除 | 写入后遍历删除 2×TTL 的条目 | `1b3368f` |
| `ProviderPool` 无定时清理 | 只在请求时清理，无请求则不清理 | startCleanupTimer 30min 周期 | `1b3368f`（接线补于 server.ts，见下）|
| `startCleanupTimer` 死代码 | 定义了但构造函数/server.ts 均未调用，空闲期 TTL 回收失效 | server.ts 在 configure() 后启动 + shutdown 时释放 disposer | pending |
| Puppeteer browser 不关闭 | 空闲后未关闭，占 50-100MB | 2min idle timeout + _browserClosing guard | `0437905` |
| `zeroBaselineFirstSeenAt` 无界 | Map 只写不删 | max 500 条 | `bf88358` |
| PG pool 过大 | 5 个 SSL 连接各占 5-10MB native memory | 减到 3 | `e82bbe1` |
| `withTimeout` dangling socket | 超时后 fetch 未 abort | AbortController + AbortSignal | `e82bbe1` |
| `roundEstimateCache` 无上限 | 有 48h TTL 但无 max entries | max 200 条兜底 | `8cd18d5` |
| `campaignMetadataMemoryCache` 无 shrink | `{...cachedTimeRanges}` 继承所有历史 key | shrinkCampaignMetadataCache() + max 500 条 | `8cd18d5` |
| `marketRowHashes` 无上限 | 有 shrink 但无 max entries | max 500 条兜底 | `8cd18d5` |
| `marketConfigHashes` 无上限 | 有 shrink 但无 max entries | max 500 条兜底 | `8cd18d5` |
| `oraclePriceHashes` 无上限 | 有 shrink 但无 max entries | max 2000 条兜底 | `8cd18d5` |
| V4 `AaveClient.queryRegistry` 无界增长 | GqlClient.resultFrom 用 .toPromise() 不触发 teardown，queryRegistry Map 只增不减；graphcache 缓存全量查询结果 | per-fetch 创建 client + cache:false + batch:false | `59d8746` |
| `_merklState.lastSuccessfulSnapshot` 保留 rawOpportunities | fallback snapshot 保留完整 raw API 数组(~5-8MB 解析对象)，仅需 index+processedData+forecastMeta | 替换为 liveOpportunityCount(number)，内存 fallback 返回空数组 | `fb2e8c3` |
| undici TLS 连接池 native memory | 默认 undici 无连接数限制，OpenSSL 缓冲区 ~14MB/h 持续累积 | setGlobalDispatcher 限制 connections=10/host + keepAliveTimeout=30s | `4faa554` |
| node-fetch 连接池 native memory | https.globalAgent.maxSockets=Infinity → 无限并发 TLS 连接 | maxSockets=10 + 7 处错误路径 drain body | `5e18193` |
| node-fetch keep-alike free socket 池 | maxFreeSockets 默认 256 → 空闲 keep-alive socket 无限累积（每个持有 TLSSocket/ClientRequest/ReadableState/7 个 stream 闭包） | maxFreeSockets=2 + Merkl fallback drain body | Session 6 |
| glibc malloc arena 碎片 | 默认 glibc 并行 arena 导致 RSS 远大于 heap（多线程各自缓存） | MALLOC_ARENA_MAX=2 | Dockerfile |

## 监控与验证

### 线上内存监控（已部署）
- 60s 间隔 `📊 Memory:` 日志：heap/rss/external + merkl cache sizes
- RSS restart guard：`RSS_RESTART_THRESHOLD_MB=800`，超限触发 graceful shutdown 替代硬 OOM kill
- Playwright RSS guard：本地 Playwright 启动前检查 `process.memoryUsage().rss`，超过 700MB 跳过启动 + warn log
- Playwright 动态 import：`import { chromium }` 改为 `await import("playwright")`，减少启动时内存占用
- `MERIT_ALLOW_LOCAL_PLAYWRIGHT=true`（默认），RSS guard 自动守卫而非硬禁用

### 验证泄漏是否修复
- 需要 24h+ 的 `📊 Memory:` 日志，观察 heapUsed 是否有单调增长趋势
- 正常模式：heap 在固定范围波动（如 270-310MB），GC 后回落
- 泄漏模式：heap 逐步上升（如每 24h 增长 50MB），GC 后不回落到基线

### 深度分析（备用）
- `/health` 端点返回内存指标 → 外部监控告警
- `--inspect` + heap snapshot → 按需获取 heap profile
- Node.js `v8.writeHeapSnapshot()` → 事后分析 OOM 原因

---

## 泄漏追踪时间线

> 按时间顺序记录每次内存泄漏诊断 session 的发现、修复和验证结果。新 session 接手时先读此节获取上下文。

### 泄漏演化总览

```
时间线（从早到晚）：

Phase 1: 初始 OOM
  ├── undici TLS 连接池 native memory ~14MB/h → commit 4faa554
  ├── metricsCache raw 保留 11-47MB/条 → commit 0437905
  ├── metricsCache 无界增长 → commit bf88358
  ├── workerDisabledResolvers 累积 → commit bf88358
  └── 多个 cache 无 max entries → commit 8cd18d5

Phase 2: 修复后仍 OOM（~23MB/h RSS 增长）
  ├── --max-old-space-size=384 → 降至 ~12MB/h
  ├── MALLOC_ARENA_MAX=2 + tryGc() → 降至 ~6.3MB/h
  └── 34h 后仍 OOM → V8 old_space 泄漏未消除

Phase 3: Heap snapshot 定位 V4 queryRegistry
  ├── 对比 3 个 heap snapshot（0h/2h/3.5h）
  ├── `query Markets` 从 0→510 instances/2.67MB
  ├── JSArrayBufferData 从 0.59MB→1.14MB
  └── commit 59d8746: V4 per-fetch client + cache:false → query Markets 稳定在 ~331/1.73MB

Phase 4: JSArrayBufferData 增长（当前）
   ├── 1GB 容器: ~1.4MB/h（237/1.36MB → 408/2.06MB over 30min）
   ├── 2GB 容器: 1725 instances/8.75MB overnight + 4336 undici stream handlers
   ├── _merklState.lastSuccessfulSnapshot rawOpportunities → commit fb2e8c3
   └── 待验证: undici stream handlers 累积原因

Phase 5: node-fetch 修复后仍增长 (~4.4MB/h RSS)
   ├── node-fetch body drain + maxSockets=10 → RSS 基线 149-159MB (-57%)
   ├── 23h 数据显示仍增长 (4.4MB/h RSS, 2.9MB/h old, 1.4MB/h arrayBuffers)
   ├── 诊断代码 (heap snapshot) 导致临时 OOM → 已移除自动触发
   └── heap snapshot diff 确认 ClientRequest/TLSSocket 持续累积

Phase 6: maxFreeSockets 修复
   ├── 根因: https.globalAgent.maxFreeSockets=256 → 空闲 keep-alive socket 无限累积
   ├── 每个 socket 持有: TLSSocket + ClientRequest + ReadableState + 7 个 stream 闭包 + JSArrayBufferData
   ├── 24min diff: +23 ClientRequest, +299 stream closures, +116 JSArrayBufferData
   ├── 修复: maxFreeSockets=2 + Merkl fallback drain body
   └── 待验证: 4-6h 观察确认增长停止
```

### Session 详细记录

#### Session 1: 2026-06-09 — 初始 OOM 排查
- **现象**: 后端在 Railway 上持续 OOM crash（2GB 容器）
- **发现**: Merit 缓存完整性判断 bug 导致无限重试 Worker/Puppeteer
- **修复**: truthy-gate fix（commit d9cad34→fcbf02d→aa62283）
- **遗留**: OOM 根因未确认，猜测是 metricsCache 无界增长
- **Handoff**: `docs/plans/executed/handoff-memory-leak.md`

#### Session 2: 2026-06-xx — Cache 全量审计 + 补强
- **发现**: 多个 cache 缺少 max entries / shrink / TTL
- **修复**: 全量补强（commit bf88358, 8cd18d5, 1b3368f）
- **结果**: 仍有 OOM，RSS ~6.3MB/h 增长
- **Handoff**: `docs/plans/executed/handoff-memory-leak-v2.md`

#### Session 3: 2026-06-xx — undici + glibc 修复
- **发现**: undici 默认无连接限制 → native memory ~14MB/h
- **修复**: setGlobalDispatcher（commit 4faa554）+ MALLOC_ARENA_MAX=2
- **结果**: 仍有 ~6.3MB/h V8 old_space 增长

#### Session 4: 2026-07-03 — Heap snapshot 诊断 V4 + JSArrayBufferData
- **现象**: 1GB 容器 old_space 稳定但 JSArrayBufferData ~1.4MB/h
- **方法**:
  1. MEMORY_DIAG=1 + heap space breakdown 日志
  2. Cron-based heap snapshot + top-40 constructor 分析
  3. 3 个 snapshot 对比（0h/2h/3.5h）
- **发现**:
  1. `query Markets` 构造器从 0→510 instances — V4 GqlClient.queryRegistry 泄漏
  2. JSArrayBufferData 从 62→114 instances — 持续增长
  3. 4336 undici stream event handlers 累积（2GB 容器）
- **修复**:
  1. V4 AaveClient per-fetch + cache:false + batch:false（commit 59d8746）
  2. MerklSuccessfulSnapshot 移除 rawOpportunities/liveOpportunities，改为 liveOpportunityCount（commit fb2e8c3）
  3. Brevis Buffer 从 buffer.slice() 改为 Buffer.from(subarray())（commit fb2e8c3）
  4. Brevis response.err 从 Buffer 改为 .toString('utf-8')（commit fb2e8c3）
- **验证中**: JSArrayBufferData 增长趋势待 2-3h 确认
- **待排除**:
  1. undici stream event handlers 累积原因（2GB 容器 4336 个，1GB 未复现）
  2. large_object_space 从 6MB→25MB 的趋势（之前 2GB 容器观察到）
  3. (code deopt data) 缓慢增长 0.67MB/1369→0.67MB/1475

#### Session 5: 2026-07-04 — node-fetch 连接池 + body 未消费修复 + 诊断代码 OOM
- **发现**:
  1. `node-fetch` 使用 Node.js 内置 `http`/`https` 模块，**不走 undici globalDispatcher**
  2. `https.globalAgent.maxSockets` 默认 `Infinity`，允许对同一 host 无限并发 TLS 连接
  3. 每条 TLS 连接持有 native memory（OpenSSL buffer + glibc malloc），不在 V8 heap 内
  4. 7 处 `node-fetch` 错误路径未消费 response body，keep-alive 连接无法回池
  5. arrayBuffers idle growth (0→18MB) 审计结论：无 JS 层长期持有，来自 native 层 Buffer
  6. **诊断代码导致 OOM**：`maybeHeapSnapshot()` 在 30min 时调用 `v8.writeHeapSnapshot()` + `readFile` + `JSON.parse`，在 1GB 容器中瞬间分配 ~500MB 内存，导致 RSS 垂直飙升到 1GB
  7. `--heapsnapshot-near-heap-limit=1` 在 OOM 前也会触发写 snapshot，同样瞬间分配大量内存
- **修复**:
  1. `https.globalAgent.maxSockets = 10` + `http.globalAgent.maxSockets = 10`（限制 node-fetch 连接池）
  2. 7 处 `node-fetch` 错误路径添加 `await response.text().catch(() => {})` drain body
  3. Memory log 添加 `nodeAgent=https:N/Nact http:N/Nact` 统计
- **修复效果**（部署验证）:
  - RSS 基线：320-367MB → 149-159MB（**-57%**）
  - arrayBuffers：16-17MB → 1MB（**-94%**）
  - external：19-20MB → 4-5MB（**-75%**）
  - old_space：67-68MB → 37-39MB（**-44%**）
- **根因分析**:
  - "两次飙升到 1G"是 **诊断代码（heap snapshot）** 在 1GB 容器中触发 OOM，不是渐进泄漏
  - node-fetch 连接池泄漏是**持续累积型**（~14MB/h），不是垂直飙升
  - 之前的修复（Session 1-4）覆盖了 V8 heap 泄漏和 undici 通道，但**遗漏了 node-fetch 这条独立 HTTP 通道**
- **文件**:
  - `backend/src/server.ts` — http/https globalAgent maxSockets 限制 + nodeAgent 统计
  - `packages/aave-fetcher/src/merkl-api.ts` — fetchWithRetry 5xx + 非 5xx drain body
  - `packages/aave-fetcher/src/merit-api.ts` — 3 处 RPC/page fetch drain body
   - `packages/aave-fetcher/src/brevis-api.ts` — gRPC 错误 drain body
   - `backend/src/services/merklForecastService.ts` — fetchJson 429/5xx/4xx drain body

#### Session 6: 2026-07-05 — maxFreeSockets 修复 (node-fetch keep-alive 空闲 socket 累积)
- **现象**:
  - Session 5 修复后 RSS 基线从 320-367MB 降至 149-159MB，但 23h 后仍增长至 265MB
  - 增长率: RSS ~4.4MB/h, old_space ~2.9MB/h, arrayBuffers ~1.4MB/h, external ~1.4MB/h
  - 所有指标减速（heap 4.0→2.6 MB/h, RSS 4.9→4.4 MB/h），但 23h 未收敛
- **方法**:
  1. `curl /api/debug/heap-snapshot` 写入 + 下载到本地
  2. Python 脚本解析 .heapsnapshot JSON，分析 top 构造器和实例数
  3. 两个快照（间隔 24min）对比增量
- **发现**:
  1. **6786 个 ReadableState, 1357 个 ClientRequest/TLSSocket** — 远超活跃连接数
  2. **17622 个 stream 事件闭包** (onend/onerror/cleanup/onclose/onfinish/onlegacyfinish/onrequest)
  3. **JSArrayBufferData**: 6841 instances, 34MB — 最大内存消费者
  4. **1354 个 GraphQL Markets 查询字符串** — 每个 5.4KB，共 7.09MB
  5. 24min diff: **+23 ClientRequest, +299 stream closures, +116 JSArrayBufferData** — 持续增长
  6. `nodeAgent=https:0/0act` — 0 活跃连接，所有 ClientRequest 是空闲的
  7. `https.globalAgent.maxFreeSockets` 默认 **256** — 空闲 keep-alive 池可缓存 256 个 socket/host
- **根因**:
  - node-fetch 请求完成后，keep-alive socket 被放入 `https.globalAgent.freeSockets` 缓存
  - `maxFreeSockets=256` 允许每 host 缓存最多 256 个空闲 socket
  - 每个 socket 持有: TLSSocket (~0.4KB V8) + ClientRequest (~0.4KB) + ReadableState (~5 个) + 7 个 stream 闭包 + JSArrayBufferData (16-128KB)
  - 请求频率低（~1次/min），keep-alive 连接很少被复用，空闲 socket 在池中无限累积
  - Session 5 只设了 `maxSockets=10`（限制并发连接），但**没有设 `maxFreeSockets`**（空闲缓存）
  - `maxFreeSockets` 和 `maxSockets` 是独立的: `maxSockets` 限制同时活跃连接，`maxFreeSockets` 限制 keep-alive 池中空闲连接
- **修复**:
  1. `https.globalAgent.maxFreeSockets = 2` + `http.globalAgent.maxFreeSockets = 2`
  2. merit-api Merkl opportunities fallback 路径 drain body (第一次 !ok 时 drain 后再发第二次)
  3. Memory log 添加 `freeSockets` 统计: `nodeAgent=https:N/Nact/Nfree http:N/Nact/Nfree`
- **验证中**: 需要 4-6h 观察确认增长趋势停止
- **文件**:
  - `backend/src/server.ts` — maxFreeSockets=2 + free socket 统计
  - `packages/aave-fetcher/src/merit-api.ts` — Merkl fallback drain body

---

## 诊断方法论

> 排查内存泄漏时参考此节选择正确的方法。

### 方法 1: `📊 Memory` 日志趋势分析（首选）

60s 间隔的日志已经能发现大部分问题。观察以下指标的单调增长趋势：

| 指标 | 正常范围 | 泄漏信号 |
|------|---------|---------|
| heap | 44-52MB (1GB container) | 持续 >55MB 且 GC 不回落 |
| old_space | 35-40MB | Δbase 持续 >+5MB |
| arrayBuffers | 0-3MB | 持续 >5MB |
| large_object | 6-8MB | 持续 >15MB |
| rss | 130-180MB | 持续 >250MB |

**关键**: 单个数据点不能判断泄漏，必须看 2h+ 的趋势。

### 方法 2: Cron-based old_space Δbase 追踪

`logOldSpaceDiff()` 在每个 cron 周期前后记录 old_space 变化。

- `Δbase` = 相对于进程启动时的增长（反映累积泄漏）
- `Δlast` = 相对于上一次测量的变化（反映单次 cron 的影响）

正常模式: Δbase 在 +2~+9MB 波动，不单调递增。
泄漏模式: Δbase 每轮 cron 增加，如 +5→+10→+15→+20→...

### 方法 3: Heap snapshot 对比分析

当方法 1/2 确认了泄漏但无法定位源头时使用。

**流程**（1GB 容器安全，不需要调大容器）：

1. `curl https://staging-api.aaveapy.com/api/debug/heap-snapshot` → 写 snapshot 到磁盘（临时 ~100-200MB RSS，写完释放），返回 `fileName`
2. `curl -o snapshot1.heapsnapshot https://staging-api.aaveapy.com/api/debug/heap-snapshot/{fileName}` → 下载到本地
3. 等一段时间后再执行步骤 1-2，得到 `snapshot2.heapsnapshot`
4. 用 Coding Agent 直接读取 JSON 文件分析 top 构造器和引用关系，或用 Chrome DevTools → Memory → Load 可视化对比

**为什么不在容器内解析**：`readFile` + `JSON.parse` 临时分配 ~500MB（等于 snapshot 文件大小 × 2），1GB 容器会 OOM。只写磁盘不读回，RSS 只临时增加 ~100-200MB。下载到本地后，本地机器内存充足，解析无压力。

**端点**（均需要 `MEMORY_DIAG=1` 环境变量）：
- `GET /api/debug/heap-snapshot` — 写 snapshot 到磁盘，返回文件名
- `GET /api/debug/heap-snapshot/:filename` — 下载已写入的 snapshot 文件
- `GET /api/debug/heap-stats` — 轻量级，只读 V8 统计数字（heap/空间/rss），零开销

### 方法 4: 构造器级别分析

从 `📊 Memory` 日志中 `spaces=[old=XX/YY code=X/Y large_object=X/Y]` 提取：

- `old_space used` 持续增长 → V8 堆泄漏（JS 对象未释放）
- `large_object_space` 增长 → 大对象（>256KB）累积
- `arrayBuffers` 增长 → ArrayBuffer/TypedArray 未释放

### 常见泄漏模式速查

| 模式 | 典型构造器 | 典型根因 | 诊断线索 |
|------|-----------|---------|---------|
| Cache 无界增长 | `(string)` / `(object)` | Map 只写不删 | heap snapshot 中 retained_size 大的 Map |
| 闭包泄漏 | `(closure)` / `(context)` | resolver/callback 未释放 | workerDisabledResolvers 模式 |
| 原生内存泄漏 | RSS >> heap | undici/ OpenSSL/glibc | external/malloced 远大于 heap |
| queryRegistry | `query Markets` | GqlClient .toPromise() 不触发 teardown | 构造器名称含 GraphQL 相关 |
| Buffer 共享 | `JSArrayBufferData` | buffer.slice() 共享底层 ArrayBuffer | ArrayBuffer 数量持续增长 |
| Stream handler | `onend`/`onerror` | HTTP response stream 未完全释放 | undici/fetch 相关 handler 累积 |
| node-fetch 连接池 | RSS >> heap | https.globalAgent.maxSockets=Infinity | node-fetch 不走 undici dispatcher，需单独限制 |
| node-fetch keep-alive 池 | ClientRequest/TLSSocket/ReadableState 持续增长 | https.globalAgent.maxFreeSockets=256 默认值 | 设 maxFreeSockets=2 限制空闲 socket 缓存 |
| Body 未消费 | keep-alive 不回池 | node-fetch !ok 路径未 drain body | await response.text().catch(() => {}) |
| 诊断代码 OOM | RSS 垂直飙升 | heap snapshot 序列化 + readFile + JSON.parse | 容器容量 < snapshot 大小的 2 倍时必 OOM |
| heapsnapshot-near-heap-limit | RSS 垂直飙升 | V8 OOM 前自动写 snapshot | 同上，1GB 容器中必须移除此参数 |

### 环境配置

诊断相关环境变量和启动参数：

| 配置 | 当前值 | 用途 | 何时移除 |
|------|--------|------|---------|
| `MEMORY_DIAG=1` | 已设置 | 门控 heap 详细日志 + snapshot + debug 端点 | 泄漏确认修复后 |
| `--expose-gc` | 已设置 | 允许 `globalThis.gc()` 手动触发 GC | 同上 |
| `--max-old-space-size=512` | 已设置 | 限制 V8 堆，强制更激进的 GC | 可保留，有防御价值 |
| `MALLOC_ARENA_MAX=2` | 已设置 | 限制 glibc 并行 arena，减少 RSS 碎片 | 可保留 |
| `RSS_RESTART_THRESHOLD_MB=800` | 已设置 | RSS 超限 graceful shutdown | 可保留 |
| `--heapsnapshot-near-heap-limit=1` | **已移除** | OOM 前自动写 heap snapshot → 1GB 容器中反而加速 OOM | 已移除 |
| `/api/debug/heap-snapshot` | 已部署 | 写 snapshot 到磁盘（只写不读，1GB 容器安全） | 泄漏确认修复后移除 |
| `/api/debug/heap-snapshot/:filename` | 已部署 | 下载已写入的 snapshot 文件 | 泄漏确认修复后移除 |
| `/api/debug/heap-stats` | 已部署 | 轻量级 V8 统计（零开销） | 泄漏确认修复后移除 |
| `/api/debug/heap-top` | **已移除** | getHeapSnapshot + JSON.parse → 1GB 容器 OOM | 已移除 |

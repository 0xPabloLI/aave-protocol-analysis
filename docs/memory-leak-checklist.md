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
| 35 | merkl-api | `_merklState` | 单例对象 | ✅ | ➖(cron替换) | ➖(单条) | ✅(替换) | 🟢 | 内含 lastSuccessfulSnapshot + lastFetchError,fetch后整体替换 |
| 36 | cloudflare-browser | `workerDisabledResolvers` | Set | ✅ | ➖(Promise自删) | ➖(并发有限) | ✅(resolve后自删除) | 🟢 | 已从Array改为Set，resolve后自删除 |
| 37 | brevis-distributed-so-far | `chainCallCache` | Map | ✅ | ✅(1h TTL+2h惰性删) | ✅(100) | ✅(pruneCache+FIFO) | 🟢 | tokenCumulativeRewards约4h变一次，1h TTL足够 |

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

## 监控与验证

### 线上内存监控（已部署）
- 60s 间隔 `📊 Memory:` 日志：heap/rss/external + merkl cache sizes
- RSS restart guard：`RSS_RESTART_THRESHOLD_MB` 可配置，当前设为 0（warn-only，不自动 SIGTERM），避免掩盖内存增长过程
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

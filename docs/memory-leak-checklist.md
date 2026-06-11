# Memory Leak Prevention Checklist

每次涉及内存相关开发时（新增/修改 cache、Map、Set、长期存活的闭包、长连接、浏览器实例等），必须逐条检查。

## Cache 设计三原则

1. **Domain 层**：cache 只存业务需要的精简数据，不存 raw API 响应或 debug 用的完整对象。Debug 需求应独立处理（写文件后释放，不存入 cache）。
2. **TTL 层**：所有 cache 必须有 TTL 过期淘汰，处理"再也没人访问的 key"场景（如已下线的 campaign、不再使用的 chain）。
3. **Size 层**：所有 cache 必须有 max entries 上限兜底，处理未知泄漏或 TTL 不够激进的场景。上限值应基于 domain 知识设定（如 chain 数量 ~20、campaign 数量 ~500）。

## 逐项检查清单

### 新增/修改 Cache 时

- [ ] 是否只存业务需要的最小数据？（不存 raw、不存 debug 数据）
- [ ] 是否有 TTL 过期淘汰？（过期 key 必须能被删除，即使无人再访问）
- [ ] 是否有 max entries 上限？（兜底防线）
- [ ] Eviction 逻辑是否在 cache 自身职责内？（不应嵌在业务代码里）
- [ ] 新条目是否覆盖同 key 旧条目？（Map.set 天然如此，确认没有 append-only 模式）

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
| `ProviderPool` 无定时清理 | 只在请求时清理，无请求则不清理 | startCleanupTimer 30min 周期 | `1b3368f` |
| Puppeteer browser 不关闭 | 空闲后未关闭，占 50-100MB | 2min idle timeout + _browserClosing guard | `0437905` |
| `zeroBaselineFirstSeenAt` 无界 | Map 只写不删 | max 500 条 | `bf88358` |
| PG pool 过大 | 5 个 SSL 连接各占 5-10MB native memory | 减到 3 | `e82bbe1` |
| `withTimeout` dangling socket | 超时后 fetch 未 abort | AbortController + AbortSignal | `e82bbe1` |
| `roundEstimateCache` 无上限 | 有 48h TTL 但无 max entries | max 200 条兜底 | `8cd18d5` |
| `campaignMetadataMemoryCache` 无 shrink | `{...cachedTimeRanges}` 继承所有历史 key，已下线 campaign 永不删除 | shrinkCampaignMetadataCache() + max 500 条 | `8cd18d5` |
| `marketRowHashes` 无上限 | 有 shrink 但无 max entries | max 500 条兜底 | `8cd18d5` |
| `marketConfigHashes` 无上限 | 有 shrink 但无 max entries | max 500 条兜底 | `8cd18d5` |
| `oraclePriceHashes` 无上限 | 有 shrink 但无 max entries | max 2000 条兜底 | `8cd18d5` |

## 监控与验证

### 线上内存监控（已部署）
- 60s 间隔 `📊 Memory:` 日志：heap/rss/external + merkl cache sizes
- RSS restart guard：`RSS_RESTART_THRESHOLD_MB=800`，超限自动 SIGTERM

### 验证泄漏是否修复
- 需要 24h+ 的 `📊 Memory:` 日志，观察 heapUsed 是否有单调增长趋势
- 正常模式：heap 在固定范围波动（如 270-310MB），GC 后回落
- 泄漏模式：heap 逐步上升（如每 24h 增长 50MB），GC 后不回落到基线

### 深度分析（备用）
- `/health` 端点返回内存指标 → 外部监控告警
- `--inspect` + heap snapshot → 按需获取 heap profile
- Node.js `v8.writeHeapSnapshot()` → 事后分析 OOM 原因

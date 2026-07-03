# ADR-0027: 分层 RPC 解析

## 状态

Implemented

## 上下文

所有链的 RPC URL 硬编码在 `packages/aave-shared-config/index.js` 的 `AAVE_RPC_URLS_BY_CHAIN_KEY` 中。两个风险：

1. **已有链全挂**：硬编码 RPC 全部宕机，无备选来源
2. **新链没配 RPC**：Aave 部署新链时 shared-config 未更新，`getAaveRpcUrlsByChainId` 返回空数组

前端已有类似方案（`chainRegistry.ts` + `chainDiscovery.ts`），后端缺失。

## 决策

ProviderPool 新增 `executeWithAutoRpc(chainId, execs, options): Promise<T | null>`，实现统一逐层补充 RPC 解析：

| 层 | 来源 | 性质 | 时效性 |
|---|---|---|---|
| 1 | shared-config 硬编码 | 静态（编译时可知） | 需人工更新部署 |
| 2 | viem/chains extractChain | 静态（编译时可知） | 随 viem 发版更新 |
| 3 | chainid.network + chainlist.org | 动态（运行时发现） | 社区实时维护 |

所有链（无论是否在 shared-config 中）走同一路径：逐层补充 URL，每层只在 `needsMore`（URL 列表为空或全部 suppressed）时才进入下一层。追加的 URL 与已有 URL 合并去重（`mergeUrls`）。

### 逐层补充逻辑

```
1. urls = getAaveRpcUrlsByChainId(chainId)
2. if needsMore(chainId, urls): urls = merge(urls, resolveViemChainRpcs(chainId))
3. if needsMore(chainId, urls): urls = merge(urls, dynamicRpcCache.get(chainId))
4. if urls.length === 0: return null
5. executeWithFallback(chainId, urls, execs, options)
```

- `needsMore(chainId, urls)` = `urls.length === 0 || areAllSuppressed(chainId, urls)`
- 硬编码链正常时：层 1 足过层 2/3，零额外开销
- 硬编码链全 suppress 时：层 2 追加 viem/chains URL（作为同级的静态补充）
- 新链首次调用：层 1 为空 → 层 2 viem/chains 同步返回 → 触发后台 `startFetch` + `newChainHook` 告警

### 缓存策略

- **永久缓存 + 失败时重新获取**：DynamicRpcCache 不设 TTL
- **re-fetch 触发**：该 chainId 的动态缓存 RPC 在 ProviderPool 中全 suppressed → invalidate → 下次调用 re-fetch
- **fire-and-forget**：新链首次调用立即从 viem/chains 同步返回，后台 fetch chainid.network/chainlist.org 写缓存

### 调用方迁移

oracleService、onchainDataService、fetchV4ReservesViaRpc 从 `getAaveRpcUrlsByChainId` + `executeWithFallback` 迁移到 `executeWithAutoRpc`。

### 包依赖

`aave-rpc-infra` 新增 `viem` 直接依赖（之前仅通过 address-book 间接引入）。

## 理由

1. **现有链零开销**：硬编码健康时 `needsMore` 为 false，不调 viem/dynamic，行为与之前完全一致
2. **硬编码链有 fallback**：所有硬编码 RPC 被 suppress 时，viem/chains 作为同级静态补充追加，不再直接抛异常
3. **新链即时可用**：viem/chains 静态兜底保证首次调用即有 RPC，无需等部署
4. **渐进增强**：外部源 RPC 异步写入缓存，后续调用质量逐步提升
5. **自愈能力**：所有 RPC suppressed 时自动 invalidate + re-fetch，发现新节点
6. **路径统一**：所有链走同一逻辑，无硬编码/非硬编码分叉

## 替代方案

### viem/chains 作为层 2（无外部源）

- 缺点：viem/chains 数据是 chainid.network 快照，新链可能等数周才进入 viem
- **未采纳**：外部源时效性更好

### 周期预刷新外部源

- 缺点：增加无谓网络请求，且外部源数据不频繁变化
- **未采纳**：懒缓存 + 失败重获取更高效

### 完全移除硬编码

- 缺点：付费 RPC（Infura/Alchemy）延迟更低、可用性更高
- **未采纳**：硬编码是最佳选择，外部源仅兜底

## 后果

- **硬编码链 fallback**：硬编码 RPC 全 suppress 时追加 viem/chains URL，再不行追加 DynamicRpcCache URL
- **新链检测告警**：首次发现无硬编码 RPC 的链时 logger.warn，提示 owner 更新 shared-config
- **viem 依赖升级**：aave-rpc-infra 直接依赖 viem，升级需关注 breaking change
- **调用方简化**：不再需要手动获取 RPC URL 列表 + 空值检查，executeWithAutoRpc 一行搞定
- **后续优化**：Prometheus counter（AAV-586）、主动通知（AAV-587）、ProviderPool↔DynamicRpcCache 清理同步（AAV-823）

### 补充（2026-07-03）

原先 `addressBookRegistry.ts` 的 `isSupportedChain` 白名单阻止了 `executeWithAutoRpc` 对新链的调用——链不在 `POOL_CONFIGS` 中，auto-discovery 永远不会触发。ADR-0034 用 `isTestnetKey` 替代 `isSupportedChain`，移除了这个障碍，使本 ADR 的三层 RPC 发现对新链真正生效。

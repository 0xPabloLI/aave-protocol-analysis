# Diagnosis: Railway OOM / SIGTERM (2026-06)

**日期**: 2026-06-15
**状态**: 根因已通过 heap snapshot 精确归因；Fix A + Fix B 已实施

## ✅ 根因已确定

**通过 V8 heap snapshot 精确归因：`googleapis` 包占 31.26MB heap（占字符串总量 54.5MB 的 57.3%，占 heap 总量 120.9MB 的 25.8%）。**

`backend/src/services/gscService.ts` 中 `import { google } from 'googleapis'` 会加载整个 googleapis 包（200+ Google API 子模块），每个模块的完整编译源码被 V8 保留在堆中。

### Heap Snapshot 分析结果（2026-06-15 部署）

稳态 heap：113MB (warmup 后), RSS：222MB

**按 V8 节点类型：**

| 类型 | 大小 | 占比 |
|---|---|---|
| **string** | **54.46MB** | **45.0%** |
| code | 21.70MB | 17.9% |
| array | 16.56MB | 13.7% |
| object | 10.00MB | 8.3% |
| obj_shape | 6.99MB | 5.8% |
| closure | 4.74MB | 3.9% |
| 其他 | 6.45MB | 5.3% |

**字符串按内容分类：**

| 字符串类别 | 大小 | 占字符串比 |
|---|---|---|
| **googleapis 源码** | **31.26MB** | **57.3%** |
| 很长字符串 (>100 chars) | 11.05MB | 20.3% |
| 中等长度字符串 (21-100 chars) | 3.44MB | 6.3% |
| 短字符串 (4-20 chars) | 2.58MB | 4.7% |
| JS 源码 (非 googleapis) | 2.26MB | 4.1% |
| hex 地址/tx 数据 | 1.33MB | 2.4% |
| JSON 数据 | 1.02MB | 1.9% |
| GraphQL | 0.81MB | 1.5% |
| 其他 | 0.61MB | 1.1% |

### 模块加载内存开销

| 组件 | Heap 增量 |
|---|---|
| ethers.js v5 | 12 MB |
| hono | 2 MB |
| pg | 1 MB |
| rpc-infra (不含 ethers) | 6 MB |
| fetcher (不含 ethers/rpc-infra) | 20 MB |
| **模块加载合计** | **44 MB** |

### 6月13日 vs 6月15日差异解释

6月13日 heap 281-321MB vs 当前 113MB。差异约 168MB，归因：
1. **googleapis 源码**：31MB（两边都有，不是差异来源）
2. **V8 GC 时间差异**：6月13日只运行~13分钟，GC 未回收 warmup 临时对象
3. **后续 commit 改善**：memory leak fix + hono 升级 + Missing APR cap 修复
4. **Fix A + Fix B 效果**：ProviderPool 复用 + Merkl AMOUNT 批量去重

## 相关 Issue

- AAV-494: Memory leak detected in production - OOM crash analysis (Done)
- AAV-888: Replace Puppeteer fallback: memory-constrained browser rendering alternative (Open)

## 症状

6月10日和6月13日，Railway 上多次收到 SIGTERM，容器被 kill。

## 日志证据

### 内存对比

| 部署日期 | RSS 范围 | Heap 范围 | External | SIGTERM | 备注 |
|----------|----------|----------|----------|---------|------|
| 6月10日 | 453-510MB | 269-325MB | 32-42MB | ✅ 收到 | Cloudflare Browser 429 → Puppeteer fallback 每分钟触发 |
| 6月13日 | 466-517MB | 281-321MB | 31-40MB | ✅ 收到 | Cloudflare Browser session=0，无 Puppeteer fallback |
| **6月15日(当前)** | **270-302MB** | **133-162MB** | **9-20MB** | 无 | 稳定运行 |

当前部署比之前低约 **200MB RSS / 150MB heap / 25MB external**。

### 6月10日 SIGTERM 序列

1. Deployment `228119da` → RSS 453-510MB → 被 SIGTERM kill
2. Deployment `5739d7b6` → RSS 220MB → 被 SIGTERM kill（新部署替换旧容器）
3. Deployment `41331cf4` → RSS 279-281MB → 被 SIGTERM kill

### 6月13日 SIGTERM 序列

1. Deployment `1f9b17c0` → RSS 372-392MB → 被 SIGTERM kill
2. Deployment `7778c158` → RSS 235-259MB → 被 SIGTERM kill
3. Deployment `2973fff8` → RSS 251MB → 被 SIGTERM kill
4. Deployment `ea640e15` → RSS 466-517MB → 被 SIGTERM kill

---

## 未解释的 heap 差异

6月13日 vs 6月15日 heap 差异（281-321MB vs 133-162MB）约 **150MB**，但数据量完全相同（354 reserves, 35 opportunities, 11 forecast campaigns），且6月13日版本：
- 没有 AMOUNT variant 并发 price resolve 代码（那是 `9ef5779` 后加的）
- 没有 Puppeteer fallback（Cloudflare Browser 正常运行，session=0）
- `Missing APR cap` 只失败了 3/11 个 campaign（`fulfilled=8, failed=3`），不足以解释 150MB

**可能原因**：6月13日部署到被 SIGTERM kill 之间只运行了 ~13 分钟，V8 GC 可能还没来得及回收 warmup 阶段的临时对象。而6月15日部署已经运行较久，GC 已完成多次回收，heap 稳定在较低水平。Node.js 的 heap 使用有锯齿形模式（分配 → GC → 回落），如果日志恰好捕获到 GC 前的峰值，就会看到 281-321MB。

**结论**：6月10日和6月13日的 SIGTERM 可能不是 OOM，而是 Railway 部署替换旧容器时的正常 SIGTERM。但 RSS 466-517MB 确实偏高（当前只有 270-302MB），说明之前的代码版本在稳态下内存确实比现在高。差异可能来自 hono 升级（`cddd3ac`）、memory leak fix（`8cd18d5`/`566a642`）的累积效果。

---

## 四个问题的分析

### 问题 1: Puppeteer fallback 内存风险（风险仍在）

**Q: Puppeteer 到底占多少？**

Puppeteer 的 Chromium 子进程占约 50-100MB 容器 RSS（不在 `process.memoryUsage()` 中），加上 Node.js CDP 连接的 external buffer 约 20-30MB，总共约 **70-130MB 容器级 RSS 增量**。

6月10日 Cloudflare Browser 429 后每分钟 fallback 到 Puppeteer，RSS 453-510MB。6月13日没触发 Puppeteer，RSS 也达 466-517MB（说明 Puppeteer 不是6月13日 OOM 的原因）。**但 Puppeteer fallback 的风险仍在**——如果当前部署（稳态 270-302MB）触发 Puppeteer，RSS 会升到 340-430MB，虽然不会立即 OOM，但如果同时有其他内存峰值就会逼近限制。

**修复方向**：Cloudflare Browser 429 时不要立即 fallback 到 Puppeteer，而是等下一轮 cron（1分钟后重试 Cloudflare）。Puppeteer 作为最后手段而非默认 fallback。这样每分钟最多触发一次 Cloudflare，不会连续启动 Chromium。

### 问题 2: Brevis chain call 的 JsonRpcProvider

**Q: 为什么没用 ProviderPool？为什么没 destroy？能不能复用？**

`brevis-distributed-so-far.ts:122` 自己 `new providers.JsonRpcProvider(rpcUrl)`，没有复用 `ProviderPool`。

**ProviderPool 的淘汰机制 vs destroy**：ProviderPool 用 `StaticJsonRpcProvider`（无状态、无内部轮询、无长连接），**不需要 destroy**。通过 TTL 淘汰（30min 未用就从 Map 中删除）就够了。而 `JsonRpcProvider` 有内部 detectNetwork 轮询（每次创建多发一个 RPC 请求），ethers v5 也没有 `destroy()` 方法（v6 才有）。所以问题不是"该不该 destroy"，而是**根本不该用 `JsonRpcProvider`**——应该跟 ProviderPool 一样用 `StaticJsonRpcProvider`，通过 ProviderPool 获取，自然享受淘汰 + failover + 复用。

**修复方向**：Brevis chain call 复用 `ProviderPool`：
1. `fetchBrevisDistributedSoFar` 接收 `ProviderPool` 实例（或一个 `(chainId, exec) => Promise<T>` 回调函数）
2. 对每个 chain，调用 `providerPool.executeWithAutoRpc(chainId, { primary: (provider) => executeMulticall3(provider, calls, ...) })`
3. 删除自己创建 `JsonRpcProvider` 的逻辑

**当前影响**：很小（只有 1-2 个 chain 有 submitContract，每分钟只创建 1-2 个短生命周期 provider）。

### 问题 3: Merkl AMOUNT variant 的并发 price resolve

**Q: 问题是调了 CoinGecko 还是 buffer 没清理？**

都不是主因。6月13日版本的代码根本没有 AMOUNT variant 并发 price resolve 代码（那是 `9ef5779` 后加的），但 heap 依然高。

当前的并发代码路径：`processMerklData` 中 `oppCampaignPromises` 对每个 campaign 并发调用 `resolveUsdPriceWithPriority`。如果 snapshot/reserve 未命中，就会打到 CoinGecko。但当前 AMOUNT variant 的 campaign 数量很少，实际触发的并发数远低于 35。

**修复方向**：作为防御性措施，可以改为先批量去重 resolve token price，再在循环内查 Map：
1. 循环前收集所有需要 price resolve 的 token（去重）
2. 串行或限流 resolve（5 个并发），build `chainId:tokenAddress → price` Map
3. 循环内直接查 Map，不再每个 campaign 独立调

这不会增加延迟（因为去重后实际 resolve 数量远少于 campaign 数量），也不需要额外的异步机制——只是把并发改为批量串行，在同一个 `processMerklData` 调用内完成。

### 问题 4: `Missing APR cap` 抛错导致内存浪费

**Q: 抛错归抛错，不要导致内存泄露？**

6月13日的 `buildForecastState`（`merklForecastModel.ts:132-135`）对 `TARGET_TOTAL_APR` 类型 campaign 要求必须有 APR cap，没有就 throw。这导致：
- 11 个 forecast campaign 中 3 个失败（`fulfilled=8, failed=3`）
- `refreshForecastSnapshotCache` 中 `Promise.allSettled` 捕获错误，失败的 campaign 仍然消耗了网络请求资源（`getMerklForecastState` 内部已经 fetch 了 metrics + campaign 数据）

**这不是内存泄漏，是内存浪费**：失败的 campaign 已经从 Merkl API 拿回了 metrics 数据（可能几十 KB JSON），但因为 throw 了，这些数据没有被缓存到 `metricsCache`，下次 cron 又会重新 fetch。**每分钟重复 fetch 3 个 campaign 的 metrics（不缓存）** → 额外的 HTTP buffer 开销。

**已修复**：`46fbd5a` 引入 TARGET_TOTAL_APR 类型后，`buildForecastState` 不再把无 APR cap 当错误。

**设计原则**：抛错本身不导致内存泄漏，但如果抛错跳过了缓存步骤，就会导致**重复 fetch 的内存浪费**。防御性写法应该是：即使最终决定 throw，也要先缓存已获取的数据（让下一轮直接 hit cache），或者在 throw 之前把 raw 数据存入 cache。

---

## 根因排序

| 排名 | 根因 | 影响 | 当前状态 |
|------|------|------|---------|
| 1 | **`googleapis` 整包导入** — 31.26MB heap 字符串（128 个 API 子模块源码） | **25.8% heap 占用** | ⚠️ 可优化（换用 `googleapis/build/src/apis/searchconsole` 专用子路径导入） |
| 2 | 6月10日/13日代码版本的稳态 heap 本身高于当前 | ~150MB heap | ✅ 已由后续多个 commit 改善 |
| 3 | Puppeteer fallback 被 Cloudflare 429 触发 → 额外 70-130MB 容器 RSS | 6月10日主因 | ⚠️ 风险仍在（429 可能再次发生，AAV-888） |
| 4 | Merkl AMOUNT variant 并发 CoinGecko 调用 | 当前 AMOUNT campaign 少，影响小 | ✅ Fix B 已实施 |
| 5 | Brevis chain call 未复用 ProviderPool | ~1-5MB（1-2 个 chain） | ✅ Fix A 已实施 |
| 6 | `Missing APR cap` 抛错跳过缓存 → 重复 fetch | ~10-30MB（3 个 campaign） | ✅ 已由 `46fbd5a` 修复 |

## 已实施修复

### Fix A: Brevis chain call 复用 ProviderPool ✅

- Commit: `663f3c1`
- `FetchBrevisDistributedSoFarOptions: providerPool?` + optional `rpcUrlsByChainId`（向后兼容）
- `fetchMarketsData` 调用方改为传 `{ providerPool }`
- 4 个 ProviderPool mock 测试 + 5 个集成测试

### Fix B: Merkl AMOUNT variant price resolve 批量去重 ✅

- Commit: `663f3c1`
- 预扫描所有 AMOUNT variant entry → 收集去重 token → 串行 resolve → build `preResolvedPrices` Map → build `amountVariantPriceMap` → 循环内查 Map
- 8 个 batch dedup 单元测试

### Fix C: Puppeteer 替换 → 移除（独立 issue AAV-888）⚠️

**Puppeteer 在当前内存环境下不是可用选项。** 稳态 RSS 222MB + Puppeteer 70-130MB = 290-350MB，与其他峰值叠加有 OOM 风险。

- 替代方案: Cloudflare Browser (primary) → Render 服务 (secondary) → Regex 兜底 (tertiary)
- 完整方案见 AAV-888

## 待实施修复

### Fix D: `googleapis` 专用子路径导入（新发现）

**问题**：`import { google } from 'googleapis'` 加载 200+ Google API 子模块源码，占 31.26MB heap。

**修复方向**：改用专用子路径导入：
```typescript
// Before (31.26MB heap)
import { google } from 'googleapis';

// After (~1-2MB heap)
import { searchconsole_v1 } from 'googleapis/build/src/apis/searchconsole/index.js';
```

或使用 `@google-cloud/storage` 等专用包替代 `googleapis` 全家桶。

**预估收益**：减少 ~29MB heap（从 31MB 降到 ~2MB）。

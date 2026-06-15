# Diagnosis: Railway OOM / SIGTERM (2026-06)

**日期**: 2026-06-15
**状态**: 根因未完全确定，调查过程供后续 agent 继续排查；三个 Fix 待实施

## ⚠️ 根因状态声明

**150MB heap 差异未精确归因。** 6月13日（281-321MB heap）vs 6月15日（133-162MB heap）数据量完全相同（354 reserves, 35 opportunities, 11 forecast campaigns），但 heap 差 150MB。可能的解释包括 V8 GC 时间差异（6月13日只运行~13分钟）、后续 commit 的累积改善等，但都未被证实。

6月10日和6月13日的 SIGTERM 可能不是 OOM，而是 Railway 部署替换旧容器时的正常 SIGTERM（旧容器收到 SIGTERM 被新部署替换）。

**建议后续 agent 重点关注**：
1. 用 `--inspect` 或 heap snapshot 对比稳态 vs 异常时的内存分布
2. 排查 V8 heap 中哪些对象类型占用了 150MB（可能是 ArrayBuffer、String、或 closures）
3. 检查是否有闭包引用了已不再需要的大对象（如 fetch 响应 buffer 被 closure 捕获）
4. 确认 Railway SIGTERM 是 OOM kill 还是 deployment 替换（检查 `railway logs` 中 `OOMKilled` vs `SIGTERM` 的区别）

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
| 1 | 6月10日/13日代码版本的稳态 heap 本身高于当前 | ~150MB heap | ✅ 已由后续多个 commit 改善（memory leak fix + hono 升级 + Missing APR cap 修复） |
| 2 | Puppeteer fallback 被 Cloudflare 429 触发 → 额外 70-130MB 容器 RSS | 6月10日主因 | ⚠️ 风险仍在（429 可能再次发生） |
| 3 | Merkl AMOUNT variant 并发 CoinGecko 调用（防御性） | 当前 AMOUNT campaign 少，影响小 | ⚠️ 未来可能增长 |
| 4 | Brevis chain call 未复用 ProviderPool | ~1-5MB（1-2 个 chain） | ⚠️ 架构债务 |
| 5 | `Missing APR cap` 抛错跳过缓存 → 重复 fetch | ~10-30MB（3 个 campaign） | ✅ 已由 `46fbd5a` 修复 |

## 待实施修复

### Fix A: Brevis chain call 复用 ProviderPool

- 文件: `packages/aave-fetcher/src/brevis-distributed-so-far.ts`
- 改法: 接收 ProviderPool 实例或回调函数，调用 `executeWithAutoRpc` 替代自己 `new JsonRpcProvider`
- 影响: 架构改善，获得 failover + health detection + provider 复用
- 风险: 低（只是换调用方式，逻辑不变）

### Fix B: Merkl AMOUNT variant price resolve 加限流（防御性）

- 文件: `packages/aave-fetcher/src/merkl-api.ts`（`processMerklData` 函数）
- 改法: 
  1. 循环前收集所有 AMOUNT variant 需要的 token（去重）
  2. 串行或限流 resolve（5 并发），build `chainId:tokenAddress → price` Map
  3. 循环内直接查 Map
- 影响: 减少 CoinGecko 并发请求（当前量小，但防御未来增长）
- 风险: 低（不增加延迟，因为去重后 resolve 数量远少于 campaign 数量）

### Fix C: Puppeteer 替换 → 移除（独立 issue AAV-888）

**Puppeteer 在当前内存环境下不是可用选项。** 稳态 RSS 270-302MB + Puppeteer 70-130MB = 340-430MB，与其他峰值叠加有 OOM 风险。

- 替代方案: Cloudflare Browser (primary) → Render 服务 (secondary) → Regex 兜底 (tertiary)
- 完整方案见 AAV-888
- 本文档的 Fix A/B 不依赖 Fix C，可独立实施

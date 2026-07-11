> **Status: Executed** (2026-05-28) — design doc superseded by PRD `2026-05-23-rpc-smart-fallback.md`.

# RPC Smart Fallback：错误分类 → 智能降级

## 问题

当前 4 个 RPC 消费者各自实现了相同的 retry/fallback 循环模板：

```typescript
candidates = ethProviderService.getProvidersForChain(chainId, rpcUrls)
for (candidate of candidates):
  try:
    result = await doWork(candidate.provider)
    ethProviderService.reportProviderSuccess(...)
    return result
  catch:
    ethProviderService.reportProviderFailure(...)
    // 下一个 RPC
```

V4 deficit 路径额外多一层 Multicall3 → serial 降级：

```typescript
try:
  Multicall3 batch  ← 网络错误时也会失败
catch:
  serial 逐条（同一 RPC）  ← 浪费时间，应该先换 RPC 再试
```

**两种不当行为**：

| 错误类型 | 当前行为 | 应该做的 |
|---|---|---|
| ECONNRESET / ETIMEDOUT | 降级到 serial → 失败 → 换 RPC | **直接换 RPC**，不浪费 serial 时间 |
| contract revert / ABI mismatch | 降级到 serial（换 RPC 没用） | 降级到 serial（正确） |

## 设计

### 在 ethProviderService 抽象层统一添加 `executeWithFallback()`

```
executeWithFallback(chainId, rpcUrls, {
  primary: (provider) => multicall3Batch(provider, calls),
  fallback: (provider) => serialDeficit(provider, config),
  errorClassifier: (error) => isNetworkError ? 'switch-rpc' : 'downgrade',
})
  → 网络错误 → 直接换 RPC，不调 fallback
  → 合约错误 → 调 fallback（同一 RPC）→ 失败再换 RPC
```

**单一路径消费者（V3 deficit、V3/V4 Oracle）** 不传 `fallback` 和 `errorClassifier`，行为不变。

**双路径消费者（V4 deficit）** 传入 `primary`（Multicall3）、`fallback`（serial）、`errorClassifier`，获得智能行为。

### Signature

```typescript
interface FallbackExecutors<T> {
  primary: (provider: Provider) => Promise<T>;
  fallback?: (provider: Provider) => Promise<T>;      // 可选：无降级路径时为 undefined
  errorClassifier?: (error: unknown) => 'switch-rpc' | 'downgrade' | 'unknown';
  // 默认分类器：networking → switch-rpc，其他 → downgrade
}

async executeWithFallback<T>(
  chainId: number,
  rpcUrls: string[],
  executors: FallbackExecutors<T>
): Promise<T>
```

### 内部流程

```
for each RPC candidate (健康优先 → 被压制兜底):
  try primary(provider):
    ✅ → reportSuccess → return result
    ❌ → 错误分类
         ├─ 'switch-rpc' → 跳过 fallback，直接换下一个 RPC
         ├─ 'downgrade'  → 如果有 fallback → try fallback(provider)
         │                   ✅ → reportSuccess → return result
         │                   ❌ → reportFailure → 换下一个 RPC
         └─ 'unknown'    → 如果无 fallback → reportFailure → 换 RPC
                           → 如果有 fallback → try fallback(provider)
                               ✅ → reportSuccess → return result
                               ❌ → reportFailure → 换 RPC

所有 RPC 都失败 → throw
```

### 默认 errorClassifier

```typescript
const DEFAULT_ERROR_CLASSIFIER = (error: unknown): 'switch-rpc' | 'downgrade' | 'unknown' => {
  const code = getErrorCode(error);
  // Ethers network-level errors
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' ||
      code === 'ECONNREFUSED' || code === 'EPIPE' || code === 'NETWORK_ERROR') {
    return 'switch-rpc';
  }
  // Ethers server errors (502, 503, 504, 429, etc.)
  if (code === 'SERVER_ERROR') return 'switch-rpc';
  // Contract-level errors
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes('CALL_EXCEPTION') || msg.includes('UNPREDICTABLE_GAS_LIMIT') ||
      msg.includes('bad address checksum') || msg.includes('INVALID_ARGUMENT')) {
    return 'downgrade';
  }
  return 'unknown';
};
```

## 改动范围

### ethProviderService.ts

新增 `executeWithFallback()` 方法 + 默认 errorClassifier。

### onchainDataService.ts（V4 deficit 路径）

`fetchAndCacheV4Spoke()` 改为调用 `executeWithFallback()`，移除手写的 Multicall3→serial 降级 + RPC 循环。

`buildHubAssetMappingMulticall()` 改为调用 `executeWithFallback()`，传入 Hub mapping primary + serial fallback。

### onchainDataService.ts（V3 deficit）

`fetchAndCacheChain()` 改为调用 `executeWithFallback()`（只传 primary，无 fallback）。

### oracleService.ts

`fetchV3WithRetry()` / `fetchV4WithRetry()` 改为调用 `executeWithFallback()`（只传 primary，无 fallback）。

### 不改的文件

- `aave-shared-config/index.js`（静态 RPC 注册表不受影响）

## 不改的设计决策

- **RPC 列表顺序不变** — publicnode 保持第一位，靠健康追踪自然压制动荡节点
- **健康追踪逻辑不变** — 2 次失败压制 5 分钟的机制保留
- **Oracle 单路径行为不变** — `executeWithFallback({primary}, {})` = 等价于现有 forEach RPC try/catch

## 影响范围

| 场景 | 现有行为 | 新行为 |
|---|---|---|
| publicnode ECONNRESET + V4 deficit | Multicall3 失败 → serial 逐条（同 RPC）→ serial 也超时 → 换 RPC | Multicall3 失败 → 直接换 drift.org（跳过 serial） |
| publicnode contract revert + V4 deficit | Multicall3 失败 → serial 逐条（同 RPC）| Multicall3 失败 → serial 逐条（同一 RPC 值得试） |
| publicnode 正常 + V4 deficit | Multicall3 ✅ → 返回 | 不变 |
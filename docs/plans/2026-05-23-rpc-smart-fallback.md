# PRD: RPC Smart Fallback — 错误分类驱动的智能降级

> **Status: Active** — awaiting implementation.

## Problem Statement

当前链上 RPC 查询有两个独立但相关的问题：

### 问题 A：Multicall3 失败后无条件降级到 serial（同一 flaky RPC）

V4 deficit 的 Multicall3 batch 失败后，直接降级到 serial 逐条调用，且**仍在同一个 RPC 上执行**。如果错误原因是网络抖动（ECONNRESET），在这个 RPC 上 serial 也必然失败，白白浪费 N 次 eth_call 后才换下一个 RPC。公共 RPC（publicnode.com）间歇性 ECONNRESET，但大多数时候能成功，导致它始终排在 ProviderPool 的首位，问题难以自行消失。

### 问题 B：V4 SDK 卡住导致外层 60s timeout 连坐 V3 数据

V4 SDK 的 Aave API 偶尔响应慢/卡住但不抛错，内部重试（3次 × 5-15s ≈ 40s）耗尽外层 60 秒超时，导致 V3 数据也被丢弃。`v4Fatal=false` 只保护 V4 抛错场景，无法应对「慢但不报错」的情况。（此问题在独立 issue 中处理）

### 核心设计缺陷

当前 4 个链上 RPC 消费者（onchainDataService × 2、oracleService × 2）各自手写了相同的 `forEach RPC → try → catch → 换 RPC` 循环模板。这些循环缺乏错误分类能力，无法区分「网络错误（换 RPC）」和「合约错误（降级 serial）」两种不同处理路径。

## Solution

在 `@internal/aave-rpc-infra` 包的 `ProviderPool` 上新增 `executeWithFallback()` 方法，统一管理所有链上 RPC 调用的 retry/fallback 逻辑。核心机制：根据 ethers.js 错误码自动分类 → 网络错误直接换 RPC（跳过 serial） → 合约错误降级到 serial（换 RPC 也没用）。

## User Stories

1. As a developer, I want Multicall3 失败时自动判断错误类型，网络错误直接换下一个 RPC 而不是在同一 flaky RPC 上浪费时间做 serial，so that publicnode ECONNRESET 不会拖慢整体查询。
2. As a developer, I want Multicall3 失败且错误是合约 revert/ABI 不匹配时，降级到 serial fallback，so that 合约级别的错误换 RPC 也无法解决时仍有兜底路径。
3. As a developer, I want 4 个链上 RPC 消费者统一使用 `executeWithFallback()` 消除重复的 forEach RPC 循环代码，so that 新增消费者自动获得智能 fallback。
4. As a developer, I want `executeWithFallback()` 放在抽象层 `ProviderPool` 上而不是各消费者自己实现，so that 符合 ADR-0021 的包边界设计。
5. As a developer, I want 不传 `fallback` 参数时走单路径模式（仅换 RPC），so that Oracle 之类单一调用路径的消费者调用最简洁。
6. As a developer, I want Hub asset mapping 每 1 分钟被重复查询的问题得到解决，so that 不会对 RPC 产生不必要的负载。
7. As a developer, I want `executeWithFallback()` 的错误分类逻辑可配置（ProviderPool 构造参数），so that 不同链/场景可以自定义分类器，但默认值覆盖全部当前场景。
8. As a developer, I want Hub mapping 和 Spoke deficit 拆分成两个独立的 `executeWithFallback()` 调用，so that Hub mapping 成功后(写入缓存)不影响 deficit 在另一个 RPC 上重试。

## Implementation Decisions

### Module 1: `executeWithFallback()` (ProviderPool 新方法)

- 位置：`@internal/aave-rpc-infra/src/index.ts`，`ProviderPool` 类上
- 签名：
  ```
  executeWithFallback<T>(
    chainId: number,
    rpcUrls: string[],
    execs: { primary: (p) => Promise<T>; fallback?: (p) => Promise<T> },
    options?: { perAttemptTimeoutMs?: number; label?: string }
  ): Promise<T>
  ```
- 流程：`forEach RPC → 试 primary → 成功则 reportSuccess + return`
  - 失败 → ErrorClassifier 分类 → 网络错误 → reportFailure → 跳过 fallback → 换下个 RPC
  - 失败 → ErrorClassifier 分类 → 合约错误 → reportFailure → 试 fallback（同一 RPC）
  - fallback 成功 → reportSuccess（覆盖前面的 failure）→ return
  - fallback 失败 → reportFailure → 换下个 RPC
- 无 fallback 参数：`forEach RPC → 试 primary → 网络/合约都换 RPC`
- 所有 RPC 耗尽 → throw 聚合错误

### Module 2: ErrorClassifier (ProviderPool 构造参数)

- 接口类型：
  ```typescript
  type ErrorClass = 'retry_next_rpc' | 'try_fallback';
  type ErrorClassifier = (error: unknown) => ErrorClass;
  ```
- 默认分类器：
  - 网络错误 `code === 'ECONNRESET' | 'ETIMEDOUT' | 'ECONNREFUSED' | 'NETWORK_ERROR' | 'SERVER_ERROR'` → `retry_next_rpc`
  - 合约错误 `message 包含 'CALL_EXCEPTION' | 'UNPREDICTABLE_GAS_LIMIT'` → `try_fallback`
  - 其他 → `retry_next_rpc`（安全默认）
- 作为 `ProviderPool` 构造参数 `errorClassifier?: ErrorClassifier`，所有 `executeWithFallback` 调用共享

### Module 3: onchainDataService.ts 重构

- Hub mapping pre-build 循环 → `providerPool.executeWithFallback(chainId, urls, { primary: buildHubAssetMappingMulticallInner, fallback: buildHubAssetMappingSerial })`
- Hub mapping 加 10 分钟模块级 TTL 缓存（避免每分钟重复查询不变数据）
- Spoke deficit 循环 → `providerPool.executeWithFallback(chainId, urls, { primary: multicall3Batch, fallback: serialContract })`
- Hub mapping 和 deficit 拆成两个独立 `executeWithFallback()`（互不拖累）
- 删除手写的 forEach RPC 循环

### Module 4: oracleService.ts 重构

- V3 Oracle → `providerPool.executeWithFallback(chainId, urls, { primary: singleCall })`（无 fallback → 单路径换 RPC）
- V4 Oracle → `providerPool.executeWithFallback(chainId, urls, { primary: singleCall })`
- 删除手写的 forEach RPC 循环

### Module 5: fetchV4ReservesViaRpc 重构

- 当前位置：`@internal/aave-rpc-infra/src/index.ts`
- 内层 forEach RPC 循环 → `pool.executeWithFallback(chainId, urls, { primary: fetchEntryReservesMulticall, fallback: fetchEntryReservesSerial })`
- 删除 `fetchEntryReserves` 包装函数（职责被 `executeWithFallback` 接管）
- `fetchEntryReservesMulticall` 和 `fetchEntryReservesSerial` 保留为私有函数

## Testing Decisions

- **测试范围**：所有新模块 + 重构的代码路径
- **测试原则**：只测试外部行为（不测试内部实现细节）——验证 `executeWithFallback()` 对网络/合约错误的正确响应，而非验证内部循环次数或重试次数
- **ProviderPool.executeWithFallback() 单测**：
  - 网络错误 → 跳过 fallback，换下一个 RPC
  - 合约错误 → 降级到 fallback，同一 RPC
  - 所有 RPC 耗尽 → throw 聚合错误
  - 无 fallback 路径 → 单路径直接换 RPC
  - Primary 成功 → 不调 fallback
  - 自定义 ErrorClassifier → 按自定义逻辑分类
- **onchainDataService 重构后测试**：不破坏现有 deficit 值正确性
- **oracleService 重构后测试**：不破坏现有 oracle 价格正确性
- **fetchV4ReservesViaRpc 重构后测试**：不破坏现有 V4 RPC reader 行为
- **参照**：`packages/aave-rpc-infra/tests/` 现有测试风格（Vitest + mock provider）

## Out of Scope

- V4 SDK timeout 隔离（独立 issue，见问题 B）
- RPC 端点顺序调整
- Hub mapping 持久化存储
- Multicall3 跨 Hub 合并
- ADR 文档更新（跟随实现后补充）

## Further Notes

- 2026-05-23 下午 13:52~17:24 CST 发生了一次 V4 SDK 超时导致全部 markets 数据丢失的线上事故（根因问题 B），推动了本次 RPC fallback 重构的优先级提升
- `ProviderPool` 已从 `backend/src/services/ethProviderService.ts` 迁移到 `@internal/aave-rpc-infra`，所有消费者已切换引用
- ADR-0021 定义了 V4 三层 fallback（SDK → RPC → stale），本次优化的是 RPC 层内部的 fallback 策略
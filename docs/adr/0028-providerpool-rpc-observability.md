# ADR-0028: ProviderPool RPC 可观测性

## 状态

Implemented

## 上下文

ADR-0027 实现了分层 RPC 解析和自动恢复，但 ProviderPool 的端点健康状态变化是静默的——运维无法从日志或 API 看到哪个端点被 suppressed、何时恢复。`getUnhealthyEndpoints()` 只暴露 suppressed 端点，缺少全量视图和聚合信息。

## 决策

### 1. 保持二态健康模型 (healthy / suppressed)

AAV-601 提出三态模型 (healthy / degraded / dead)，未采纳。理由：

- 当前二态已覆盖实际需求
- `getProvidersForChain` 按 `lastSuccessAt` 排序——偶尔失败的端点自然排后面，不需要中间态
- `degraded` 没有消费者，增加状态机复杂度（9 种转换 vs 4 种）但无行为差异

### 2. logFn 结构化日志

扩展 `warnFn` → `logFn`，支持多级别：

```ts
type LogFn = (level: 'info' | 'warn', msg: string, meta: Record<string, unknown>) => void;
```

- healthy → suppressed：`logFn('warn', 'rpc-endpoint-suppressed', { chainId, rpcUrl, consecutiveFailures, lastError, suppressedUntil })`
- suppressed → healthy：`logFn('info', 'rpc-endpoint-recovered', { chainId, rpcUrl })`
- 单次失败（未达阈值）：不记日志
- 不加抖动检测——29 链规模下抖动本身是有价值的信号

`ProviderPool` 新增 `configure({ logFn })` 方法，允许后置配置 singleton 的日志能力。

### 3. getHealthStatus() 替代 getUnhealthyEndpoints()

```ts
type EndpointStatus = {
  chainId: number;
  rpcUrl: string;
  status: 'healthy' | 'suppressed';
  consecutiveFailures: number;
  lastError: string;
  lastFailureAt: string;
  lastSuccessAt: string;
  suppressedUntil?: string;
};

type HealthStatus = {
  endpoints: EndpointStatus[];
  summary: { total: number; healthy: number; suppressed: number };
};
```

- `getUnhealthyEndpoints()` 和 `UnhealthyEndpoint` 类型已删除
- 全量端点状态 + 聚合摘要，零额外开销（只读内存数据）

### 4. /health 集成 RPC 健康状态

- RPC 健康信息嵌入现有 `/health` 响应体，不新增路由
- RPC suppressed 不影响 HTTP 状态码——只有 markets 未就绪/过期时才 503
- 某链所有 RPC suppressed 时，顶层 `status` 变为 `'suppressed'`（HTTP 仍 200）
- markets 未就绪/过期时仍返回 503 + `status: 'degraded'`（不变）

### 5. 术语：suppressed

- `suppressed` 传达"主动压制 + 定时恢复"的语义，比 `degraded`（模糊降级）和 `dead`（完全不可用）更精确
- 内部变量和公共 API 统一使用 `suppressed`
- `/health` 顶层 status 在 markets 问题时保持 `'degraded'`——这是整体服务降级，与 RPC 端点的 `suppressed` 是不同概念

## 理由

1. **运维可见性**：结构化日志让 RPC 故障从静默变为可观测
2. **零资源开销**：`getHealthStatus()` 只读已有内存数据，不需要主动探活
3. **Railway 安全**：RPC 问题不影响 HTTP 状态码，不会触发 Railway 重启
4. **术语精确**：`suppressed` 准确描述"排末尾 + 定时恢复"的行为

## 替代方案

### 三态模型 (healthy / degraded / dead)

- 缺点：`degraded` 无消费者，增加复杂度无行为差异
- **未采纳**

### Exponential backoff

- 缺点：当前"排末尾"策略已隐式探活，exponential backoff 在 29 链规模下不紧急
- **未采纳**，可作为未来优化

### EventEmitter 模式

- 缺点：需要 `.on()` + `.off()`，增加内存泄漏风险；日志是唯一消费者，不需要发布-订阅
- **未采纳**，`logFn` 回调更简单

### 独立 /health/rpc 路由

- 缺点：多一个 endpoint 增加维护成本，RPC 健康是系统健康的一部分
- **未采纳**，嵌入 `/health` 更精简

## 后果

- `warnFn` 已删除，迁移为 `logFn`
- `getUnhealthyEndpoints()` 已删除，迁移为 `getHealthStatus()`
- Backend 启动时调用 `providerPool.configure({ logFn })` 绑定 winston
- `/health` 响应体新增 `rpc` 字段
- 后续：Prometheus metrics（AAV-586）、主动通知（AAV-587）

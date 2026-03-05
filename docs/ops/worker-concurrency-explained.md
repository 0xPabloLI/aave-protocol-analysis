# Worker 并发与 Session 管理详解

## 1. "请求层防抖"是什么意思？

**更正**：我之前用词不当。准确来说，Merkl API 的重试机制是 **"重试 + 指数退避"**，不是"防抖"。

- **防抖（Debounce）**：限制函数调用频率，例如输入框搜索，只在用户停止输入后才执行
- **重试 + 退避（Retry with Backoff）**：请求失败后，等待一段时间再重试，等待时间逐渐增加

**Merkl API 的重试机制**：
```typescript
// 在 src/merkl-api.ts 中
async function fetchWithRetry(url: string, label: string): Promise<Response> {
  // 最多重试 4 次（默认）
  // 每次重试前等待：1s → 2s → 4s → 8s（指数退避）
  // 加上随机抖动（0-250ms），避免"雷群效应"
}
```

**为什么需要这个机制**：
- 网络抖动（ECONNRESET）是临时性的，重试通常能成功
- 指数退避避免在服务器恢复时立即大量请求
- 随机抖动避免多个客户端同时重试

---

## 2. scheduleDynamicSlot 串行化是什么意思？

### 架构层次

```
Node.js 应用 (src/cloudflare-browser.ts)
    ↓ HTTP POST (scheduleDynamicSlot 控制频率)
Cloudflare Worker (workers/src/index.ts)
    ↓ Puppeteer API (scheduleLaunchSlot 控制频率)
Browser Instance/Session
```

### 两层串行化

#### 第一层：Node.js 应用层 (`scheduleDynamicSlot`)

**位置**：`src/cloudflare-browser.ts:31-50`

**作用**：控制**对 Worker 的 HTTP 请求频率**

```typescript
// 确保两次 Worker HTTP 请求之间至少间隔 21 秒
async function scheduleDynamicSlot(): Promise<void> {
  // 串行化：前一个请求完成后，才允许下一个请求开始
  await prev;  // 等待前一个请求完成
  
  // 检查距离上次请求是否已过 21 秒
  const waitMs = Math.max(0, lastDynamicStartedAt + 21000 - now);
  if (waitMs > 0) {
    await sleep(waitMs);  // 如果不够 21 秒，等待
  }
}
```

**效果**：
- ✅ **同时只有一个 Worker HTTP 请求在进行**
- ✅ 多个 `extractMeritDynamicInfoWithWorker()` 调用会排队
- ❌ **不是限制 Worker 数量**（Worker 是 Cloudflare 托管的，可以同时处理多个请求）

#### 第二层：Worker 内部 (`scheduleLaunchSlot`)

**位置**：`workers/src/index.ts:32-50`

**作用**：控制**创建新 Browser Instance 的频率**

```typescript
// Worker 内部：控制 browser instance 创建频率
async function scheduleLaunchSlot(minIntervalMs: number): Promise<void> {
  // 串行化：前一个 browser launch 完成后，才允许下一个
  await prev;
  
  // 检查距离上次 launch 是否已过 minIntervalMs（默认 20 秒）
  const waitMs = Math.max(0, lastLaunchStartedAt + minIntervalMs - now);
  if (waitMs > 0) {
    await sleep(waitMs);
  }
}
```

**效果**：
- ✅ **同时只创建一个新的 Browser Instance**
- ✅ 如果已有 session 可用，会直接复用（跳过 launch）
- ❌ **不是限制 Worker 数量**

### 总结

| 层级 | 函数 | 控制对象 | 效果 |
|------|------|---------|------|
| Node.js 应用 | `scheduleDynamicSlot` | **对 Worker 的 HTTP 请求** | 串行化，间隔 ≥21s |
| Worker 内部 | `scheduleLaunchSlot` | **Browser Instance 创建** | 串行化，间隔 ≥20s |

**关键点**：
- Worker 本身可以**并发处理多个请求**（Cloudflare 自动扩展）
- 但**创建新 Browser Instance** 是串行的（受 Cloudflare 限制）

---

## 3. BROWSER_MIN_LAUNCH_INTERVAL_MS=20000 详解

### 单位
**毫秒（milliseconds）**，`20000` = 20 秒

### 配置依据

**Cloudflare Browser Rendering 限制**：
- **免费计划**：每分钟最多创建 **3 个新浏览器实例**
- 计算：60 秒 ÷ 3 次 = **20 秒/次**

**代码注释**：
```typescript
// workers/src/index.ts:28
// Cloudflare Browser Rendering limits (Workers Bindings):
// - New browser instances per minute: 3 on Workers Free -> ~1 request every 20s.
const MIN_LAUNCH_INTERVAL_MS_DEFAULT = 20000;
```

### 为什么是 20 秒而不是 20.000... 秒？

**安全余量**：
- 理论值：60 ÷ 3 = 20 秒
- 实际值：**21 秒**（Node.js 层）或 **20 秒**（Worker 层）
- 原因：避免边界情况（例如同一秒内多个请求）

### 如何调整

**环境变量**（在 Worker 中设置）：
```bash
# wrangler.toml 或 Worker 环境变量
BROWSER_MIN_LAUNCH_INTERVAL_MS=25000  # 25 秒（更保守）
```

**Node.js 应用层**：
```bash
# .env 文件
CLOUDFLARE_DYNAMIC_MIN_INTERVAL_MS=25000  # 25 秒
```

**建议**：
- 免费计划：保持 20-21 秒
- 付费计划：可以缩短（根据你的计划限制调整）

---

## 4. Durable Object 是什么？怎么用？

### 什么是 Durable Object？

**Durable Object** 是 Cloudflare 的一个特性，用于维护**有状态的对象**。

**特点**：
- ✅ **全局唯一**：每个 Durable Object ID 对应一个实例（跨 Worker 实例）
- ✅ **强一致性**：所有请求路由到同一个实例
- ✅ **持久化状态**：可以存储数据（例如浏览器 session 池）

### 为什么需要 Durable Object？

**当前问题**：
- Worker 是无状态的，每次请求可能路由到不同的 Worker 实例
- Browser Session 存储在 Worker 内存中，无法跨实例共享
- 多个 Worker 实例可能同时创建 Browser Instance，触发限流

**解决方案**：
- 使用 Durable Object 作为**浏览器会话池管理器**
- 所有 Worker 请求都路由到同一个 Durable Object
- Durable Object 维护一个 Browser Session 池，统一分配和复用

### 架构对比

#### 当前架构（无 Durable Object）

```
请求1 → Worker 实例 A → Browser Instance 1
请求2 → Worker 实例 B → Browser Instance 2  (可能触发限流)
请求3 → Worker 实例 A → Browser Instance 3  (可能触发限流)
```

#### 使用 Durable Object 后

```
请求1 → Worker A → Durable Object → Browser Session 1
请求2 → Worker B → Durable Object → Browser Session 1 (复用)
请求3 → Worker A → Durable Object → Browser Session 2 (新创建)
```

### 如何实现

#### 1. 创建 Durable Object 类

```typescript
// workers/src/browser-pool.ts
export class BrowserPool {
  private sessions: Map<string, any> = new Map();
  private lastLaunchAt: number = 0;
  
  async getBrowser(env: Env): Promise<any> {
    // 1. 尝试复用现有 session
    if (this.sessions.size > 0) {
      const sessionId = Array.from(this.sessions.keys())[0];
      return await puppeteer.connect(env.MY_BROWSER, sessionId);
    }
    
    // 2. 检查是否超过限流
    const now = Date.now();
    if (now - this.lastLaunchAt < 20000) {
      throw new Error('Rate limited');
    }
    
    // 3. 创建新 session
    const browser = await puppeteer.launch(env.MY_BROWSER, {
      keep_alive: 300000
    });
    this.lastLaunchAt = now;
    return browser;
  }
}
```

#### 2. 配置 wrangler.toml

```toml
# workers/wrangler.toml
[[durable_objects.bindings]]
name = "BROWSER_POOL"
class_name = "BrowserPool"
script_name = "aave-browser-rendering"
```

#### 3. Worker 中使用

```typescript
// workers/src/index.ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 获取 Durable Object ID（固定 ID，确保所有请求路由到同一个实例）
    const id = env.BROWSER_POOL.idFromName("global-pool");
    const pool = env.BROWSER_POOL.get(id);
    
    // 调用 Durable Object 方法
    const browser = await pool.getBrowser(env);
    // ... 使用 browser
  }
}
```

### 优势

1. **统一管理**：所有 Browser Session 在一个地方管理
2. **避免限流**：串行化创建，不会触发 Cloudflare 限流
3. **会话复用**：多个 Worker 实例共享同一个 Session 池
4. **降低成本**：减少 Browser Instance 创建次数

### 当前状态

**你的代码目前没有使用 Durable Object**，而是：
- ✅ Worker 内部尝试复用 session（`puppeteer.sessions()`）
- ✅ 串行化 launch（`scheduleLaunchSlot`）
- ❌ 但无法跨 Worker 实例共享 session

**建议**：如果遇到频繁的 429 错误，可以考虑实现 Durable Object 方案。

---

## 总结

### 当前并发设置

| 层级 | 并发控制 | 限制 |
|------|---------|------|
| **Worker 实例** | Cloudflare 自动扩展 | 无限制（受计划限制） |
| **Browser Instance 创建** | `scheduleLaunchSlot` | 串行，≥20s 间隔 |
| **Worker HTTP 请求** | `scheduleDynamicSlot` | 串行，≥21s 间隔 |
| **Browser Session** | `puppeteer.sessions()` | 尝试复用，但无法跨实例 |

### 优化建议

1. **短期**：保持当前设置，监控 429 错误
2. **中期**：如果频繁 429，考虑实现 Durable Object
3. **长期**：升级到付费计划，提高 Browser Instance 创建限制

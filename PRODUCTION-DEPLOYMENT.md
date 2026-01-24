# 生产环境部署检查清单

## 🎯 概述

本文档列出了将 API 服务部署到生产环境前需要完成的配置和检查项。

## ✅ 必做项

### 1. CORS 配置 - 限制前端域名

**当前实现**: 通过 `ecosystem.config.cjs` 配置

编辑 `ecosystem.config.cjs`:

```javascript
env: {
  NODE_ENV: 'production',
  FRONTEND_URL: 'https://your-production-domain.com,https://www.your-production-domain.com',
  ALLOWED_DEV_ORIGINS: 'https://codex.warp.dev,https://warp.dev,http://103.151.172.89,http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173,http://127.0.0.1:3000',
  PORT: 3001
}
```

**验证**:
```bash
curl https://api.aaveapy.com/health
# 应该看到 "corsMode": "whitelist"
```

### 2. 安全头配置

**当前状态**: 未配置安全头

**需要添加**: 使用 `helmet` 中间件添加安全头

#### 安装依赖

```bash
cd backend
npm install helmet
npm install --save-dev @types/helmet
```

#### 修改 `backend/src/server.ts`

```typescript
import helmet from 'helmet';

// 在 app.use(corsMiddleware) 之后添加
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  frameguard: { action: 'deny' },
  noSniff: true,
  xssFilter: true,
}));
```

### 3. 速率限制

**当前状态**: 未配置速率限制

**需要添加**: 使用 `express-rate-limit` 防止滥用

#### 安装依赖

```bash
cd backend
npm install express-rate-limit
```

#### 创建速率限制中间件

创建 `backend/src/middleware/rateLimiter.ts`:

```typescript
import rateLimit from 'express-rate-limit';

// 通用 API 速率限制
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 分钟
  max: 100, // 每个 IP 最多 100 个请求
  message: {
    error: 'Too many requests',
    message: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true, // 返回速率限制信息在 `RateLimit-*` 头中
  legacyHeaders: false, // 禁用 `X-RateLimit-*` 头
});

// 更严格的健康检查限制
export const healthCheckLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 分钟
  max: 10, // 每个 IP 最多 10 个请求
});
```

#### 在 `backend/src/server.ts` 中使用

```typescript
import { apiLimiter, healthCheckLimiter } from './middleware/rateLimiter.js';

// 在路由之前添加
app.use('/api/', apiLimiter);
app.get('/health', healthCheckLimiter, (req, res) => {
  // ... 现有代码
});
```

### 4. Secret Manager 配置（推荐：使用 Doppler）

**为什么需要 Secret Manager？**

- ✅ **安全性**：敏感信息（如 API tokens）不存储在服务器文件系统中
- ✅ **集中管理**：所有 secrets 在一个地方管理，易于轮换和审计
- ✅ **版本控制**：可以追踪 secret 的变更历史
- ✅ **访问控制**：可以精细控制谁可以访问哪些 secrets

**推荐：Doppler**（永久免费 tier：5 用户，无限 secrets，无限 API 调用）

#### Secret Manager 配置（使用本地 .env 文件 + 专用用户运行 PM2）

**完整流程说明**（基于 `deploy.sh` 的实际实现）：

**步骤 1：本地读取和准备**
```bash
# deploy.sh 在本地执行：
# 1. 读取本地 .env 文件，解析出 DOPPLER_TOKEN
DOPPLER_TOKEN_FROM_ENV="dp.st.xxxxx.your-token-here"  # 从 .env 解析得到

# 2. 在本地 shell 中 export，使其成为环境变量
export DOPPLER_TOKEN="$DOPPLER_TOKEN_FROM_ENV"
# 现在本地 shell 有 DOPPLER_TOKEN 环境变量了
```

**步骤 2：通过 SSH 传递到远程**
```bash
# 使用 Heredoc (<< EOF) 将命令发送到远程服务器
ssh server << EOF
  # 注意：这里的 $DOPPLER_TOKEN 会在本地 shell 中先展开
  # 本地：$DOPPLER_TOKEN → "dp.st.xxxxx.your-token-here"
  # 远程收到：export DOPPLER_TOKEN="dp.st.xxxxx.your-token-here"
  export DOPPLER_TOKEN="$DOPPLER_TOKEN"
  
  # 现在远程 shell 也有 DOPPLER_TOKEN 环境变量了
EOF
```

**步骤 3：注入到 PM2 进程**
```bash
# 在远程服务器上执行：
pm2 restart aave-backend --update-env
# --update-env 标志让 PM2 读取当前 shell 的环境变量（包括 DOPPLER_TOKEN）
# 并将这些环境变量注入到 PM2 进程环境中
# 现在 PM2 进程可以访问 DOPPLER_TOKEN 了
```

**关键点理解**：

1. **"本地 export 一次，远程 export 一次"的含义**：
   - **本地 export**：在运行 `deploy.sh` 的机器上，将 `.env` 中的 token 设置为环境变量，这样 Heredoc 中的 `$DOPPLER_TOKEN` 才能被本地 shell 展开
   - **远程 export**：在远程服务器上，将展开后的 token 值设置为环境变量，这样 `pm2 restart --update-env` 才能读取到

2. **"Token 直接注入 PM2，不经过中间文件"的含义**：
   - **之前的流程（不推荐）**：token → 写入服务器上的 `.env` 文件 → PM2 读取文件 → 注入进程
   - **现在的流程（当前实现）**：token → 通过 SSH 传递到远程 shell 环境变量 → `pm2 restart --update-env` 直接读取环境变量 → 注入进程
   - **优势**：token 只在内存中（shell 环境变量），不会写入磁盘文件，更安全

**步骤**：

1. **获取 Doppler Token**：
   - 访问 [Doppler 官网](https://doppler.com) 注册/登录
   - 创建 Project（例如：`aave-backend`）
   - 创建 Environment（例如：`prod`）
   - 进入 Project → Settings → Service Tokens
   - 创建 Service Token，复制 token 值

2. **添加到本地 .env 文件**：
   ```bash
   DOPPLER_TOKEN=dp.st.xxxxx.your-token-here
   ```

3. **部署**：
   ```bash
   ./deploy.sh <host>
   ```

**安全性优化措施（已实现）**：

✅ **Token 不会出现在日志中**：
- `deploy.sh` 完全不打印 token 的任何信息（包括长度）
- 所有 `echo` 语句都经过检查，确保不会泄露 token
- SSH 传输过程中，token 只在内存中，不会写入临时文件

✅ **本地 `.env` 保护**：
- `.env` 文件已在 `.gitignore` 中，不会被提交到 Git
- **设置文件权限**：`chmod 600 .env`
  - **作用**：只有文件所有者可以读写，其他人无法访问
  - **如何设置**：在本地执行 `chmod 600 .env`
  - **影响**：提高安全性，防止其他用户或进程读取你的 `.env` 文件

✅ **SSH 传输安全**：
- Token 通过加密的 SSH 连接传输
- 使用 `--update-env` 直接注入到 PM2 进程，不经过中间文件

**关于 token 在服务器上的存在时间**：

- **远程 shell 关闭后**：
  - Shell 环境变量会消失（因为环境变量只在进程生命周期内存在）
  - **但是**：PM2 进程已经通过 `--update-env` 获得了 token，PM2 进程会一直持有这个环境变量，直到进程重启
  - **重要**：如果 PM2 进程重启（服务器重启、手动重启），需要重新运行 `deploy.sh` 或使用持久化的方法（方法 B）

**关于 `pm2 describe` 暴露 token 的问题**：

- **问题**：`pm2 describe aave-backend` 会显示进程的所有环境变量，包括 `DOPPLER_TOKEN`
- **解决方案**：使用专用用户运行 PM2，限制访问权限（见下方"专用用户配置"）

**剩余风险**：
- ⚠️ 本地 `.env` 文件如果泄露（误提交到 Git、本地文件被访问），token 会暴露
- ⚠️ Token 会在远程 shell 会话中临时存在（但不会写入日志或文件）

**最佳实践**：
- ✅ 使用专用用户运行 PM2（见下方配置）
- ✅ 定期轮换 Doppler token（在 Doppler 控制台中撤销旧 token，创建新 token）
- ✅ 使用强密码保护本地开发机器
- ✅ 设置 `.env` 文件权限：`chmod 600 .env`（已自动执行）

#### 在 Doppler 中设置 Secrets

在 Doppler 控制台中，为你的 Project + Environment 添加以下 secrets：

- `CLOUDFLARE_BROWSER_RENDERING_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `PORT`（可选）
- `FRONTEND_URL`（可选）
- `ALLOWED_DEV_ORIGINS`（可选）

#### 验证配置

```bash
# 在服务器上测试 Doppler CLI（需要切换到专用用户）
sudo su - aave
doppler secrets download --no-file --format env

# 应该能看到你设置的所有 secrets
```

### 5. 关于 `pm2 describe` 暴露 token 的问题

**问题**：
- `pm2 describe aave-backend` 会显示进程的所有环境变量，包括 `DOPPLER_TOKEN`
- 在单人 VPS + root 的场景下，这是可接受的：
  - 如果攻击者已经获得 root 权限，整个服务器都已被攻破
  - 主要保护的是 token 不落盘（只在进程内存中），而不是限制 root 访问

**当前方案的优势**：
- ✅ Token 不落盘：只在进程内存中，不会写入 `.env` 文件
- ✅ 通过 Secret Manager 管理：可以集中管理和轮换 token
- ✅ 部署时自动注入：不需要手动配置服务器环境变量

**如果未来需要多用户环境**：
- 可以考虑创建专用用户运行 PM2
- 但在单人 VPS 场景下，当前方案已经足够

### 6. 日志配置增强

**当前状态**: 已有 winston 日志

**生产环境建议**:
- 确保日志轮转配置正确
- 考虑添加日志聚合服务（如 Logtail、Datadog）
- 设置错误告警

检查 `backend/src/logger.ts` 确保：
- 日志级别设置为 `info` 或 `warn`（生产环境避免 `debug`）
- 日志文件大小和保留策略合理

### 7. 错误处理增强

**建议**: 添加全局错误处理中间件

在 `backend/src/server.ts` 末尾添加：

```typescript
// 404 处理
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`
  });
});

// 全局错误处理
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' 
      ? 'An error occurred' 
      : err.message
  });
});
```

### 7. Cloudflare 配置

#### 7.1 WAF 规则

在 Cloudflare Dashboard 中：
1. 进入 `Security` > `WAF` > `Custom rules`
2. 创建规则保护 API：
   - **规则名称**: `Protect API endpoints`
   - **表达式**: `(http.request.uri.path contains "/api/")`
   - **操作**: `Challenge` 或 `Block`（根据需求）

#### 7.2 速率限制

在 Cloudflare Dashboard 中：
1. 进入 `Security` > `WAF` > `Rate limiting rules`
2. 创建规则：
   - **规则名称**: `API Rate Limit`
   - **匹配**: `http.request.uri.path contains "/api/"`
   - **限制**: 例如 100 请求/分钟
   - **操作**: `Block`

#### 7.3 SSL/TLS 配置

1. 进入 `SSL/TLS` > `Overview`
2. 确保 SSL/TLS encryption mode 设置为 `Full` 或 `Full (strict)`
3. 启用 `Always Use HTTPS`
4. 启用 `Minimum TLS Version` 设置为 1.2 或更高

#### 7.4 缓存配置

对于 API 端点，建议禁用缓存：
1. 进入 `Rules` > `Page Rules`
2. 创建规则：
   - **URL**: `api.aaveapy.com/api/*`
   - **设置**: `Cache Level: Bypass`

### 8. 监控和告警

#### 8.1 健康检查端点

已有 `/health` 端点，建议：
- 设置外部监控服务（如 UptimeRobot、Pingdom）
- 监控响应时间和可用性

#### 8.2 应用监控

考虑集成：
- **PM2 Plus**: PM2 的监控服务
- **New Relic**: APM 监控
- **Datadog**: 全栈监控

### 9. 性能优化

#### 9.1 PM2 集群模式（可选）

如果服务器有多个 CPU 核心，可以考虑使用集群模式：

```javascript
// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'aave-backend',
    script: 'dist/server.js',
    cwd: './backend',
    instances: 'max', // 或指定数字，如 2
    exec_mode: 'cluster',
    // ... 其他配置
  }]
};
```

**注意**: 需要确保应用是无状态的（当前实现应该是无状态的）

#### 9.2 压缩响应

安装 `compression` 中间件：

```bash
cd backend
npm install compression
npm install --save-dev @types/compression
```

在 `backend/src/server.ts` 中添加：

```typescript
import compression from 'compression';

app.use(compression());
```

### 10. 数据备份

**当前状态**: 数据存储在 `data/aave-formatted-data.json`

**生产环境建议**:
- 设置定期备份（每天或每小时）
- 考虑使用对象存储（如 AWS S3、Cloudflare R2）备份数据文件
- 保留多个版本的数据文件

## 📋 部署前检查清单

- [ ] 设置 `FRONTEND_URL` 环境变量
- [ ] 配置安全头（helmet）
- [ ] 配置速率限制
- [ ] 更新错误处理
- [ ] 检查日志配置
- [ ] 配置 Cloudflare WAF 规则
- [ ] 配置 Cloudflare 速率限制
- [ ] 配置 SSL/TLS
- [ ] 设置监控和告警
- [ ] 测试所有 API 端点
- [ ] 验证 CORS 配置
- [ ] 性能测试
- [ ] 安全扫描（可选）

## 🚀 部署步骤

### 1. 更新代码

```bash
# 在服务器上
cd /root/aave
git pull origin main  # 或你的分支
```

### 2. 安装新依赖

```bash
cd backend
npm install
npm run build
```

### 3. 配置环境变量

推荐二选一：
1. **PM2 配置文件**：编辑 `ecosystem.config.cjs` 的 `env`（通常服务器不需要 .env）
2. **根目录 .env 文件**：在服务器写入 `/root/aave/.env`（当前后端与抓取器都统一读取这一份）

### 4. 重启服务

```bash
pm2 restart aave-backend
# 或
pm2 reload ecosystem.config.cjs --only aave-backend
```

### 5. 验证

```bash
# 检查服务状态
pm2 status

# 检查日志
pm2 logs aave-backend --lines 50

# 测试 API
curl https://api.aaveapy.com/health
```

## 🔒 安全最佳实践

1. **最小权限原则**: 只允许必要的域名访问
2. **定期更新**: 保持依赖包更新
3. **密钥管理**: 不要在代码中硬编码密钥
4. **日志审查**: 定期审查日志，查找异常活动
5. **备份策略**: 定期备份数据和配置
6. **监控告警**: 设置关键指标告警

## 📝 生产环境 vs 开发环境对比

| 配置项 | 开发环境 | 生产环境 |
|--------|---------|---------|
| CORS | 允许所有来源 | 仅允许白名单域名 |
| 安全头 | 可选 | 必需 |
| 速率限制 | 可选 | 必需 |
| 日志级别 | debug/info | info/warn |
| 错误信息 | 详细 | 简化（隐藏内部错误） |
| 监控 | 可选 | 强烈建议 |
| 备份 | 可选 | 必需 |

## 🆘 故障排查

如果部署后出现问题：

1. **检查日志**: `pm2 logs aave-backend`
2. **检查环境变量**: `pm2 describe aave-backend`
3. **验证配置**: `curl https://api.aaveapy.com/health`
4. **检查 Cloudflare**: 查看 Analytics > Logs
5. **回滚**: 如果有问题，可以快速回滚到之前的版本

## 📚 相关文档

- [环境配置检查指南](./backend/ENV-CHECK.md)
- [Cloudflare 故障排查](./CLOUDFLARE-TROUBLESHOOTING.md)
- [部署指南](./DEPLOY.md)

# Doppler 环境变量配置问题排查指南

## 发现的问题

### 1. **PM2 `--update-env` 的可靠性问题**
   - `--update-env` 标志在某些情况下可能不会正确更新环境变量
   - PM2 可能无法从当前 shell 继承环境变量，特别是当 PM2 daemon 在后台运行时

### 2. **Doppler CLI Token 检测不完整**
   - 原代码只检查 `DOPPLER_TOKEN` 环境变量
   - 但 Doppler CLI 也可以从配置文件读取 token（如果运行了 `doppler setup`）
   - 如果只配置了文件但没有环境变量，会导致误判

### 3. **错误信息不够详细**
   - 当 Doppler 拉取失败时，错误信息不够具体
   - 无法快速定位是 token 问题还是配置问题

### 4. **缺少验证步骤**
   - deploy.sh 没有验证 DOPPLER_TOKEN 是否成功传递给 PM2 进程
   - 无法在部署时发现环境变量传递失败

## 已实施的修复

### 1. **改进 env.ts 中的 Doppler 检测逻辑**
   - ✅ 现在会检查环境变量和 Doppler 配置文件
   - ✅ 提供更详细的错误信息和解决建议
   - ✅ 确保 DOPPLER_TOKEN 正确传递给 doppler CLI 子进程

### 2. **改进 deploy.sh 的 PM2 重启逻辑**
   - ✅ 添加了 fallback 机制：如果 `pm2 reload --update-env` 失败，会尝试 `delete && start`
   - ✅ 添加了 DOPPLER_TOKEN 验证步骤，部署后立即检查是否成功传递
   - ✅ 提供清晰的警告信息和建议

### 3. **增强日志输出**
   - ✅ 显示 Doppler token 的前缀（用于验证，但不暴露完整 token）
   - ✅ 列出所有成功加载的环境变量
   - ✅ 检查关键变量（如 CLOUDFLARE_WORKER_URL）是否存在

## 如何验证 Doppler 是否正常工作

### 方法 1: 查看应用启动日志
```bash
pm2 logs aave-backend --lines 50
```

应该看到类似输出：
```
✅ DOPPLER_TOKEN found in environment (prefix: dp.st.xxxx...)
🔍 Attempting to fetch secrets from Doppler...
✅ Successfully loaded X environment variable(s) from Doppler
   Variables loaded: CLOUDFLARE_WORKER_URL, ...
```

### 方法 2: 运行验证脚本
```bash
cd /root/aave
./scripts/verify-doppler.sh
```

### 方法 3: 手动检查 PM2 进程环境变量
```bash
pm2 describe aave-backend | grep DOPPLER_TOKEN
pm2 describe aave-backend | grep CLOUDFLARE_WORKER_URL
```

### 方法 4: 在服务器上直接测试 Doppler
```bash
# 确保 DOPPLER_TOKEN 已设置
export DOPPLER_TOKEN='your-token-here'

# 测试拉取环境变量
doppler secrets download --no-file --format env

# 检查特定变量
doppler secrets download --no-file --format env | grep CLOUDFLARE_WORKER_URL
```

## 常见问题排查

### 问题 1: "DOPPLER_TOKEN not set" 警告

**可能原因：**
- DOPPLER_TOKEN 没有正确传递给 PM2 进程
- PM2 进程启动时环境变量未设置

**解决方法：**
1. 检查本地 .env 文件中是否有 DOPPLER_TOKEN
2. 检查 deploy.sh 是否成功传递了 token
3. 手动设置并重启：
   ```bash
   export DOPPLER_TOKEN='your-token-here'
   pm2 delete aave-backend
   pm2 start ecosystem.config.cjs --only aave-backend --env production --update-env
   ```

### 问题 2: "CLOUDFLARE_WORKER_URL not set" 警告

**可能原因：**
- Doppler 项目中没有配置 CLOUDFLARE_WORKER_URL
- 环境变量没有被正确注入

**解决方法：**
1. 在 Doppler 控制台中添加 CLOUDFLARE_WORKER_URL secret
2. 重启 PM2 进程以加载新变量：
   ```bash
   pm2 reload ecosystem.config.cjs --only aave-backend --update-env
   ```
3. 查看日志确认变量是否被加载

### 问题 3: "Failed to fetch secrets from Doppler"

**可能原因：**
- DOPPLER_TOKEN 无效或已过期
- 网络连接问题
- Doppler 项目配置错误

**解决方法：**
1. 验证 token 是否有效：
   ```bash
   export DOPPLER_TOKEN='your-token-here'
   doppler secrets download --no-file --format env
   ```
2. 检查网络连接
3. 在 Doppler 控制台中验证项目配置

### 问题 4: PM2 进程中没有 DOPPLER_TOKEN

**可能原因：**
- `--update-env` 标志没有生效
- PM2 daemon 没有继承 shell 环境变量

**解决方法：**
1. 使用更可靠的重启方法：
   ```bash
   pm2 delete aave-backend
   export DOPPLER_TOKEN='your-token-here'
   pm2 start ecosystem.config.cjs --only aave-backend --env production --update-env
   ```
2. 或者使用 PM2 的 env 设置：
   ```bash
   pm2 set pm2:env DOPPLER_TOKEN "your-token-here"
   pm2 restart aave-backend
   ```

## 最佳实践

1. **始终在本地 .env 文件中设置 DOPPLER_TOKEN**
   - deploy.sh 会自动读取并传递给远程服务器
   - 不要将 token 提交到 git

2. **部署后立即验证**
   - 运行 `./scripts/verify-doppler.sh`
   - 查看 PM2 日志确认环境变量已加载

3. **使用 Doppler 配置文件作为备选**
   - 如果环境变量传递有问题，可以在服务器上运行 `doppler setup`
   - 这样 Doppler CLI 可以从配置文件读取 token

4. **定期检查环境变量**
   - 使用 `pm2 describe aave-backend` 查看进程环境变量
   - 确保关键变量（如 CLOUDFLARE_WORKER_URL）存在

## 环境变量优先级

1. **系统环境变量**（PM2 启动时已设置）
2. **ecosystem.config.cjs 中的 env 对象**
3. **Doppler 拉取的值**（如果前两者都没有设置）

**重要：** 如果某个变量已经在 ecosystem.config.cjs 或系统环境变量中设置，Doppler 拉取的值**不会覆盖**它。这是 `injectEnv` 函数的设计，用于尊重进程管理器或系统的设置。

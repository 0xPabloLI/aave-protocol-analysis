# 服务器部署指南

本文档介绍如何使用 `deploy.sh` 脚本将后端服务部署到服务器 `43.247.134.242`。

## 前置要求

1. **SSH 访问权限**
   - 确保你的 SSH 密钥已添加到服务器的 `~/.ssh/authorized_keys`
   - 测试连接：`ssh 43.247.134.242`

2. **GitHub SSH 访问**
   - 确保服务器可以访问 GitHub（SSH 密钥已配置）
   - 或者确保你的 SSH 密钥已添加到 GitHub 账户

3. **代码已推送到 GitHub**
   - 确保所有代码（包括 `ecosystem.config.cjs`）已提交并推送到仓库

## 部署步骤

### 1. 确保代码已提交

```bash
# 检查是否有未提交的更改
git status

# 提交并推送所有更改
git add .
git commit -m "Prepare for deployment"
git push origin main  # 或 master
```

### 2. 运行部署脚本

```bash
# 在项目根目录执行
./deploy.sh 43.247.134.242
```

或者使用主机别名（如果已配置）：

```bash
./deploy.sh ipv6server
```

### 3. 部署过程

脚本会自动执行以下操作：

1. ✅ 连接到服务器
2. ✅ 检查并安装 Node.js 20.18.1（使用 NVM）
3. ✅ 检查并安装 PM2
4. ✅ 从 GitHub 拉取最新代码
5. ✅ 安装根目录依赖并构建
6. ✅ 运行初始数据获取
7. ✅ 安装后端依赖并构建
8. ✅ 使用 PM2 启动/重启服务
9. ✅ 配置日志轮转
10. ✅ 配置防火墙开放端口 3001

### 4. 验证部署

部署完成后，可以通过以下方式验证：

```bash
# 健康检查
curl http://43.247.134.242:3001/health

# 获取市场数据
curl http://43.247.134.242:3001/api/markets

# 查看服务状态（SSH 到服务器）
ssh 43.247.134.242
pm2 status
pm2 logs aave-backend
```

## 访问地址

部署成功后，服务可以通过以下地址访问：

- **健康检查**: `http://43.247.134.242:3001/health`
- **API 端点**: `http://43.247.134.242:3001/api/markets`
- **统计信息**: `http://43.247.134.242:3001/api/markets/stats`
- **链列表**: `http://43.247.134.242:3001/api/markets/chains`

## 服务器管理

### 查看服务状态

```bash
ssh 43.247.134.242
pm2 status
```

### 查看日志

```bash
ssh 43.247.134.242
pm2 logs aave-backend
```

### 重启服务

```bash
ssh 43.247.134.242
pm2 restart aave-backend
```

### 停止服务

```bash
ssh 43.247.134.242
pm2 stop aave-backend
```

### 查看实时日志

```bash
ssh 43.247.134.242
pm2 logs aave-backend --lines 100
```

## 防火墙配置

脚本会自动配置防火墙，但如果你需要手动配置：

### UFW (Ubuntu/Debian)

```bash
sudo ufw allow 3001/tcp
sudo ufw status
```

### firewalld (CentOS/RHEL)

```bash
sudo firewall-cmd --permanent --add-port=3001/tcp
sudo firewall-cmd --reload
```

### 云服务商安全组

如果使用云服务器（阿里云、腾讯云、AWS 等），还需要在云控制台配置安全组规则：

- **端口**: 3001
- **协议**: TCP
- **源**: 0.0.0.0/0（允许所有 IP 访问）

## 常见问题

### 1. SSH 连接失败

**问题**: `Permission denied (publickey)`

**解决**: 
- 确保你的 SSH 公钥已添加到服务器的 `~/.ssh/authorized_keys`
- 检查 SSH 密钥权限：`chmod 600 ~/.ssh/id_rsa`

### 2. GitHub 访问失败

**问题**: `Permission denied (publickey)` 或 `Host key verification failed`

**解决**:
- 确保服务器的 SSH 密钥已添加到 GitHub 账户
- 脚本会自动添加 `github.com` 到 `known_hosts`

### 3. Node.js 版本不匹配

**问题**: Node.js 版本不是 20.18.1

**解决**: 脚本会自动安装正确的 Node.js 版本（使用 NVM）

### 4. PM2 启动失败

**问题**: PM2 无法启动服务

**解决**:
```bash
ssh 43.247.134.242
cd /root/aave
pm2 logs aave-backend --err
# 查看错误日志并修复问题
```

### 5. 端口无法访问

**问题**: 外部无法访问 `http://43.247.134.242:3001`

**解决**:
1. 检查防火墙配置
2. 检查云服务商安全组规则
3. 检查服务是否运行：`pm2 status`

### 6. 数据文件不存在

**问题**: 首次部署时数据文件可能不存在

**解决**: 
- 脚本会自动运行数据获取，但可能需要几分钟
- 可以手动触发：`curl -X POST http://43.247.134.242:3001/api/markets/refresh`

## 更新部署

当代码更新后，只需再次运行部署脚本：

```bash
# 1. 提交并推送代码
git add .
git commit -m "Update code"
git push origin main

# 2. 运行部署脚本
./deploy.sh 43.247.134.242
```

脚本会自动：
- 拉取最新代码
- 重新构建
- 重启 PM2 服务

## 监控和维护

### 设置 PM2 开机自启

```bash
ssh 43.247.134.242
pm2 startup
pm2 save
```

### 查看资源使用

```bash
ssh 43.247.134.242
pm2 monit
```

### 查看详细信息

```bash
ssh 43.247.134.242
pm2 describe aave-backend
```

## 安全建议

1. **使用 HTTPS**: 建议配置 Nginx 反向代理并启用 SSL
2. **限制访问**: 如果不需要公网访问，可以限制 IP 范围
3. **定期更新**: 保持系统和依赖包更新
4. **监控日志**: 定期检查日志文件，发现异常及时处理

## 下一步

部署成功后，你可以：

1. 配置域名和 HTTPS（可选）
2. 设置监控和告警
3. 配置自动备份
4. 集成到 CI/CD 流程


# 最简单的 HTTPS 方案：后端直接监听 80 端口

## 方案说明

让后端直接监听 80 端口，Cloudflare 直接代理到 80 端口，无需 Nginx。

## 优势

- ✅ 最简单，无需 Nginx
- ✅ 无需额外配置
- ✅ Cloudflare 自动提供 HTTPS
- ✅ 配置最少

## 配置步骤

### 步骤 1: 更新 PM2 配置

PM2 配置已更新为使用 80 端口（`ecosystem.config.cjs`）。

### 步骤 2: 部署更新

```bash
# 提交更改
git add ecosystem.config.cjs
git commit -m "Change backend port to 80 for Cloudflare"
git push origin main

# 重新部署
./deploy.sh 43.247.134.242
```

### 步骤 3: 配置防火墙开放 80 端口

部署脚本会自动开放 80 端口，如果需要手动配置：

```bash
ssh 43.247.134.242

# UFW
sudo ufw allow 80/tcp

# 或 firewalld
sudo firewall-cmd --permanent --add-port=80/tcp
sudo firewall-cmd --reload
```

### 步骤 4: 验证 HTTP 访问

```bash
# 测试 HTTP（80 端口）
curl http://43.247.134.242/health
curl http://43.247.134.242/api/markets
```

### 步骤 5: Cloudflare 配置

1. **DNS 记录**（已配置）：
   - Type: A
   - Name: `api`
   - IPv4: `43.247.134.242`
   - Proxy: ✅ Proxied（橙色云朵）

2. **SSL/TLS 设置**（已配置）：
   - Mode: Full

3. **页面规则**（可选）：
   - URL: `http://api.aaveapy.com/*`
   - Setting: Always Use HTTPS

### 步骤 6: 验证 HTTPS

等待几分钟让 DNS 和 SSL 生效，然后测试：

```bash
# HTTPS 访问
curl https://api.aaveapy.com/health
curl https://api.aaveapy.com/api/markets
```

## 端口说明

- **后端监听**: 80 端口（HTTP）
- **Cloudflare 代理**: 80 → 443（自动 HTTPS）
- **外部访问**: `https://api.aaveapy.com`（HTTPS）

## 更新前端配置

配置完成后，更新前端环境变量：

```
VITE_API_URL = https://api.aaveapy.com/api
```

## 注意事项

1. **需要 root 权限**: 监听 80 端口需要 root 权限
   - PM2 以 root 运行，所以没问题
   - 或者使用 `setcap` 允许 Node.js 绑定低端口

2. **防火墙**: 确保 80 端口已开放

3. **Cloudflare Proxy**: 必须启用（橙色云朵），才能使用 HTTPS

## 如果遇到权限问题

如果 PM2 无法绑定 80 端口，可以使用 `setcap`：

```bash
ssh 43.247.134.242

# 允许 Node.js 绑定低端口
sudo setcap 'cap_net_bind_service=+ep' $(which node)

# 或使用 authbind（另一种方式）
sudo apt install authbind
sudo touch /etc/authbind/byport/80
sudo chmod 500 /etc/authbind/byport/80
sudo chown $USER /etc/authbind/byport/80
```

## 验证清单

- [ ] PM2 配置已更新（PORT: 80）
- [ ] 代码已提交并推送
- [ ] 已重新部署
- [ ] 80 端口已开放
- [ ] HTTP 可以访问：`http://43.247.134.242/health`
- [ ] Cloudflare DNS 已配置（Proxied）
- [ ] SSL/TLS 模式为 Full
- [ ] HTTPS 可以访问：`https://api.aaveapy.com/health`
- [ ] 前端环境变量已更新

## 完成！

配置完成后，你的 API 地址将是：

- **HTTPS URL**: `https://api.aaveapy.com`
- **健康检查**: `https://api.aaveapy.com/health`
- **API 端点**: `https://api.aaveapy.com/api/markets`

前端配置：
```
VITE_API_URL = https://api.aaveapy.com/api
```


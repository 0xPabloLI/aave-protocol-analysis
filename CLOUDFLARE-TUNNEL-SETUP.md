# Cloudflare Tunnel 配置指南（最安全方案）

## 方案优势

- ✅ **无需开放 80/443 端口**（最安全）
- ✅ **无需 Nginx**
- ✅ **后端继续使用 3001 端口**
- ✅ **自动 HTTPS**
- ✅ **隐藏真实 IP 地址**
- ✅ **完全免费**

## 工作原理

Cloudflare Tunnel 通过 `cloudflared` 在服务器和 Cloudflare 之间建立加密连接，无需开放任何端口。

```
用户 → HTTPS → Cloudflare → 加密隧道 → 服务器:3001
```

## 步骤 1: 安装 cloudflared

在服务器上安装：

```bash
ssh 43.247.134.242

# 下载并安装 cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

# 验证安装
cloudflared --version
```

## 步骤 2: 登录 Cloudflare

```bash
cloudflared tunnel login
```

这会打开浏览器，让你登录 Cloudflare 并授权。登录后会自动下载证书文件。

## 步骤 3: 创建隧道

```bash
# 创建隧道（名称可以自定义）
cloudflared tunnel create aave-api-tunnel

# 记下输出的 Tunnel ID（类似：abc12345-6789-efgh-ijkl-mnopqrstuvwx）
```

## 步骤 4: 配置隧道

创建配置文件：

```bash
sudo mkdir -p /etc/cloudflared
sudo nano /etc/cloudflared/config.yml
```

添加以下内容（替换 `<TUNNEL_ID>` 为你的 Tunnel ID）：

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /root/.cloudflared/<TUNNEL_ID>.json

ingress:
  # 将 api.aaveapy.com 路由到本地 3001 端口
  - hostname: api.aaveapy.com
    service: http://localhost:3001
  # 默认规则（必须放在最后）
  - service: http_status:404
```

## 步骤 5: 配置 DNS 路由

```bash
# 将域名路由到隧道
cloudflared tunnel route dns aave-api-tunnel api.aaveapy.com
```

或者手动在 Cloudflare Dashboard 中：
1. 进入 DNS → Records
2. 编辑 `api` 记录
3. 类型改为 `CNAME`
4. 内容改为：`<TUNNEL_ID>.cfargotunnel.com`
5. Proxy 状态：**Proxied**（橙色云朵）

## 步骤 6: 运行隧道（测试）

```bash
# 前台运行测试
sudo cloudflared tunnel run aave-api-tunnel
```

如果看到 "Connection established"，说明成功！

## 步骤 7: 安装为系统服务

```bash
# 安装为系统服务
sudo cloudflared service install

# 启动服务
sudo systemctl start cloudflared

# 设置开机自启
sudo systemctl enable cloudflared

# 查看状态
sudo systemctl status cloudflared
```

## 步骤 8: 关闭 80/443 端口（可选，但推荐）

```bash
# 关闭防火墙中的 80/443 端口
sudo ufw delete allow 80/tcp
sudo ufw delete allow 443/tcp

# 或者如果使用 firewalld
sudo firewall-cmd --permanent --remove-port=80/tcp
sudo firewall-cmd --permanent --remove-port=443/tcp
sudo firewall-cmd --reload
```

## 步骤 9: 更新后端端口配置

将后端改回 3001 端口（更安全）：

```javascript
// ecosystem.config.cjs
env: {
  NODE_ENV: 'production',
  PORT: 3001  // 改回 3001
}
```

## 验证

等待几分钟让 DNS 生效，然后测试：

```bash
curl https://api.aaveapy.com/health
curl https://api.aaveapy.com/api/markets
```

## 优势对比

| 方案 | 需要开放端口 | 需要 Nginx | 隐藏 IP | 安全性 |
|------|------------|-----------|---------|--------|
| 直接 80 端口 | ✅ 是 | ❌ 否 | ❌ 否 | ⚠️ 低 |
| Nginx + 80/443 | ✅ 是 | ✅ 是 | ❌ 否 | ⚠️ 中 |
| **Cloudflare Tunnel** | ❌ **否** | ❌ **否** | ✅ **是** | ✅ **高** |

## 管理命令

```bash
# 查看隧道列表
cloudflared tunnel list

# 查看隧道信息
cloudflared tunnel info aave-api-tunnel

# 查看服务状态
sudo systemctl status cloudflared

# 查看日志
sudo journalctl -u cloudflared -f

# 重启服务
sudo systemctl restart cloudflared
```

## 故障排查

### 问题 1: 连接失败

检查：
```bash
# 检查 cloudflared 服务状态
sudo systemctl status cloudflared

# 检查配置
sudo cloudflared tunnel validate

# 检查后端是否运行
curl http://localhost:3001/health
```

### 问题 2: DNS 未生效

等待几分钟，或清除 DNS 缓存：
```bash
# macOS
sudo dscacheutil -flushcache

# Linux
sudo systemd-resolve --flush-caches
```

## 完成后的架构

```
用户浏览器
    ↓ HTTPS
Cloudflare 边缘节点
    ↓ 加密隧道（cloudflared）
你的服务器（只监听 3001，不开放 80/443）
    ↓
Node.js 后端 (3001)
```

## 安全优势

1. **无需开放公网端口** - 服务器完全隐藏在 Cloudflare 后面
2. **加密隧道** - Cloudflare 到服务器的连接也是加密的
3. **隐藏 IP** - 攻击者无法直接访问你的服务器
4. **DDoS 防护** - Cloudflare 自动防护

这是最安全的方案！🎉


# Cloudflare Tunnel 故障排查

## 当前状态

✅ **Tunnel 服务运行正常**
- 服务状态：active (running)
- 连接数：4 个连接（1xhkg01, 2xhkg08, 1xhkg09）
- 后端运行：3001 端口正常

❌ **HTTPS 访问返回 530/1033 错误**

## 可能的原因和解决方案

### 原因 1: SSL/TLS 模式设置错误

**问题：** Cloudflare 的 SSL/TLS 模式可能设置为 "Full"，但 Tunnel 不需要这个设置。

**解决：**
1. 登录 Cloudflare Dashboard
2. 选择域名 `aaveapy.com`
3. 进入 "SSL/TLS" → "Overview"
4. 将 SSL/TLS encryption mode 设置为 **"Flexible"**
   - Flexible: Cloudflare ↔ 用户 HTTPS，Cloudflare ↔ Tunnel HTTP
   - 这是 Tunnel 的正确配置

### 原因 2: DNS 传播未完成

**问题：** DNS 更改可能需要几分钟才能完全生效。

**解决：**
1. 等待 5-10 分钟
2. 清除本地 DNS 缓存：
   ```bash
   # macOS
   sudo dscacheutil -flushcache
   
   # Linux
   sudo systemd-resolve --flush-caches
   ```
3. 使用不同网络测试

### 原因 3: Tunnel 配置需要验证

**检查配置：**
```bash
ssh 43.247.134.242
sudo cloudflared tunnel validate
```

**检查后端：**
```bash
ssh 43.247.134.242
curl http://localhost:3001/health
```

### 原因 4: 需要等待 Tunnel 完全连接

**检查连接状态：**
```bash
ssh 43.247.134.242
cloudflared tunnel info aave-api-tunnel
```

应该显示多个连接（CONNECTIONS 列）

## 验证步骤

### 步骤 1: 检查所有组件

```bash
# 1. 检查 Tunnel 服务
ssh 43.247.134.242 "sudo systemctl status cloudflared"

# 2. 检查后端
ssh 43.247.134.242 "curl http://localhost:3001/health"

# 3. 检查 Tunnel 连接
ssh 43.247.134.242 "cloudflared tunnel list"

# 4. 检查 DNS
nslookup api.aaveapy.com
```

### 步骤 2: 检查 Cloudflare 设置

1. **DNS 记录：**
   - Type: CNAME
   - Name: api
   - Target: `aave-api-tunnel.cfargotunnel.com`
   - Proxy: Proxied (橙色云朵)

2. **SSL/TLS 模式：**
   - 设置为 "Flexible"

### 步骤 3: 重启服务

```bash
ssh 43.247.134.242
sudo systemctl restart cloudflared
sleep 5
curl https://api.aaveapy.com/health
```

## 错误代码说明

- **530**: Cloudflare 无法连接到源服务器（Tunnel 连接问题）
- **1033**: 类似 530，表示连接失败

## 如果仍然无法解决

1. **查看详细日志：**
   ```bash
   ssh 43.247.134.242
   sudo journalctl -u cloudflared -f
   ```

2. **测试 Tunnel 直接运行：**
   ```bash
   ssh 43.247.134.242
   sudo cloudflared tunnel run aave-api-tunnel
   ```
   查看是否有错误信息

3. **检查防火墙：**
   ```bash
   ssh 43.247.134.242
   sudo ufw status
   ```
   确保没有阻止 cloudflared 的出站连接

4. **重新创建 Tunnel：**
   如果以上都不行，可能需要重新创建 Tunnel 和 DNS 记录


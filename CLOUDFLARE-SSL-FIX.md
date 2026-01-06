# Cloudflare SSL/TLS 模式修复

## 问题

HTTPS 返回 521 错误：Web server is down

## 原因

Cloudflare SSL/TLS 模式设置为 "Full"，但后端只监听 HTTP（80端口）。
Cloudflare 尝试用 HTTPS 连接到后端，但后端不支持 HTTPS，导致连接失败。

## 解决方案

将 Cloudflare 的 SSL/TLS 模式改为 **"Flexible"**：

1. 登录 Cloudflare Dashboard
2. 选择域名 `aaveapy.com`
3. 点击左侧菜单 **"SSL/TLS"**
4. 在 **"Overview"** 部分，找到 **"SSL/TLS encryption"**
5. 点击 **"Configure"** 按钮
6. 选择 **"Flexible"** 模式
   - **Flexible**: Cloudflare ↔ Visitor: HTTPS, Cloudflare ↔ Origin: HTTP
   - 这是最适合当前配置的模式（后端只监听 HTTP 80 端口）
7. 保存设置

## 模式说明

- **Off**: 完全关闭 SSL（不推荐）
- **Flexible**: ✅ **推荐** - Cloudflare 到用户 HTTPS，Cloudflare 到源服务器 HTTP
- **Full**: Cloudflare 到用户 HTTPS，Cloudflare 到源服务器 HTTPS（需要源服务器支持 HTTPS）
- **Full (strict)**: 同 Full，但需要有效的 SSL 证书

## 验证

修改后等待 1-2 分钟，然后测试：

```bash
curl https://api.aaveapy.com/health
```

应该返回：
```json
{"status":"ok","timestamp":"..."}
```

## 完成后的配置

- ✅ DNS: `api.aaveapy.com` → `43.247.134.242` (Proxied)
- ✅ SSL/TLS: Flexible
- ✅ 后端监听: HTTP 80 端口
- ✅ 用户访问: HTTPS（通过 Cloudflare）


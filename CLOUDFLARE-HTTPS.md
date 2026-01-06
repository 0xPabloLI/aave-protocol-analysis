# 使用 Cloudflare 配置 HTTPS（最简单方案）

如果你没有域名或想要最简单的方案，可以使用 Cloudflare。

## 方案优势

- ✅ 无需服务器配置
- ✅ 免费 SSL 证书
- ✅ CDN 加速
- ✅ DDoS 防护
- ✅ 可以免费获取域名

## 步骤 1: 获取域名（如果没有）

### 选项 A: 购买域名

推荐域名注册商：
- Namecheap: https://www.namecheap.com
- GoDaddy: https://www.godaddy.com
- Cloudflare Registrar: https://www.cloudflare.com/products/registrar/

### 选项 B: 使用免费域名

- Freenom: https://www.freenom.com（免费 .tk, .ml, .ga 域名）
- DuckDNS: https://www.duckdns.org（免费动态 DNS）

## 步骤 2: 添加域名到 Cloudflare

1. 访问 https://cloudflare.com
2. 注册/登录账户
3. 点击 "Add a Site"
4. 输入你的域名（如 `yourdomain.com`）
5. 选择免费计划（Free plan）
6. 按照提示更改 DNS 服务器

## 步骤 3: 配置 DNS 记录

在 Cloudflare Dashboard 中：

1. 进入你的域名
2. 点击 "DNS" → "Records"
3. 添加 A 记录：
   - **Type**: A
   - **Name**: `api`（或 `@` 用于根域名）
   - **IPv4 address**: `43.247.134.242`
   - **Proxy status**: ✅ **Proxied**（橙色云朵，重要！）
   - **TTL**: Auto

4. 点击 "Save"

## 步骤 4: 配置 SSL/TLS

1. 进入 "SSL/TLS" 设置
2. 选择 "Full" 或 "Full (strict)" 模式
   - **Full**: 允许自签名证书（适合测试）
   - **Full (strict)**: 需要有效证书（推荐）

## 步骤 5: 配置页面规则（HTTP 重定向到 HTTPS）

1. 进入 "Rules" → "Page Rules"
2. 点击 "Create Page Rule"
3. 配置：
   - **URL**: `http://api.yourdomain.com/*`
   - **Setting**: "Always Use HTTPS"
4. 保存

## 步骤 6: 更新前端配置

在 Vercel 或前端环境变量中更新：

```
VITE_API_URL = https://api.yourdomain.com/api
```

## 验证

访问以下 URL 验证 HTTPS：

- `https://api.yourdomain.com/health`
- `https://api.yourdomain.com/api/markets`

## 优势

使用 Cloudflare 后：
- ✅ 自动 HTTPS（无需服务器配置）
- ✅ 隐藏真实 IP 地址
- ✅ CDN 加速（全球节点）
- ✅ DDoS 防护
- ✅ 免费 SSL 证书

## 注意事项

1. **Proxy 状态**：必须启用 Proxy（橙色云朵），否则无法使用 Cloudflare 的 SSL
2. **DNS 传播**：DNS 更改可能需要几分钟到几小时生效
3. **端口**：Cloudflare 只代理 80 和 443 端口，后端仍运行在 3001

## 如果使用 IP 地址

如果你只有 IP 地址没有域名：

1. 可以使用 Cloudflare Tunnel（需要安装 cloudflared）
2. 或使用免费的动态 DNS 服务（如 DuckDNS）
3. 或购买一个便宜的域名


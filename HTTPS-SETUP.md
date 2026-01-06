# 后端 HTTPS 配置指南

本文档介绍如何将后端 API 服务从 HTTP 升级到 HTTPS。

## 方案选择

### 方案 1: Nginx + Let's Encrypt（推荐，免费）

- ✅ 免费 SSL 证书
- ✅ 自动续期
- ✅ 反向代理，隐藏后端端口
- ✅ 性能好

### 方案 2: Cloudflare（最简单）

- ✅ 免费 SSL
- ✅ 无需服务器配置
- ✅ CDN 加速
- ⚠️ 需要域名

### 方案 3: 直接使用 HTTPS（需要证书）

- ⚠️ 需要自己管理证书
- ⚠️ 需要手动续期

## 方案 1: Nginx + Let's Encrypt（推荐）

### 前置要求

1. **域名**：需要一个域名指向服务器 IP `43.247.134.242`
   - 例如：`api.yourdomain.com` 或 `yourdomain.com`
   - 在域名 DNS 中添加 A 记录：`api.yourdomain.com` → `43.247.134.242`

2. **服务器访问**：SSH 访问权限

### 步骤 1: 安装 Nginx

```bash
ssh 43.247.134.242

# Ubuntu/Debian
sudo apt update
sudo apt install nginx -y

# 启动 Nginx
sudo systemctl start nginx
sudo systemctl enable nginx
```

### 步骤 2: 安装 Certbot（Let's Encrypt）

```bash
# Ubuntu/Debian
sudo apt install certbot python3-certbot-nginx -y
```

### 步骤 3: 配置 Nginx

创建 Nginx 配置文件：

```bash
sudo nano /etc/nginx/sites-available/aave-api
```

添加以下配置（替换 `api.yourdomain.com` 为你的域名）：

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

启用配置：

```bash
sudo ln -s /etc/nginx/sites-available/aave-api /etc/nginx/sites-enabled/
sudo nginx -t  # 测试配置
sudo systemctl reload nginx
```

### 步骤 4: 获取 SSL 证书

```bash
sudo certbot --nginx -d api.yourdomain.com
```

按照提示操作：
1. 输入邮箱地址
2. 同意服务条款
3. 选择是否接收邮件（可选）

Certbot 会自动：
- 获取 SSL 证书
- 配置 Nginx 使用 HTTPS
- 设置自动续期

### 步骤 5: 验证 HTTPS

访问：`https://api.yourdomain.com/health`

### 步骤 6: 更新前端配置

更新前端环境变量：

```
VITE_API_URL = https://api.yourdomain.com/api
```

## 方案 2: Cloudflare（最简单，无需服务器配置）

### 步骤 1: 添加域名到 Cloudflare

1. 访问 https://cloudflare.com
2. 添加你的域名
3. 按照提示更改 DNS 服务器

### 步骤 2: 配置 DNS

在 Cloudflare 中添加 A 记录：
- **Name**: `api`（或 `@` 用于根域名）
- **IPv4 address**: `43.247.134.242`
- **Proxy status**: ✅ Proxied（橙色云朵）

### 步骤 3: 配置 SSL/TLS

1. 进入 Cloudflare Dashboard
2. 选择你的域名
3. 进入 "SSL/TLS" 设置
4. 选择 "Full" 或 "Full (strict)" 模式

### 步骤 4: 配置页面规则（可选）

如果需要将 HTTP 重定向到 HTTPS：
1. 进入 "Rules" → "Page Rules"
2. 添加规则：
   - URL: `http://api.yourdomain.com/*`
   - Setting: "Always Use HTTPS"

### 步骤 5: 更新前端配置

```
VITE_API_URL = https://api.yourdomain.com/api
```

## 方案 3: 使用自签名证书（仅用于测试）

⚠️ **注意**：自签名证书会在浏览器中显示警告，不适合生产环境。

### 步骤 1: 生成自签名证书

```bash
ssh 43.247.134.242

# 创建证书目录
sudo mkdir -p /etc/ssl/aave-api
cd /etc/ssl/aave-api

# 生成证书（有效期 365 天）
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout aave-api.key \
  -out aave-api.crt \
  -subj "/C=US/ST=State/L=City/O=Organization/CN=43.247.134.242"
```

### 步骤 2: 修改后端代码支持 HTTPS

需要修改 `backend/src/server.ts` 来支持 HTTPS。

## 推荐方案对比

| 方案 | 难度 | 成本 | 证书类型 | 自动续期 | 推荐度 |
|------|------|------|---------|---------|--------|
| Nginx + Let's Encrypt | 中等 | 免费 | 受信任 | ✅ | ⭐⭐⭐⭐⭐ |
| Cloudflare | 简单 | 免费 | 受信任 | ✅ | ⭐⭐⭐⭐⭐ |
| 自签名证书 | 简单 | 免费 | 不受信任 | ❌ | ⭐（仅测试） |

## 更新部署脚本

如果使用 Nginx + Let's Encrypt，可以更新部署脚本自动配置。

## 常见问题

### Q: 我没有域名怎么办？

**A**: 
1. 可以购买一个域名（如 Namecheap、GoDaddy）
2. 或使用 Cloudflare 的免费域名服务
3. 或使用免费的动态 DNS 服务（如 DuckDNS）

### Q: 使用 IP 地址可以申请 SSL 证书吗？

**A**: 
- Let's Encrypt 不支持 IP 地址，需要域名
- 可以使用 Cloudflare 的 IP 代理功能
- 或使用自签名证书（仅测试）

### Q: HTTPS 配置后前端无法连接？

**A**: 
1. 检查 Nginx 配置是否正确
2. 检查防火墙是否开放 443 端口
3. 检查 SSL 证书是否有效
4. 检查前端环境变量是否更新为 HTTPS URL

## 下一步

选择方案后，按照对应步骤操作。推荐使用 **Nginx + Let's Encrypt** 或 **Cloudflare**。


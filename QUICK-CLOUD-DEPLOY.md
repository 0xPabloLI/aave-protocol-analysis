# 快速云部署指南

## 🚀 最快部署方式：Railway（推荐）

### 1. 准备代码
确保代码已推送到 GitHub

### 2. 部署步骤
1. 访问 https://railway.app
2. 使用 GitHub 登录
3. 点击 "New Project" → "Deploy from GitHub repo"
4. 选择你的仓库
5. Railway 会自动检测并部署

### 3. 配置环境变量（可选）
在 Railway 项目设置中添加：
```
NODE_ENV=production
```

### 4. 获取 URL
部署完成后，Railway 会提供类似这样的 URL：
```
https://your-app-name.up.railway.app
```

### 5. 测试
访问：`https://your-app-name.up.railway.app/health`

---

## 🎯 其他云平台快速部署

### Render（免费）
1. 访问 https://render.com
2. 连接 GitHub
3. 创建 "Web Service"
4. 使用项目中的 `render.yaml` 配置（已自动配置）
5. 点击部署

### Fly.io（免费额度）
```bash
# 1. 安装 CLI
curl -L https://fly.io/install.sh | sh

# 2. 登录
fly auth login

# 3. 部署
fly launch
fly deploy
```

---

## 📋 部署前检查清单

- [ ] 代码已推送到 GitHub/GitLab
- [ ] 项目根目录有 `Dockerfile`（在 `backend/` 目录）
- [ ] 项目根目录有 `render.yaml`（用于 Render）
- [ ] 项目根目录有 `railway.json`（用于 Railway）
- [ ] 项目根目录有 `fly.toml`（用于 Fly.io）

---

## 🔗 部署后的 API 地址

部署完成后，你的 API 地址将是：

```
https://your-domain.com/api/markets
https://your-domain.com/health
https://your-domain.com/api/markets/stats
https://your-domain.com/api/markets/chains
```

---

## ⚠️ 注意事项

1. **首次启动**：服务首次启动时会尝试获取数据，可能需要几分钟
2. **数据持久化**：确保云平台配置了数据持久化（Volume/Disk）
3. **端口配置**：云平台会自动设置 PORT，代码已支持
4. **定时任务**：数据每 1 分钟自动更新一次

---

## 🆘 遇到问题？

1. 查看云平台的日志输出
2. 检查环境变量是否正确设置
3. 确认数据目录有写入权限
4. 查看 `CLOUD-DEPLOY.md` 获取详细帮助


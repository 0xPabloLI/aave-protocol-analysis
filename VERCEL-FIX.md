# Vercel 部署问题修复指南

## 问题：显示源代码而不是前端页面

如果 Vercel 显示源代码而不是构建后的页面，可能是以下原因：

### 1. Root Directory 配置错误

**检查步骤：**

1. 进入 Vercel Dashboard
2. 选择你的项目
3. 进入 **Settings** → **General**
4. 检查 **Root Directory** 设置

**应该设置为：**
```
frontend
```

**如果不是，修改为：**
- 点击 "Edit"
- 输入 `frontend`
- 保存

### 2. 构建配置检查

**在 Vercel Dashboard 中：**

1. 进入 **Settings** → **General**
2. 检查以下设置：
   - **Framework Preset**: Vite
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
   - **Install Command**: `npm install`
   - **Root Directory**: `frontend`

### 3. 环境变量配置

**在 Vercel Dashboard 中：**

1. 进入 **Settings** → **Environment Variables**
2. 添加/更新：
   - **Key**: `VITE_API_URL`
   - **Value**: `https://api.aaveapy.com/api`
   - **环境**: 选择所有（Production, Preview, Development）

### 4. 重新部署

修改配置后：

1. 进入 **Deployments** 页面
2. 找到最新的部署
3. 点击右侧的 "..." 菜单
4. 选择 **Redeploy**
5. 或者推送新的 commit 到 GitHub

## 常见问题

### 问题 1: 显示源代码

**原因：** Root Directory 未设置或设置错误

**解决：** 设置为 `frontend`

### 问题 2: 404 错误

**原因：** 路由配置问题

**解决：** 确保 `vercel.json` 中有正确的 rewrites 规则

### 问题 3: API 请求失败

**原因：** API URL 配置错误

**解决：** 
- 更新环境变量 `VITE_API_URL = https://api.aaveapy.com/api`
- 更新 `vercel.json` 中的代理地址

## 验证步骤

1. **检查构建日志：**
   - 进入 **Deployments**
   - 点击最新的部署
   - 查看 **Build Logs**
   - 应该看到 "Build Completed" 和文件列表

2. **检查部署文件：**
   - 在部署详情中，应该看到 `dist/index.html` 等文件
   - 不应该看到源代码文件

3. **测试访问：**
   - 访问 `https://aave-protocol-analysis.vercel.app/`
   - 应该看到前端界面，而不是源代码

## 如果还是不行

1. **删除并重新导入项目：**
   - 在 Vercel Dashboard 中删除项目
   - 重新导入 GitHub 仓库
   - 确保 Root Directory 设置为 `frontend`

2. **检查 GitHub 仓库结构：**
   ```
   aave-protocol-analysis/
   ├── frontend/
   │   ├── package.json
   │   ├── vite.config.ts
   │   ├── src/
   │   └── ...
   └── ...
   ```

3. **本地测试构建：**
   ```bash
   cd frontend
   npm run build
   ls dist/
   ```
   应该看到构建后的文件


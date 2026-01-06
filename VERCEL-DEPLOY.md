# Vercel 部署指南

本文档介绍如何将前端部署到 Vercel，并配置自动部署。

## 前置要求

1. **GitHub 账户** - 代码已推送到 GitHub
2. **Vercel 账户** - 如果没有，访问 https://vercel.com 注册（可以使用 GitHub 账号登录）

## 重要说明：不需要在 GitHub 中分环境

**你不需要在 GitHub 中创建不同的分支或环境配置。**

- ✅ 使用同一个 `main` 分支即可
- ✅ 环境变量在 Vercel Dashboard 中配置
- ✅ Vercel 会根据部署类型自动选择环境（Production/Preview/Development）

详细说明请查看 `VERCEL-ENVIRONMENT-EXPLAIN.md`

## 部署步骤

### 方法 1: 通过 Vercel Dashboard（推荐）

#### 步骤 1: 连接 GitHub 仓库

1. 访问 https://vercel.com
2. 使用 GitHub 账号登录
3. 点击 "Add New..." → "Project"
4. 选择你的 GitHub 仓库：`0xPabloLI/aave-protocol-analysis`

#### 步骤 2: 配置项目

Vercel 会自动检测到这是一个 Vite 项目，配置如下：

- **Framework Preset**: Vite
- **Root Directory**: `frontend`（重要！）
- **Build Command**: `npm run build`（自动检测）
- **Output Directory**: `dist`（自动检测）
- **Install Command**: `npm install`（自动检测）

#### 步骤 3: 配置环境变量

在 "Environment Variables" 部分：

1. **添加环境变量**：
   - **Key**: `VITE_API_URL`
   - **Value**: `http://43.247.134.242:3001/api`

2. **选择环境**（重要）：
   - 在添加环境变量时，会看到环境选择选项
   - 或者添加后，点击环境变量右侧的编辑图标
   - 选择以下所有环境：
     - ✅ **Production** - 生产环境
     - ✅ **Preview** - 预览环境（Pull Request）
     - ✅ **Development** - 开发环境

   **注意**：如果添加时没有看到环境选择，可以：
   - 添加后点击环境变量右侧的编辑/设置图标
   - 或者进入项目设置 → Environment Variables 中编辑

#### 步骤 4: 部署

点击 "Deploy" 按钮，Vercel 会自动：
1. 安装依赖
2. 构建项目
3. 部署到全球 CDN

### 方法 2: 使用 Vercel CLI

#### 步骤 1: 安装 Vercel CLI

```bash
npm install -g vercel
```

#### 步骤 2: 登录

```bash
vercel login
```

#### 步骤 3: 部署

```bash
cd frontend
vercel
```

按照提示操作：
- 选择项目范围
- 链接到现有项目或创建新项目
- 确认配置

#### 步骤 4: 配置环境变量

```bash
vercel env add VITE_API_URL
# 输入值: http://43.247.134.242:3001/api
# 选择环境: Production, Preview, Development
```

#### 步骤 5: 重新部署

```bash
vercel --prod
```

## 自动部署配置

### GitHub 集成（自动配置）

当你通过 Vercel Dashboard 连接 GitHub 仓库后，Vercel 会自动：

1. **监听推送**：每次推送到 `main` 分支时自动部署
2. **创建预览**：每次创建 Pull Request 时创建预览部署
3. **自动构建**：自动运行 `npm run build`

### 手动触发部署

如果需要手动触发：

1. 在 Vercel Dashboard 中点击 "Redeploy"
2. 或使用 CLI：`vercel --prod`

## 环境变量配置

### 在 Vercel Dashboard 中配置

1. 进入项目设置（项目页面右上角的 "Settings"）
2. 点击左侧菜单的 "Environment Variables"
3. 添加变量：
   - 点击 "Add New" 或 "+ Add More" 按钮
   - **Key**: `VITE_API_URL`
   - **Value**: `http://43.247.134.242:3001/api`
   - **Environment**: 在添加时会显示环境选择，勾选：
     - ✅ Production
     - ✅ Preview  
     - ✅ Development
4. 点击 "Save" 保存

**如果添加时没有看到环境选择**：
- 添加后，点击该环境变量右侧的编辑图标（铅笔图标）
- 会显示环境选择选项，勾选所有三个环境
- 保存更改

### 使用 CLI 配置

```bash
# 添加环境变量
vercel env add VITE_API_URL production
# 输入值: http://43.247.134.242:3001/api

vercel env add VITE_API_URL preview
# 输入值: http://43.247.134.242:3001/api

vercel env add VITE_API_URL development
# 输入值: http://43.247.134.242:3001/api
```

## 项目结构要求

确保项目结构如下：

```
aave-protocol-analysis/
├── frontend/          # 前端代码目录
│   ├── src/
│   ├── package.json
│   ├── vite.config.ts
│   └── vercel.json    # Vercel 配置（已创建）
├── backend/           # 后端代码（Vercel 不部署）
└── ...
```

## 部署后的访问

部署成功后，Vercel 会提供：

- **生产环境 URL**: `https://your-project-name.vercel.app`
- **自定义域名**: 可以在项目设置中配置

## 更新部署

### 自动更新（推荐）

每次推送到 GitHub 的 `main` 分支时，Vercel 会自动：

1. 检测到新的推送
2. 自动构建项目
3. 部署新版本

**工作流程**：
```bash
# 1. 修改代码
git add .
git commit -m "Update frontend"
git push origin main

# 2. Vercel 自动检测并部署（无需手动操作）
```

### 手动更新

如果需要手动触发：

1. 在 Vercel Dashboard 点击 "Redeploy"
2. 或使用 CLI：`vercel --prod`

## 验证部署

### 1. 检查部署状态

在 Vercel Dashboard 中查看：
- 部署历史
- 构建日志
- 部署状态

### 2. 测试 API 连接

在浏览器中打开部署的 URL，打开控制台运行：

```javascript
fetch('http://43.247.134.242:3001/api/markets')
  .then(res => res.json())
  .then(data => {
    console.log('✅ API 连接成功！', data.data.length, '条数据');
  });
```

### 3. 检查环境变量

在 Vercel Dashboard 的 "Environment Variables" 中确认：
- `VITE_API_URL` 已设置
- 值正确：`http://43.247.134.242:3001/api`

## 常见问题

### 问题 1: 构建失败

**可能原因**：
- 依赖安装失败
- 构建命令错误
- 环境变量未设置

**解决方法**：
1. 查看 Vercel 构建日志
2. 检查 `package.json` 中的脚本
3. 确认环境变量已配置

### 问题 2: API 连接失败（CORS）

后端已配置允许所有来源，如果仍有问题：
1. 检查后端服务是否运行
2. 检查 API URL 是否正确
3. 查看浏览器控制台的错误信息

### 问题 3: 页面空白

**可能原因**：
- 路由配置问题
- 构建输出目录错误

**解决方法**：
1. 检查 `vercel.json` 中的 `rewrites` 配置
2. 确认 `outputDirectory` 为 `dist`

### 问题 4: 环境变量不生效

**解决方法**：
1. 确认变量名以 `VITE_` 开头
2. 重新部署项目
3. 检查环境变量是否应用到所有环境

## 自定义域名

### 添加自定义域名

1. 在 Vercel Dashboard 进入项目设置
2. 点击 "Domains"
3. 添加你的域名
4. 按照提示配置 DNS 记录

## 性能优化

Vercel 自动提供：
- ✅ 全球 CDN 加速
- ✅ 自动 HTTPS
- ✅ 边缘缓存
- ✅ 自动压缩

## 监控和分析

Vercel 提供：
- 部署日志
- 性能分析
- 访问统计（需要升级到付费计划）

## 下一步

部署成功后：

1. **测试功能**：访问部署的 URL，测试所有功能
2. **配置域名**：添加自定义域名（可选）
3. **设置监控**：配置错误监控和性能分析（可选）

## 工作流程总结

```bash
# 1. 本地开发
cd frontend
npm run dev

# 2. 提交代码
git add .
git commit -m "Update frontend"
git push origin main

# 3. Vercel 自动部署（无需手动操作）
# ✅ 自动检测推送
# ✅ 自动构建
# ✅ 自动部署
```

现在每次推送到 GitHub，Vercel 都会自动更新部署！


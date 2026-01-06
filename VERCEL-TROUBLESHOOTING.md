# Vercel 部署问题排查指南

## 当前问题：页面显示 Error

### 快速检查清单

#### 1. 检查环境变量配置

在 Vercel Dashboard 中：

1. 进入项目：https://vercel.com/dashboard
2. 选择你的项目：`aaveapy`
3. 点击 **Settings** → **Environment Variables**
4. 确认以下环境变量存在：

   - **Key**: `VITE_API_URL`
   - **Value**: `http://43.247.134.242:3001/api`
   - **Environment**: 必须勾选所有三个环境
     - ✅ Production
     - ✅ Preview
     - ✅ Development

#### 2. 检查环境变量是否生效

**重要**：修改环境变量后，需要重新部署才能生效！

1. 在 Vercel Dashboard 中，点击 **Deployments**
2. 找到最新的部署，点击右侧的 **⋯** 菜单
3. 选择 **Redeploy**
4. 或者使用 CLI：`vercel --prod`

#### 3. 检查浏览器控制台

1. 打开部署的网站：https://aaveapy.vercel.app/
2. 按 `F12` 打开开发者工具
3. 查看 **Console** 标签页的错误信息
4. 查看 **Network** 标签页，检查 API 请求是否失败

常见错误信息：

- `Failed to fetch` → 网络连接问题或 CORS 问题
- `Network Error` → API 服务器无法访问
- `404 Not Found` → API URL 配置错误
- `CORS policy` → 跨域问题

#### 4. 检查后端服务

确认后端服务正在运行：

```bash
# 测试后端 API 是否可访问
curl http://43.247.134.242:3001/api/markets
```

如果无法访问，需要：
1. 检查后端服务器是否运行
2. 检查防火墙设置
3. 检查服务器 IP 是否正确

#### 5. 检查混合内容问题

如果前端是 HTTPS（Vercel 默认），但 API 是 HTTP，浏览器可能会阻止请求。

**解决方案**：
- 使用 HTTPS 的 API（推荐）
- 或者配置后端支持 HTTPS

### 使用 Vercel CLI 检查和修复

#### 1. 安装并登录 Vercel CLI

```bash
npm install -g vercel
vercel login
```

#### 2. 检查环境变量

```bash
cd frontend
vercel env ls
```

#### 3. 添加/更新环境变量

```bash
# 删除旧的环境变量（如果存在）
vercel env rm VITE_API_URL production
vercel env rm VITE_API_URL preview
vercel env rm VITE_API_URL development

# 添加正确的环境变量
vercel env add VITE_API_URL production
# 输入值: http://43.247.134.242:3001/api

vercel env add VITE_API_URL preview
# 输入值: http://43.247.134.242:3001/api

vercel env add VITE_API_URL development
# 输入值: http://43.247.134.242:3001/api
```

#### 4. 重新部署

```bash
vercel --prod
```

### 在浏览器中测试 API 连接

打开浏览器控制台（F12），运行以下代码：

```javascript
// 检查环境变量
console.log('API URL:', import.meta.env.VITE_API_URL);

// 测试 API 连接
fetch('http://43.247.134.242:3001/api/markets')
  .then(res => res.json())
  .then(data => {
    console.log('✅ API 连接成功！', data);
  })
  .catch(error => {
    console.error('❌ API 连接失败：', error);
  });
```

### 常见问题及解决方案

#### 问题 1: 环境变量未生效

**症状**：页面显示错误，控制台显示 API URL 为 `http://localhost:3001/api`

**解决**：
1. 确认环境变量已添加到所有环境（Production, Preview, Development）
2. 重新部署项目
3. 清除浏览器缓存

#### 问题 2: CORS 错误

**症状**：控制台显示 `CORS policy` 错误

**解决**：
1. 检查后端 CORS 配置
2. 确认后端允许来自 `https://aaveapy.vercel.app` 的请求
3. 检查后端服务是否正常运行

#### 问题 3: 网络错误

**症状**：控制台显示 `Network Error` 或 `Failed to fetch`

**解决**：
1. 检查后端服务是否运行：`curl http://43.247.134.242:3001/api/markets`
2. 检查服务器防火墙设置
3. 检查 API URL 是否正确

#### 问题 4: 混合内容错误

**症状**：控制台显示混合内容警告

**解决**：
- 使用 HTTPS API（推荐）
- 或配置后端支持 HTTPS

### 验证修复

修复后，按以下步骤验证：

1. **检查环境变量**：
   - Vercel Dashboard → Settings → Environment Variables
   - 确认 `VITE_API_URL` 存在且值正确

2. **重新部署**：
   - 在 Vercel Dashboard 中点击 "Redeploy"
   - 或使用 CLI：`vercel --prod`

3. **检查部署日志**：
   - 在 Vercel Dashboard 中查看构建日志
   - 确认构建成功，没有错误

4. **测试网站**：
   - 访问 https://aaveapy.vercel.app/
   - 打开浏览器控制台（F12）
   - 确认没有错误
   - 确认数据正常加载

### 获取帮助

如果问题仍然存在：

1. 查看 Vercel 部署日志
2. 查看浏览器控制台错误
3. 检查后端服务状态
4. 提供详细的错误信息以便进一步排查

# Vercel 环境变量和环境说明

## 重要说明：不需要在 GitHub 中分环境

**你不需要在 GitHub 中创建不同的分支或环境配置。**

Vercel 的环境变量是在 **Vercel 平台**上配置的，不是在代码中。同一个代码库可以部署到不同环境，通过环境变量来区分。

## Vercel 环境的工作原理

### 1. 代码库结构

你的 GitHub 代码库只需要：
```
aave-protocol-analysis/
├── frontend/          # 前端代码（所有环境共用）
│   ├── src/
│   ├── package.json
│   └── vercel.json
└── ...
```

**不需要**：
- ❌ 创建 `production`、`staging`、`development` 分支
- ❌ 在代码中硬编码不同环境的 API URL
- ❌ 创建多个配置文件

### 2. Vercel 环境类型

Vercel 自动根据部署类型选择环境：

| 环境类型 | 触发条件 | 使用的环境变量 |
|---------|---------|--------------|
| **Production** | 推送到 `main`/`master` 分支 | `Production` 环境变量 |
| **Preview** | 创建 Pull Request 或推送到其他分支 | `Preview` 环境变量 |
| **Development** | 本地使用 `vercel dev` | `Development` 环境变量 |

### 3. 环境变量配置

在 Vercel Dashboard 中，你可以为同一个变量设置不同的值：

```
VITE_API_URL (Production)   → http://43.247.134.242:3001/api
VITE_API_URL (Preview)      → http://43.247.134.242:3001/api  (可以相同)
VITE_API_URL (Development)  → http://localhost:3001/api       (本地开发)
```

## 实际工作流程

### 场景 1: 所有环境使用同一个 API（推荐）

如果你的后端 API 对所有环境都可用：

1. **在 Vercel 中配置环境变量**：
   - Key: `VITE_API_URL`
   - Value: `http://43.247.134.242:3001/api`
   - 环境：✅ Production, ✅ Preview, ✅ Development（全部勾选）

2. **代码中不需要任何环境判断**：
   ```typescript
   // frontend/src/services/api.ts
   const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';
   // Vercel 会自动注入正确的环境变量值
   ```

3. **部署流程**：
   ```bash
   # 推送到 main 分支
   git push origin main
   # → Vercel 自动部署到 Production，使用 Production 环境变量
   
   # 创建 Pull Request
   # → Vercel 自动创建 Preview 部署，使用 Preview 环境变量
   ```

### 场景 2: 不同环境使用不同的 API（可选）

如果你需要不同环境使用不同的 API：

1. **在 Vercel 中配置不同的值**：
   - `VITE_API_URL` (Production) → `https://api.production.com`
   - `VITE_API_URL` (Preview) → `https://api.staging.com`
   - `VITE_API_URL` (Development) → `http://localhost:3001/api`

2. **代码保持不变**：
   ```typescript
   // 代码不需要修改，Vercel 会自动注入对应环境的值
   const API_BASE_URL = import.meta.env.VITE_API_URL;
   ```

## 你的情况（推荐配置）

由于你的后端 API `http://43.247.134.242:3001/api` 对所有环境都可用，建议：

### 配置方式

在 Vercel Dashboard 中：

1. **添加环境变量**：
   - Key: `VITE_API_URL`
   - Value: `http://43.247.134.242:3001/api`
   - **环境选择**：勾选所有三个
     - ✅ Production
     - ✅ Preview
     - ✅ Development

2. **这样配置后**：
   - 推送到 `main` → 自动部署到 Production，使用这个 API
   - 创建 PR → 自动创建 Preview，使用这个 API
   - 本地开发 → 可以使用这个 API 或本地 API

## 常见误解

### ❌ 误解 1: 需要创建不同的分支

**错误**：创建 `production`、`staging` 分支来区分环境

**正确**：使用同一个 `main` 分支，通过 Vercel 环境变量区分

### ❌ 误解 2: 需要在代码中判断环境

**错误**：
```typescript
const API_URL = process.env.NODE_ENV === 'production' 
  ? 'https://api.prod.com' 
  : 'https://api.dev.com';
```

**正确**：
```typescript
const API_URL = import.meta.env.VITE_API_URL;
// Vercel 会自动注入对应环境的值
```

### ❌ 误解 3: 需要多个配置文件

**错误**：创建 `.env.production`、`.env.development` 等文件

**正确**：在 Vercel Dashboard 中配置环境变量，代码中只需要读取

## 总结

1. **GitHub 代码库**：只需要一个 `main` 分支，所有环境共用
2. **环境变量**：在 Vercel Dashboard 中配置，不是在代码中
3. **环境区分**：Vercel 自动根据部署类型选择环境变量
4. **你的配置**：所有环境使用同一个 API URL，勾选所有三个环境即可

## 下一步

1. 在 Vercel 中添加环境变量 `VITE_API_URL`
2. 值设置为 `http://43.247.134.242:3001/api`
3. 勾选所有三个环境（Production, Preview, Development）
4. 部署即可

不需要修改 GitHub 代码或创建分支！


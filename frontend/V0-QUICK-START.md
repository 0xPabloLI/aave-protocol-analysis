# v0 快速开始指南

## 如何在 v0.dev 中使用这个项目

### 1. 访问 v0.dev

访问 https://v0.dev 并使用 GitHub 账号登录

### 2. 导入项目代码

在 v0 中，你可以：

**选项 A: 直接粘贴代码**
- 复制 `src/components/MarketsTable.tsx` 的内容
- 粘贴到 v0 编辑器中
- 让 v0 根据你的需求修改

**选项 B: 描述需求让 v0 生成**
- 在 v0 中描述你的需求
- v0 会生成代码
- 然后集成到项目中

### 3. 重要配置

#### API 路径配置

**⚠️ 重要**：由于使用了 Vercel 代理，API 路径应该是：

```typescript
// ✅ 正确：使用相对路径（通过 Vercel 代理）
const API_BASE_URL = '/api';

// 或者根据环境自动选择
const API_BASE_URL = import.meta.env.PROD 
  ? '/api'  // 生产环境：使用 Vercel 代理
  : 'http://localhost:3001/api';  // 开发环境
```

#### 类型导入

确保从项目中导入类型：

```typescript
import type { MarketWithSpread, FilterOptions } from '../types/index.js';
```

#### 样式类

使用项目中的样式类：

```typescript
// 卡片样式
className="card-elevated p-6"

// 表格行样式
className="table-row"

// 表格头样式
className="table-header"
```

### 4. 给 v0 的提示词示例

#### 修改现有功能

```
"修改 MarketsTable 组件：
- 添加深色模式支持
- 优化移动端响应式布局
- 添加数据导出功能（CSV/JSON）
- 改进加载状态，使用骨架屏"
```

#### 添加新功能

```
"在 MarketsTable 中添加：
- 收藏功能，使用 localStorage
- 数据对比功能
- 分享功能，生成可分享的 URL
- 数据可视化图表"
```

#### 优化性能

```
"优化 MarketsTable：
- 实现虚拟滚动
- 添加防抖搜索
- 使用 React.memo 优化重渲染
- 添加数据缓存"
```

### 5. 集成代码到项目

1. **复制 v0 生成的代码**
2. **替换项目中的文件**（如 `src/components/MarketsTable.tsx`）
3. **确保 API 路径正确**（使用 `/api`）
4. **测试本地运行**：`npm run dev`
5. **提交到 GitHub**：`git add . && git commit -m "Update from v0" && git push`
6. **Vercel 自动部署**

### 6. 项目结构

```
frontend/src/
├── components/
│   ├── MarketsTable.tsx      # 主表格组件（主要修改目标）
│   ├── FilterControls.tsx    # 筛选控件
│   └── LoadingSpinner.tsx    # 加载动画
├── hooks/
│   └── useMarkets.ts         # 数据获取 Hook
├── services/
│   ├── api.ts                # API 客户端（已配置代理）
│   └── tokenFilter.ts        # 代币筛选
└── types/
    └── index.ts              # TypeScript 类型
```

### 7. 技术栈

- React 19 + TypeScript
- Vite
- Tailwind CSS
- Axios

### 8. 常见问题

**Q: v0 生成的代码无法连接 API？**
A: 确保使用 `/api` 路径，不要使用 `http://43.247.134.242:3001/api`

**Q: 样式不匹配？**
A: 使用项目中的样式类，查看 `src/index.css` 了解可用样式

**Q: 类型错误？**
A: 从 `src/types/index.ts` 导入正确的类型

### 9. 下一步

1. 访问 https://v0.dev
2. 粘贴或导入你的组件代码
3. 描述你的需求
4. 复制生成的代码
5. 集成到项目中
6. 推送到 GitHub，Vercel 自动部署

详细文档请查看：[V0-INTEGRATION-GUIDE.md](../V0-INTEGRATION-GUIDE.md)

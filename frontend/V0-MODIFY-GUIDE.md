# v0 修改指南 - MarketsTable 组件

## 简单回答：大多数情况下只需要修改 MarketsTable

`MarketsTable.tsx` 是主组件，包含了：
- ✅ 表格显示逻辑
- ✅ UI 布局和样式
- ✅ 用户交互（排序、筛选等）
- ✅ 数据展示

## 什么情况下只需要修改 MarketsTable？

### ✅ 只需要修改 MarketsTable 的情况：

1. **UI/UX 改进**
   - 修改表格样式
   - 添加深色模式
   - 优化响应式布局
   - 改进加载/错误状态显示
   - 添加动画效果

2. **显示逻辑**
   - 修改数据展示方式
   - 添加新的显示字段
   - 格式化数据展示
   - 添加图标或徽章

3. **用户交互**
   - 添加新的按钮或操作
   - 修改排序/筛选的 UI
   - 添加工具提示
   - 添加复制/分享功能

4. **布局优化**
   - 修改表格结构
   - 添加卡片视图
   - 优化移动端布局

### 示例提示词（只需要修改 MarketsTable）：

```
"修改 MarketsTable 组件：
- 添加深色模式切换按钮
- 优化移动端布局，小屏幕使用卡片
- 添加数据导出按钮（CSV/JSON）
- 改进加载状态，使用骨架屏"
```

## 什么情况下需要修改其他文件？

### ⚠️ 需要修改其他文件的情况：

#### 1. 添加新的筛选功能
**需要修改**：
- `MarketsTable.tsx` - 添加 UI
- `FilterControls.tsx` - 添加筛选控件
- `src/types/index.ts` - 添加类型定义（如果需要）

**示例**：
```
"添加按代币类型筛选功能"
→ 需要修改 FilterControls.tsx 和 MarketsTable.tsx
```

#### 2. 添加新的数据字段或 API 调用
**需要修改**：
- `MarketsTable.tsx` - 显示新数据
- `src/services/api.ts` - 添加 API 调用（如果需要）
- `src/types/index.ts` - 添加类型定义

**示例**：
```
"添加代币价格显示"
→ 需要修改 types/index.ts（添加价格字段）
→ 可能需要修改 api.ts（如果后端没有提供）
```

#### 3. 修改数据获取逻辑
**需要修改**：
- `src/hooks/useMarkets.ts` - 数据获取逻辑
- `MarketsTable.tsx` - 使用新的数据

**示例**：
```
"添加数据缓存功能"
→ 需要修改 useMarkets.ts
```

#### 4. 添加新的页面或路由
**需要修改**：
- `src/App.tsx` - 添加路由
- 创建新组件文件

## 推荐的工作流程

### 步骤 1: 先只修改 MarketsTable

1. 在 v0 中导入 `MarketsTable.tsx`
2. 描述你的需求
3. 让 v0 生成代码
4. 复制并替换 `MarketsTable.tsx`
5. 测试是否工作

### 步骤 2: 如果遇到问题，再修改其他文件

如果 v0 生成的代码需要：
- 新的类型定义 → 修改 `src/types/index.ts`
- 新的筛选控件 → 修改 `FilterControls.tsx`
- 新的 API 调用 → 修改 `src/services/api.ts`

## 给 v0 的提示词模板

### 模板 1: 只修改 UI（推荐）

```
"修改 MarketsTable 组件：
[描述你的需求]

注意：
- 保持现有的数据获取逻辑（useMarkets hook）
- 保持现有的筛选功能（FilterControls）
- 只修改 UI 和显示逻辑
- 使用项目中的样式类（card-elevated, table-row 等）
- API 路径使用 '/api'（Vercel 代理）
"
```

### 模板 2: 需要新功能

```
"修改 MarketsTable 组件，添加 [新功能]：
[描述需求]

如果需要修改其他文件，请说明需要修改哪些文件：
- FilterControls.tsx（如果需要新的筛选）
- types/index.ts（如果需要新的类型）
- api.ts（如果需要新的 API 调用）
"
```

## 快速检查清单

在让 v0 修改代码前，问自己：

- [ ] 只是改 UI/样式？ → **只需要 MarketsTable**
- [ ] 只是改数据展示方式？ → **只需要 MarketsTable**
- [ ] 需要新的筛选选项？ → **需要 FilterControls**
- [ ] 需要新的数据字段？ → **可能需要 types/index.ts**
- [ ] 需要新的 API 调用？ → **可能需要 api.ts**

## 实际示例

### 示例 1: 添加深色模式 ✅ 只需要 MarketsTable

```
"为 MarketsTable 添加深色模式：
- 添加主题切换按钮
- 使用 Tailwind 的 dark: 类
- 保存主题到 localStorage"
```

**只需要修改**：`MarketsTable.tsx`

### 示例 2: 添加数据导出 ✅ 只需要 MarketsTable

```
"在 MarketsTable 中添加数据导出功能：
- 添加导出按钮（CSV/JSON）
- 导出当前显示的数据"
```

**只需要修改**：`MarketsTable.tsx`

### 示例 3: 添加新的筛选 ⚠️ 需要多个文件

```
"添加按代币类型筛选（稳定币/ETH相关）"
```

**需要修改**：
- `MarketsTable.tsx` - 传递新的筛选参数
- `FilterControls.tsx` - 添加筛选 UI
- `src/types/index.ts` - 可能需要更新类型

## 总结

**大多数情况下，只需要修改 `MarketsTable.tsx`！**

只有在需要以下功能时才需要修改其他文件：
- 新的筛选选项 → FilterControls
- 新的数据字段 → types/index.ts
- 新的 API 调用 → api.ts
- 修改数据获取逻辑 → useMarkets.ts

**建议**：先只修改 MarketsTable，如果遇到问题或需要新功能，再告诉 v0 需要修改哪些其他文件。

# Vercel 环境变量配置详细说明

## 在哪里选择环境（Production, Preview, Development）

### 方法 1: 首次添加环境变量时

1. 在项目配置页面或项目设置的 "Environment Variables" 部分
2. 点击 "Add New" 或 "+ Add More" 按钮
3. 输入 Key 和 Value 后
4. **在输入框下方或右侧会显示环境选择选项**，通常显示为：
   - ☐ Production
   - ☐ Preview
   - ☐ Development
5. 勾选所有三个选项
6. 点击 "Save" 或 "Add"

### 方法 2: 编辑已存在的环境变量

如果添加时没有选择环境，或者需要修改：

1. 进入项目设置 → "Environment Variables"
2. 找到已添加的 `VITE_API_URL` 环境变量
3. 点击该变量右侧的**编辑图标**（通常是铅笔图标 ✏️ 或设置图标 ⚙️）
4. 会展开显示环境选择选项
5. 勾选所有三个环境：
   - ✅ Production
   - ✅ Preview
   - ✅ Development
6. 保存更改

### 方法 3: 在项目设置中统一管理

1. 进入项目页面
2. 点击右上角的 **"Settings"** 按钮
3. 在左侧菜单选择 **"Environment Variables"**
4. 这里可以看到所有环境变量及其应用的环境
5. 点击环境变量右侧的编辑图标可以修改环境选择

## 环境说明

- **Production**: 生产环境，访问主域名时使用
- **Preview**: 预览环境，Pull Request 和分支部署时使用
- **Development**: 开发环境，本地开发时使用（如果使用 Vercel CLI）

## 验证配置

配置完成后，可以：

1. 查看环境变量列表，确认 `VITE_API_URL` 显示在所有三个环境下
2. 重新部署项目，确保环境变量生效
3. 在部署日志中检查环境变量是否正确加载

## 常见问题

### Q: 添加环境变量时没有看到环境选择选项？

**A**: 这可能是因为：
1. 界面版本不同，环境选择可能在添加后编辑时显示
2. 尝试添加后，点击编辑图标来设置环境
3. 或者进入项目设置 → Environment Variables 中管理

### Q: 如何确认环境变量已应用到所有环境？

**A**: 
1. 进入项目设置 → Environment Variables
2. 查看环境变量列表
3. 每个变量会显示应用的环境（Production, Preview, Development）
4. 确认 `VITE_API_URL` 显示在所有三个环境下

### Q: 环境变量不生效？

**A**:
1. 确认变量名以 `VITE_` 开头（Vite 项目要求）
2. 确认已应用到 Production 环境
3. 重新部署项目（环境变量更改后需要重新部署）
4. 检查部署日志确认环境变量已加载


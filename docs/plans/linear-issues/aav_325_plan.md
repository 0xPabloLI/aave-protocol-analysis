# 开发方案：AAV-325 - 后端挂载 Swagger UI

## 1. Issue 概述
为后端 API 添加 Swagger UI 文档界面，方便前后端协作和外部使用者理解接口。

## 2. 当前状态
- 前端已有完整 OpenAPI 链路：`src/lib/apiSchemas.ts` (Zod) → `scripts/generate-openapi.ts` → `public/openapi.json` → `public/swagger.html`
- 后端无任何 Swagger/OpenAPI 相关文件

## 3. 方案（方案 A — 零重复，serve 前端已有 spec）

### 3.1 实现步骤
1. 复制前端 `public/openapi.json` 到后端 `backend/static/openapi.json`
2. 创建 `backend/static/swagger.html`，url 指向 `/api/docs/openapi.json`
3. 创建 `backend/src/routes/swagger.ts`，两个 GET 路由：
   - `GET /api/docs` → serve swagger.html
   - `GET /api/docs/openapi.json` → serve openapi.json
4. 在 `backend/src/server.ts` 中挂载 `app.use('/api/docs', swaggerRouter)`

### 3.2 已完成
- ✅ 所有文件已创建并 commit（`1d7e920 feat(swagger): serve OpenAPI spec + Swagger UI at /api/docs`）
- ✅ 构建、测试、类型检查均通过
- ✅ Linear issue AAV-325 已关闭

## 4. 验收标准
- 访问 `/api/docs` 显示 Swagger UI
- 访问 `/api/docs/openapi.json` 返回有效 JSON spec
- Railway 部署后 static 目录可正常访问

## 5. 注意事项
- `openapi.json` 是静态复制，前端 schema 更新时后端不会自动同步
- 长期可考虑 CI 同步或构建时从前端仓库拉取

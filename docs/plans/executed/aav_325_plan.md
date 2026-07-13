# 开发方案：AAV-325 - 后端挂载 Swagger UI

## 1. Issue 概述
为后端 API 添加 Swagger UI 文档界面，方便前后端协作和外部使用者理解接口。

## 2. 当前状态
- 前端已有完整 OpenAPI 链路：`src/lib/apiSchemas.ts` (Zod) → `scripts/generate-openapi.ts` → `public/openapi.json` → `public/swagger.html`
- 后端无任何 Swagger/OpenAPI 相关文件

## 3. 方案

### 3.1 第一版（已废弃）— 静态复制前端 spec
- ❌ 从独立前端仓库手动复制 `openapi.json` 到 `backend/static/openapi.json`
- ❌ 问题：前端 Zod schema 与后端 `serializeReserveForApi()` 实际输出已出现漂移
  - 前端 spec 中 `supplyIncentives` / `borrowIncentives` / `suppliable` / `borrowable` 四个字段在后端实际响应中不存在

### 3.2 第二版（当前）— 后端脚本自动生成

**数据流：**
```
serializeReserveForApi() (marketsApiSerialize.ts)
        ↓
generate-openapi.ts → backend/static/openapi.json
        ↓
swagger.ts → serve at GET /api/docs + /api/docs/openapi.json
```

**实现步骤：**
1. 创建 `backend/static/swagger.html`，url 指向 `/api/docs/openapi.json`
2. 创建 `backend/src/routes/swagger.ts`，两个 GET 路由
3. 在 `backend/src/server.ts` 中挂载 `app.use('/api/docs', swaggerRouter)`
4. 创建 `backend/scripts/generate-openapi.ts`：
   - 基于 `serializeReserveForApi()` 的实际输出字段定义 schema
   - 覆盖 `/markets` (GET) + `/meta/side-data` (GET) 两个公开端点
   - 不包含 SEO（admin-only）、health（内部运维）端点
5. 集成到构建流程：`npm run build` → `gen:schema-fp → gen:openapi → tsc`

### 3.3 已完成
- ✅ Swagger UI serve 基础设施（commit `1d7e920`）
- ✅ `generate-openapi.ts` 脚本，从后端自身类型体系生成 spec
- ✅ 构建流程集成（`gen:openapi` 作为 build 的一环）
- ✅ 测试通过（339/339）
- ✅ Linear issue AAV-325 已关闭

## 4. 验收标准
- 访问 `/api/docs` 显示 Swagger UI
- 访问 `/api/docs/openapi.json` 返回有效 JSON spec
- Railway 部署后 static 目录可正常访问

## 5. 维护说明
- `openapi.json` 由 `backend/scripts/generate-openapi.ts` 自动生成
- 新增 reserve 字段时，同步更新脚本中的 `RESERVE_PROPERTIES` 映射
- 运行 `npm run gen:openapi -w aave-dashboard-backend` 可单独重新生成
- 构建流程 `npm run build -w aave-dashboard-backend` 会自动执行生成步骤

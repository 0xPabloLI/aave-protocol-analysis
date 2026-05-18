# AAV-110 开发方案

## 1. Issue 概述
将 backend 目前依赖的 root build 产物（`dist/index.js` 中的共享类型如 `MarketsPayload`、`RuntimeReserveData`）拆分到独立的共享 package 中，消除 backend 对 root dist 的跨项目 import 耦合。完成后，backend 通过共享 package 引用类型定义，`fetchMarketsData` 的运行时调用改为从共享 fetcher 包引用，**不再 import root dist**。API 行为完全不变（cron-write/API-read-only 模式不受影响）。

## 2. 当前状态
- 共享类型（`RuntimeReserveData`、`MarketsPayload`）定义在 `src/index.ts`，通过 `dist/index.js` 导出
- `fetchMarketsData` 函数定义在 `src/index.ts`，包含 Aave SDK + Merit + Merkl + Brevis 数据聚合逻辑
- backend 有 3 处直接 import root dist：
  - `backend/src/services/marketsService.ts` — **值导入 + 类型导入**：`import { fetchMarketsData, type MarketsPayload, type RuntimeReserveData } from '../../../dist/index.js'`
  - `backend/src/services/persistenceService.ts` — 仅类型导入
  - `backend/tests/persistenceService.test.ts` — 仅类型导入
- 项目已有 `packages/aave-shared-config`（通过 `file:` 协议引用），无 npm workspaces 管理
- backend 当前是独立 npm 项目（独立 `backend/package.json` + `backend/package-lock.json` + 独立 `npm ci`），如果要彻底去掉 `file:` 协议，需要把 backend 也纳入 root workspace
- root fetcher 代码当前同时承担 library export 与 CLI 入口职责，`src/index.ts` 底部有直接运行逻辑和 `process.exit`
- `src/index.ts`、`src/merit-api.ts`、`src/merkl-api.ts` 通过模块相对路径推导 `data/` 目录；迁入 package 前必须固定数据目录解析规则，避免 artifact 路径漂移
- `marketsApiSerialize.ts` 是 backend 视图层映射（`RuntimeReserveData` → `MarketWithSpread`），应留在 backend

### 当前数据流（不可改变）
```
cron :00秒 → fetchMarketsData() → 内存快照 (snapshot)
API 请求   → getMarketsSnapshot() → 序列化 → JSON 响应
DB         → 纯归档（只 INSERT，0 个 SELECT），不参与 API 数据供给
```
**persistenceService 是纯写入（0 SELECT），DB 不参与 API 请求路径。** 任何方案都不能改变这一点。

## 3. 影响范围
- 根项目（`src/`）：类型定义迁移出、`fetchMarketsData` 迁移出、导入路径变更
- backend（`backend/src/`）：import 来源变更（从 root dist → 共享包）
- 共享层：新建 `packages/aave-shared-contracts`（类型）+ `packages/aave-fetcher`（数据抓取）
- 基建：npm workspaces 启用、backend 纳入 workspace、CI/Docker 构建顺序调整
- 测试：类型验证、字段覆盖测试迁移
- **API 行为**：完全不变，cron-write/API-read-only 模式不受影响

## 4. 实现方案

### 4.1 启用 npm workspaces
- 在根 `package.json` 添加：
  ```json
  {
    "workspaces": ["packages/*", "backend"]
  }
  ```
- 将 backend 正式纳入 root workspace，删除独立 `backend/package-lock.json`，统一使用 root `package-lock.json`
- root、backend、packages 内部依赖统一使用 workspace resolution，不再声明 `file:` 协议依赖
- 更新 root scripts、CI workflow、Dockerfile：
  - 安装依赖统一使用 root `npm ci`
  - backend 命令使用 workspace 形式（例如 `npm run build -w aave-dashboard-backend`）
  - 构建顺序使用显式脚本保障：`aave-shared-contracts` → `aave-fetcher` → root → backend
- 运行 `npm install` 重新生成 root lockfile，验证 hoisting 与 workspace symlink 行为正确

### 4.2 新建共享契约包 `packages/aave-shared-contracts`
- 包含：
  - **类型定义**：`RuntimeReserveData`、`MarketsPayload`、激励相关类型（`MeritAprEntry`、`MerklOpportunityGroup`、`BrevisCampaignItem`）
  - **字段注册表**：`EXPECTED_RUNTIME_FIELDS`（从 `src/types/runtime-validation.ts` 迁入）
  - **验证函数**：`validateRuntimeReserveShape`
  - **编译时类型检查辅助**：使用会真实触发 TS 错误的 equality assertion，而不是仅声明未使用的 type alias
- **依赖方向约束**：仅依赖标准库和 `@internal/aave-shared-config`，禁止依赖 root 或 backend
- 添加 package 基建：
  - `package.json`：`type: "module"`、`exports`、`types`、`files`
  - `tsconfig.json`：输出 `dist/` 与 declaration
  - `build` / `test` scripts
- **不放入的内容**：
  - ❌ 序列化逻辑（`marketsApiSerialize.ts`）— backend 视图层映射
  - ❌ `MarketWithSpread` — backend API 响应形状
  - ❌ `fetchMarketsData` — 数据抓取逻辑（放入 4.3 的 fetcher 包）

### 4.3 新建数据抓取包 `packages/aave-fetcher`
- **核心职责**：封装 `fetchMarketsData` 及其依赖链（Aave SDK、Merit/Merkl/Brevis API 客户端、token-price-resolver 等）
- 依赖 `@internal/aave-shared-contracts`（消费类型定义）
- 依赖 `@aave/client`、`@aave/client-v4`、`@aave-dao/aave-address-book` 等 SDK 包
- 导出：`fetchMarketsData` 函数及必要配置类型
- root 和 backend 都从此包引用 `fetchMarketsData`，而非从 root dist
- 必须保证 package import 无副作用：
  - `packages/aave-fetcher/src/index.ts` 只导出函数/类型，不执行抓取、不写文件、不调用 `process.exit`
  - CLI 入口单独放在 `packages/aave-fetcher/src/cli.ts` 或 root `src/cli.ts`
  - `checkAndReportSessionStatus()` 等运行时动作只在 `fetchMarketsData()` 被显式调用时发生
- 固定数据目录解析规则：
  - 新增 `getDataDir()` / `FETCHER_DATA_DIR` 配置，默认仍指向 app/repo 根目录下的 `data/`
  - 保持 `data/runtime`、`data/debug`、`data/exports` 的现有位置不变
  - backend runtime 与 root CLI 使用同一套目录解析，避免迁包后写入 `packages/aave-fetcher/data`
- 添加 package 基建：
  - `package.json`：`type: "module"`、`exports`、`types`、`files`
  - `tsconfig.json`：输出 `dist/` 与 declaration
  - `build` / `test` scripts

### 4.4 修改 root build
- 从 `src/index.ts` 移除 `RuntimeReserveData`、`MarketsPayload` 等类型定义，改为从 `@internal/aave-shared-contracts` import
- 从 `src/index.ts` 积除 `fetchMarketsData` 函数定义，改为从 `@internal/aave-fetcher` import 并 re-export（保持向后兼容）
- 拆分 root CLI 与 library entry：
  - `src/index.ts` 保持纯 library entry，只做 re-export，不包含直接运行逻辑
  - 新增/调整 `src/cli.ts` 承担原 `runMarketsFetcher()` 的命令行入口
  - root `package.json` 中 `main` 仍指向 `dist/index.js`，`dev`/`start` 改为运行 CLI entry
- `src/types/runtime-validation.ts` 改为从共享包 import 类型和 `EXPECTED_RUNTIME_FIELDS`
- 调整 `package.json`：添加对两个共享包的依赖

### 4.5 修改 backend 代码

#### 4.5.1 类型依赖迁移
- `persistenceService.ts` 和 `persistenceService.test.ts` 中的 `import type { MarketsPayload, RuntimeReserveData }` 改为从 `@internal/aave-shared-contracts` 引入
- `marketsApiSerialize.ts` 中的 `RuntimeReserveData` 类型改为从 `@internal/aave-shared-contracts` 引入
- `MarketWithSpread` 保留在 `backend/src/types/index.ts` 不变
- 处理间接类型消费者：
  - 短期可在 `marketsService.ts` 继续 re-export `MarketsPayload` / `RuntimeReserveData` 作为兼容层，但来源必须是 `@internal/aave-shared-contracts`
  - 或者一次性将 controllers/tests 中从 `marketsService.ts` 引入 runtime 类型的地方全部改为直接引入 `@internal/aave-shared-contracts`
  - 无论采用哪种方式，backend 内不得再通过 root `dist` 获得任何类型

#### 4.5.2 运行时依赖迁移（`fetchMarketsData`）
- `marketsService.ts` 中的 `import { fetchMarketsData, type ... } from '../../../dist/index.js'` 改为：
  - `import { fetchMarketsData } from '@internal/aave-fetcher'`
  - `import type { MarketsPayload, RuntimeReserveData } from '@internal/aave-shared-contracts'`
- **数据流不变**：cron 仍调用 `fetchMarketsData()` → 写入内存快照 → API 读取快照
- **API 行为不变**：`getMarketsSnapshot()` → 序列化 → JSON 响应，路径完全相同
- 只是 `fetchMarketsData` 的物理来源从 root dist 变为共享 fetcher 包

#### 4.5.3 序列化逻辑保留
- `marketsApiSerialize.ts` 保留在 backend，消费共享包的类型，产出 `MarketWithSpread`
- 添加编译时保障：利用共享包中的 runtime field registry 做字段覆盖检查，但不把 backend API 响应形状上移到共享包

### 4.6 构建和启动验证
- 更新 root、backend、packages 的 `package.json`，确保共享包作为 workspace 依赖正确安装
- **CI 构建顺序**：shared-contracts → aave-fetcher → root → backend（使用显式 script 保障顺序，不依赖隐式 workspace 排序）
- root `npm run build` 应先构建共享 packages，再构建 root；backend build 在 packages build 后执行
- Dockerfile 改为 workspace 安装/构建模型：
  - builder 阶段 root `npm ci`
  - build shared packages → root → backend
  - production 阶段 root `npm ci --omit=dev`，并复制 packages/root/backend 所需 dist 产物
- 运行 `npm run build`（根目录和 backend）验证构建无误
- 启动 backend 服务，确保正常运行且接口返回数据正确
- 验证 backend 中不再有任何 `import ... from '../../../dist/index.js'` 引用

### 4.7 测试覆盖更新
- 在 `aave-shared-contracts` 中添加：
  - 类型结构验证测试（`EXPECTED_RUNTIME_FIELDS` 覆盖度）
  - `validateRuntimeReserveShape` 函数测试
- 在 `aave-fetcher` 中添加：
  - package import side-effect 测试：import `@internal/aave-fetcher` 不执行 CLI、不调用 `process.exit`、不触发抓取
  - `fetchMarketsData` 集成 smoke test（验证返回结构符合 `MarketsPayload`），但应通过环境变量显式启用，避免普通 CI 因外部 API/Cloudflare/Puppeteer 波动而不稳定
- backend 的 `marketsApiSerialize` 测试不变（仍在 backend 内，类型来源改为共享包）
- 添加禁止 root dist import 的验证脚本：
  ```bash
  rg "dist/index\\.js|\\.\\.\\/\\.\\.\\/\\.\\.\\/dist" backend src tests
  ```
  该命令在验证中必须无结果
- 运行 `npm run ci:remote` 做全量验证
- 增加 `docker build` 验证，确保生产镜像中的 workspace package resolution 正常

### 4.8 文档更新
- 在项目文档中补充架构边界说明：
  - `aave-shared-contracts`：类型定义 + 字段注册表 + 验证函数
  - `aave-fetcher`：数据抓取逻辑（`fetchMarketsData` 及依赖链）
  - 依赖方向：shared-contracts ← aave-fetcher ← root/backend（单向）
  - 序列化逻辑归属：backend 视图层
- 说明 root build 与 backend 之间的依赖关系调整
- 更新 AGENTS.md 中 "Required Coupled Changes" 部分

## 5. 依赖关系
- 无直接依赖其他 Issue，但建议同步关注 AAV-113（src/lib refactor）以避免重复改动
- 本方案**不改变** cron-write/API-read-only 模式和 DB 纯归档角色

## 6. 验收标准
- ✅ 共享类型及字段注册表成功拆分到 `packages/aave-shared-contracts`
- ✅ `fetchMarketsData` 及依赖链成功拆分到 `packages/aave-fetcher`
- ✅ backend **不再有任何** `import ... from '../../../dist/index.js'` 引用（包括类型和值导入）
- ✅ `@internal/aave-fetcher` import 无副作用：不会执行 CLI、不会调用 `process.exit`、不会主动抓取或写文件
- ✅ root CLI 与 library entry 已拆分，`src/index.ts` 保持纯 re-export 入口
- ✅ `data/runtime`、`data/debug`、`data/exports` 路径保持在现有 app/repo 根目录下，不因迁包漂移
- ✅ `npm run build` 后 backend 能正常启动且接口正常响应
- ✅ API 行为完全不变（cron-write/API-read-only 模式、数据流路径、响应格式均不变）
- ✅ 共享包依赖方向为单向：shared-contracts ← aave-fetcher ← root/backend
- ✅ npm workspaces 启用，backend 纳入 workspace，不再使用 `file:` 协议引用共享包，root lockfile 统一管理依赖
- ✅ CI 和 Dockerfile 使用 workspace 安装/构建模型，构建顺序明确为 shared-contracts → aave-fetcher → root → backend
- ✅ 相关测试覆盖完整且通过（`npm run ci:remote`）
- ✅ 禁止 dist import 检查无结果：`rg "dist/index\\.js|\\.\\.\\/\\.\\.\\/\\.\\.\\/dist" backend src tests`
- ✅ `docker build` 通过，生产镜像中 workspace package resolution 正常
- ✅ 项目文档中有明确架构边界描述

## 7. 复杂度评估
- Medium-High
  理由：需新建两个共享包（契约 + fetcher），fetcher 包包含 SDK 依赖和外部 API 调用链，迁移时需保证 import 路径和运行时行为不变。npm workspaces 正式化和 CI 构建顺序调整增加基建复杂度。类型兼容通过编译时保障和运行时测试双重验证。

## 8. Review 修正记录

| # | 问题 | 修正 |
|---|---|---|
| P0 | `fetchMarketsData` 运行时依赖未处理 | v1 错误地提出"通过 persistenceService DB 读取"解耦（DB 是纯归档，0 SELECT）。v2 修正：将 fetchMarketsData 迁入独立 fetcher 包，backend 从包引用，数据流和 API 行为不变 |
| P1 | 序列化逻辑不应放入共享包 | 4.2 明确标注不放入内容；4.5.3 保留在 backend |
| P2 | 应正式化 npm workspaces | 新增 4.1 小节，优先启用 workspaces |
| P3 | 共享包依赖方向未约束 | 4.2 + 4.3 添加依赖方向约束 |
| P4 | 类型同步缺少编译时保障 | 4.5.3 添加编译时保障；4.2 迁入字段注册表和验证函数 |
| P5 | v1 方案会改变 API 行为 | v2 明确"API 行为完全不变"为验收标准；persistenceService 保持纯归档角色 |
| P6 | workspace 范围未覆盖 backend | 4.1 修正为 `["packages/*", "backend"]`，统一 root lockfile，删除 backend 独立 lockfile |
| P7 | fetcher 迁包会导致 `data/` 路径漂移 | 4.3 新增稳定数据目录解析规则，保持 `data/runtime`、`data/debug`、`data/exports` 现有位置 |
| P8 | `src/index.ts` 同时是 CLI 和 library entry，存在 import 副作用风险 | 4.3 + 4.4 新增 CLI/library 拆分要求与 import side-effect 测试 |
| P9 | packages 构建、CI、Docker 细节不足 | 4.2、4.3、4.6 补充 package build 基建、显式构建顺序、Docker workspace 构建模型 |
| P10 | 验证缺少禁止 root dist import 与 Docker 覆盖 | 4.7 + 验收标准新增 `rg` 检查和 `docker build` 验证 |

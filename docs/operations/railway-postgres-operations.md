# Railway PostgreSQL 运维手册

## 密码轮换

### 原则

**永远不要手改 `POSTGRES_PASSWORD` / `PGPASSWORD`，也不要执行 `ALTER USER`。**
两者都只改单边，会让数据库内密码与 Railway 变量失去同步（见踩坑记录 2026-05-10）。
唯一受支持的方式是 **Regenerate**（Dashboard），或其 API 等价物 `databasePasswordReset`。

### 为什么手改会坏

Railway 通过代理层（`railway connect`）建立到 PostgreSQL 的隧道，代理层用
`POSTGRES_PASSWORD` 认证。手改任一侧会导致：

1. 数据库密码与 `POSTGRES_PASSWORD` 不一致 → 代理隧道认证失败
2. 应用连不上（连接串里是旧密码）
3. 下一次重新部署时，Docker entrypoint 会尝试用 `POSTGRES_PASSWORD` 重设密码，可能与现有密码冲突

### 步骤

Regenerate 会一次性完成：改数据库内密码 + 更新该服务的变量 + **重启数据库（踢掉所有旧会话）**。

**方式 A：Dashboard**

Postgres-15fr → **Database** 标签 → **Config** → Connection → **Regenerate**

**方式 B：GraphQL API（可脚本化，2026-11-09 验证通过）**

```bash
curl -s -X POST https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation($input: DatabasePasswordResetInput!) { databasePasswordReset(input: $input) { newPassword rotationInProgress updatedVariables } }",
       "variables":{"input":{"databaseType":"postgres","environmentId":"<ENV_ID>","serviceId":"<PG_SERVICE_ID>"}}}'
```

`databaseType` 必须是 `postgres`，**不是** `postgresql`（后者返回 `BAD_USER_INPUT`，无副作用）。
响应里的 `updatedVariables` 含新的 `DATABASE_URL` / `DATABASE_PUBLIC_URL` / `PGPASSWORD` 等。

### ⚠️ 轮换后必须手动同步的消费者

**`DATABASE_URL` 是字面值，不是引用变量。** 2026-11-09 用 Railway GraphQL 核对过：
应用服务的 `DATABASE_URL` 与 Postgres 服务的 `DATABASE_URL` 逐字节相同，且不含 `${{ }}` 引用语法。
所以它**不会**随 Postgres 服务自动更新——以下三处必须手动同步：

| 消费者                        | 位置                                         | 为什么                                                       |
| ----------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| 应用服务 `DATABASE_URL`       | Railway → aave-protocol-analysis → Variables | 存的是写死的连接串，不会自动跟随                             |
| `DATABASE_URL_PUBLIC_STAGING` | GitHub repo secret                           | 每日备份 `db-backup.yml` 用它做 `pg_dump`（走公网 TCP 代理） |
| 本地 `.env`                   | 仅当指向 staging 时才需要                    | 默认是 localhost 占位符，通常无需改动                        |

同步完成后重新部署应用服务（容器只在启动时读环境变量）。

### 验证

```bash
# 1. 新凭据能连（公网通道）
psql "$DATABASE_PUBLIC_URL" -c "SELECT 'auth_ok', current_user;"

# 2. 应用侧无认证失败
railway logs --lines 400 | grep -ci 'password authentication failed'   # 期望 0

# 3. 应用真的在写库（关键证据，不只是"没报错"）
psql "$DATABASE_PUBLIC_URL" -c "SELECT relname, n_tup_ins FROM pg_stat_user_tables
  WHERE relname IN ('market_snapshots','side_data_snapshots');"

# 4. 备份链路（验证 GitHub secret 已同步）
gh workflow run db-backup.yml && gh run list --workflow=db-backup.yml --limit 2
```

## 数据库迁移

### 原则

Railway 不会自动运行 `backend/migrations/` 中的 SQL 文件。每次修改数据库结构后，必须手动执行迁移。

### 步骤

```bash
# 1. 获取 DATABASE_URL（公网通道，用于外部执行迁移）
railway variables --service Postgres-15fr --environment staging --json | jq -r '.DATABASE_PUBLIC_URL'

# 2. 执行迁移（通过公网代理连接）
psql "$DATABASE_PUBLIC_URL" -f backend/migrations/XXX_description.sql
```

## 数据库直连（查数据/调试）

```bash
# 方式 1：交互式隧道（CLI 负责认证，不需要手抄密码）
railway connect Postgres-15fr --environment staging

# 方式 2：直接用公网连接串（密码从 Railway 读取）
psql "$(railway variables --service Postgres-15fr --environment staging --json | jq -r '.DATABASE_PUBLIC_URL')"
```

## SSL 配置

### Backend → PostgreSQL 连接

由 [dbPool.ts](../../backend/src/services/dbPool.ts) 的 `resolveSslConfig()` 控制。

**生产环境不设置 `DATABASE_SSL`**，依赖默认行为：

| 场景                              | 默认行为                   |
| --------------------------------- | -------------------------- |
| Remote（Railway 内网 / 公网代理） | SSL 开启（接受自签名证书） |
| Localhost                         | SSL 关闭                   |

`DATABASE_SSL` 仅作为紧急调试开关保留在代码中，生产环境不设置。

## CI 安全审计

### 排除已知无法修复的漏洞

`elliptic` 依赖（GHSA-848j-6mx2-7j84）来自 `ethers@5`，无可用修复版本。排除规则位于共享脚本：

- [package.json](../../package.json) → `"audit"` 脚本 — **单一真相来源**
- 本地 pre-commit/pre-push hook → `npm run ci:remote` → 调用 `npm run audit`
- GitHub Actions → [ci.yml](../../.github/workflows/ci.yml) → `npm run audit`

只需在一处维护排除规则。

## 已知踩坑记录

### 2026-05-10: ALTER USER 破坏 railway connect

- 原因：用 `ALTER USER postgres WITH PASSWORD` 修改密码，导致 DB 密码与 `POSTGRES_PASSWORD` 环境变量不一致
- 后果：`railway connect` 代理隧道认证失败
- 修复：同步 `POSTGRES_PASSWORD` 到当前 DB 密码，触发 PostgreSQL 重新部署

### 2026-05-10: 迁移未执行导致持久化写入失败

- 原因：`railway up` 部署了新代码（期望拆分后的表结构），但迁移 002+003 未手动执行
- 影响：`market_configs` 表不存在 → `persistSnapshots` 在写入 `market_snapshots` 后报错，跳过 `oracle_prices` 写入
- 表现：`market_snapshots` 仍有新数据写入，但 `oracle_prices` 在部署后停止更新
- 修复：手动执行迁移 002 + 003

### 2026-11-09: `DATABASE_URL` 是字面值，不是引用变量（文档曾误记为引用）

- 原因：本手册原写"Backend 的 DATABASE_URL 使用了 `${{postgres-mdwg.DATABASE_URL}}` 引用变量，无需手动更新"
- 实际：用 GraphQL `variables()` 核对原始模板，**不含 `${{ }}` 引用语法**，应用服务存的是写死的连接串
- 后果（若照旧文档操作）：轮换 Postgres 密码后应用仍持旧密码，且不会有任何编译期报错
- 修复：轮换流程中把应用 `DATABASE_URL` 与 GitHub secret `DATABASE_URL_PUBLIC_STAGING` 列为必改项（见「密码轮换」）
- 附带修正：本手册及 `AGENTS.md` 中引用的数据库服务名 `postgres-mdwg` 已不存在，实际为 `Postgres-15fr`

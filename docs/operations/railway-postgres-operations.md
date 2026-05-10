# Railway PostgreSQL 运维手册

## 密码轮换

### 原则

**永远不要对 Railway PostgreSQL 执行 `ALTER USER`。** 只通过 Railway 环境变量 + 重新部署来修改密码。

### 为什么

Railway 通过代理层 (`railway connect`) 建立到 PostgreSQL 的隧道。代理层使用 `POSTGRES_PASSWORD` 环境变量进行认证。如果用 `ALTER USER` 直接修改数据库密码：

1. 数据库密码变化，但 `POSTGRES_PASSWORD` 环境变量不变
2. 代理层仍用旧密码认证 → 连接失败
3. 应用层可能用了硬编码密码 → 也能连上但密码不一致
4. 下一次重新部署时，Docker entrypoint 会尝试用 `POSTGRES_PASSWORD` 重设密码，可能与现有密码冲突

### 步骤

```bash
# 1. 生成新密码（32 位字母数字）
NEW_PASSWORD=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32)

# 2. 轮换密码（设置环境变量 → PostgreSQL 自动重新部署）
railway variables set POSTGRES_PASSWORD="$NEW_PASSWORD" \
  --service postgres-mdwg --environment staging

# 3. 等待 PostgreSQL 重新部署完成（约 1-2 分钟）

# 4. Backend 的 DATABASE_URL 使用了 ${{postgres-mdwg.DATABASE_URL}} 引用变量
#    所以 Backend 会自动获取新密码，**无需手动更新**

# 5. 验证连接
railway connect postgres-mdwg --environment staging
```

## 数据库迁移

### 原则

Railway 不会自动运行 `backend/migrations/` 中的 SQL 文件。每次修改数据库结构后，必须手动执行迁移。

### 步骤

```bash
# 1. 获取 DATABASE_URL
railway variables get DATABASE_URL --service postgres-mdwg --environment staging

# 2. 执行迁移（通过公网代理连接）
PGPASSWORD='<password>' psql "postgresql://postgres:<password>@turntable.proxy.rlwy.net:17469/railway?sslmode=require" \
  -f backend/migrations/XXX_description.sql
```

## 数据库直连（查数据/调试）

```bash
# 启动代理隧道
railway connect postgres-mdwg --environment staging

# 在另一个终端
PGPASSWORD='<password>' psql "postgresql://postgres:<password>@localhost:5432/railway"
```

## SSL 配置

### Backend → PostgreSQL 连接

由 [dbPool.ts](../../backend/src/services/dbPool.ts) 的 `resolveSslConfig()` 控制。

**生产环境不设置 `DATABASE_SSL`**，依赖默认行为：

| 场景 | 默认行为 |
|---|---|
| Remote（Railway 内网 / 公网代理） | SSL 开启（接受自签名证书） |
| Localhost | SSL 关闭 |

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
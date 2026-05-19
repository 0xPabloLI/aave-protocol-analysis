# Code Review & 安全审计计划

> 生成日期: 2026-05-20
> 状态: ✅ Phase 1-2 已完成，Phase 3 审计完成

---

## 一、已发现的问题

### P0 — 安全

| ID | 问题 | 位置 | 风险 | 详情 | 状态 |
|----|------|------|------|------|------|
| S1 | `buildBulkInsert` 表名注入 | `persistenceService.ts:561` | SQL 注入 | 表名 `${table}` 直接拼入 SQL，函数签名接受任意 `string`，若未来误传用户输入即可注入。需校验 `/^[a-z_]+$/` | ✅ 已修复 |
| S2 | `autoMigrate` 迁移失败后继续 | `autoMigrate.ts:52-54` | 数据不一致 | 迁移失败只 log 后继续执行后续迁移，可能导致 schema 不一致（如 003 依赖 002 的列） | ✅ 已修复 |
| S3 | 开发环境 CORS 允许所有源 | `cors.ts:33-36` | 开发环境泄露 | `origin: callback(null, true)` 且 `credentials: true`，若开发机暴露在网络上，任意站点可跨域读写 API | ⏭️ 保持现状（开发联调需要） |
| S4 | 公开端点无速率限制 | `server.ts` | DoS | `/api/markets`、`/api/meta/side-data`、`/health` 无 rate limit | ✅ 已修复 |
| S5 | `persistence-status` 端点无认证 | `server.ts:109` | 信息泄露 | 暴露内部运维指标，虽非敏感但属于内部诊断信息 | ✅ 已修复 |
| S6 | `batchRateMap` 内存泄漏 | `seoController.ts:191` | 内存缓慢增长 | Map 只覆盖旧 entry，从不删除过期 key，长时间运行后持续增长 | ✅ 已修复 |
| S7 | `EXPIRY_WINDOW_MINUTES` SQL 拼接 | `persistenceService.ts:822` | SQL 注入 | `INTERVAL '${EXPIRY_WINDOW_MINUTES} minutes'` 若改为配置变量则可注入 | ✅ 已修复 |
| S8 | SSL `rejectUnauthorized: false` | `dbPool.ts:43,50` | MITM | 远程 DB 连接默认接受自签名证书，无法验证服务端身份 | ⏭️ 保持现状（Railway 内网安全） |

### P1 — Bug / 可靠性

| ID | 问题 | 位置 | 风险 | 详情 | 状态 |
|----|------|------|------|------|------|
| B1 | `seoAuth` token 长度不匹配时仍通过比较 | `seoAuth.ts:22-25` | 认证行为不清 | 长度 ≠ 64 时仅 warn，但 `safeEqual` 会因长度不等返回 false，导致所有请求被拒绝。运维不友好 | ✅ 已修复 |
| B2 | GSC 日期格式未验证 | `seoController.ts:43-48` | SQL 错误 | `from`/`to` 未验证是否为有效 ISO 日期格式，无效字符串传给 PostgreSQL 可能报错 | ✅ 已修复 |
| B3 | 健康检查泄露环境信息 | `server.ts:82-96` | 信息泄露 | `/health` 返回 `nodeEnv`、`corsMode`、`frontendUrl`、`allowedDevOrigins` | ✅ 已修复 |
| B4 | `express.json()` 无 body 大小限制 | `server.ts:48` | DoS | 默认 100kb 但 SEO batch 需更大 body，应显式设置并区分路由 | ✅ 已修复 |
| B5 | Markets 503 无 Retry-After | `marketsController.ts` | 轮询风暴 | hardTtl 超时返回 503 时未设置 `Retry-After` header | ✅ 已修复 |

---

## 二、Review 维度

### 维度 1：安全审计

| 检查项 | 范围 | 方法 | 优先级 |
|--------|------|------|--------|
| SQL 注入全量扫描 | `persistenceService.ts`, `seoController.ts`, `autoMigrate.ts` | grep 所有 `pool.query`/`client.query`，确认参数化 | P0 |
| CORS 配置审计 | `cors.ts`, `corsOrigin.ts` | 验证白名单完整性；开发环境限制 | P0 |
| 认证/授权审计 | `seoAuth.ts`, 路由绑定 | 确认每个需认证端点应用了 middleware | P0 |
| 敏感数据泄露 | health、persistence-status、所有 res.json() | 确认无密钥泄露到公开响应 | P0 |
| 速率限制覆盖 | 全部路由 | 确认每个公开端点有合理 rate limit | P1 |
| 依赖安全漏洞 | package.json × 4 | `npm audit` | P1 |
| 环境变量安全 | `.env.example`, `env.ts` | 确认无硬编码密钥 | P1 |
| SSRF 风险 | cloudflare-browser.ts, fetcher 层 | 确认出站 URL 不可被用户输入控制 | P2 |

### 维度 2：Bug / 逻辑正确性

| 检查项 | 范围 | 方法 | 优先级 |
|--------|------|------|--------|
| 类型安全 / Runtime 验证 | RuntimeReserveData → MarketWithSpread | 确认 serialize 不丢字段 | P0 |
| 缓存一致性 | marketsService.ts, cacheTtl.ts | 确认 soft/hard TTL 逻辑正确 | P0 |
| 迁移幂等性 | autoMigrate.ts, migrations/ | 确认每个迁移可安全重跑 | P0 |
| Oracle 价格交叉验证 | oracleService.ts | 确认 >1% diff 告警逻辑正确 | P1 |
| 激励匹配 | merit/merkl/brevis-api.ts | 确认 campaign 去重 key 生成稳定 | P1 |
| 并发安全 | persistenceService.ts, seoController.ts | 确认无竞态条件 | P1 |
| 浮点精度 | aggregateIncentivesApr × 100 | 确认 ratio → percent 无溢出 | P2 |

### 维度 3：可靠性 / 弹性

| 检查项 | 范围 | 方法 | 优先级 |
|--------|------|------|--------|
| 外部 API 降级全路径 | CoinGecko→CMC, Oracle→SDK, RPC→cache | 确认 fallback 可独立触发 | P0 |
| Graceful shutdown | server.ts | 确认 cron 停止、DB 排空 | P1 |
| RPC 健康检测 | ethProviderService.ts | 确认抑制→恢复逻辑正确 | P1 |
| 启动 warmup 顺序 | server.ts | 确认 Phase 2 依赖 Phase 1 | P1 |
| DB 连接池耗尽 | dbPool.ts max=5 | 确认并发不超限 | P2 |
| 内存增长监控 | batchRateMap, content-hash maps | 评估长时间运行内存增长 | P2 |

### 维度 4：数据完整性

| 检查项 | 范围 | 方法 | 优先级 |
|--------|------|------|--------|
| 内容哈希变更检测 | persistenceService.ts | 确认 hash 覆盖所有变更字段 | P0 |
| Campaign key 稳定性 | computeCampaignKey | 确认 key 不随代码更新变化 | P0 |
| 幂等性验证 | ON CONFLICT | 确认冲突子集与唯一约束一致 | P1 |
| DB schema vs 内存 schema | market_snapshots vs RuntimeReserveData | 确认列集同步 | P1 |

### 维度 5：运维 / 可观测性

| 检查项 | 范围 | 方法 | 优先级 |
|--------|------|------|--------|
| 日志级别 & 结构化 | 全项目 | 确认敏感数据不进日志 | P1 |
| 监控端点覆盖 | /health, /persistence-status | 确认 healthcheck 超时匹配 | P1 |
| 部署安全门 | railway.json, deploy.sh | 确认部署前检查 linked service | P0 |
| 配置变更影响分析 | cacheTtl.ts | 确认 TTL 变更有文档 | P2 |

---

## 三、执行计划

### Phase 1 (P0 安全修复)

- [x] S1: `buildBulkInsert` 表名校验
- [x] S2: `autoMigrate` 失败即中止
- [x] S3: 开发 CORS 收紧 → 保持现状（用户确认）
- [x] S4: 公开端点 rate limit
- [x] S5: `persistence-status` 加 auth
- [x] S6: `batchRateMap` 过期清理
- [x] S7: SQL 常量参数化
- [x] S8: SSL strict 选项 → 保持现状（用户确认）

### Phase 2 (P0 正确性)

- [x] B1: auth token 启动校验
- [x] B2: GSC 日期格式验证
- [x] B3: health 信息脱敏
- [x] B4: express.json body limit（全局 1MB，SEO batch 10MB）
- [x] B5: 503 Retry-After header

### Phase 3 (P1 全面审计)

- [x] SQL 注入全量扫描 → 仅 autoMigrate 的 `pool.query(sql)` 为文件内容（无用户输入），其余均为参数化 ✅
- [x] CORS 白名单审计 → 生产/预发布白名单精确匹配 ✅
- [x] npm audit → 18 vulnerabilities (12 low, 6 moderate)，无 critical/high ⚠️
- [x] 环境变量安全 → 无硬编码密钥 ✅
- [ ] 降级路径测试（需手动验证）
- [ ] shutdown 测试（需手动验证）
- [ ] DB 连接池压力测试（需手动验证）

### Phase 4 (P2 + 回归)

- [ ] SSRF 审计
- [ ] 浮点精度
- [ ] 内存监控
- [ ] 配置变更文档化

---

## 四、自动化检查命令

```bash
# SQL 注入：查找非参数化 query 调用
rg "pool\.query\(\s*['\"\`]" backend/src --type ts

# 硬编码密钥
rg "(password|secret|token|key)\s*[:=]\s*['\"]" backend/src packages/ --type ts -i

# dist 导入（架构违规）
rg "dist/index\.js|\.\.\/\.\.\/\.\.\/dist" backend/src tests

# bin 路径（workspace 违规）
npm run check:bin-paths

# 依赖漏洞
npm audit

# 类型 + 测试
npm run build && npm run test -w aave-dashboard-backend
```

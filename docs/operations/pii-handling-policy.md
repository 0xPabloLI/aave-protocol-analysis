# PII 处理策略

本文声明本服务（backend，Aave 数据聚合与 API 服务）在**日志与分析事件**两条通道上的
个人数据（PII）边界、执行点与残留风险。AAV-1290 要求「analytics 事件与日志无文档化的
PII 边界声明」——本文即该声明。

范围：`backend/` 进程产生的日志与分析事件。前端（`aaveapy`）不在范围内。数据库不在范围内：
库为**纯归档**（写入快照、0 次 SELECT），存的是 Aave 储备与激励快照，不存任何用户数据。

## 1. 通道清单与其中的个人数据

| 通道            | 落盘位置                                                              | 实际写入的字段                                              | 是否含 PII            |
| --------------- | --------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------- |
| 主日志          | `backend/logs/combined.log`、`error.log`（5MB × 5 轮转）              | 业务日志 + 结构化 meta                                      | 见下「404 访问日志」  |
| 404 访问日志    | 同上                                                                  | `{ method, path, ip, ua }`                                  | **是**：客户端 IP     |
| 分析事件        | `backend/logs/analytics.log`（5MB × 3 轮转）                          | `event` + `{ requestId, method, path, status, durationMs }` | 否                    |
| Prometheus 指标 | `GET /metrics`（`METRICS_ENABLED` 控制，**默认 true**；该端点无鉴权） | 标签仅 `method` / `route` / `status`                        | 通常否，见残留风险 R3 |
| Sentry          | 外部（`SENTRY_DSN` 未设时休眠）                                       | 错误事件                                                    | 见 §3 执行点          |
| 请求关联 ID     | 响应头 `X-Request-ID` + 日志 + Sentry tag                             | 服务端生成的 UUID                                           | 否                    |

代码位置：访问日志 `backend/src/server.ts` 的 404 catch-all 处理器；分析事件
`backend/src/analytics.ts` 的 `trackEvent`，唯一调用点是
`backend/src/middleware/metrics.ts`；Sentry 初始化 `backend/src/instrumentation.ts`。

## 2. 边界规则

1. **分析事件不得携带 PII。** `trackEvent` 的字段集是「标识符 + 路由事实」：
   服务端生成的 requestId、HTTP 方法、Express 路由（不是原始 URL）、状态码、耗时。
   当前唯一的调用点即此五项。新增字段前必须先对照本表。
2. **IP 只出现在 404 访问日志，用途限爬虫/扫描监控。** 不进入分析事件，不进指标标签。
3. **凭据一律不进日志元数据。** 即使 §3 的闸门能兜住，也不以此为由往里传 token、
   API key 或带凭据的 URL。
4. **UA 是截断值。** 访问日志截到 120 字符（`MAX_UA_LEN`）并把 `\r`/`\n` 替换为 `_`，
   避免日志注入；不是完整的客户端指纹。
5. **不记录请求体与查询串。** 全仓无任何把 `req.body` / `req.query` 写入日志的代码。

## 3. 执行点（这些保证由什么兜住）

- **`scrubFormat`**（`backend/src/logger.ts`）：既是键名红名单（`authorization`、`token`、
  `apiKey`、`password`、`cookie`、`dsn` 等，大小写不敏感），也是对自由文本的模式清洗
  （`scheme://user:pass@`、Bearer、JWT、`?token=`/`?apikey=`、`sk-`/`ghp_`/`github_pat_` 前缀）。
  它**原地改写** `info`——重建对象会丢 triple-beam 的符号键，导致所有 transport 静默丢弃
  日志（0076c92 曾造成此事故，AAV-1290 修复）。
- 该 format 被三条链路共用：主日志 `logFormat`、控制台 `consoleFormat`、
  **分析 `analyticsFormat`**（`backend/src/analytics.ts`）。分析通道是独立 winston 实例、
  独立文件，曾是唯一没有闸门的通道（AAV-1290 前会把凭据原文写入 `analytics.log`）。
- `scrubFormat` 在主日志链中必须排在 `splat()` **之后**：`logger.info(msg, meta)` 的 meta
  由 splat 并入记录，排在前面会整段绕过清洗。
- **Sentry**：`sendDefaultPii: false`，并在 `beforeSend` 中显式删除
  `authorization` 与 `cookie` 请求头（纵深防御）。
- **回归测试**：`backend/tests/logScrubbing.test.ts` —— 覆盖键名红名单、嵌套/数组、
  自由文本模式、主日志 format、控制台 transport、分析通道，以及「真实
  `logger.info` 必须穿过 transport 等级门禁并脱敏到达」这一条（唯一能抓住 LEVEL 丢失的测试）。

## 4. 保留期

主日志与分析日志均为**按大小轮转 + 固定份数**（主日志 5MB × 5、分析 5MB × 3），
没有基于时间的 PII 保留窗口或删除流程。轮转文件位于容器/主机本地目录，不外发。

## 5. 残留风险

| 编号 | 风险                                                                                                                                        | 现状与建议                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | 404 访问日志中的 IP **完整保留、未做匿名化**                                                                                                | 保留原样是刻意的（爬虫封禁需要可定位来源），但需接受：R1 是本服务唯一的常规 PII 落盘。若合规要求更严，可在 `sanitizeForLog` 处加末位截断                                                                         |
| R2   | 键名红名单是「已知坏名字」清单                                                                                                              | 凭据若挂在未登记的键名且值也不匹配任何模式，不会被兜住。约定见 §2 规则 3：不依赖闸门，而是不传                                                                                                                   |
| R3   | 未匹配到路由的请求，`route` 标签回落为 `req.path`（原始路径）                                                                               | `backend/src/middleware/metrics.ts` 中 `req.route?.path ? … : req.path`。路径里若嵌了地址，会作为指标标签与 `analytics.path` 出现。当前公开 API 无此类路径；若未来新增按地址寻址的端点，需把该端点显式注册为路由 |
| R4   | 分析事件的**字段集还没有第二个接入方**来检验这条边界                                                                                        | `analyticsEnabled` 默认 true，每个完成的请求都会写一条 `api_request`；当前只有 `middleware/metrics.ts` 一个调用点，所以字段集此刻是收敛的。本节的规则正是为了让下一个接入方不必重新推导边界                      |
| R5   | `GET /metrics` **无鉴权**，且 `metricsEnabled` 默认 true（`backend/src/server.ts` 中 `app.get("/metrics", metricsHandler)` 未挂任何中间件） | 这不构成 PII 泄漏（标签是非个人数据），但确实是对公网暴露的内部指标面。超出本文范围，仅登记以便单独评估                                                                                                          |

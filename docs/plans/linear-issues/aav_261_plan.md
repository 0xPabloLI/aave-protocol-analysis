# 开发方案：AAV-261 Oracle Price 异常告警（纯后端日志方案）

## 1. Issue 概述
当 oracle 价格与 SDK 价格差异超过阈值时，后端输出结构化告警日志，便于通过日志系统检测和每日汇总推送，及时发现价格异常风险。不增加生产 API 字段，不增加后端计算负担，前端无需改动。

## 2. 方案选型

| 路径 | 方案 | 优点 | 缺点 | 选择 |
|------|------|------|------|------|
| 1 | 纯日志 | 零 API 变动，零前端改动，复用已有 diff 判断 | 需日志汇总机制 | **✅ 选定** |
| 2 | API 新增字段 | 前端可实时展示 | 增加 API 负担，需前端改动 | ❌ |
| 3 | 独立 cron + 存储 | 可持久化、可查询 | 新增基础设施，复杂度高 | ❌ |

## 3. 当前状态
- **后端已有 oracle diff 对比逻辑**：`marketsService.ts:338-363`，当 oracle 与 SDK 价格差异 > 1%（硬编码 `0.01`）时覆盖 `tokenPrice`，但**静默替换无告警**。
- **已有类似告警模式**：`coingeckoController.ts:303-306` 的 FDV diff alert，用 `logger.warn` + emoji 前缀。
- **日志框架**：Winston，通过 `backend/src/logger.ts` 导出单例，支持结构化 meta。

## 4. 影响范围
- **后端**：`aave-protocol-analysis/` railway 分支
- **前端**：无改动

## 5. 实现方案

### 5.1 后端改动（约 15 行）

#### 5.1.1 加告警日志
在 `backend/src/services/marketsService.ts` 行 359 的 `if (diff > 0.01)` 分支内加 `logger.warn`，参考已有 FDV diff alert 模式：

```typescript
logger.warn('⚠️ Oracle price anomaly', {
  chainId,
  reserveId: reserve.id,
  asset: reserve.symbol,
  oraclePrice: oraclePriceUsd,
  sdkPrice: tokenPriceUsd,
  diffPercent: (diff * 100).toFixed(2) + '%',
  market: reserve.market,
});
```

#### 5.1.2 阈值提取到 config（可选）
在 `backend/src/config.ts` 新增 `oracleDiffThreshold`，默认 `0.01`，替换硬编码。

### 5.2 每日汇总推送（GitHub Actions cron）
- 每日 UTC 06:00 触发 GitHub Actions workflow
- 用 `railway logs --filter "Oracle price anomaly"` 提取过去 24h 告警
- 格式化为 Markdown 摘要，通过 Slack webhook 或 Linear comment 推送
- 无告警时跳过推送

### 5.3 前端改动
**无**。前端不展示 oracle price diff，不新增 API 字段。

## 6. 测试
- 后端单元测试覆盖 `logger.warn` 调用（spy on logger）
- 集成测试确认 diff > threshold 时日志输出正确 meta
- E2E 确认 API 响应结构无变化

## 7. 验收标准
- oracle diff > 1% 时，后端日志输出结构化告警（含 chainId、reserveId、diffPercent 等）
- 生产 API 响应结构**无变化**（不新增字段）
- 阈值可通过 config 配置
- GitHub Actions cron 每日汇总可运行
- 前端无改动、无回归

## 8. 复杂度评估
- **Low**
- 理由：仅加 1 处 `logger.warn` + 可选阈值提取 + cron 配置，核心改动约 15 行。

## 9. 后续可演进方向
- 若需前端实时展示，可新增 API 字段（路径 2）
- 若需历史查询，可加 cron + 存储（路径 3）
- 可将阈值暴露到前端 Settings 面板

---

此方案通过最小化改动（纯日志），在不增加生产环境负担的前提下实现 oracle price 异常告警。

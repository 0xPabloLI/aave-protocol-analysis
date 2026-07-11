# Handoff: AAV-261 Oracle Price Anomaly 告警

## 目标

在后端已有 oracle 价格对比逻辑中增加 `logger.warn`，使价格异常可通过日志聚合被感知，再配一个轻量每日汇总推送。

**不修改生产 API schema，不增加新字段，不增加新定时任务。**

---

## 当前状态

### 后端已有逻辑

- **文件**: `aave-protocol-analysis/backend/src/services/marketsService.ts` 行 338-363
- **行为**: 当 oracle 价格与 SDK 价格差异 > 1%（硬编码 `0.01`）时，覆盖 `reserve.tokenPrice` 为 oracle 价格
- **问题**: 超阈值时静默替换，无 warn 日志，无通知
- **Oracle 刷新**: 与 markets 数据聚合在同一 pipeline，缓存 TTL 60s（`oracleTtlMs = 60_000`），无额外开销

### 日志框架

- **Winston**，通过 `backend/src/logger.ts` 导出单例
- 支持 info/warn/error/debug 四级 + 文件轮转（combined.log 5MB × 5 files）
- 使用方式: `logger.warn({ ...meta }, 'message')`

### 现有类似模式参考

- `coingeckoController.ts:303-306` 已有 FDV diff 告警模式：
  ```typescript
  if (Math.abs(diffPct) >= FDV_DIFF_ALERT_THRESHOLD_PCT) {
    logger.warn(`⚠️ FDV parity alert for ${cmcItem.id}: CMC=..., CoinGecko=..., diff=...%`);
  }
  ```

---

## 实现步骤

### Step 1: 在 marketsService.ts 加 warn 日志

**文件**: `aave-protocol-analysis/backend/src/services/marketsService.ts`

在行 359 `if (diff > 0.01)` 分支内，替换价格之前加一行 warn：

```typescript
if (diff > 0.01) {
  logger.warn(
    {
      token: reserve.tokenSymbol,
      chain: reserve.chainName,
      chainId: reserve.chainId,
      oraclePrice,
      sdkPrice,
      diffPct: (diff * 100).toFixed(2),
    },
    'oracle price anomaly'
  );
  reserve.tokenPrice = oraclePrice;
  oracleOverrideCount++;
}
```

确保 `logger` 已 import（文件顶部应有 `import { logger } from '../logger.js'`，如无则添加）。

### Step 2: （可选）将阈值提取到 config.ts

当前 1% 阈值硬编码为 `0.01`。建议提取到 `config.ts`：

```typescript
// config.ts 新增
oracleDiffThreshold: Number(process.env.ORACLE_DIFF_THRESHOLD) || 0.01,
```

然后在 `marketsService.ts` 引用 `config.oracleDiffThreshold` 替换硬编码 `0.01`。

### Step 3: 部署后验证

1. 部署到 Railway staging
2. 观察 Railway 日志中出现 `oracle price anomaly` 的 warn 记录
3. 确认 meta 字段（token, chain, oraclePrice, sdkPrice, diffPct）格式正确

### Step 4: 配置每日汇总推送

在 Railway 日志中搜 `oracle price anomaly` 即可看到所有异常。每日汇总推荐两种方式：

#### 方案 A: GitHub Actions Cron（推荐，零后端负担）

```yaml
# .github/workflows/daily-price-anomaly.yml
name: Daily Price Anomaly Summary
on:
  schedule:
    - cron: '0 8 * * *'  # 每天 UTC 8:00
jobs:
  summary:
    runs-on: ubuntu-latest
    steps:
      - name: Fetch Railway logs
        env:
          RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}
          SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK }}
        run: |
          # 用 Railway API 获取过去 24h 日志，过滤 oracle price anomaly
          YESTERDAY=$(date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)
          LOGS=$(curl -s -H "Authorization: Bearer $RAILWAY_TOKEN" \
            "https://backboard.railway.app/graphql/v2" \
            -d '{"query":"..."}' )  # 需根据 Railway API 调整
          ANOMALIES=$(echo "$LOGS" | grep -c "oracle price anomaly" || true)
          if [ "$ANOMALIES" -gt 0 ]; then
            curl -s -X POST "$SLACK_WEBHOOK" \
              -H 'Content-type: application/json' \
              -d "{\"text\":\"⚠️ 过去 24h 有 $ANOMALIES 条 oracle 价格异常，详见 Railway 日志\"}"
          fi
```

#### 方案 B: Railway 内置 Log Drains

在 Railway 项目设置中配置 Log Drain → 过滤 warn 级别 → 转发到 Slack/Seq/Loki。无需写代码，但需要 Railway Pro 计划。

---

## 不做的事

- ❌ 不在 `/markets` API 中新增 `priceDiffPercent` / `priceDiffAlert` 字段
- ❌ 不新增独立的 cron 定时任务
- ❌ 不新增数据库表存储异常记录
- ❌ 前端不需要任何改动

---

## 关键文件路径

| 文件 | 说明 |
|------|------|
| `backend/src/services/marketsService.ts:338-363` | oracle diff 对比逻辑，**改动点** |
| `backend/src/services/oracleService.ts` | oracle 价格缓存服务（只读，不改动） |
| `backend/src/logger.ts` | Winston logger 单例（不改动） |
| `backend/src/config.ts` | 配置文件，**可选改动**（提取阈值） |
| `backend/src/cacheTtl.ts` | oracleTtlMs = 60_000（参考，不改动） |

---

## 验收标准

- [ ] `marketsService.ts` 中 oracle diff > 阈值时输出 `logger.warn`
- [ ] warn 日志包含 token、chain、oraclePrice、sdkPrice、diffPct 结构化字段
- [ ] Railway 部署后日志中可搜到 `oracle price anomaly`
- [ ] （可选）阈值从 config.ts 读取而非硬编码
- [ ] （可选）每日汇总推送配置完成

---

## Linear Issue

AAV-261 — 关联但需更新方案：原方案规划了前后端字段扩展，现改为纯后端日志告警方案。

---

## Suggested Skills

- `source-command-commit` — 提交改动时遵循 CI gate
- `verification-before-completion` — 部署前验证

# Aave UI ↔ Backend API Comparison Tool

对比 Aave 官方 GraphQL API（V3 + V4）与后端 `/api/markets` 的输出数据。

## 运行

```bash
# 对比 staging 后端
node scripts/verification/compare-aave-ui/run-compare.mjs

# 对比本地后端
node scripts/verification/compare-aave-ui/run-compare.mjs --local

# 只跑 V3
node scripts/verification/compare-aave-ui/run-compare.mjs --no-v4

# 自定义后端 URL + 输出路径
node scripts/verification/compare-aave-ui/run-compare.mjs --backend-url http://localhost:3001/api/markets --output ./my-report.json
```

## 选项

| 选项 | 说明 |
|------|------|
| `--backend-url URL` | 后端 API URL（默认 staging） |
| `--local` | 等价于 `--backend-url http://localhost:3001/api/markets` |
| `--no-v3` | 跳过 V3 对比 |
| `--no-v4` | 跳过 V4 对比 |
| `--output PATH` | JSON 报告输出路径 |

## 对比字段与容差

| 字段 | 容差 | 说明 |
|------|------|------|
| Supply APY | 0.05% | APY 实时计算，小幅差异正常 |
| Borrow APY | 0.05% | 同上 |
| Utilization | 0.1% | 随 APY 波动 |
| LTV | 0.01% | 链上常量，差异异常 |
| Liquidation Threshold | 0.01% | 链上常量 |
| Supply Cap | 0.1% | 原始 token 数量 |
| Borrow Cap | 0.1% | 同上 |
| Is Frozen | exact | 布尔值 |
| Is Paused | exact | 布尔值 |
| Collateral Factor (V4) | 0.01% | V4 替代 LTV |

## 数据源

| 数据源 | URL | 说明 |
|--------|-----|------|
| Aave V3 GraphQL | `https://api.v3.aave.com/graphql` | V3 Markets query |
| Aave V4 GraphQL | `https://api.aave.com/graphql` | V4 Reserves query |
| Backend API (staging) | `https://staging-api.aaveapy.com/api/markets` | 后端 REST API |
| Backend API (local) | `http://localhost:3001/api/markets` | 本地开发 |

## 匹配键

- **V3**: `(chainId, tokenAddress)` — 两侧都用 token address 作为唯一标识
- **V4**: `(spokeChainId, tokenAddress)` — V4 Hub-Spoke 模型用 spoke chain 定位

## 输出

- Console 人类可读报告
- JSON 详细报告（默认写入 `data/debug/aave-ui-comparison-report.json`）
- Exit code: 0 = 全部通过, 1 = 有超出容差的差异, 2 = 运行时错误

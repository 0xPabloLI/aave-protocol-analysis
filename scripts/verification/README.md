# Verification Scripts

验证脚本集合，用于核对 SDK 数据、链上数据、公式计算的一致性。

## 脚本列表

| 脚本 | 用途 | 运行方式 |
|------|------|----------|
| `v4-sdk-calculations.ts` | V4 SDK APY/utilization 公式验证 | `npx tsx scripts/verification/v4-sdk-calculations.ts` |
| `v3-snx-onchain-compare.mjs` | V3 单个 reserve (SNX) 链上 vs SDK 对比 | `node scripts/verification/v3-snx-onchain-compare.mjs` |
| `v3-base-rate-fallback.mjs` | V3 baseVariableBorrowRate fallback 验证 | `node scripts/verification/v3-base-rate-fallback.mjs` |
| `v3-sdk-onchain-match.mjs` | V3 SDK vs 链上数据匹配验证 | `node scripts/verification/v3-sdk-onchain-match.mjs` |
| `sdk-field-coverage.mjs` | SDK 字段覆盖率检查 | `node scripts/verification/sdk-field-coverage.mjs` |

## 运行前提

大部分脚本需要先构建项目：

```bash
npm run build && npm --prefix backend run build
```

部分脚本依赖 `data/debug/` 目录下的数据文件，需先运行 fetcher 生成。

## V4 SDK Calculations (`v4-sdk-calculations.ts`)

验证 V4 SDK 返回的 APY 和 utilization 是否与公式计算一致。

**核心公式**：

1. **Utilization**: `U = D / (L + D)` (D=borrowed, L=liquidity)
2. **Borrow APY** (分段线性):
   - `U <= U_opt`: `R = R_base + slope1 × (U / U_opt)`
   - `U > U_opt`: `R = R_base + slope1 + slope2 × ((U - U_opt) / (1 - U_opt))`
3. **Supply APY**: `Supply APY = U × R_borrow × (1 - fee)`

**验证结果** (2026-05-15):

| 验证项 | 结果 |
|--------|------|
| Supply APY 公式 | 63/63 完美匹配 |
| Borrow APY 公式 | 正确，差异来自链上 RAY 精度损失 |
| Utilization 公式 | 与 SDK 有微小差异 (0.01-0.03%) |

**精度说明**：
- V3/V4 SDK 统一返回 decimal fraction string (如 `"0.04"` = 4%)
- 通过 `percentValueToPercent()` 统一转换为 percent number (如 `4`)
- 公式计算使用 float 精度，SDK 使用链上 RAY 精度

## V3 Base Rate Fallback (`v3-base-rate-fallback.mjs`)

验证 `calculateBaseRateFallback()` 函数的正确性：

- 对比链上 RPC 获取的 `baseVariableBorrowRate` 与 fallback 计算值
- Fallback 公式：从已知 borrow APY 反推 base rate

## V3 SDK On-chain Match (`v3-sdk-onchain-match.mjs`)

验证 SDK 返回的 reserve 与链上 `UiPoolDataProvider.getReservesHumanized()` 返回的数据是否一一对应。

报告：
- In SDK but not in on-chain
- In on-chain but not in SDK

## V3 SNX On-chain Compare (`v3-snx-onchain-compare.mjs`)

针对 SNX reserve (AaveV3Ethereum) 的详细对比，用于调试公式不匹配问题。

对比参数：
- baseVariableBorrowRate
- variableRateSlope1, variableRateSlope2
- optimalUsageRate
- utilization

## SDK Field Coverage (`sdk-field-coverage.mjs`)

检查 SDK 返回的每个 reserve 是否包含所有依赖的字段。

依赖文件：`data/debug/aave-all-markets-data.json`

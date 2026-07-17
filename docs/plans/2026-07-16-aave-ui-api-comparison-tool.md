# Aave UI ↔ Backend API 对比工具

> **Status: Active** — Phase 1+2 完成，Phase 3 待定。

## 目标

构建 CLI 工具，自动从 Aave 官方 GraphQL API（V3 + V4）拉取市场数据，与后端 `/api/markets` 的输出逐字段对比，发现数值/字段缺失/单位不一致等问题。

## 背景

### 现有验证体系（协议层）

`scripts/verification/` 下有 5 个脚本，全部对比 **SDK ↔ 链上 RPC**：

| 脚本 | 对比维度 |
|------|---------|
| `v3-snx-onchain-compare.mjs` | V3 链上 vs SDK 逐字段 |
| `v3-sdk-onchain-match.mjs` | V3 SDK vs 链上条目匹配 |
| `v3-base-rate-fallback.mjs` | V3 baseRate fallback 反推验证 |
| `v4-sdk-calculations.ts` | V4 SDK APY/utilization 公式验证 |
| `sdk-field-coverage.mjs` | SDK 字段覆盖率检查 |

**缺失的维度**：没有任何工具验证后端 API 输出与 Aave 官网 UI 显示的一致性。

### 新增维度（UI 层）

```
Aave 官方 GraphQL API ──→ 对比引擎 ←── 后端 /api/markets
    │                                      │
    ├─ V3: api.v3.aave.com/graphql         ├─ MarketWithSpread (percent)
    └─ V4: api.aave.com/graphql            └─ RuntimeReserveData → serialize
```

## 架构设计

### 实际文件结构（Phase 1+2 已完成，合并了 normalize 模块）

```
scripts/verification/compare-aave-ui/
├── README.md                    # 工具使用说明
├── fetch-aave-v3.mjs            # V3 GraphQL 数据拉取 + 标准化
├── fetch-aave-v4.mjs            # V4 GraphQL 数据拉取 + 标准化
├── fetch-backend-api.mjs        # 后端 API 拉取 + 标准化（含 raw→human-readable 转换辅助）
├── diff-engine.mjs              # 对比引擎（逐字段 diff + 容差判定 + 报告生成）
└── run-compare.mjs              # 主入口（串联全部流程）
```

### 关键实现细节

1. **V3 APY 单位**: Aave UI 返回 `PercentValue.value`（decimal fraction，如 0.04=4%），工具 ×100 转为 percent
2. **V4 APY 单位**: Aave UI 返回 `PercentNumber.normalized`（已格式化 percent，如 76.00=76%），直接使用
3. **Cap 单位转换**: 后端存 raw（base units string），Aave UI 返回 `amount.value`（human-readable）。diff-engine 中用 `rawToHumanReadable()` 按 decimals 转换后端值再对比
4. **V4 版本判定**: 后端 API 无 `isV4` 字段，用 `hubId`/`spokeId` 或 `marketName` 含 "v4" 判定
5. **V4 spokeChainId**: 后端无 `spokeChainId` 字段，从 `spokeId`（base64 编码）解码提取 chainId
scripts/verification/
├── compare-aave-ui/
│   ├── README.md                    # 工具使用说明
│   ├── fetch-aave-v3.mjs            # V3 GraphQL 数据拉取
│   ├── fetch-aave-v4.mjs            # V4 GraphQL 数据拉取
│   ├── normalize-aave-ui.mjs        # Aave UI 数据标准化（→ 统一比较格式）
│   ├── normalize-backend-api.mjs    # 后端 API 数据标准化（→ 统一比较格式）
│   ├── diff-engine.mjs              # 对比引擎（逐字段 diff + 容差判定）
│   └── run-compare.mjs              # 主入口（串联全部流程）
```

### 数据源

| 数据源 | URL | 协议 | 认证 |
|--------|-----|------|------|
| Aave V3 GraphQL | `https://api.v3.aave.com/graphql` | GraphQL POST | 无 |
| Aave V4 GraphQL | `https://api.aave.com/graphql` | GraphQL POST | 无 |
| 后端 API (staging) | `https://staging-api.aaveapy.com/api/markets` | REST GET | 无 |
| 后端 API (local) | `http://localhost:3001/api/markets` | REST GET | 无 |

### V3 GraphQL 查询

```graphql
query Markets($request: MarketsRequest!) {
  value: markets(request: $request) {
    chain { chainId }
    address
    supplyReserves: reserves(request: { reserveType: SUPPLY }) {
      underlyingToken { address, symbol, decimals, chainId }
      supplyInfo {
        apy { raw, value, formatted }
        total { usd }
        maxLTV { value, formatted }
        liquidationThreshold { value, formatted }
        supplyCap { amount { raw, value }, usd }
        supplyCapReached
      }
      borrowInfo {
        apy { raw, value, formatted }
        total { usd }
        utilizationRate { raw, value, formatted }
        availableLiquidity { usd }
        borrowCap { amount { raw, value }, usd }
        borrowCapReached
        baseVariableBorrowRate { raw, value, formatted }
        variableRateSlope1 { raw, value, formatted }
        variableRateSlope2 { raw, value, formatted }
      }
      isFrozen
      isPaused
      incentives { __typename }
    }
    borrowReserves: reserves(request: { reserveType: BORROW }) {
      underlyingToken { address, symbol, decimals, chainId }
      borrowInfo { apy { raw, value, formatted } }
    }
  }
}
```

**请求参数**：`{ request: { chainIds: [1, 42161, 10, 137, 8453, 43114, 1088] } }`

### V4 GraphQL 查询

```graphql
query Reserves($request: ReservesRequest!, $currency: Currency!, $timeWindow: TimeWindow!) {
  value: reserves(request: $request) {
    id
    onChainId
    chain { chainId }
    spoke { chain { chainId } }
    summary {
      supplied { amount { onChainValue, value }, exchange, exchangeRate }
      borrowed { amount { onChainValue, value }, exchange, exchangeRate }
      suppliable { amount { onChainValue, value } }
      borrowable { amount { onChainValue, value } }
      supplyApy { onChainValue, value, normalized }
      borrowApy { onChainValue, value, normalized }
    }
    settings {
      collateralFactor { onChainValue, value, normalized }
      supplyCap { amount { onChainValue, value } }
      borrowCap { amount { onChainValue, value } }
    }
    status { frozen, paused, active }
    asset { symbol, decimals }
  }
}
```

**请求参数**：`{ request: { ... }, currency: "USD", timeWindow: "ONE_DAY" }`

（V4 的 `ReservesRequest` 需要在实际测试中确认具体参数格式。）

### 对比策略

#### 匹配键

- **V3**: `(chainId, underlyingTokenAddress)` — V3 GraphQL 返回 `chain.chainId` + `underlyingToken.address`
- **V4**: `(chainId, onChainId)` — V4 GraphQL 返回 `chain.chainId` + `onChainId`（链上 reserve ID）

后端 API 用 `reserveId`（=`chainId:poolAddress:tokenAddress`），需拆解提取 `chainId` + `tokenAddress` 做匹配。

#### 对比字段与容差

| 字段 | 后端字段 | Aave UI 字段 | 容差 | 说明 |
|------|---------|-------------|------|------|
| Supply APY | `supplyApy` (percent) | `supplyInfo.apy.value` (decimal→需×100) | 0.05% | APY 小数位差异 |
| Borrow APY | `borrowApy` (percent) | `borrowInfo.apy.value` (decimal→需×100) | 0.05% | APY 小数位差异 |
| Total Supply USD | `totalSupplyUsd` | `supplyInfo.total.usd` | 1% | 汇率波动 |
| Total Borrow USD | `totalBorrowUsd` | `borrowInfo.total.usd` | 1% | 汇率波动 |
| Utilization | `utilizationPct` (percent) | `borrowInfo.utilizationRate.value` (decimal→×100) | 0.1% | 精度差异 |
| Supply Cap | `supplyCap` | `supplyInfo.supplyCap.amount.value` | 0.1% | 原始值对比 |
| Borrow Cap | `borrowCap` | `borrowInfo.borrowCap.amount.value` | 0.1% | 原始值对比 |
| LTV | `ltv` (percent) | `supplyInfo.maxLTV.value` (decimal→×100) | 0.01% | RAY 精度 |
| Liquidation Threshold | `liquidationThreshold` (percent) | `supplyInfo.liquidationThreshold.value` (decimal→×100) | 0.01% | RAY 精度 |
| Is Frozen | `isFrozen` | `isFrozen` | exact | 布尔值 |
| Is Paused | `isPaused` | `isPaused` | exact | 布尔值 |

#### V4 特有字段

| 字段 | 后端字段 | Aave UI 字段 | 容差 | 说明 |
|------|---------|-------------|------|------|
| Supply APY | `supplyApy` | `summary.supplyApy.value` | 0.05% | V4 normalized 值 |
| Borrow APY | `borrowApy` | `summary.borrowApy.value` | 0.05% | V4 normalized 值 |
| Collateral Factor | `collateralFactor` | `settings.collateralFactor.value` | 0.01% | V4 替代 LTV |

### 输出格式

```json
{
  "timestamp": "2026-07-16T12:00:00Z",
  "backendSource": "https://staging-api.aaveapy.com/api/markets",
  "aaveUiSource": { "v3": "https://api.v3.aave.com/graphql", "v4": "https://api.aave.com/graphql" },
  "summary": {
    "totalReserves": { "backend": 450, "aaveUiV3": 380, "aaveUiV4": 70 },
    "matched": 430,
    "backendOnly": 20,
    "aaveUiOnly": 10,
    "fieldMismatches": 45,
    "fieldsCompared": 10
  },
  "mismatches": [
    {
      "reserveId": "1:0x878...:0xabc...",
      "tokenSymbol": "WETH",
      "chainId": 1,
      "version": "v3",
      "field": "supplyApy",
      "backend": 3.12,
      "aaveUi": 3.15,
      "diff": 0.03,
      "tolerance": 0.05,
      "status": "within_tolerance"
    }
  ],
  "missingInBackend": [...],
  "missingInAaveUi": [...]
}
```

### 容差状态

| 状态 | 含义 |
|------|------|
| `exact_match` | 完全一致 |
| `within_tolerance` | 差异在容差内 |
| `out_of_tolerance` | 差异超出容差 |
| `missing_in_backend` | Aave UI 有但后端无 |
| `missing_in_aave_ui` | 后端有但 Aave UI 无 |
| `type_mismatch` | 值类型不同 |

## 实现计划

### Phase 1: V3 数据拉取 + 基础对比

1. **`fetch-aave-v3.mjs`** — 从 V3 GraphQL API 拉取所有链的 reserve 数据
   - 发送 `MarketsQuery`，按 chainIds 批量拉取
   - 提取 supplyReserves + borrowReserves
   - 输出统一的 `AaveUiReserve` 格式

2. **`normalize-aave-ui.mjs`** — 将 Aave UI 数据标准化
   - V3: `apy.value` (decimal) → `×100` → percent
   - V4: `supplyApy.value` (percent?) → 确认单位后转换
   - 统一 key 为 `(chainId, tokenAddress)`

3. **`normalize-backend-api.mjs`** — 从后端 API 拉取并标准化
   - GET `/api/markets` → `reserves[]`
   - 拆解 `reserveId` → `(chainId, tokenAddress)`
   - 字段已是 percent，直接使用

4. **`diff-engine.mjs`** — 对比引擎
   - 按 `(chainId, tokenAddress)` 匹配
   - 逐字段 diff，应用容差
   - 生成 mismatch 报告

5. **`run-compare.mjs`** — 主入口
   - 串联全部流程
   - 输出 console 报告 + JSON 报告

### Phase 2: V4 数据拉取 + Hub-Spoke 处理

6. **`fetch-aave-v4.mjs`** — 从 V4 GraphQL API 拉取数据
   - Hub-Spoke 模型需要特殊处理（spoke chain → hub 映射）
   - 确认 `ReservesRequest` 参数格式

7. **V4 标准化逻辑** — 处理 V4 特有字段
   - `PercentNumber` vs `PercentValue` 单位差异
   - `Erc20Amount` 的 `exchange` / `exchangeRate`
   - Hub ↔ Spoke reserve ID 映射

### Phase 3: 增强功能

8. **Incentive 对比** — 比较激励 APR
9. **历史对比** — 保存历史报告，追踪漂移趋势
10. **CI 集成** — 集成到 `ci:remote` 作为可选检查

## 技术决策

### 为什么不用 Aave SDK（`@aave/aave-sdk`）？

1. SDK 是 urql GraphQL client，在 Node.js 长运行进程中有内存泄漏（已在后端踩过坑）
2. 直接发 GraphQL POST 请求更轻量、无依赖、无泄漏风险
3. 对比工具只需读一次数据，不需要 SDK 的缓存/retry 功能

### 为什么用 `.mjs` 而非 `.ts`？

与现有 `scripts/verification/` 保持一致。`.mjs` 直接 `node` 运行，无需 `npx tsx`。

### 为什么分 V3/V4 拉取模块？

V3 和 V4 的 GraphQL schema 完全不同（不同 endpoint、不同查询、不同数据模型），强行统一会增加复杂度。分开后每个模块只关注自己的 schema。

## 已知限制

1. **汇率波动**：Aave UI API 和后端 API 拉取时间不同，USD 金额会有差异（容差 1%）
2. **APY 实时性**：APY 基于利用率实时计算，两次拉取间利用率变化会导致 APY 差异
3. **Incentive 复杂度**：V3 有 9 种 union incentive 类型，V4 有独立 reward 结构，对比逻辑复杂
4. **V4 Hub-Spoke**：V4 的 reserve ID 映射比 V3 复杂，需要处理 spoke chain → hub chain 的关系
5. **速率限制**：Aave GraphQL API 未公开速率限制文档，需保守请求

## 进度跟踪

| # | 任务 | 状态 | 备注 |
|---|------|------|------|
| 1 | V3 GraphQL 数据拉取 (`fetch-aave-v3.mjs`) | ✅ | 7 条链 184 reserves |
| 2 | V4 GraphQL 数据拉取 (`fetch-aave-v4.mjs`) | ✅ | 从后端 API 自动检测 hub chain IDs |
| 4 | 后端 API 数据标准化 (`fetch-backend-api.mjs`) | ✅ | V4 判定用 hubId/spokeId，提取 aaveProReserveId，spokeChainId 从 base64 解码 |
| 5 | 对比引擎 (`diff-engine.mjs`) | ✅ | V4 用 aaveProReserveId 精确匹配，raw→human-readable 转换，绝对/相对容差 |
| 6 | 主入口 (`run-compare.mjs`) | ✅ | --local/--no-v3/--no-v4/--output |
| 7 | V3 全量对比测试 | ✅ | 168 matched, APY 全部 exact 或 within_tolerance |
| 8 | V4 全量对比测试 | ✅ | 67 matched (aaveProReserveId 精确匹配), 0 out_of_tolerance |
| 9 | 根因分析 | ✅ | 4 个根因已识别并全部修复 |
| 10 | Incentive 对比 | 🔲 | Phase 3 |
| 11 | CI 集成 | 🔲 | Phase 3 |

## 首次实测结果 (2026-07-16, aaveProReserveId 精确匹配后)

### 总体

| 指标 | V3 | V4 |
|------|-----|-----|
| 匹配 reserves | 168 | 67 |
| 后端独有 | 123 | 11 |
| Aave UI 独有 | 0 | 0 |
| Out of tolerance | 0 | 0 |
| Within tolerance | ~230 | 94 |
| Exact match | ~720 | 310 |

### 根因分析：差异来源

**核心结论：数据源同源（同一 GraphQL API），差异来自数据处理层的 4 个环节。**

```
Aave GraphQL API ──→ Aave UI（直接展示）
         │
         ├──→ @aave/aave-sdk (V3) / @aave/aave-v4-sdk (V4)  [环节1: SDK 序列化]
         │         │
         │         ├──→ fetchMarketsData()  [环节2: Fetcher 聚合/剪裁]
         │         │         │
         │         │         ├──→ pruneReserveForRuntime()  [环节3: 字段裁剪]
         │         │         │
         │         │         ├──→ marketsApiSerialize()  [环节4: ratio→percent ×100]
         │         │         │
         │         │         └──→ /api/markets 响应
```

#### 根因 1: V4 Spoke 粒度不匹配（已修复）

**现象**: USDC (Ethereum V4) 后端 supplyApy=3.04% vs Aave UI=6.64%

**根因**: V4 Hub-Spoke 架构下，同一 token 在不同 Spoke 有不同的 APY 和 Cap。例如 USDC 在 Main spoke 有 6.64% APY，在 Bluechip spoke 只有 3.04%。

对比工具之前用 `(spokeChainId, tokenAddress)` 匹配，未区分 spokeName，导致同 token 不同 spoke 的数据错误配对。

**修复**: 匹配键加入 `spokeName`，从 `(chainId, tokenAddress)` → `(chainId, tokenAddress, spokeName)`

**修复后结果**: V4 匹配从 22 → 63，out_of_tolerance 从 29 → 4

#### 根因 2: V4 同 Spoke 多实例（已修复）

**现象**: USDC Ethena Ecosystem：后端 APY 1.32% vs Aave UI 6.64%

**根因**: Aave V4 在同一 spoke（"Ethena Ecosystem"）下可以有**多个 reserve 实例**，通过 `onChainId` 区分。两个 USDC reserve 的 onChainId 分别是 4 和 7，代表同一 token 的不同 V4 配置实例（不同的利率曲线、不同的 cap）。

后端用完整的 4 段 `reserveId`（`chainId:hubPool:token:spokePool`）区分，第 4 段 spoke 地址不同。但对比工具之前的匹配键只有 `(spokeChainId, tokenAddress, spokeName)`，无法区分同一 spoke 下的多个实例。

**修复**: 后端 API 返回 `aaveProReserveId` 字段，与 Aave UI 的 `id` 字段完全一致（均为 base64 编码的 `hubChainId::hubPoolAddress::onChainId`）。将匹配键从 `(chainId, tokenAddress, spokeName)` 改为 `aaveProReserveId` 精确匹配。

**修复后结果**: V4 匹配从 63 → 67，out_of_tolerance 从 8 → 0

#### 根因 3: Cap 单位差异（已修复）

**现象**: supplyCap 差异巨大（如 7e+24 vs 7000000）

**根因**: 后端存 raw（链上 base units，如 `7000000000000000000000000`），Aave UI 返回 human-readable（如 `7000000`）。

**修复**: diff-engine 中用 `rawToHumanReadable()` 按 decimals 转换后端值再对比。

#### 根因 4: V4 后端缺少部分字段（missing_value 1081 条）

**现象**: 大量 missing_value，特别是 `isFrozen`/`isPaused`/`collateralFactor`/`ltv`/`liquidationThreshold`

**根因**: V4 后端 API 的 `MarketWithSpread` 类型不包含这些字段。V4 用 `collateralFactor` 替代 V3 的 `ltv`，但后端序列化层未将其纳入标准输出。V4 的 `isFrozen`/`isPaused` 需要从链上 RPC 获取，后端目前未采集。

**影响**: 这些字段无法在对比工具中验证，但不影响 APY/Cap 等核心数值的对比。

### 后端独有但 Aave UI 不包含的链

后端覆盖了 Aave UI V3 GraphQL 未包含的链：BSC (56)、Celo (42220)、Linea (59144)、Gnosis (100) 等。这些不是错误，是数据源覆盖范围差异。

### 同源确认

后端和 Aave UI 使用**完全相同的 GraphQL API 端点**：
- V3: `https://api.v3.aave.com/graphql` — 后端 `@aave/aave-sdk` 的 `AaveClient.create()` 底层就是 urql 连到这个端点
- V4: `https://api.aave.com/graphql` — 后端 `@aave/aave-v4-sdk` 同理

所以差异一定来自 SDK 之上的处理层（fetcher 聚合、字段裁剪、单位转换），不是数据源本身。

## 顺带修复：RPC fallback `aaveProReserveId` 格式不一致

### 问题

`aaveProReserveId` 有两个数据路径，输出格式不一致：

| 路径 | 值 | 格式 |
|---|---|---|
| SDK fetcher (`v4-fetcher.ts`) | `r.id` | base64（`MTo6MHg...Ojo0`） |
| RPC fallback (`aave-rpc-infra`) | `aaveProReserveId()` 函数 | 5段冒号（`1:0xspoke:0xtoken:0xhub:Main`） |

前端 `buildAaveUrl()` 直接把 `aaveProReserveId` 拼入 `pro.aave.com/explore/reserve/{id}` URL。pro.aave.com 路由期望 base64 格式。当 SDK 挂掉走 RPC fallback 时，前端会生成无效链接。

### 修复

RPC fallback 路径不输出 `aaveProReserveId`（设为 `undefined`）。序列化层已有的 `reserve.aaveProReserveId ? { ... } : {}` 逻辑会自动省略空值。前端 `buildAaveV4Url` 返回 null 时 fallback 到 V3 格式链接。

### 改动

- `packages/aave-rpc-infra/src/index.ts`: `aaveProReserveId: undefined`，移除无用 import

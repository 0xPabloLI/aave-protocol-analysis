# API字段命名优化分析

对比V3/V4 SDK原始字段、前端UI显示、当前后端API字段名，提出优化建议。

## 字段单位约定

API 中所有规模类 raw token 字段统一为 `string` 类型（BigInt-safe），包括：
`supplied`、`borrowed`、`liquidity`、`supplyCap`、`borrowCap`、`deficit`。

无需在字段名中加 `Raw` 后缀，整个 API 的 raw token 字段已形成一致的默认约定。

## 字段对比表

| 语义 | V3 SDK Raw字段 | V4 SDK Raw字段 | 前端UI显示 | 当前后端API字段 | 优化后 |
|------|----------------|----------------|------------|-----------------|--------|
| **规模相关** |
| 总供应量（raw） | `reserve.size.amount.raw` | `r.summary.supplied.amount.onChainValue` | "Total supplied" | `reserveSize` | `supplied` |
| 总借款量（raw） | `reserve.borrowInfo.total.amount.raw` | `r.summary.borrowed.amount.onChainValue` | "Total borrowed" | `totalVariableDebt` | `borrowed` |
| 可用流动性（raw） | `reserve.borrowInfo.availableLiquidity.amount.raw` | `r.asset.summary.availableLiquidity.amount.onChainValue` | "Available liquidity" / "Liquidity" | `availableLiquidity` | `liquidity` |
| 供应上限（raw） | `reserve.supplyInfo.supplyCap.amount.raw` | `r.settings.supplyCap.amount.onChainValue` | "Supply cap" | `supplyCap` | 保留 |
| 借贷上限（raw） | `reserve.borrowInfo.borrowCap.amount.raw` | `r.settings.borrowCap.amount.onChainValue` | "Borrow cap" | `borrowCap` | 保留 |
| **利率模型参数** |
| 协议费用 | `reserve.borrowInfo.reserveFactor.value` | `r.asset.settings.liquidityFee.value` | - | `reserveFactor` | `protocolFee` |
| 利率斜率1 | `reserve.borrowInfo.variableRateSlope1.value` | `r.asset.settings.slopeBelowOptimal.value` | - | `variableRateSlope1` | `slopeBelowOptimal` |
| 利率斜率2 | `reserve.borrowInfo.variableRateSlope2.value` | `r.asset.settings.slopeAboveOptimal.value` | - | `variableRateSlope2` | `slopeAboveOptimal` |
| 最优利用率 | `reserve.borrowInfo.optimalUsageRate.value` | `r.asset.settings.optimalUtilizationRate.value` | "Optimal utilization" | `optimalUsageRate` | `optimalUtilization` |
| 基础借款利率 | RPC或反推 | `r.asset.settings.baseBorrowRate.value` | - | `baseVariableBorrowRate` | `baseBorrowRate` |
| **其他** |
| 坏账（raw） | RPC (`UiPoolDataProvider`) | N/A (V4无此概念) | "Deficit" | `deficit` | 保留（V3专用） |

## 优化理由

### 字段重命名详析

1. **`reserveSize` → `supplied`**
   - V4 SDK字段名为`supplied`，直接对应
   - 更简洁，与`borrowed`形成对称
   - 语义清晰：表示已供应的总量
   - 无需`Raw`后缀：API 中所有 raw token 字段均为 `string` 类型，已形成统一约定

2. **`totalVariableDebt` → `borrowed`**
   - V4 SDK字段名为`borrowed`，直接对应
   - 去掉"variable"前缀，V4只有一种借款模式
   - 与`supplied`形成对称
   - 前端UI显示为"Total borrowed"

3. **`availableLiquidity` → `liquidity`**
   - 在 Aave lending pool 中，不存在独立的"总流动性"概念，池子中唯一流动性即 available liquidity：
     ```
     supplied = liquidity + borrowed + deficit
     ```
   - `liquidity` 不会引起歧义，且更简洁
   - 前端UI显示为"Available liquidity" / "Liquidity"

4. **`reserveFactor` → `protocolFee`**
   - V3叫`reserveFactor`，V4叫`liquidityFee`，两者均协议特定的历史名称
   - `protocolFee` 是跨 V3/V4 的通用名称，且为未来可能接入的其他借贷协议预留扩展空间

5. **`variableRateSlope1` → `slopeBelowOptimal`**
   - V4 SDK字段名为`slopeBelowOptimal`，直接对应
   - 语义更清晰：低于最优利用率时的斜率
   - 去掉"variable"前缀（V4无stable debt区分）

6. **`variableRateSlope2` → `slopeAboveOptimal`**
   - V4 SDK字段名为`slopeAboveOptimal`，直接对应
   - 语义更清晰：高于最优利用率时的斜率

7. **`optimalUsageRate` → `optimalUtilization`**
   - V4 SDK字段名为`optimalUtilizationRate`，简化为`optimalUtilization`
   - 与`utilizationPct`保持一致的命名风格
   - 前端UI显示为"Optimal utilization"

8. **`baseVariableBorrowRate` → `baseBorrowRate`**
   - V4 SDK字段名为`baseBorrowRate`，直接对应
   - 去掉"variable"前缀，V4只有一种借款模式

## 影响范围

### 后端（8个文件）

| 文件 | 受影响引用 | 说明 |
|------|-----------|------|
| `src/index.ts` | ~12处 | V3数据映射（L76-86, L433-500） |
| `src/v4-fetcher.ts` | ~10处 | V4数据映射（L168-220） |
| `src/types/runtime-validation.ts` | 8条目 | `EXPECTED_RUNTIME_FIELDS` 数组 |
| `backend/src/types/index.ts` | 8字段 | `MarketWithSpread` 接口定义 |
| `backend/src/services/marketsApiSerialize.ts` | 8处 | API响应序列化（L82-92） |
| `backend/src/services/marketsService.ts` | ~6处 | 市场数据合并 + fallback计算 |
| `backend/src/services/onchainDataService.ts` | ~15处 | 利率反推 + RPC数据映射 |
| `backend/src/services/persistenceService.ts` | ~7处 | DB列名映射（L291-321） |

### 前端

| 文件 | 说明 |
|------|------|
| `src/types/aave.ts` | 类型定义 |
| `src/lib/apiSchemas.ts` | Zod schema |
| `src/lib/interestRateCalculator.ts` | 利率计算 |
| `src/hooks/useRateSimulation.ts` | 利率模拟 |
| 所有组件引用 | 字段读取 |

### 文档（5个文件）

| 文件 | 说明 |
|------|------|
| `docs/api/api-documentation.md` | API接口文档（含精度描述错误需一并修复） |
| `aaveapy-doc/v3-v4-sdk-field-mapping.md` | V3/V4字段映射文档 |
| `aaveapy-doc/field-glossary.md` | 字段→前端概念映射 |
| `docs/backend/data-precision-comparison.md` | 数据精度对比 |
| `docs/plans/` | 历史设计文档 |

### 数据库

| 表/列 | 说明 |
|--------|------|
| `reserves` 表 | `availableLiquidity`, `totalVariableDebt`, `reserveSize` |
| `reserves` 表 | `baseVariableBorrowRate`, `reserveFactor`, `variableRateSlope1`, `variableRateSlope2`, `optimalUsageRate` |

DB 迁移需要 `ALTER TABLE RENAME COLUMN`，或方案B兼容过渡期间双写新旧列名。

### 测试

| 文件 | 说明 |
|------|------|
| `tests/field-coverage.test.ts` | `EXPECTED_RUNTIME_FIELDS` 更新，需同步新增字段名 |

## 实施方案

### 方案B：保留旧字段名作为别名（兼容过渡）✅ 推荐

**Phase 1** ✅ 已完成：后端同时输出旧字段名 + 新字段名（同一个 reserve 对象中双写）

```json
{
  "reserveSize": "7000000000000000000000000",
  "supplied": "7000000000000000000000000",
  "totalVariableDebt": "3000000000000000000000000",
  "borrowed": "3000000000000000000000000"
}
```

- 优点：向后兼容，前后端独立发布
- 缺点：Phase 1 期间 JSON payload 略有膨胀（每个字段多一个 key）

**Phase 2** ✅ 已完成 (2026-05-13)：前端迁移到新字段名，停止读取旧字段名
- 类型定义、Zod schema、核心计算逻辑、组件代码全部更新
- 1201 个前端测试全部通过

**Phase 3** ✅ 已完成 (2026-05-13)：后端删除旧字段名，执行 DB 列名迁移
- `marketsApiSerialize.ts` 仅输出新字段名
- `persistenceService.ts` COLUMNS 常量更新为新的 DB 列名
- DB 迁移脚本: `backend/migrations/007_rename_reserve_columns.sql`
- API 文档 `docs/api/api-documentation.md` 更新为新的字段名表
- 75 个后端测试全部通过

**Phase 4** ✅ 已完成 (2026-05-13)：API version bump → `markets-v3`
- `MARKETS_API_VERSION = 'markets-v3'` 常量已导出
- `MarketsResponse.snapshot.version` 类型更新
- `marketsVersionBump.test.ts` 验证版本号

### 方案A：直接重命名（不推荐）

- 优点：彻底清理，代码更简洁
- 缺点：前后端需同步发布；DB 列名需同步迁移；无法回滚

### 方案C：仅新增字段（不推荐）

- 优点：完全向后兼容
- 缺点：旧字段永久保留，长期维护两套命名

## 执行顺序

> 测试先行（TDD）：Step 3 的测试必须在 Step 4 的代码实现之前编写并确认通过（RED→GREEN）。

```
Step 1: 修复 docs/api/api-documentation.md（精度/单位描述错误）
Step 2: 修复 aaveapy-doc/v3-v4-sdk-field-mapping.md（如有过时内容）
Step 3: 新增测试覆盖新字段名（V3+V4双端验证） ← TDD RED phase
Step 4: 后端双写新旧字段名（方案B Phase 1）       ← TDD GREEN phase
Step 5: 更新所有文档（field-glossary, precision docs 等）
Step 6: 前端迁移到新字段名
Step 7: 后端删除旧字段名 + DB migration + API version bump
```

### 为什么先修文档再重命名

当前 `docs/api/api-documentation.md` 的字段精度描述已经与实际 API 不一致——
仍标注为 RAY/BPS 单位，但精度统一后早已改为 `number` percent。
先修文档确保对照文档改代码时不会引入新的不一致。
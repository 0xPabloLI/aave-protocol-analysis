# ADR-0035: 统一单位转换系统 (units.ts)

## 状态

Implemented

## 上下文

AAV-1106 暴露了 `baseBorrowRate` 单位错误（RAY 小数误当作百分数），根因分析发现：

1. **转换函数散落 3 处**：`onchainDataService.ts` 本地 `rayStringToPercent`、`aave-rpc-infra/src/index.ts` 本地 `rayToPercent`、无共享入口
2. **字段单位无文档**：`RuntimeReserveData` 的 `number` 类型无法区分 ratio（0.04）还是 percent（4.0），依赖注释和口头约定
3. **V4 RPC fallback 用错函数**：`borrowApy` 是 ratio 字段（序列化器 ×100），但 V4 RPC 路径用 `rayToPercent()`（÷10^25 → 4.0 percent）赋值，序列化器再 ×100 → 400%
4. **无自动验证**：新增字段时没有测试验证单位一致性，错误只能通过手动数据对比发现

## 决策

### 1. 创建 `packages/aave-shared-contracts/src/units.ts` 作为唯一真相源

- **`FIELD_UNITS`**：声明 `RuntimeReserveData` 每个字段的内存单位（`'ratio'` | `'percent'` | `'number'` | `'string'` | `'boolean'` | `'campaignArray'`）
- **`SERIALIZER_RULES`**：从 `FIELD_UNITS` 自动派生，记录序列化器对每个字段的操作（`'multiply100'` | `'passthrough'`）
- **4 个转换函数**：`rayToRatio()`、`rayToPercent()`、`ratioToPercent()`、`percentToRatio()` — 全项目唯一入口

### 2. 单位约定

| 层 | `supplyApy`/`borrowApy`/`campaignApr` | `utilizationPct`/`slopes`/`baseBorrowRate`/`protocolFee` |
|---|---|---|
| **内存** (`RuntimeReserveData`) | ratio (0.04) | percent (4.0) |
| **API** (`MarketWithSpread`) | percent (4.0) | percent (4.0) |
| **序列化器** | ×100 | passthrough |

### 3. 三层测试安全网

| 测试 | 位置 | 防什么 |
|---|---|---|
| 注册表完整性 | `shared-contracts/tests/units.test.ts` | 新增字段忘记注册到 `FIELD_UNITS` |
| 转换函数正确性 | 同上 | `rayToRatio`/`rayToPercent` 对已知 RAY 值的输出 |
| 序列化器一致性 | `backend/tests/unitsConsistency.test.ts` | 序列化器实际行为与 `SERIALIZER_RULES` 不匹配 |
| AAV-1106 回归 | 同上 | V4 RPC `borrowApy` 存了 percent 而非 ratio |

### 4. 消除重复定义

- `onchainDataService.ts`：删除本地 `rayStringToPercent`，直接 import 共享 `rayToPercent`
- `aave-rpc-infra/src/index.ts`：删除本地 `rayToPercent`，`borrowApy` 改用共享 `rayToRatio`

## 关键代码点

| 文件 | 关键点 |
|---|---|
| `packages/aave-shared-contracts/src/units.ts` | `FIELD_UNITS`、`SERIALIZER_RULES`、转换函数 |
| `packages/aave-shared-contracts/src/index.ts` | re-export units.ts |
| `packages/aave-shared-contracts/tests/units.test.ts` | 注册表完整性 + 转换正确性 |
| `packages/aave-rpc-infra/src/index.ts` | `buildReserveData()` 中 `borrowApy = rayToRatio(...)` |
| `backend/src/services/onchainDataService.ts` | `rayToPercent` import 自 shared-contracts |
| `backend/src/services/marketsApiSerialize.ts` | 序列化器行为（被 `unitsConsistency.test.ts` 验证） |
| `backend/tests/unitsConsistency.test.ts` | 序列化器 ↔ 注册表一致性 |

## 后果

- 新增数值字段时必须注册到 `FIELD_UNITS`，否则 invariant 测试失败
- 禁止在其他包定义本地 `rayToPercent`/`rayToRatio` 等函数
- `SERIALIZER_RULES` 是声明式的，但序列化器本身是命令式手写代码——`unitsConsistency.test.ts` 弥合这个 gap

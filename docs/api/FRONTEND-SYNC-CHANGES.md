# 前端同步更新说明（Markets API 变更）

**文档版本**: 2026-03  
**后端变更摘要**: 撤销独立 rate-inputs 接口，所有数据统一由 `GET /api/markets` 返回；部分字段更名/移除，on-chain 字段可能缺失需前端 fallback。

---

## 1. 破坏性变更概览

| 变更类型 | 说明 |
|----------|------|
| **接口移除** | `GET /api/rate-inputs` 已下线，不再可用 |
| **数据源统一** | 原 rate-inputs 所需字段全部并入 `GET /api/markets` 的 `reserves[]` |
| **字段移除** | `totalScaledVariableDebt`、`variableBorrowIndex` 不再返回 |
| **字段新增** | `totalVariableDebt`（总借款，raw 单位，直接可用） |
| **可选 on-chain 字段** | `deficit`、`baseVariableBorrowRate` 可能缺失，前端必须做 fallback |

---

## 2. 数据获取方式变更

### 旧方式（已废弃）

```text
GET /api/markets          → 市场与 reserve 基础数据
GET /api/rate-inputs      → 利率计算用参数（按 chainId/asset/marketName 查）
```

### 新方式（当前）

```text
GET /api/markets          → 市场 + 全部 reserve 数据（含原 rate-inputs 字段）
```

- 仅保留一个接口：`GET /api/markets`。
- 原 `useReserveRateInputs` / 对 `/api/rate-inputs` 的请求应改为：使用 `/api/markets` 的 `reserves`，按 `chainId` + `tokenAddress`（及可选 `marketName`）定位到对应 reserve，从该条 reserve 上读取下列字段。

---

## 3. Reserve 字段变更明细

### 3.1 已移除字段（勿再使用）

| 字段 | 说明 | 替代方式 |
|------|------|----------|
| `totalScaledVariableDebt` | 缩放后总债务 | 使用 `totalVariableDebt`（已是实际债务，无需再乘 index） |
| `variableBorrowIndex` | 可变借款指数 (RAY) | 不再需要，直接使用 `totalVariableDebt` |

### 3.2 新增字段

| 字段 | 类型 | 单位/精度 | 说明 |
|------|------|-----------|------|
| `totalVariableDebt` | `string` | Raw token units | 总可变借款（实际值），对应原「scaledDebt × variableBorrowIndex / RAY」 |

### 3.3 仍存在且含义不变的字段（现均来自 Aave SDK）

| 字段 | 类型 | 单位/精度 | 说明 |
|------|------|-----------|------|
| `decimals` | `number` | 整数 | 代币精度 |
| `availableLiquidity` | `string` | Raw token units | 可用流动性 |
| `reserveFactor` | `string` | BPS（如 "2000" = 20%） | 储备因子 |
| `variableRateSlope1` | `string` | RAY (10²⁷) | 利率曲线斜率 1 |
| `variableRateSlope2` | `string` | RAY (10²⁷) | 利率曲线斜率 2 |
| `optimalUsageRate` | `string` | RAY (10²⁷) | 最优利用率 |

### 3.4 On-chain 字段（可能缺失，必须 fallback）

| 字段 | 类型 | 单位/精度 | 说明 | 缺失时建议 |
|------|------|-----------|------|------------|
| `deficit` | `string` | Raw token units | 坏账，用于 Supply APY 计算 | 使用 `"0"` |
| `baseVariableBorrowRate` | `string` | RAY (10²⁷) | 基础可变借款利率，用于模拟利率 | 使用 `"0"` |

- 后端在 RPC 失败或超时时会使用 30 分钟内缓存；若仍无数据则不会返回上述两字段。
- 前端应始终做「有则用，无则用默认值」的处理，并建议在 UI 上对「使用默认值」的情况做轻量提示（如小图标/tooltip）。

---

## 4. 精度与单位（与链上一致）

以下与原 on-chain 数据精度对齐，可直接用于现有公式（建议用 `BigInt` 做运算，避免 JS 精度问题）：

| 单位 | 说明 | 示例 |
|------|------|------|
| Raw token units | 与 `decimals` 一致 | `"4512942554869044630386380"` |
| BPS | 10000 = 100% | `reserveFactor`: `"2000"` = 20% |
| RAY | 10²⁷ | `variableRateSlope1`: `"90000000000000000000000000"` = 9% |

---

## 5. 前端必做改动清单

- [ ] **移除** 所有对 `GET /api/rate-inputs` 的调用及对应 hook（如 `useReserveRateInputs`）。
- [ ] **改为** 仅请求 `GET /api/markets`，从 `reserves` 中按 `chainId`、`tokenAddress`（及可选 `marketName`）取当前 reserve。
- [ ] **删除** 对 `totalScaledVariableDebt`、`variableBorrowIndex` 的引用；**改用** `totalVariableDebt` 作为总借款（无需再乘 index）。
- [ ] **对 `deficit`、`baseVariableBorrowRate` 做 fallback**：  
  `deficit = reserve.deficit ?? '0'`，`baseVariableBorrowRate = reserve.baseVariableBorrowRate ?? '0'`。
- [ ] **（可选）** 当使用 fallback 值时，在模拟/APY 相关 UI 上做轻量提示。

---

## 6. 类型定义参考（TypeScript）

```typescript
// 从 /api/markets 的 reserves 中取出的单条 reserve 类型（与利率计算相关部分）
interface ReserveForRateCalc {
  chainId: number;
  tokenAddress: string;
  marketName?: string;

  decimals?: number;
  availableLiquidity?: string;
  totalVariableDebt?: string;   // 新增，替代 totalScaledVariableDebt + variableBorrowIndex
  reserveFactor?: string;
  variableRateSlope1?: string;
  variableRateSlope2?: string;
  optimalUsageRate?: string;

  // On-chain，可能缺失
  deficit?: string;
  baseVariableBorrowRate?: string;
}

// 使用示例
function getRateInputsFromReserve(reserve: ReserveForRateCalc) {
  const deficit = reserve.deficit ?? '0';
  const baseVariableBorrowRate = reserve.baseVariableBorrowRate ?? '0';
  const totalVariableDebt = reserve.totalVariableDebt ?? '0';
  // ...
}
```

---

## 7. 相关文档

- 完整 API 说明：`docs/api/api-documentation.md`
- 利率/公式与数据来源：`docs/api/native-apr-calculation.md`
- 精度与单位对比：`docs/backend/data-precision-comparison.md`

如有疑问可联系后端或对照上述文档。

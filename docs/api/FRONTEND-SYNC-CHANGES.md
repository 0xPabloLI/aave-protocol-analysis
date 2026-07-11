# 前端同步更新说明（Markets API 变更）

**文档版本**: 2026-03  
**后端变更摘要**: 撤销独立 rate-inputs 接口，所有数据统一由 `GET /api/markets` 返回；部分字段更名/移除，`deficit`/`baseVariableBorrowRate`/`totalVariableDebt` 已由后端保证返回。

---

## 1. 破坏性变更概览

| 变更类型 | 说明 |
|----------|------|
| **接口移除** | `GET /api/rate-inputs` 已下线，不再可用 |
| **数据源统一** | 原 rate-inputs 所需字段全部并入 `GET /api/markets` 的 `reserves[]` |
| **字段移除** | `totalScaledVariableDebt`、`variableBorrowIndex` 不再返回 |
| **字段新增** | `totalVariableDebt`（总借款，raw 单位，直接可用） |
| **字段保障** | `deficit`、`baseVariableBorrowRate`、`totalVariableDebt` 由后端保证返回，可直接使用 |

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

### 3.4 On-chain 字段（后端保证返回）

| 字段 | 类型 | 单位/精度 | 说明 |
|------|------|-----------|------|
| `deficit` | `string` | Raw token units | 坏账，用于 Supply APY 计算 |
| `baseVariableBorrowRate` | `string` | RAY (10²⁷) | 基础可变借款利率，用于模拟利率 |

- 后端已保证上述字段在响应中可用（含后端侧降级处理）；前端可直接使用，无需额外 fallback。

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
- [ ] **直接使用** `deficit`、`baseVariableBorrowRate`、`totalVariableDebt`（后端已保证返回）。

---

## 6. 类型定义参考（TypeScript）

```typescript
// 从 /api/markets 的 reserves 中取出的单条 reserve 类型（与利率计算相关部分）
interface ReserveForRateCalc {
  chainId: number;
  tokenAddress: string;
  marketName?: string;

  decimals: number;
  availableLiquidity: string;
  totalVariableDebt: string;   // 新增，替代 totalScaledVariableDebt + variableBorrowIndex
  reserveFactor: string;
  variableRateSlope1: string;
  variableRateSlope2: string;
  optimalUsageRate: string;
  deficit: string;
  baseVariableBorrowRate: string;
}

// 使用示例
function getRateInputsFromReserve(reserve: ReserveForRateCalc) {
  const deficit = reserve.deficit;
  const baseVariableBorrowRate = reserve.baseVariableBorrowRate;
  const totalVariableDebt = reserve.totalVariableDebt;
  // ...
}
```

---

## 7. 相关文档

- 完整 API 说明：`docs/api/api-documentation.md`
- 利率/公式与数据来源：`docs/api/native-apr-calculation.md`
- 精度与单位对比：`docs/backend/data-precision-comparison.md`

---

## 8. 如何向后端 API 添加新的 Reserve 字段

当需要添加新的 reserve 字段到 API 响应时，根据字段类型在不同位置进行修改。序列化层已重构为**透传区/变换区/覆写区**三段结构，并有序列化覆盖测试作为安全网。

### 8.1 字段分类与修改位置

新增字段首先需要判断它属于哪一类：

| 分类 | 判断标准 | 序列化处理 | 修改位置 |
|------|---------|-----------|---------|
| **透传字段** | 值不变，只需 `!== undefined` 过滤 | 自动由 `pickDefined` + `PASSTHROUGH_FIELDS` 处理 | 1, 2, 3, 5(透传区) |
| **变换字段** | 需 roundTo6 / ×100 等数值变换 | 需在序列化变换区手动添加 | 1, 2, 3, 5(变换区), 6(fingerprint) |
| **覆写字段** | 激励数组等类型不同的字段 | 需在序列化覆写区手动添加 | 1, 2, 3, 5(覆写区), 6(fingerprint) |

### 8.2 必须修改的位置

| 顺序 | 文件 | 修改内容 | 说明 |
|------|------|----------|------|
| 1 | `packages/aave-shared-contracts/src/index.ts` | `RuntimeReserveData` 接口 + `EXPECTED_RUNTIME_FIELDS` 数组 | 共享类型定义 + 字段注册表（编译期双向绑定自动验证） |
| 2 | Fetcher 文件 (`v4-fetcher.ts` / `index.ts`) | V4 数据填充 / V3 默认值 | 从 SDK 读取并赋值 |
| 3 | `backend/src/services/marketsApiSerialize.ts` | 根据字段分类添加到对应区 | 见 8.1 分类表 |
| 4 | `backend/tests/marketsApiSerialize.test.ts` | `makeFullReserve()` mock | 覆盖测试自动验证序列化输出包含所有字段 |

**不再需要修改的文件**：
- ~~`packages/aave-fetcher/src/index.ts` 的 `pruneReserveForRuntime()`~~ — 该函数已不存在
- ~~`backend/src/types/index.ts` 的 `MarketWithSpread`~~ — 通过 `Omit<RuntimeReserveData, ...> & {...}` 自动继承非覆写字段

### 8.3 序列化层结构（参考）

```typescript
// marketsApiSerialize.ts 中 serializeReserveForApi 的结构：

export function serializeReserveForApi(reserve: RuntimeReserveData): MarketWithSpread {
  return {
    // 1. 必填字段（reserveId, marketName, ...）
    // 2. pickDefined 透传区 — PASSTHROUGH_FIELDS 数组中的字段
    // 3. 布尔开关手动区 — isFrozen, isPaused, isActive, supplyDisabled, borrowDisabled
    // 4. 特殊条件区 — decimals, aaveProReserveId
    // 5. 变换区 — supplyApy/borrowApy (×100), protocolFee/slopes (roundTo6)
    // 6. 覆写区 — 激励数组 (scaleMeritEntry/scaleMerklBreakdown/scaleBrevisBreakdown)
  };
}
```

**新增透传字段**：只需在 `PASSTHROUGH_FIELDS` 数组加一行 + 步骤1/2修改。
**新增变换字段**：需在变换区手动添加 roundTo6 处理 + 步骤1/2/3修改 + fingerprint canonical 更新。

### 8.4 安全网：序列化覆盖测试

`marketsApiSerialize.test.ts` 中的覆盖测试会自动验证：给定全字段 `RuntimeReserveData`，序列化输出的 key 集合包含所有 `EXPECTED_RUNTIME_FIELDS` 中的字段。**漏加字段会测试失败**。

### 8.5 构建验证顺序

```bash
# 1. 先构建 root (生成 dist/ 供 backend 导入)
npm run build

# 2. 再构建 backend
npm run build -w aave-dashboard-backend

# 3. 运行 backend 测试
npm run test -w aave-dashboard-backend
```

### 8.4 V4 Hub/Spoke 字段示例

本次添加的 V4 专属字段（用于 pro.aave.com 链接和合约交互）：

```typescript
// GET /api/markets 响应中的 V4 reserve
{
  "hubId": "MTo6MHhDY2E4NTJCYzQwZTU2MGFkQzNi...",
  "hubName": "Core",
  "hubAddress": "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9",
  "spokeId": "MTo6MHg5NGU3QTVkQ2JFODE2ZTQ5OGI4...",
  "spokeName": "Main",
  "spokeAddress": "0x94e7A5dCbE816e498b89aB752661904E2F56c485"
}
```

前端可拼接的链接：
- Hub 页面: `https://pro.aave.com/explore/hub/${hubId}`
- Reserve 页面: `https://pro.aave.com/explore/reserve/${aaveProReserveId}`

### 8.5 架构说明

为什么有这么多层？

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Root Fetcher  │────▶│   prune function   │────▶│  Backend API    │
│   (packages/aave-fetcher/src/index.ts)│     │ (pruneReserveFor  │     │ (backend/src/)   │
│                 │     │   Runtime)         │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
       │                                               │
       │ Aggregates data from Aave, Merit, Merkl,      │ Serves HTTP
       │ Brevis, V4 SDK...                              │ API
       ▼                                               ▼
   RuntimeReserveData                          MarketWithSpread
```

- `RuntimeReserveData`: 数据聚合阶段的完整结构
- `RuntimeReserveData`: 经过 prune 后写入磁盘的精简结构
- `MarketWithSpread`: HTTP API 返回的最终结构

### 8.6 相关文件速查

| 层级 | 文件 | 作用 |
|------|------|------|
| Root 类型 | `packages/aave-shared-contracts/src/index.ts` | `RuntimeReserveData` 接口定义 |
| Root 获取/裁剪 | `packages/aave-fetcher/src/index.ts` | `pruneReserveForRuntime()` |
| Root 获取 | `packages/aave-fetcher/src/v4-fetcher.ts` | V4 数据获取，填充字段 |
| Backend 类型 | `backend/src/types/index.ts` | `MarketWithSpread` API 响应接口 |
| Backend 序列化 | `backend/src/services/marketsApiSerialize.ts` | `serializeReserveForApi()` |
| Backend 数据模型 | `backend/src/services/marketsService.ts` | 使用 `RuntimeReserveData` |

如有疑问可联系后端或对照上述文档。

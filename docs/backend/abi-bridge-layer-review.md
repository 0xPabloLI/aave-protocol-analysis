# ABI Bridge Layer — 架构

> 范围：[backend/src/abis/](../../backend/src/abis/) 及其在 services 层的消费
> 更新日期：2026-05

---

## 1. 架构（upstream + local 二层）

| 层 | 含义 | 来源 |
|---|---|---|
| Upstream | 上游包原生导出，消费侧直接 import | `@aave-dao/aave-address-book/abis/*`、`@internal/aave-rpc-infra` |
| Local | 后端本地补充，`abis/` 目录唯一职责 | `backend/src/abis/v4-oracle-prices.ts` |

`abis/index.ts` **只 re-export 本地定义**，不再透传上游。消费侧直接从上游包导入上游 ABI。

### 1.1 ABI 归属表

| ABI 名 | 层 | 细分 | 来源包 | 备注 |
|---|---|---|---|---|
| `ISpokeV4_ABI` | Upstream | upstream | `@aave-dao/aave-address-book/abis/ISpokeV4` | 完整 Spoke 接口 |
| `IAaveOracle_ABI` | Upstream | upstream | `@aave-dao/aave-address-book/abis/IAaveOracle` | V3 oracle |
| `IPool_ABI` | Upstream | upstream | `@aave-dao/aave-address-book/abis/IPool` | V3 pool |
| `V4_HUB_FULL_ABI` | Upstream | shared | `@internal/aave-rpc-infra` | `IHubV4_ABI + HUB_EXTENSIONS_ABI` composite |
| `V4_ORACLE_PRICES_ABI` | Local | local | `backend/src/abis/v4-oracle-prices.ts` | 仅 `getReservesPrices`（上游 `IAaveOracleV4_ABI` 只有 `getReserveSource`，不适用） |

### 1.2 为什么不保留 re-export 单入口？

旧架构用 `abis/index.ts` 做 5 个 ABI 的统一 re-export 入口。其中 4 个是纯透传（无任何本地加工）。精简后：

- 消费侧直接 import 上游包，路径更短、来源更明确
- `abis/` 职责单一：只管本地补充
- 深路径拦截规则简化：允许 `@aave-dao/aave-address-book/abis/*`（消费侧合法入口），只禁止根 barrel import

---

## 2. CI 约束

| 约束 | 测试文件 | 内容 |
|---|---|---|
| 禁止内联 ABI 字面量 | `tests/no-inline-abi.test.ts` | `backend/src/services/**` 不得含 `type: 'function'` 数组 |
| 禁止 address-book 根 barrel import | `tests/no-inline-abi.test.ts` | services（除 `addressBookRegistry.ts`）不得 `from '@aave-dao/aave-address-book'` |
| 本地补充不与上游 overlap | `tests/abi-drift.test.ts` | `V4_ORACLE_PRICES_ABI` 方法不得已在 `IAaveOracle_ABI` 中 |
| 上游 ABI drift 检测 | `tests/abi-drift.test.ts` | 必须 method 存在 + 最小 function count |

---

## 3. 决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 单入口 re-export vs 消费侧直导 | **消费侧直导** | 4/5 是纯透传，单入口无附加价值；直导路径更短来源更明确 |
| 深路径导入合法性 | **合法** | `@aave-dao/aave-address-book` exports 声明 `./*` 通配符，官方支持 |
| `getReservesPrices` 放哪 | **Local 层** | 上游 `IAaveOracleV4_ABI` 只有 `getReserveSource`，方法不重叠 |
| `getSpokeDeficitRay` 放哪 | **Upstream (shared: aave-rpc-infra)** | 已迁至共享包，backend 只消费 |

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

---

## 4. 新增 ABI 规范

### 4.1 合法入口（仅 3 条）

| 入口 | 路径模式 | 适用场景 |
|---|---|---|
| A. address-book 深路径 | `@aave-dao/aave-address-book/abis/<ContractName>` | 上游包已导出的标准合约 ABI |
| B. shared 包 | `@internal/aave-rpc-infra` | 我们自己 shared 包定义/组装的 ABI（含上游未暴露方法的补充、composite ABI） |
| C. 本地补充 | `../abis/index.js`（消费侧）→ 定义放 `backend/src/abis/<name>.ts` | 上游和 shared 都不提供，且仅 backend 使用的补充 ABI |

**禁止的入口：**
- `@aave-dao/aave-address-book`（根 barrel，拿地址用 `addressBookRegistry`，拿 ABI 用深路径 A）
- `backend/src/services/` 内 inline ABI 字面量

### 4.2 决策树

```
新增 ABI_X
  │
  ├─ address-book/abis/ 已有？
  │   └─ 是 → 入口 A，消费侧直接 import，无需本地文件
  │
  ├─ aave-rpc-infra 已有或适合放入？
  │   ├─ 是（多项目共用 / 组合 ABI / 上游未暴露方法）→ 入口 B
  │   └─ 否 ↓
  │
  └─ 仅 backend 使用且无上游来源？
      └─ 是 → 入口 C：在 abis/ 新建文件 → index.ts re-export → 消费侧从 ../abis/index.js 导入
```

### 4.3 落地检查清单

新增 ABI 后，逐项确认：

- [ ] **定义落位**：按决策树选对入口（A/B/C）
- [ ] **归属表**：在 §1.1 新增一行（ABI 名 / 层 / 细分 / 来源包 / 备注）
- [ ] **HARDCODE 文档**：若属入口 B 或 C，在 `HARDCODE-AND-EXTERNAL-IMPORTS.md` §2.1 对应行补充
- [ ] **drift test**：`backend/tests/abi-drift.test.ts` 添加 drift 断言（method 存在 + 最小 function count）
- [ ] **overlap 检测**：若属入口 C，在 drift test 中添加与上游 ABI 的 overlap 断言
- [ ] **no-inline-abi test**：若新增了 service 文件，确认被 `no-inline-abi.test.ts` 的 glob 覆盖
- [ ] **CI 验证**：`npm run test -w aave-dashboard-backend` 全绿

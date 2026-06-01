# PRD: ABI Bridge Layer — 二层精简方案（事后追认）

> 状态：代码已落地，本 PRD 为事后追认 + 遗留项规划
> 前置 PRD：已归档（基于旧三层架构，已被本方案取代）

---

## Problem Statement

旧三层架构（L1 re-export / L2 本地补充 / L3 组合）中 4/5 ABI 是纯透传 re-export，`abis/index.ts` 单入口无附加价值。消费侧 import 路径反而更长、来源更模糊。且 `HUB_EXTENSIONS_ABI` 住在 `@internal/aave-rpc-infra`（我们自己的 shared 包），文档归类为 "upstream" 不准确。

## Solution（已落地）

1. 删除 4 条纯透传 re-export，`abis/index.ts` 只 re-export 本地定义的 `V4_ORACLE_PRICES_ABI`
2. 消费侧直接从上游包 import 上游 ABI（address-book 深路径 + aave-rpc-infra）
3. CI 规则翻转：**允许**深路径导入，**禁止**根 barrel import
4. 新增 `no-inline-abi.test.ts`（禁内联 ABI + 禁根 barrel import）
5. 扩展 `abi-drift.test.ts`（overlap 检测 + 跨层方法断言）
6. 文档全量重写为 upstream + local 二层架构

### ABI 归属（二层）

| ABI | 层 | 来源 | 方法 |
|---|---|---|---|
| `ISpokeV4_ABI` | Upstream | `@aave-dao/aave-address-book/abis/ISpokeV4` | 完整 Spoke 接口 |
| `IAaveOracle_ABI` | Upstream | `@aave-dao/aave-address-book/abis/IAaveOracle` | V3 oracle |
| `IPool_ABI` | Upstream | `@aave-dao/aave-address-book/abis/IPool` | V3 pool |
| `V4_HUB_FULL_ABI` | Shared | `@internal/aave-rpc-infra` | `IHubV4_ABI`（upstream）+ `HUB_EXTENSIONS_ABI`（shared-local composite） |
| `V4_ORACLE_PRICES_ABI` | Local | `backend/src/abis/v4-oracle-prices.ts` | `getReservesPrices`（上游 `IAaveOracleV4_ABI` 只有 `getReserveSource`） |

### HUB_EXTENSIONS_ABI 说明

只含 **1 个方法**：`getSpokeDeficitRay(uint256 assetId, address spoke) → uint256`

这是我们自己硬编码的 ABI，因为 `@aave-dao/aave-address-book` 的 `IHubV4_ABI` 未暴露此方法。它住在 `@internal/aave-rpc-infra`，该包是我们自己的 shared 包（非第三方上游），归类为 **shared-local** 更准确。当前文档标注 "Upstream" 是简写，需修正为 "Shared"。

### 聚合层判断

消费侧实际 import（grep 验证）：

| 渠道 | 消费文件 | ABI |
|---|---|---|
| `@aave-dao/aave-address-book/abis/*` | `oracleService.ts` | ISpokeV4, IAaveOracle, IPool |
| `@internal/aave-rpc-infra` | `onchainDataService.ts` | V4_HUB_FULL_ABI |
| `backend/src/abis/index.js` | `oracleService.ts` | V4_ORACLE_PRICES_ABI |

每个 ABI 只有 1 个消费点，3 渠道零交叉。**不需要重新引入聚合层**。若未来 ABI 消费方 >1 或需运行时切换来源，再引入不迟。

## User Stories（已落地 ✅ / 遗留 ❌）

1. ✅ 作为后端开发者，CI 拦截服务文件中的内联 ABI 数组
2. ✅ 作为后端开发者，CI 拦截 address-book 根 barrel import（**深路径允许**，规则已翻转）
3. ✅ 作为后端开发者，CI 检测 local 层方法与上游重叠
4. ✅ 作为后端开发者，CI 验证 V4_HUB_FULL_ABI 包含 upstream + shared-local 方法
5. ✅ 作为后端开发者，文档使用 upstream/local 二层命名（非 L1/L2/L3）
6. ✅ 作为后端开发者，决策记录包含"上游缺失方法 → local 层"原则
7. ✅ 作为后端开发者，ABI 归属表中 `V4_HUB_FULL_ABI` 层标注从 "Upstream" 修正为 "Shared"
8. ✅ 作为后端开发者，HARDCODE 文档 §6 补上 `MULTICALL3_ADDRESS` 索引（地址已迁到 `@internal/aave-rpc-infra`，地址已修正为 canonical `0xcA11bde05977b3631167028862bE2a173976CA11`）

## Implementation: 遗留项

### 项 A: V4_HUB_FULL_ABI 层标注修正

- 文件：`docs/backend/abi-bridge-layer-review.md` §1.1 ABI 归属表
- 改动：`V4_HUB_FULL_ABI` 层列从 `Upstream` → `Shared`
- 文件：`docs/backend/HARDCODE-AND-EXTERNAL-IMPORTS.md` §2.1 二层结构表
- 改动：Upstream 行拆分为 Upstream（address-book）+ Shared（aave-rpc-infra）两行
- 理由：`@internal/aave-rpc-infra` 是我们自己的 shared 包，非第三方上游

### 项 B: MULTICALL3_ADDRESS 文档索引

- 文件：`docs/backend/HARDCODE-AND-EXTERNAL-IMPORTS.md` §6
- 改动：末尾新增 `MULTICALL3_ADDRESS` 行，标注来源 `@internal/aave-rpc-infra`
- 理由：地址审计时不应遗漏通用预部署合约

### 项 C: 二层架构正式承认（非 upstream + local，而是 upstream + shared + local）

当前文档写 "upstream + local 二层"，但 `V4_HUB_FULL_ABI` 来自 shared 包，不是纯 upstream 也不是纯 local。选择：
- **方案 1**：保持二层，把 shared 包视作 upstream 的一种（当前做法，加注释说明）
- **方案 2**：改为三层 upstream / shared / local，语义最准确

**建议方案 1**：三层只在文档层面增加分类复杂度，代码不需要任何变化。在归属表的"备注"列加 `shared-local composite` 说明即可。

## Testing Decisions

- 已落地的 CI 测试通过 `npm run test -w aave-dashboard-backend` 验证
- 新增测试均遵循"只测外部可观察行为"原则
- `no-inline-abi.test.ts`：完全独立，零运行时依赖
- `abi-drift.test.ts`：扩展已有 describe 结构

## Out of Scope

- §2.3 Interface 实例下沉（会打破 abis/ 纯数据边界）
- §2.4 `as const` 类型一致性（零收益）
- §2.7 ISpokeV4_ABI 裁剪版（过早优化）
- `abis/index.ts` #region 注释（只剩 1 行 re-export，无意义）
- 聚合层重新引入（每个 ABI 只有 1 个消费方，直导更清晰）

## Further Notes

- 精简方案落地时流程违规（未走 to-prd → to-issues → TDD），本 PRD 为事后追认
- `HUB_EXTENSIONS_ABI` 的 `getSpokeDeficitRay` 方法在 Hub 合约上存在但 `IHubV4_ABI` 未包含——这是 Aave address-book 的已知缺失
- `addressBookRegistry.ts` 直接导入 `@aave-dao/aave-address-book` 根模块（取地址数据非 ABI），no-inline-abi 测试豁免

# AAV-1222 Spec: Per-reserve ltv + liquidationThreshold 字段

## Problem Statement

前端 AAV-756（Portfolio LTV constraint + Net Effective APY + Health Factor，Urgent）阻塞于后端 `GET /markets` API 缺少 per-reserve `ltv` 和 `liquidationThreshold` 字段。前端无法计算最大可借量、Health Factor，也无法恢复 Net Effective APY。

## Solution

在 `GET /markets` API 每个 reserve 中增加 `ltv`（percent）和 `liquidationThreshold`（percent）字段，全链路从 shared-contracts 类型注册 → fetcher 提取 → 序列化器输出。V3 和 V4 统一字段名；V4 的 `collateralFactor` 双填到两个字段。

## User Stories

1. 作为前端开发者，我希望 API 每个 reserve 返回 `ltv` 字段，以便计算 Portfolio Simulation 的最大可借量（`maxBorrowUsd = Σ(supplyUsd_i × ltv_i / 100)`）
2. 作为前端开发者，我希望 API 每个 reserve 返回 `liquidationThreshold` 字段，以便计算 Health Factor（`HF = Σ(supplyUsd × liquidationThreshold_i / 100) / totalBorrowUsd`）
3. 作为前端开发者，我希望 V3 和 V4 使用统一字段名，以便用同一公式处理两个版本（V3 有缓冲：ltv < LT；V4 无缓冲：ltv = LT = collateralFactor）
4. 作为前端开发者，我希望 `ltv` 和 `liquidationThreshold` 使用 percent 单位（80 = 80%），与 `utilizationPct`、`protocolFee`、`collateralRisk` 等现有字段一致
5. 作为前端开发者，我希望 frozen 资产的 `ltv` 反映链上运行时状态（V3 frozen → ltv=0），以便自动阻止用户对 frozen 资产发起借款模拟

## Implementation Decisions

### 字段定义

- `ltv?: number` — percent（80 = 80%），抵押率，决定最大可借比例
- `liquidationThreshold?: number` — percent（82.5 = 82.5%），清算触发线
- 两者均为 optional（V3 仅供应资产无 `supplyInfo` 时、V4 RPC fallback 时为 `undefined`）

### 单位约定

- In-memory（`RuntimeReserveData`）：`percent`（80.0 = 80%）
- API output（`MarketWithSpread`）：`percent`（80.0 = 80%），序列化器 passthrough + `roundTo6`
- `FIELD_UNITS` 注册为 `'percent'`，`SERIALIZER_RULES` → `'passthrough'`
- 与 `collateralRisk`、`utilizationPct`、`protocolFee` 等现有 percent 字段完全一致

### V3 数据来源

- `ltv`：`reserve.supplyInfo.maxLTV.value`（decimal fraction，如 0.8）→ `percentValueToPercent()` → 80
- `liquidationThreshold`：`reserve.supplyInfo.liquidationThreshold.value`（decimal fraction，如 0.775）→ `percentValueToPercent()` → 77.5
- 提取位置：`buildV3BaseDataset()` 中，已有从 `supplyInfo` 提取 `apy`、`supplyCap` 的代码，同模式新增
- Frozen 时 SDK 反映合约运行时状态：`maxLTV` → 0，`liquidationThreshold` 不变

### V4 数据来源

- `collateralFactor`：`r.settings.collateralFactor.value`（decimal fraction，如 0.8）→ `percentValueToPercent()` → 80
- **双填策略**：`ltv = collateralFactor`，`liquidationThreshold = collateralFactor`（V4 架构中两者本就是同一值）
- 提取位置：`fetchV4MarketsDataInner()` 中，已有从 `r.settings` 提取 `collateralRisk` 的代码，同模式新增

### 序列化器

- `PASSTHROUGH_FIELDS` 不动（ltv/liquidationThreshold 不是 raw amounts）
- 显式输出：`...(reserve.ltv !== undefined ? { ltv: roundTo6(reserve.ltv) } : {})`，同 `collateralRisk` 模式
- `computeSchemaFingerprint()` 的 canonical reserve 需加上 `ltv` 和 `liquidationThreshold`

### V4 RPC fallback

- 不提取 `ltv`/`liquidationThreshold`，留 `undefined`（`collateralFactor` 属于 `DynamicReserveConfig`，不在 `HubAsset` 上）
- 另开 issue 处理 RPC fallback 的 `collateralFactor` 获取

### 不新增 `collateralFactor` 字段

- `collateralFactor` 的信息已被 `ltv` 和 `liquidationThreshold` 完整捕获
- 前端公式无需版本分支

## Testing Decisions

### 测试 seam

1. **shared-contracts invariant tests**（`packages/aave-shared-contracts/tests/units.test.ts`）— 验证 `ltv`/`liquidationThreshold` 注册到 `FIELD_UNITS` 为 `'percent'`，`EXPECTED_RUNTIME_FIELDS` 包含两个新字段
2. **Backend serializer tests**（`backend/tests/marketsApiSerialize.test.ts`）— 验证 `serializeReserveForApi()` 正确输出 `ltv`/`liquidationThreshold`（passthrough + roundTo6）
3. **Backend units consistency test**（`backend/tests/unitsConsistency.test.ts`）— canonical reserve 加上新字段，验证 passthrough 行为
4. **Backend fingerprint test**（`backend/tests/apiSchemaFingerprint.test.ts`）— 更新 `EXPECTED_FINGERPRINT`
5. **V3 fetcher test**（`packages/aave-fetcher/tests/fetchMarketsData-concurrency.test.ts`）— mock `supplyInfo.maxLTV` / `supplyInfo.liquidationThreshold`，验证提取
6. **V4 fetcher test** — mock `settings.collateralFactor`，验证双填

### 测试原则

- 只测外部行为（公共接口），不测内部实现细节
- 用已知的 literal 值（如 0.8 → 80），不用同源计算
- 现有测试模式（`unitsConsistency.test.ts` 的 `buildCanonicalReserve`）为 prior art

## Scenario & Risk Verification Matrix

| #   | 场景                                  | 输入                                                                                  | 预期输出                                          | 风险类别     | 测试位置             |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------ | -------------------- |
| S1  | V3 正常 reserve，ltv=80%, LT=82.5%    | `supplyInfo.maxLTV.value="0.8"`, `supplyInfo.liquidationThreshold.value="0.775"`      | `ltv=80`, `liquidationThreshold=82.5`             | 数据一致性   | V3 fetcher test      |
| S2  | V4 正常 reserve，collateralFactor=80% | `settings.collateralFactor.value="0.8"`                                               | `ltv=80`, `liquidationThreshold=80`               | 数据一致性   | V4 fetcher test      |
| S3  | V3 frozen reserve                     | `supplyInfo.maxLTV.value="0"` (SDK 反映 frozen), `liquidationThreshold.value="0.825"` | `ltv=0`, `liquidationThreshold=82.5`              | 运行时状态   | V3 fetcher test      |
| S4  | V3 仅供应资产（无 supplyInfo）        | `reserve.supplyInfo` = undefined                                                      | `ltv=undefined`, `liquidationThreshold=undefined` | 缺失数据     | V3 fetcher test      |
| S5  | V4 RPC fallback                       | V4 SDK 挂掉，走 RPC                                                                   | `ltv=undefined`, `liquidationThreshold=undefined` | 降级路径     | 现有 RPC test 不需改 |
| S6  | 序列化器 passthrough                  | `ltv=80.123456789`                                                                    | API 输出 `ltv=80.123457` (roundTo6)               | 精度         | serializer test      |
| S7  | undefined 不出现在 JSON               | `ltv=undefined`                                                                       | JSON 中无 `ltv` key                               | payload 精简 | serializer test      |
| S8  | FIELD_UNITS 注册完整性                | 新增字段后                                                                            | `units.test.ts` 自动通过                          | 类型安全     | invariant test       |
| S9  | Schema fingerprint 变化               | canonical reserve 加新字段                                                            | fingerprint 改变，test 失败需更新                 | CI/CD        | fingerprint test     |
| S10 | unitsConsistency passthrough          | canonical reserve `ltv=4`                                                             | API 输出 `ltv=4`（不 ×100）                       | 单位安全     | consistency test     |

## Out of Scope

- V4 RPC fallback 路径获取 `collateralFactor`（另开 issue）
- 前端 AAV-756 的 Portfolio LTV / HF / Net Effective APY 实现（AAV-756 issue）
- 前端 `ReserveWithSpread` 类型更新（AAV-756 同步处理）
- 新增 `collateralFactor` 独立字段（不需要）
- `collateralRisk` 字段的消费端实现（AAV-333）

## Further Notes

- V4 `collateralFactor` 双填到 `ltv` + `liquidationThreshold` 不是近似——V4 合约设计中两者本就是同一个值
- V3 frozen 时合约自动将 LTV 设为 0，GraphQL SDK 从 subgraph 读取会反映此状态
- 参考文档：`aaveapy-doc/v3-v4-collateral-and-health-factor.md` §四（AAV-1222 API 映射策略）

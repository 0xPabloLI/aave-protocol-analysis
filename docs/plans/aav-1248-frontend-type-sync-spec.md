# AAV-1248 Spec: 前端 ReserveWithSpread 类型加 ltv/liquidationThreshold + fingerprint sync

> **追溯 Spec** — 代码已实现并推送（commit `879f289f` on `lovable`）。此文档为标准工作流补走产物。

## Problem Statement

后端 AAV-1222 已在 `GET /markets` API 返回 `ltv` 和 `liquidationThreshold`（percent 单位），但前端 `ReserveWithSpread` 类型缺少这两个字段，schema fingerprint 仍为旧值 `541bf2ebdf0c`。前端无法消费后端新字段，AAV-756 P3（maxBorrow 约束）和 P4（模拟 HF）被阻塞。

## Solution

在前端 `aaveapy` 仓库完成 4 项变更：

1. `ReserveWithSpread` interface 新增 `ltv?: number` 和 `liquidationThreshold?: number`
2. 从 staging API 拉取最新 OpenAPI spec → 重新生成 Zod schema（codegen 自动包含新字段）
3. `schema-fingerprint.ts` 从 `541bf2ebdf0c` 更新为 `2d1059421baf`
4. `field-canary.test.ts` 新增 canary 测试

## User Stories

1. 作为 P3 开发者，我希望 `reserve.ltv` 在前端类型中可用，以便计算 `maxBorrowUsd = Σ(supplyUsd × ltv / 100) - Σ(borrowUsd)`
2. 作为 P4 开发者，我希望 `reserve.liquidationThreshold` 在前端类型中可用，以便计算 `HF = Σ(supplyUsd × liquidationThreshold / 100) / Σ(borrowUsd)`
3. 作为前端开发者，我希望 Zod schema 自动通过 codegen 包含新字段，以便运行时 schema validation 不 strip 掉 ltv/LT
4. 作为前端开发者，我希望 schema fingerprint 与后端一致，以便缓存失效机制正确触发

## Implementation Decisions

### 字段定义

- `ltv?: number` — percent（80 = 80%），optional
- `liquidationThreshold?: number` — percent（82.5 = 82.5%），optional
- 位置：`ReserveWithSpread` interface 中 `baseBorrowRate` 之后、"Protocol incentives" 之前（collateral 参数区）

### Optional 而非 Required

- 后端 serializer 使用条件 spread（`undefined → omit`），API JSON 中不出现该 key
- `ReserveWithSpread` 现有所有数值字段均为 optional（`supplyApy?`, `borrowApy?`, `utilizationPct?` 等）
- P3/P4 消费者需处理 `undefined`：`reserve.ltv ?? 0`（P2 scope 外）

### Zod Schema 策略

- **不手动 `.extend()`**：`ReserveWithSpreadSchema` extends `generated.MarketWithSpread`，codegen 自动包含 `ltv: z.number().optional()` 和 `liquidationThreshold: z.number().optional()`
- Zod default strip mode 不会 strip 已注册字段

### OpenAPI Spec 来源

- 从 **staging** API 拉取（`staging-api.aaveapy.com/api`），因为 production 尚未部署 AAV-1222
- CI `openapi-check` 也默认从 staging 拉取（`LIVE_API_BASE` fallback = staging），来源一致，不会 CI fail
- `openapi-sync` 自动安全网：检测到 drift 时自动创建 PR 同步 spec + schema

### Schema Fingerprint

- 后端 `generate-schema-fp.ts` 生成 `2d1059421baf`
- 前端 `schema-fingerprint.ts` 手动更新为 `2d1059421baf`
- 两者必须一致，否则前端缓存失效机制失效

### V3 vs V4 语义（类型注释）

- V3: `ltv` = `baseLTVasCollateral`（较低），`liquidationThreshold`（较高）— 有安全缓冲
- V4: 两者 = `collateralFactor`（同值）— 无缓冲
- 前端公式统一，无版本分支：`ltv` 用于 maxBorrow，`liquidationThreshold` 用于 HF

## Testing Decisions

### 测试 seam

`field-canary.test.ts` — 类型级 canary 测试，验证字段存在性和语义

### 测试原则

- Canary 测试只验证类型级属性（optional、number type、V3/V4 语义差异），不验证运行时数据
- Schema validation 由 generated Zod schema 保证，不需要额外测试
- 完整的 API 响应 schema validation 由 `apiSchemas.test.ts` 覆盖（已有）

## Scenario & Risk Verification Matrix

| #   | 场景                                    | 输入                                            | 预期行为                                            | 风险类别    | 验证方式                      | 状态 |
| --- | --------------------------------------- | ----------------------------------------------- | --------------------------------------------------- | ----------- | ----------------------------- | ---- |
| S1  | ltv 字段 optional，未设置时为 undefined | mock reserve 不含 ltv                           | `mock.ltv` === `undefined`                          | 类型安全    | canary test `reserve.ltv`     | ✅   |
| S2  | ltv 字段设置时为 number                 | `{ ...mock, ltv: 80 }`                          | `typeof withLtv.ltv` === `'number'`                 | 类型安全    | canary test                   | ✅   |
| S3  | liquidationThreshold optional           | mock reserve 不含 liquidationThreshold          | `mock.liquidationThreshold` === `undefined`         | 类型安全    | canary test                   | ✅   |
| S4  | liquidationThreshold 设置时为 number    | `{ ...mock, liquidationThreshold: 82.5 }`       | `typeof withLt.liquidationThreshold` === `'number'` | 类型安全    | canary test                   | ✅   |
| S5  | V4: ltv === liquidationThreshold        | `{ ltv: 75, liquidationThreshold: 75 }`         | `v4Reserve.ltv === v4Reserve.liquidationThreshold`  | 语义正确性  | canary test                   | ✅   |
| S6  | V3: ltv ≠ liquidationThreshold          | `{ ltv: 80, liquidationThreshold: 82.5 }`       | `v3Reserve.ltv !== v3Reserve.liquidationThreshold`  | 语义正确性  | canary test                   | ✅   |
| S7  | Zod schema 包含新字段                   | codegen 后 `generated.MarketWithSpread`         | 包含 `ltv: z.number().optional()`                   | Schema 安全 | `schema:check` (codegen diff) | ✅   |
| S8  | SCHEMA_FP 与后端一致                    | 后端 `generate-schema-fp.ts` 输出               | 前端 `SCHEMA_FP` === `'2d1059421baf'`               | 缓存失效    | fingerprint 值比对            | ✅   |
| S9  | CI openapi:check 不 fail                | CI 从 staging 拉取 spec，与 committed spec diff | 无 diff → exit 0                                    | CI/CD       | CI `openapi-check` job        | ✅   |
| S10 | TypeScript 编译无错误                   | `tsc --noEmit`                                  | exit 0                                              | 类型安全    | pre-commit hook               | ✅   |
| S11 | 全量测试无回归                          | `vitest run`                                    | 3377 passed, 0 failed                               | 回归安全    | pre-commit hook               | ✅   |
| S12 | Frozen reserve (ltv=0)                  | API 返回 `ltv: 0`                               | 前端类型接受 `number` 0，P3 计算 maxBorrow=0        | 运行时状态  | P2 不测试，P3 负责            | N/A  |
| S13 | 无抵押数据 (ltv undefined)              | API JSON 中无 ltv key                           | `reserve.ltv` === `undefined`，P3 需 `?? 0`         | 缺失数据    | P2 不测试，P3 负责            | N/A  |

## Out of Scope

- P3（AAV-1250）：maxBorrow 约束计算 — 消费 `ltv` 字段
- P4（AAV-1251）：模拟 HF 计算 — 消费 `liquidationThreshold` 字段
- P5（AAV-1249）：NE APY 展示 — 不直接消费 ltv/LT，但依赖 P3 约束后有物理意义
- 后端 AAV-1222 部署到 production（railway → main PR）— 独立部署流程
- V4 RPC fallback 路径获取 `collateralFactor` — 另开 issue

## Further Notes

- OpenAPI spec 从 staging 拉取是安全的：CI `openapi-check` 也从 staging 拉取（`LIVE_API_BASE` fallback）
- `openapi-sync` 自动安全网：如果检测到 spec drift，自动创建 PR 同步 spec + Zod schema
- 参考文档：`aaveapy-doc/v3-v4-collateral-and-health-factor.md` §四（AAV-1222 API 映射策略）
- 后端 spec：`docs/plans/aav-1222-ltv-liquidation-threshold-spec.md`

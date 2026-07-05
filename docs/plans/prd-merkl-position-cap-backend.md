# PRD: Merkl Position Cap 后端部署 (AAV-1070)

## 背景

Merkl `maxDeposit` campaign 有 per-user position cap，限制用户可获得 incentive 的最大仓位金额。前端已实现 position cap 显示逻辑（commit b551d3f3），但后端改动尚未部署到 staging。

## 已完成的工作

### 后端代码（未提交/未部署）
1. `packages/aave-shared-config/index.d.ts` — `BaseCampaignBreakdown` 加 `positionCap` + `isCombineCap`
2. `packages/aave-shared-contracts/src/index.ts` — `ApiMeritCampaignBreakdown`/`ApiBrevisBreakdown` Pick 列表加 `isCombineCap`
3. `packages/aave-fetcher/src/merkl-api.ts` — `extractPositionCapFromCampaign` 函数 + 内联/fallback 两处调用 + breakdown 构建传入字段
4. `backend/scripts/generate-openapi.ts` — OpenAPI schema 加 `positionCap`/`isCombineCap`
5. `packages/aave-fetcher/tests/extractPositionCapFromCampaign.test.ts` — 9 个测试全通过

### 前端代码（已提交 commit b551d3f3）
- 类型/Zod schema / 计算逻辑 / 测试 / 文档全部完成
- 等 staging 后端部署后即可端到端验证

## 需要做的事

1. **提交后端改动**到 `railway` 分支
2. **部署到 staging**，验证 API `/markets` 返回 `positionCap`/`isCombineCap` 字段
3. **staging 端到端验证**：前端显示有 positionCap 的 Merkl campaign

## 关键设计决策

| 决策 | 选择 | 原因 |
|---|---|---|
| `isCombineCap` 位置 | `BaseCampaignBreakdown`（所有 source 共享） | 与 `positionCap` 一样是 per-campaign 属性，不限于某个 source |
| Merkl `isCombineCap` 值 | 固定 `false` | Merkl maxDeposit 是 net position cap（supply-borrow 净值），非 supply+borrow 共享 cap |
| 提取条件 | `computeMethod === 'maxDeposit'` | 最可靠判断条件，不依赖 hookType |
| 价格 fallback | `targetTokenPrice` 参数优先，fallback 到 `campaign.targetToken.price` | 参数显式传入更可靠，但 API 响应对象也有价格可兜底 |
| hookType 不参与提取 | 仅判断 `computeMethod` | hookType 和 computeMethod 是正交概念，无固定配对 |
| Merkl SELF_VERIFICATION (hookType=20) | 不提取 `verificationId`/`verifierAddress` | Merkl 链下引擎已处理，API 返回的 campaignApr 是 post-verification 值 |

## 文件变更清单

| 文件 | 变更 |
|---|---|
| `packages/aave-shared-config/index.d.ts` | `BaseCampaignBreakdown` 加 `positionCap?: number` + `isCombineCap?: boolean` |
| `packages/aave-shared-contracts/src/index.ts` | `ApiMeritCampaignBreakdown`/`ApiBrevisBreakdown` Pick 加 `isCombineCap` |
| `packages/aave-fetcher/src/merkl-api.ts` | 新增 `extractPositionCapFromCampaign` + 调用 + breakdown 传字段 |
| `backend/scripts/generate-openapi.ts` | merkl/brevis/merit breakdown schema 加 `positionCap`/`isCombineCap` |
| `packages/aave-fetcher/tests/extractPositionCapFromCampaign.test.ts` | 9 个测试 |

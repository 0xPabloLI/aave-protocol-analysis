# pro.aave.com V4 Deep-Link 支持

## 背景

Aave V4 使用 `pro.aave.com` 作为前端界面（V3 使用 `app.aave.com`）。V4 reserve 页面有两种 URL 格式：

| 格式 | 路径 | 说明 |
|---|---|---|
| 汇总页 | `/explore/asset/{chainId}/{address}` | 不区分 spoke/market 的资产汇总视图 |
| Reserve 页 | `/explore/reserve/{base64}` | 具体 spoke 下的 reserve 详情页 |

其中 reserve 页的 base64 解码后为 `{chainId}::{spokeAddress}::{onChainReserveId}`，
这个值恰好就是 V4 SDK 返回的 `reserve.id`（类型 `ReserveId`）。

## 改动概览

### 后端 (aave-protocol-analysis)

**数据流：** `V4 SDK → v4-fetcher → RuntimeReserveData → pruneReserveForRuntime → RuntimeReserveData → serializeReserveForApi → MarketWithSpread → /api/markets`

新增可选字段 `aaveProReserveId?: string`，在以上 5 个阶段逐层透传：

| 文件 | 改动 |
|---|---|
| `src/v4-fetcher.ts` | 接口加字段 + 提取 `r.id` |
| `packages/aave-fetcher/src/index.ts` | `RuntimeReserveData`、`RuntimeReserveData` 加字段；`pruneReserveForRuntime` 透传 |
| `backend/src/types/index.ts` | `MarketWithSpread` 加字段 |
| `backend/src/services/marketsApiSerialize.ts` | `serializeReserveForApi` 透传 |

V3 reserve 不会产生此字段（值为 `undefined`，API 响应中不出现）。

### 前端 (aaveapy)

| 文件 | 改动 |
|---|---|
| `src/types/aave.ts` | `ReserveWithSpread` 加 `aaveProReserveId` |
| `src/lib/aaveLinks.ts` | 新增 `buildAaveProUrl`（V4 专用）和 `buildAaveUrl`（统一入口）|
| `src/components/dashboard/DesktopReserveRow.tsx` | 改用 `buildAaveUrl` |
| `src/components/dashboard/ReservesTable.tsx` | 改用 `buildAaveUrl` |
| `src/components/dashboard/TopOpportunities.tsx` | 改用 `buildAaveUrl` + 传递 `aaveProReserveId` |
| `src/components/dashboard/SimulationSubRow.tsx` | 改用 `buildAaveUrl` |
| `src/components/dashboard/MobileReserveCard.tsx` | 传递 `aaveProReserveId` |
| `src/components/dashboard/AssetActionMenu.tsx` | 新增 prop + 改用 `buildAaveUrl` |

### 链接生成逻辑

```typescript
// aaveLinks.ts

// V3: app.aave.com（已有）
buildAaveReserveUrl({ marketName, tokenAddress })

// V4: pro.aave.com（新增）
buildAaveProUrl({ aaveProReserveId })

// 统一入口：V3 优先，V4 兜底（新增）
buildAaveUrl({ marketName, tokenAddress, aaveProReserveId })
  // → buildAaveReserveUrl() ?? buildAaveProUrl()
```

## 已知的字段透传陷阱

后端数据管道使用**显式字段映射**（而非 `...spread`），新增字段必须在每一层都手动添加。
核心卡点列表（见 `AGENTS.md` "Required Coupled Changes"）：

1. `V4RuntimeReserveData` (v4-fetcher.ts)
2. `RuntimeReserveData` (index.ts)
3. `pruneReserveForRuntime` (index.ts) ← **本次遗漏被修复的位置**
4. `RuntimeReserveData` (index.ts)
5. `MarketWithSpread` (backend/src/types/index.ts)
6. `serializeReserveForApi` (backend/src/services/marketsApiSerialize.ts)

## 测试

`backend/tests/marketsApiSerialize.test.ts` 新增 3 个用例：
- V4 reserve 带 `aaveProReserveId` → 透传到 API 输出
- V3 reserve 无此字段 → API 输出不含该字段
- 空字符串 → 视为无值，不输出

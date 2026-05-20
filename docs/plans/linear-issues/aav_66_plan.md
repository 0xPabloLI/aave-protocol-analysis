# 开发方案 - AAV-66 连接钱包读取 Merkl 白名单/黑名单

> **Status: Active** — 方案修订中（v2），数据写入路径与刷新频率语义经过评审后已调整。
>
> **关联 issue（解耦清理）**：
> - **AAV-366**（PR #111，In Review）— side-data Cache-Control header 注释/值清理；与本方案解耦。
> - **AAV-365**（Backlog）— side-data deterministic ETag + 前端 `If-None-Match` 304 节流；适用于本方案落地后的 `/api/meta/campaign-access`。

## 1. Issue 概述

连接钱包后，用户需要知道自己是否在 Merkl campaign 的白名单或黑名单中，以判断能否参与该 campaign 的激励。

## 2. 数据源分析

### 2.1 Merkl v4 API

Merkl **没有**按用户地址校验白名单/黑名单的专用 API。相关端点：

| 端点 | 白名单/黑名单 | 用户校验 |
|---|---|---|
| `/v4/opportunities?campaigns=true` | `campaign.params.whitelist[]` / `params.blacklist[]` | ❌ 无 |
| `/v4/campaigns` | 同上 | ❌ 无 |
| `/v4/users/{address}/rewards` | 不返回名单信息 | ❌ 无 |

**结论：必须自行提取名单数据，前端做地址匹配。**

### 2.2 实测数据量（Aave 全量）

| 指标 | 数值 |
|---|---|
| 总 opportunities | 112 |
| 总 campaigns | 583 |
| 有 whitelist 的 campaigns | 1（1 个地址） |
| 有 blacklist 的 campaigns | 357（5559 个地址） |
| Blacklist 每 campaign 大小 | 1–32 个地址，平均 15.2 |

**Payload 预估**：~250KB 压缩前，gzip 后 ~30KB。

### 2.3 本地已有数据

`packages/aave-fetcher/data/debug/merkl-raw-data.json` 中 `liveOpportunities[].campaigns[].params.whitelist|blacklist` 已包含完整地址数组。Fetcher 遍历 campaign 时已接触该数据，目前只提取了 `whitelistOnly` 布尔值，丢弃了原始地址数组。

## 3. 架构决策

### 3.1 独立 endpoint `/api/meta/campaign-access`（v2 修订）

**v1 方案**：合并进 `/api/meta/side-data`。
**v2 决策**：拆为独立 endpoint，原因：

1. **钱包未连接用户零成本** — `/api/meta/side-data` 是首页加载链路，所有访客都会拉；campaign-access 仅连接钱包后才需要，混在一起会让 80%+ 未连接用户白白下载 ~30KB。
2. **缓存策略可独立优化** — 独立路由可设更长的 `s-maxage`（10~30min），与 side-data 的高频成员（FDV 15min、forecast 10min）解耦，CDN 命中率更高。
3. **新鲜度语义清晰** — 这份数据"几乎不变"（campaign 生命周期内固定），可单独声明长 `staleTimeMs`，不会拖累 side-data 整体轮询节奏。
4. **未来加 deterministic ETag（AAV-365）粒度更细** — 独立 endpoint 内容稳定，做 content-hash 304 节流效果显著。

**不放入 markets 的理由（保留 v1 判断）：**
- 数据量虽可控但与 reserve 级别数据混合会膨胀 markets payload
- 只有连接钱包的用户需要，不查钱包的用户白白加载
- 刷新节奏与 markets 不同（名单变化频率远低于利率变化）

### 3.2 数据写入：markets cron；对外新鲜度：staleTime 独立声明（v2 修订）

**v1 错误**：声称"搭 forecast warm cron 的 `processMerklData`"——实测后端 `warmCampaignForecastStatesCache` → `refreshForecastSnapshotCache` 走的是 `merklOpportunityClient.fetchMerklOpportunities`（per-campaignId 查 forecast 状态），**根本不调** fetcher 包里的 `processMerklData`。

**v2 实际路径**：

```diagram
╭──────────────────────╮     ╭─────────────────────╮     ╭───────────────────╮
│ markets cron         │────▶│ in-memory snapshot  │◀────│ API handler       │
│ (every 1 min)        │     │ (campaignAccess)    │     │ /api/meta/        │
│ → fetchMarketsData   │     │ +250KB resident     │     │ campaign-access   │
│   → processMerklData │     ╰─────────────────────╯     ╰───────┬───────────╯
╰──────────────────────╯                                         │
                                                                 ▼
                                                          ╭──────────────╮
                                                          │ Cache-Control│
                                                          │ s-maxage=600 │
                                                          ╰──────┬───────╯
                                                                 ▼
                                                          ╭──────────────╮
                                                          │  CDN edge    │
                                                          ╰──────────────╯
```

**关键拆分（cron 频率 ≠ 新鲜度声明）：**

| 维度 | 取值 | 决定者 |
|---|---|---|
| Snapshot 写入频率 | 每 1 min（搭 markets cron 便车） | fetcher pipeline 调用频率 |
| Snapshot 实际新鲜度 | 永远是最新 cron 写入的版本 | API handler 直接读内存 |
| `Cache-Control: s-maxage` | 600s（10 min） | 边缘缓存兜底，与新鲜度无关 |
| `payload.staleTimeMs` | 30 min（建议） | 前端 TanStack Query 轮询节奏 |

**理由：**
- 名单数据"campaign 创建时定，生命周期内不变"，真实变化频率数小时一次 → 即使后端每 1 min 覆盖 snapshot，对外声明 30 min 新鲜度是诚实的
- 前端 `useSideDataMeta` 用各 source `staleTimeMs` 的 **min** 决定轮询间隔；本 endpoint 独立后不会拉低 side-data 的 10 min 节奏
- s-maxage=600s 是边缘缓存兜底，对应"用户拿到的数据最多比 cron 落后 10 min"，与 staleTime 解耦

**为什么不搭 forecast 10min cron：** v1 论证的"零额外 API 调用"假设错误（forecast cron 不调 `processMerklData`）；搭 markets cron 才是真正的零额外 API 调用，因为 `fetchMarketsData` 本就遍历 `liveOpportunities[].campaigns[].params`。

## 4. 实现方案

### 4.1 类型定义 — `@internal/aave-shared-contracts`

**文件**：`packages/aave-shared-contracts/src/index.ts`

新增接口：

```ts
export interface MerklCampaignAccess {
  campaignId: string;
  chainId: number;
  whitelist: string[];
  blacklist: string[];
}
```

### 4.2 Fetcher 层 — 提取 campaign access map

**文件**：`packages/aave-fetcher/src/merkl-api.ts`

在 `processMerklData` 遍历 `liveOpportunities` 构建 `campaignDetailsCache` 的循环中，同步构建 `campaignAccessMap`：

```ts
const campaignAccessMap = new Map<string, MerklCampaignAccess>();

opp.campaigns.forEach((campaign) => {
  // ...已有 campaignDetailsCache 逻辑...
  const params = campaign.params ?? {};
  const wl = Array.isArray(params.whitelist) ? params.whitelist.filter(Boolean) : [];
  const bl = Array.isArray(params.blacklist) ? params.blacklist.filter(Boolean) : [];
  // 只保留有名单数据的 campaign（空数组都为空的跳过）
  if (wl.length > 0 || bl.length > 0) {
    campaignAccessMap.set(id, {
      campaignId: id,
      chainId: opp.chain?.id ?? 0,
      whitelist: wl,
      blacklist: bl,
    });
  }
  // 同样处理 composedCampaigns 中的名单
});
```

**返回值扩展**：`processMerklData` 返回 `{ index, campaignAccess }` 其中 `campaignAccess: MerklCampaignAccess[]`。

### 4.3 Fetcher 入口透传

**文件**：`packages/aave-fetcher/src/index.ts`

`fetchMarketsData` → `MarketsPayload` 增加 `campaignAccess` 字段，从 `processMerklData` 返回值透传。

### 4.4 Backend — in-memory snapshot

**新增文件**：`backend/src/services/merklCampaignAccessService.ts`

```ts
// cron-write / API-read-only 模式
let snapshot: MerklCampaignAccess[] | null = null;
let updatedAt: string | null = null;

export function setCampaignAccessSnapshot(data: MerklCampaignAccess[]): void { ... }
export function getCampaignAccessSnapshot(): { campaigns: Record<string, ...>, updatedAt: string } | null { ... }
```

### 4.5 Backend — 独立 endpoint（v2 修订）

**新增文件**：
- `backend/src/controllers/campaignAccessController.ts`
- `backend/src/routes/campaignAccess.ts`

**route 挂载**：`backend/src/server.ts` 增加 `app.use('/api/meta/campaign-access', campaignAccessRouter)`。

**Controller 形态**：

```ts
// GET /api/meta/campaign-access
export const getCampaignAccess = async (_req: Request, res: Response) => {
  const snapshot = getCampaignAccessSnapshot();
  if (!snapshot) {
    res.status(503).json({ error: 'campaign-access snapshot not ready' });
    return;
  }
  res.status(200).json({
    generatedAt: new Date().toISOString(),
    campaigns: snapshot.campaigns,
    updatedAt: snapshot.updatedAt,
    staleTimeMs: BACKEND_TIME_MS.thirtyMinutes,
  });
};
```

**cache-header**：在 `backend/src/middleware/cacheHeaders.ts` 增加 path 分支：
```ts
if (path.startsWith('/api/meta/campaign-access')) {
  setCacheControlIfMissing(res, 'public, max-age=60, s-maxage=600, stale-while-revalidate=1800');
}
```

> 注：与 AAV-366 拆出的 `sideDataMeta` 常量并列，新增 `campaignAccess` 常量。

### 4.6 Backend — Snapshot 写入路径（v2 修订）

**文件**：`backend/src/services/marketsService.ts`

`refreshMarketsSnapshot()` 调用 `fetchMarketsData()` 后，从返回的 `MarketsPayload.campaignAccess` 中提取数组并调用 `setCampaignAccessSnapshot(payload.campaignAccess)`。

**伪代码**：

```ts
// backend/src/services/marketsService.ts
const payload = await fetchMarketsData({ v4Fatal: v4FatalConfig.v4Fatal });
// ...existing markets snapshot processing...
if (payload.campaignAccess) {
  setCampaignAccessSnapshot(payload.campaignAccess);
}
```

**频率**：由 `marketsBackupEveryMinuteAtSecond0`（每 1min）驱动，零额外 cron schedule。

## 5. API 响应示例

```json
GET /api/meta/campaign-access

{
  "generatedAt": "2026-05-21T12:00:00.000Z",
  "campaigns": {
    "6061207342662881111": {
      "chainId": 1,
      "whitelist": [],
      "blacklist": ["0x13dda4af1d87c404f611dfc1555ed7074fe9e418"]
    }
  },
  "updatedAt": "2026-05-21T11:50:00.000Z",
  "staleTimeMs": 1800000
}
```

> **地址归一化**：所有 `whitelist[]` / `blacklist[]` 在 fetcher 写入 snapshot 时统一 `toLowerCase()`，前端可直接做精确匹配。

## 6. 前端消费方式

```ts
// 钱包连接后才发起请求（lazy fetch）：
const { campaigns } = await fetch('/api/meta/campaign-access').then(r => r.json());

function getUserCampaignStatus(userAddress: string, campaignId: string):
  'allowed' | 'whitelist-blocked' | 'blacklisted'
{
  const access = campaigns[campaignId];
  if (!access) return 'allowed'; // 无名单数据 = 公开 campaign
  const addr = userAddress.toLowerCase();
  if (access.whitelist.length > 0) {
    return access.whitelist.includes(addr) ? 'allowed' : 'whitelist-blocked';
  }
  if (access.blacklist.includes(addr)) return 'blacklisted';
  return 'allowed';
}
```

**TanStack Query 配置建议：**

```ts
const CAMPAIGN_ACCESS_QUERY_KEY = ['campaign-access'] as const;

export function useCampaignAccess(enabled: boolean) {
  return useQuery({
    queryKey: CAMPAIGN_ACCESS_QUERY_KEY,
    queryFn: fetchCampaignAccess,
    enabled, // 仅钱包连接后启用
    staleTime: QUERY_STALE_TIMES.campaignAccess, // 30min，与 backend payload.staleTimeMs 对齐
  });
}
```

## 7. Repo 与文件清单

### 后端 Repo

**GitHub**: [`0xPabloLI/aave-protocol-analysis`](https://github.com/0xPabloLI/aave-protocol-analysis)
**本地路径**: `/Users/pabloli/Documents/code/aave-protocol-analysis`

| 层 | 文件（相对 repo root） | 改动类型 | 改动说明 |
|---|---|---|---|
| shared-contracts | `packages/aave-shared-contracts/src/index.ts` | 修改 | +`MerklCampaignAccess` 接口，+`MarketsPayload.campaignAccess?: MerklCampaignAccess[]` |
| fetcher | `packages/aave-fetcher/src/merkl-api.ts` | 修改 | `processMerklData` 遍历 `liveOpportunities` + `composedCampaigns` 时构建 `campaignAccessMap`，地址统一 `toLowerCase()`；返回值增加 `campaignAccess` |
| fetcher | `packages/aave-fetcher/src/index.ts` | 修改 | `fetchMarketsData` / `MarketsPayload` 透传 `campaignAccess` |
| backend | `backend/src/services/merklCampaignAccessService.ts` | **新增** | in-memory snapshot（cron-write/API-read-only），`setCampaignAccessSnapshot` / `getCampaignAccessSnapshot` |
| backend | `backend/src/services/marketsService.ts` | 修改 | `refreshMarketsSnapshot` 完成后调用 `setCampaignAccessSnapshot(payload.campaignAccess)` |
| backend | `backend/src/controllers/campaignAccessController.ts` | **新增** | `GET /api/meta/campaign-access` handler |
| backend | `backend/src/routes/campaignAccess.ts` | **新增** | Express router 挂载 controller |
| backend | `backend/src/server.ts` | 修改 | 挂载 `app.use('/api/meta/campaign-access', campaignAccessRouter)` |
| backend | `backend/src/middleware/cacheHeaders.ts` | 修改 | 新增 path 分支 + `CACHE_CONTROL.campaignAccess` 常量（`s-maxage=600, swr=1800`） |

### 前端 Repo

**GitHub**: [`0xPabloLI/aaveapy`](https://github.com/0xPabloLI/aaveapy)
**本地路径**: `/Users/pabloli/Documents/code/aaveapy`

| 文件（相对 repo root） | 改动类型 | 改动说明 |
|---|---|---|
| `src/types/aave.ts` | 修改 | +`MerklCampaignAccess` / `CampaignAccessResponse` 类型 |
| `src/lib/apiSchemas.ts` | 修改 | +`CampaignAccessResponseSchema` zod 校验 |
| `src/config/queryStaleTimes.ts` | 修改 | +`campaignAccess: 30 * 60 * 1000` |
| `src/hooks/useCampaignAccess.ts` | **新增** | `useQuery` gated by wallet 连接，封装 `getUserCampaignStatus(address, campaignId)` |
| `src/components/dashboard/ReservesTable.tsx` | 修改 | Merkl breakdown 行渲染时调用 `useCampaignAccess` 显示准入状态 |

> 注：前端目前**尚未接入钱包连接**（AAV-66 本身就是钱包功能的前置），前端改动依赖钱包 hook（`useAccount` / wagmi）先就位。钱包连接属于 AAV-66 的另一半工作，本方案仅覆盖数据链路（后端 API → 前端 hook → 地址匹配），UI 展示和钱包集成在另一方案中处理。

### 文件总计

- 后端：**9 个文件**（4 新增 + 5 修改），新增 1 个路由（`/api/meta/campaign-access`），零新增 cron schedule（复用 markets cron）
- 前端：**5 个文件**（1 新增 + 4 修改），依赖钱包连接 hook 先就位

## 8. 安全考量

- Whitelist/blacklist 地址为链上地址（`0x...`），无敏感信息泄露风险
- 该数据在 Merkl API 公开可查，仅为聚合展示
- 前端匹配逻辑使用 `toLowerCase()` 确保大小写不敏感

## 9. 执行顺序

```
① 后端 shared-contracts 类型定义（MerklCampaignAccess + MarketsPayload 字段）
② 后端 fetcher 提取逻辑（merkl-api.ts: liveOpportunities + composedCampaigns + toLowerCase）
③ 后端 snapshot service（merklCampaignAccessService.ts）
④ 后端 controller + route + cacheHeaders 注册（新增 /api/meta/campaign-access）
⑤ 后端 marketsService 写入 snapshot
⑥ 后端验证：npm run build && npm run test -w aave-dashboard-backend
⑦ 前端类型 + schema + queryStaleTimes
⑧ 前端 useCampaignAccess hook（gated by wallet）+ 组件集成
⑨ 前端验证：pnpm test
```

①–⑥ 可独立先行部署，前端连接后即可消费 `/api/meta/campaign-access` 数据。

## 10. v2 修订摘要（评审决议）

| 项 | v1 | v2 | 原因 |
|---|---|---|---|
| Endpoint | 合并进 `/api/meta/side-data` | 独立 `/api/meta/campaign-access` | 钱包未连接用户零成本；缓存策略独立；不拖累 side-data 轮询节奏 |
| 数据写入路径 | "搭 forecast warm cron 的 processMerklData" | markets cron → marketsService → setCampaignAccessSnapshot | v1 假设错误：forecast cron 实际不调 fetcher 的 processMerklData |
| 刷新频率 | 10 min | 1 min snapshot 写入 / 30 min staleTime 声明 | 把 cron 频率（写入）与对外新鲜度（消费）解耦 |
| 地址归一化 | 仅前端 toLowerCase | fetcher 写入时统一 toLowerCase | 避免前后端各做一次 / 某一端漏做 |
| composedCampaigns 名单 | 未明确 | 显式同样提取 | 否则 composed campaign 名单丢失 |
| chainId fallback | `opp.chain?.id ?? 0` | 跳过并 warn | `0` 不是合法链 ID |

### 评审中拆出的独立 issue（与本方案解耦）

- **AAV-366**（PR #111，In Review）— side-data Cache-Control header 注释过期 + s-maxage 对齐当前最短 TTL 的清理。
- **AAV-365**（Backlog）— side-data deterministic ETag + 前端 `If-None-Match` 304 节流；本方案落地后可同样受益 `/api/meta/campaign-access`。

### Trade-off 决议记录

| 维度 | 影响 | 决定 |
|---|---|---|
| 后端常驻内存 | +250KB（名单数组不再被 GC 回收） | 接受 |
| 后端 API 调用 | 0（搭 markets cron 现有 processMerklData） | — |
| 后端 CPU | ~0（多遍历一次 liveOpportunities） | — |
| CDN origin→edge 带宽 | 几乎不变（s-maxage=600 决定回源频率，与 payload 大小无关） | — |
| 钱包未连接用户 | 0 请求 | 独立 endpoint 保证 |
| 单次钱包连接用户 | 1 次请求 ~30KB | 边缘缓存命中后摊薄 |
| 前端 side-data 轮询节奏 | 不变（独立 endpoint，不进 side-data min(staleTimeMs) 计算） | 关键 |

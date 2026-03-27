# Brevis / Incentra 补充参考

非核心细节与归档内容；**对外 API 契约与 gRPC vs REST 结论**仍以 [api-documentation.md](./api-documentation.md) 中「### 3. Brevis」为准。

---

## 1. 已从 `src/brevis-api.ts` 移除的 client dead API

以下曾在 `BrevisApiClient` 中实现，**全仓库无调用**，与生产路径 `getAaveCampaignsData()`（遍历 Aave protocols + 详情 + 建索引）重复维护成本高，已从源码删除。若需要按 **单个 pool** 拉 `GetAllProtocolDetail` 并打成「宽表」行，可复制下方参考实现到本地脚本或临时分支。

### 曾导出的类型 `BrevisCampaignInfo`（归档参考）

```ts
export interface BrevisCampaignInfo {
  chainId: number;
  poolAddress: string;
  tokenAddress: string | null;
  action: number;
  actionType: 'supply' | 'borrow' | 'both' | 'unknown';
  campaignId: string;
  campaignName: string;
  startTime: number;
  endTime: number;
  apr: number;
  link: string;
  message: string;
  status: string;
  rewardInfo?: {
    tokenAddress: string;
    tokenSymbol: string;
    rewardAmt: string;
    rewardUsdPrice: string;
    apr: number;
    tvl: number;
  };
}
```

### `campaign.status` 数值 → 标签（归档参考）

旧客户端曾用下列映射生成可读 `status` 字符串；**该映射已从源码删除**，下表仅供对照 REST/gRPC raw 或自建脚本时使用。

| 数值 | 标签 |
|------|------|
| 1 | DEPLOYING |
| 2 | CREATING_FAILED |
| 3 | INACTIVE |
| 4 | ACTIVE |
| 5 | ENDED |
| 6 | DEACTIVATED |

### 曾有的方法语义：`getCampaignDetailByPool({ chainId?, type?, poolId? })`

- 内部调用与生产相同的 gRPC：`POST …/IncentiveProvider/GetAllProtocolDetail`，body 为 protobuf 编码的 `chainId` / `type` / `id`（**不支持数组**，单次一个 pool）。
- 返回 `{ raw, rawCampaigns, campaigns }`，其中 `campaigns` 由下面解析器从已解码的 `response` 生成。

### `parseCampaignsFromGrpcResponse(response)` 逻辑摘要（归档参考）

- `protocol = response.protocol`，`details = response.campaignDetailsList ?? []`。
- 对每条 `detail`：`campaign = detail.campaign`，`config = campaign.config`，`type = campaign.type ?? config.type ?? 0`。
- `actionType`：与当前生产 `mapActionType` 一致——`2002 → supply`，`2001 → borrow`，`3001 → both`，否则 `unknown`。
- `link`：`https://incentra.brevis.network/campaign/?pool_id=${protocol.id}&type=${type}&chainId=${protocol.chainId}`（需 `protocol.id`、`protocol.chainId`、`type` 齐全）。
- `apr`：使用 `protocol.apr`（小数，如 0.024）；`rewardInfo` 中 `rewardUsdPrice` 在旧实现中恒为空字符串（未填）。

生产代码仍保留私有 `getAllProtocolDetailFromGrpc` 与完整 protobuf 解析；仅上述 **按-pool 的公开包装 + `BrevisCampaignInfo` + 宽表解析函数** 已删除。

---

## 2. Brevis type code（证据分级：官方文档 / 外部接口实测 / 项目代码映射）

> Source: Incentra docs `Get Campaigns` / 各协议 campaign API / reward batch API（见下文链接）。

| Type code | 语义 | 证据等级 | 证据来源 |
|---|---|---|---|
| `1` | Liquidity campaign (Uniswap v3) | 官方文档 | Incentra docs: Get Campaigns / Liquidity |
| `2` | Liquidity campaign (Uniswap v4) | 官方文档 | Incentra docs: Get Campaigns / Liquidity |
| `3` | Liquidity campaign (PancakeSwap v3) | 官方文档 | Incentra docs: Get Campaigns / Liquidity |
| `4` | Liquidity campaign (PancakeSwap v4) | 官方文档 | Incentra docs: Get Campaigns / Liquidity |
| `5` | Liquidity campaign (QuickSwap v3) | 官方文档 | Incentra docs: Get Campaigns / Liquidity |
| `6` | Liquidity campaign (KoalaSwap) | 官方文档 | Incentra docs: Get Campaigns / Liquidity |
| `8` | Liquidity campaign (Pancake v4 CL) | 官方文档 | Incentra docs: Get Campaigns / Liquidity |
| `9` | Liquidity campaign (Pancake v4 BIN) | 官方文档 | Incentra docs: Get Campaigns / Liquidity |
| `1001` | Token holding campaign | 官方文档 | Incentra docs: reward batch APIs (`types`) |
| `2001` | Euler borrow action | 官方文档 | Incentra docs: Euler campaigns (`action`) |
| `2002` | Euler lend action | 官方文档 | Incentra docs: Euler campaigns (`action`) |
| `5001` | Aave lend action | 官方文档 | Incentra docs: Aave campaigns (`action`) |
| `5002` | Aave borrow action | 官方文档 | Incentra docs: Aave campaigns (`action`) |
| `5003` | Aave lend_net action | 官方文档 | Incentra docs: Aave campaigns (`action`) |
| `6001` | Morpho lend action | 官方文档 | Incentra docs: Morpho campaigns (`action`) |
| `3001` | Aave campaign（当前项目实测为 both） | 外部接口实测 + 项目代码映射 | `data/debug/brevis-raw-data.json` + `src/brevis-api.ts`（`mapActionType`） |

本项目当前 `/api/markets` 的 Brevis 解析逻辑中，`actionType` 映射为：

- `2002 -> supply`
- `2001 -> borrow`
- `3001 -> both`

当前实现未将 `5001/5002/5003` 直接映射到 `/api/markets` 的 Brevis actionType；这三类目前主要出现在官方 REST `aaveCampaigns` 文档语义中。

补充说明（统一口径）：

- 对官方 SDK 文档：Aave `action` 定义为 `5001/5002/5003`。
- 对本项目当前抓取路径（`GetAllProtocolDetail` + 运行时数据）：Aave 样本中可见 `type=3001`，并在代码中映射为 `both`（即不再拆分成独立 lend/borrow code）。

官方文档入口：

- `https://incentra-docs.brevis.network`
- `https://incentra-docs.brevis.network/developer-sdk/get-campaigns`
- `https://incentra-docs.brevis.network/print.html`

---

## 3. Brevis campaign status code（证据分级：官方文档 / 外部接口实测 / 项目代码映射）

生产路径在 `getAaveCampaignsData` 中**仅保留 `campaign.status === 4`（ACTIVE）**；下列全表用于解读 debug/raw 或其它协议 REST 响应，**不再由 `brevis-api` 导出字符串标签**。

| Status code | 标签 | 证据等级 | 证据来源 |
|---|---|---|---|
| `1` | `DEPLOYING` | 定向补证未观察到活样本 + 归档映射表 | 见下文「定向补证」 |
| `2` | `CREATING_FAILED` | 外部接口实测 + 归档映射（暂无官方数字佐证） | Brevis REST `/sdk/v1/{liquidityCampaigns,tokenholdingCampaigns,eulerCampaigns}` |
| `3` | `INACTIVE` | 官方文档 + 归档映射 | Incentra docs |
| `4` | `ACTIVE` | 官方文档 + 归档映射 | Incentra docs |
| `5` | `ENDED` | 官方文档 + 归档映射 | Incentra docs |
| `6` | `DEACTIVATED` | 定向补证未观察到活样本 + 归档映射 | 见下文「定向补证」；官方仅列标签未给数字 |

补充说明：

- Incentra 文档在 rewards batch API 中明确给出 `INACTIVE=3`、`ACTIVE=4`、`ENDED=5`。
- 其余状态标签（`DEPLOYING`、`CREATING_FAILED`、`DEACTIVATED`）在官方文档中有列举，但未在同一处统一给出数字；解读 raw 时可对照上表。
- 2026-03-26 外部接口补证：`status=2` 在 `liquidityCampaigns` / `tokenholdingCampaigns` / `eulerCampaigns` 可返回非空样本，且响应标签为 `CREATING_FAILED`。

### 定向补证（`status=1` DEPLOYING / `status=6` DEACTIVATED）

方法（对生产 host `incentra-prd.brevis.network`）：

1. **按状态过滤**：`POST /sdk/v1/{liquidityCampaigns,tokenholdingCampaigns,eulerCampaigns}`，body 含 `"status":[1]` 或 `"status":[6]`，其余 filter 置空；再追加 `chain_id: [1,59144,42161,10,8453,88811]` 复测一轮。
2. **全量去重**：同上三端点在**不传 `status` 约束**时拉全表，对返回的 `campaigns[].status` 字符串去重。

结果：

- `status=1` 与 `status=6`：两轮请求下 **`campaigns` 均为空数组**（计数 0），**未拿到**带 `DEPLOYING` / `DEACTIVATED` 标签的活样本。
- 全量去重：REST 侧仅观察到 `ACTIVE`、`CREATING_FAILED`、`ENDED`（**未出现** `DEPLOYING`、`DEACTIVATED` 字符串）。
- gRPC 调试快照 `data/debug/brevis-raw-data.json`：当前样本里 **campaign 级** `campaign.status` 仅为 `4`；协议行上的 **`protocolStatus` 为 4 或 5**（与 campaign `status` 不同字段，勿混用）。
- 链上仓库 [brevis-network/incentra-contracts](https://github.com/brevis-network/incentra-contracts) 的 Solidity 接口**未暴露**与后端 gRPC 一致的数字枚举定义，**不能**作为 `1/2/6` 数字含义的链上佐证。

结论：`1` / `6` 仍**仅**能依赖上表约定映射；若日后 raw 或外部 API 出现新数值，按维护约定更新。

### 维护约定

当 `data/debug/brevis-raw-data.json` 出现新的 `type` 或 `status` 数值时，须在本文件同步更新 type/status 对照表，并在 `src/brevis-api.ts` 中更新 `mapActionType` 或 ACTIVE 过滤逻辑（如有需要）。

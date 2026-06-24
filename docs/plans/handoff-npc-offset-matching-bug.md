# Handoff: Merkl NPC Offset Matching Bug（2026-06-23 更新）

## 当前 Commit

`9d99c86` + 本 session 变更（待 commit）

## 已完成

1. ✅ `tokenAddrToReserveId` 已删除 — 不再构建反查 Map (AAV-996 Done)
2. ✅ `resolveOffsetReserveIds` 新增 `hub-cross-spoke` 模式 — V4 HUB_SUPPLY offset 匹配同 hub 同 token 下所有 spoke (AAV-997 Done)
3. ✅ 路径 B offset 集成 — `extractNetPositionConstraint` 接收 `offsetTokenAddresses` 参数；`index.ts` 传入 `oppOffsetLevel` 和 `opp.offsetTokenAddresses`
4. ✅ `distributionType` 赋值修复 — 优先使用 opp 级别的 NET 类型，不被 breakdown 覆盖
5. ✅ V3/V4 匹配语义确认 — V3 是 1:1，V4 HUB_SUPPLY 是 1:N（Hub 层统一 APR），V4 SPOKE_SUPPLY 有完整 4 维度但 ADR-0030 已跳过
6. ✅ `OffsetTokenInfo` 接口已删除 — `offsetTokenAddresses` 类型从 `OffsetTokenInfo[]` 简化为 `string[]`，`extractNetPositionConstraint` 内部直接用 `resolveOffsetReserveIds` 解析地址
7. ✅ `hookType=14` 跨 market NPC 已处理 — 新增 `cross-market` offset level + `hasCrossMarketNpc` 标志，hookType=14 opp 自动使用跨 market 匹配

## 本 Session 变更摘要

### `OffsetTokenInfo` → `string[]` 简化

**改动**：
- 删除 `OffsetTokenInfo` 接口（原含 `address` + `reserveId?` 字段）
- `MerklOpportunityData.offsetTokenAddresses` 类型从 `OffsetTokenInfo[]` 改为 `string[]`
- `extractOffsetTokenAddresses` 返回 `string[]`（不再包 `{ address }` 对象）
- `extractNetPositionConstraint` 和 `detectNetPositionConstraint` 参数从 `OffsetTokenInfo[]` 改为 `string[]`
- `extractNetPositionConstraint` 内部移除 `info.reserveId` 直接使用逻辑，统一走 `resolveOffsetReserveIds` 解析
- 测试文件适配新类型

**原因**：`OffsetTokenInfo.reserveId` 从未被路径 A 填充（`extractOffsetTokenAddresses` 只写入 `{ address }`），是死路径。简化后消除概念混淆。

### `hookType=14` → `cross-market` offset

**改动**：
- `OffsetLevel` 新增 `'cross-market'` 值
- `resolveOffsetReserveIds` 新增 cross-market 逻辑：同 chainId + 同 tokenAddress，不限 pool/market/spoke/hub
- `MerklOpportunityData` 新增 `hasCrossMarketNpc?: boolean` 字段
- `hasHookType14()` 函数检测 opp 的 campaigns 中是否包含 hookType=14
- `processMerklData` 中检测并设置 `hasCrossMarketNpc`
- `index.ts` 路径 B 中 `oppOffsetLevel` 判断逻辑：`hasCrossMarketNpc ? 'cross-market' : ...`

**原因**：hookType=14 的 NPC 语义是"borrowers on any market are excluded"，offset 范围是跨 market 的。`borrowBytesLike` 格式不一致（protocol=0 是 32 字节 hash，其他是地址），无法可靠反查 vTokenAddress。改用 tokenAddress 匹配更稳定。

**当前数据影响**：USDtb (chain=1) 只有 1 个 reserve（Main market），所以 cross-market 和 per-reserve 结果相同。当 Lido/EtherFi/Horizon 也上线 USDtb 时，cross-market 才会真正生效。

## Linear Issue 状态

| Issue | 状态 | 说明 |
|---|---|---|
| AAV-995 (PRD) | Todo | 核心+清理+hooks 全部完成 |
| AAV-996 (删除 tokenAddrToReserveId) | Done | — |
| AAV-997 (hub-cross-spoke) | Done | — |
| AAV-905 (tokenAddrToReserveId 冲突) | Done | 已删除 |
| AAV-906 (resolveOffsetReserveIds prefix) | Done | hub-cross-spoke 已实现 |
| AAV-927 (Slice 3 多值映射) | Canceled | 方案变更为删除 |
| AAV-928 (Slice 4 hub-aware) | Done | 被 AAV-997 覆盖 |

## 调研结论（保留供参考）

### 匹配语义

| opp 类型 | 匹配维度 | 匹配关系 |
|---|---|---|
| V3 (NET_LENDING/SUPPLY 等) | `chainId` + `explorerAddress` → tokenAddr/aTokenAddr/vTokenAddr | 1:1 |
| V4 SPOKE_SUPPLY | `chainId` + `spokeAddress` + `underlyingToken` + `hubAddress` | 1:1（ADR-0030 已跳过） |
| V4 HUB_SUPPLY | `chainId` + `ds.hubAddress` + `explorerAddress`(=tokenAddress) | 1:N（Hub 层 APR 统一覆盖所有 spoke） |

### Offset 范围规则

| 条件 | offset 范围 | OffsetLevel |
|---|---|---|
| 有 `hookType=14` | 跨 Aave market（同 chain + 同 token） | `cross-market` |
| `AAVE_V4_NET_APR` | hub 内跨 spoke | `hub-cross-spoke` |
| `AAVE_NET_APR` + 无 hooks | 同 pool 内 | `reserve` |
| V4 SPOKE_SUPPLY | 同 spoke 跨 hub | `spoke-cross-hub` |

### `ds.targetToken` 含义

V4 HUB_SUPPLY 的 `ds.targetToken` = `opp.identifier`，是 Merkl 系统的 Hub asset 内部标识符（不是 Hub 合约上的 token 地址，也不是 underlying token 地址）。Hub 合约用 `assetId` 数字标识资产。匹配 reserve 用 `explorerAddress`（= underlyingToken），不用 `ds.targetToken`。

### hookType=14 borrowBytesLike 格式

| protocol | Market | borrowBytesLike 格式 | 可 vToken 反查？ |
|---|---|---|---|
| 0 | Main | 32 字节 hash | ❌ |
| 1 | Lido | 地址 | ❌（不在 vTokenAddress 映射中） |
| 2 | EtherFi | 地址 | ✅ |
| 3 | Horizon | 混合 | 部分 |

结论：borrowBytesLike 格式不一致，不适合做 reserve 反查。改用 tokenAddress + chainId 匹配。

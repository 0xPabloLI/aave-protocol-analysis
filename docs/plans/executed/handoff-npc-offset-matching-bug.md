# Handoff: Merkl NPC Offset Matching Bug（2026-06-25 最终更新）

> **Status: Executed** (2026-07-06) — 全部完成，commit 7109281。

## 最终 Commit

`7109281` (railway branch)

## 全部完成 ✅

1. ✅ `tokenAddrToReserveId` 已删除 — 不再构建反查 Map (AAV-996 Done)
2. ✅ `resolveOffsetReserveIds` 新增 `hub-cross-spoke` 模式 — V4 HUB_SUPPLY offset 匹配同 hub 同 token 下所有 spoke (AAV-997 Done)
3. ✅ 路径 B offset 集成 — `extractNetPositionConstraint` 接收 `offsetTokenAddresses` 参数；`index.ts` 传入 `oppOffsetLevel` 和 `opp.offsetTokenAddresses`
4. ✅ `distributionType` 赋值修复 — 优先使用 opp 级别的 NET 类型，不被 breakdown 覆盖
5. ✅ V3/V4 匹配语义确认 — V3 是 1:1，V4 HUB_SUPPLY 是 1:N（Hub 层统一 APR），V4 SPOKE_SUPPLY 有完整 4 维度但 ADR-0030 已跳过
6. ✅ `OffsetTokenInfo` 接口已删除 — `offsetTokenAddresses` 类型从 `OffsetTokenInfo[]` 简化为 `string[]`
7. ✅ **offsetLevel 简化为 deterministic mapping** — 由 opportunityType 直接决定，无运行时推导
8. ✅ **borrowBlacklist 检测** (AAV-924) — CampaignGroup 级 `borrowBlacklist?: boolean` 字段
9. ✅ **跨协议 BORROW_BL autodetect** (AAV-958) — `hasBlacklistWithBorrowHook` + `extractBorrowHookProtocols`

## 最终 offsetLevel 映射（deterministic，无 fallback）

| opportunityType | offsetLevel | 原因 |
|---|---|---|
| `AAVE_V4_SPOKE_SUPPLY` | `'reserve'` | 4维度精确匹配（chainId + spoke + token + hub），offset 也精确匹配 |
| `AAVE_V4_HUB_SUPPLY` | `'hub-cross-spoke'` | 缺少 spokeAddress，只能匹配同 hub 同 token 下所有 spoke |
| `AAVE_NET_*` (V3) | `'reserve'` | 同 pool 精确匹配 |
| `AAVE_V4_NET_APR` | `'hub-cross-spoke'` | 同 HUB_SUPPLY，缺少 spokeAddress |

## 已移除的死路径

- ❌ `hasCrossMarketNpc` / `'cross-market'` offsetLevel — hookType=14 opp 无 offset tokens（`params.tokens` 为空），`extractNetPositionConstraint` 永远不进入 offset 解析逻辑，cross-market 分支从未执行
- ❌ `'spoke-cross-hub'` offsetLevel — SPOKE_SUPPLY 有完整 4 维度，无需跨 hub
- ❌ `'hub'` / `'spoke'` 别名 — 被 `'hub-cross-spoke'` / `'reserve'` 取代
- ❌ `normalizeOffsetLevel` 函数 — 无需别名归一化
- ❌ `OffsetTokenInfo` 接口 — `reserveId` 从未填充，简化为 `string[]`

## 关键认知修正

1. **Aave 合约层 → Merkl offset 等价性是错误推理**：Aave V4 HF 隔离（同 spoke cross-hub collateral 可 offset）不能推导 Merkl offset scope。offset scope 取决于 Merkl 自身的 reward 计算逻辑。
2. **hookType=14 ≠ BORROW_BL**：hookType=14 是"borrow exclusion hook"，但可能存在 hookType=14 不含 BORROW_BL 的情况。hookType=14 无 Merkl 官方文档确认，仅为逆向推断。
3. **BORROW_BL opp 无 offset tokens**：因此 `hasCrossMarketNpc → 'cross-market'` 路径从未执行，是死代码。

## Linear Issue 状态

| Issue | 状态 | 说明 |
|---|---|---|
| AAV-924 (PRD + borrowBlacklist) | Done | commits: `9f4c2a9`, `5354e33`, `e17a7f4`, `7109281` |
| AAV-921 (V4 HUB_SUPPLY hub 消歧) | Done | commit: `7109281` |
| AAV-995 (PRD) | Done | 核心+清理+hooks 全部完成 |
| AAV-996 (删除 tokenAddrToReserveId) | Done | — |
| AAV-997 (hub-cross-spoke) | Done | — |
| AAV-905 (tokenAddrToReserveId 冲突) | Done | 已删除 |
| AAV-906 (resolveOffsetReserveIds prefix) | Done | hub-cross-spoke 已实现 |
| AAV-927 (Slice 3 多值映射) | Canceled | 方案变更为删除 |
| AAV-928 (Slice 4 hub-aware) | Done | 被 AAV-997 覆盖 |
| AAV-958 (跨协议 BORROW_BL autodetect) | Done | commit: `e17a7f4` |
| AAV-962 (前端 BORROW_BL simulation) | Backlog | 待前端实现 |

## 调研结论（保留供参考）

### 匹配语义

| opp 类型 | 匹配维度 | 匹配关系 |
|---|---|---|
| V3 (NET_LENDING/SUPPLY 等) | `chainId` + `explorerAddress` → tokenAddr/aTokenAddr/vTokenAddr | 1:1 |
| V4 SPOKE_SUPPLY | `chainId` + `spokeAddress` + `underlyingToken` + `hubAddress` | 1:1（ADR-0030 已跳过） |
| V4 HUB_SUPPLY | `chainId` + `ds.hubAddress` + `explorerAddress`(=tokenAddress) | 1:N（Hub 层 APR 统一覆盖所有 spoke） |

### `ds.targetToken` 含义

V4 HUB_SUPPLY 的 `ds.targetToken` = `opp.identifier`，是 Merkl 系统的 Hub asset 内部标识符（不是 Hub 合约上的 token 地址，也不是 underlying token 地址）。Hub 合约用 `assetId` 数字标识资产。匹配 reserve 用 `explorerAddress`（= underlyingToken），不用 `ds.targetToken`。

### hookType=14 borrowBytesLike 格式（逆向推断，无官方文档）

| protocol | Market | borrowBytesLike 格式 | 可 vToken 反查？ |
|---|---|---|---|
| 0 | Main | 32 字节 hash | ❌ |
| 1 | Lido | 地址 | ❌（不在 vTokenAddress 映射中） |
| 2 | EtherFi | 地址 | ✅ |
| 3 | Horizon | 混合 | 部分 |

结论：borrowBytesLike 格式不一致，不适合做 reserve 反查。

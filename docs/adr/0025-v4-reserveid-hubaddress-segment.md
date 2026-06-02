# ADR-0025: V4 reserveId/onchainKey 第四段统一用 hubAddress

## 状态

Accepted

## 上下文

V4 reserveId 的第四段 `hubName` 存在值域不一致问题：
- v4-fetcher（SDK 侧）用 `r.asset.hub.name`，值如 "Core"/"Prime"/"Plus"
- onchainDataService（address-book 侧）用 `V4SpokeConfig.hubName`（= hubKey），值如 "CORE_HUB"/"PRIME_HUB"/"PLUS_HUB"

这导致 `onchainMap.get(reserve.reserveId)` 无法直接命中，需要 `SDK_HUB_TO_HUBKEY` 运行时映射。如果 SDK 新增 hub name 但映射表未更新，V4 reserve 会静默缺少 onchain 数据。

## 决策

将 reserveId/onchainKey 的 V4 第四段从 hubName 改为 hubAddress（链上合约地址）。

V4 reserveId 新格式：`{chainId}:{spokeAddress}:{tokenAddress}:{hubAddress}`

## 理由

1. **零映射**：SDK 和 address-book 包含同一个 Hub 合约的链上地址，天然一致，无需任何映射表
2. **健壮性**：新增 Hub 不需要更新任何映射表，不会静默 lookup miss
3. **架构整洁**：hubAddress 是 Hub 的全局唯一标识，比 human-readable name 更适合做 composite key 的组成部分
4. **消除 fallback**：marketsService 中 SDK_HUB_TO_HUBKEY 映射表和 V4 fallback lookup 可完全删除

## 替代方案

### 统一到 hubKey（CORE_HUB/PRIME_HUB/PLUS_HUB）

- reserveId 改用 hubKey，与 onchainKey 一致
- v4-fetcher 中需加 SDK hubName→hubKey 映射（3行）
- 映射在构造时执行而非 lookup 时，比当前 fallback 更安全
- 可读性比 hubAddress 好
- **未采纳**：仍需维护映射表，新增 Hub 仍需更新映射

### 维持现状，改进 fallback

- 保留 SDK name，加强 fallback 的健壮性（自动发现新 hub name→hubKey 映射）
- **未采纳**：增加运行时复杂度，治标不治本

## 后果

- reserveId 不可读（第四段是地址而非 "Core"），但 reserveId 主要用作 key 而非显示
- 前端需适配解析逻辑（V4 第四段从 hubName 变为 hubAddress）
- API 可去除 hubAddress 和 spokeAddress 字段（从 reserveId 解析），节省少量体积
- DB 历史快照中 V4 reserveId 失效，需迁移脚本（DB 是 archive 非 source of truth，可接受）
- onchainDataService 的 v4SpokeCache key 从 `${spokeAddress}:${hubKey}` 改为 `${spokeAddress}:${hubAddress}`
- **V4_SPOKE_TO_HUB 仍保留**：addressBookRegistry 中的 `V4_SPOKE_TO_HUB` 静态映射继续用于初始化 V4SpokeConfig（从 spokeAddress 查找其所属 hubAddress），因为 address-book 不提供 spoke→hub 拓扑的自动发现。用 SDK `spoke.connectedHubs` 动态化是 AAV-498 的范围，不在本 ADR 中处理。该映射仅在启动时读取一次，不影响 reserveId 格式本身
- **hubKey 仅限启动时中间查找**：`V4SpokeEntry` 中的 `hubKey` 仅在 `addressBookRegistry.buildAll()` 启动阶段用于从 `HUBS` 字典查找 `hubAddress`，查找后即丢弃。下游服务（onchainDataService、oracleService）的运行时关键路径上无 hubKey，reserveId/onchainKey/v4SpokeCache key 均为纯地址格式

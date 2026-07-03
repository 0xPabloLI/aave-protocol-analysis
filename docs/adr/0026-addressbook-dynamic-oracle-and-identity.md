# ADR-0026: addressBook 地址数据动态化与 spokeKey/spokeName 语义分离

## 状态

Partially Implemented

### 已实现

- 白名单移除：`isSupportedChain`（AAVE_CHAIN_ID_TO_RPC_KEY 白名单）已替换为 `isTestnetKey`（testnet 名称过滤），见 ADR-0034
- 新链自动纳入：address-book 新增的 mainnet 链不再需要 shared-config 先行更新

### 未实现

- spokeKey/spokeName 语义分离（仍使用 raw key 如 `MAIN_SPOKE`）
- oracleAddress 链上读取（仍从 address-book 获取）
- poolAddress 链上读取（仍从 address-book 获取）
- 根 barrel import 消除（仍使用 `import * as AaveAddressBook`）

## 上下文

AAV-528 完成后，`V4_SPOKE_TO_HUB` 已通过 SDK `spoke.connectedHubs` 动态化。addressBookRegistry 仅剩从 `@aave-dao/aave-address-book` 获取以下字段的职责：

1. **spokeKey**（如 `MAIN_SPOKE`）— 同时充当标识和展示
2. **oracleAddress**（V3: `AaveV3*.ORACLE`，V4: `SPOKES[*_ORACLE]`）
3. **poolAddress**（V3: `AaveV3*.POOL`，fetcher fallback）

这些字段依赖 npm 包发版，新增 spoke 需等 address-book 升级后才能生效。

### 当前 spokeKey 的语义问题

address-book 的 raw key（如 `MAIN_SPOKE`）在本项目中同时承担两个职责：
- **功能性标识**：persistenceService 用 `v4|${spokeName}` 做 configMap key 查找
- **展示标签**：日志、API 输出的人类可读名

但 `MAIN_SPOKE` 既不是可靠的唯一标识（隐含 chainId 但不显式），也不是好的展示名（含 `_SPOKE` 后缀冗余）。

## 决策

### 1. spokeKey/spokeName 语义分离

| 字段 | 新语义 | 新来源 | 示例 |
|------|--------|--------|------|
| `spokeKey` | 功能性唯一标识 | `chainId:spokeAddress` | `1:0x94e7a5dcbe81...` |
| `spokeName` | 展示性标签 | SDK `spoke.name` | `"Main"` |

- `spokeKey` 用于 DB 查找、configMap key、唯一性约束
- `spokeName` 用于日志、API 输出、前端展示
- `spokeName` 不保证全局唯一（当前观测唯一，但非合约级保证）

### 2. oracleAddress 链上读取

| 协议 | 当前 | 动态化方案 | 链上方法 |
|------|------|-----------|---------|
| V3 | address-book `AaveV3*.ORACLE` | `PoolAddressesProvider.getOracle()` | addressBookRegistry 已有 `poolAddressesProvider` 字段 |
| V4 | address-book `SPOKES[*_ORACLE]` | `Spoke.ORACLE()` | ISpokeV4 ABI 已有此 view 函数 |

缓存策略：首次 oracle 查询时读取一次，内存缓存。Oracle 地址是部署时设定的合约地址，链上不变（治理升级极罕见）。

### 3. poolAddress 链上读取（V3 fetcher fallback）

当前 fetcher 的 `getAllAaveV3Networks()` 已优先用 SDK `chains()` API，仅 `poolAddress` 依赖 address-book fallback。可改为 `PoolAddressesProvider.getPool()` 链上读取。

### 4. 保留 address-book `/abis/*` 深路径

合约 ABI 无法链上获取，继续使用 `@aave-dao/aave-address-book/abis/*` 深路径 import。消除的是**根 barrel import**（`import * as AaveAddressBook`），不是包本身。

## 理由

1. **实时性**：链上读取 oracleAddress/poolAddress 不依赖 npm 发版周期，新增 spoke 后首次查询即可生效
2. **语义精确**：spokeKey 作为 `chainId:spokeAddress` 天然唯一，无需依赖 address-book 命名约定；spokeName 来自 SDK 官方数据，展示性优于 `MAIN_SPOKE`
3. **架构一致**：与 ADR-0025（reserveId 用 hubAddress 而非 hubName）一脉相承 — 功能标识用地址，展示用 SDK name
4. **最小依赖**：消除根 barrel import 后，address-book 降级为纯 ABI 提供者，地址数据不再耦合

## 替代方案

### 保持 address-book 根 barrel，仅改命名

- spokeKey/spokeName 语义分离可行，但 oracleAddress 仍依赖 npm 发版
- **未采纳**：不解决核心问题（非实时更新）

### 完全移除 address-book 依赖

- ABI 自行维护或从其他源获取
- **未采纳**：ABI 维护成本高且无收益，address-book 的 ABI 深路径 import 无实时性问题

## 后果

- **DB 迁移**：`oracle_source_configs.poolKey` 列值从 `MAIN_SPOKE` 更新为 `1:0x94e7...` 格式；reserve 行 `spokeName` 列值从 `MAIN_SPOKE` 更新为 `Main`
- **API 输出变化**：`spokeName` 字段值从 `MAIN_SPOKE` 变为 `Main`；`spokeKey` 字段新增（当前 API 不输出 spokeKey，仅内部使用）
- **启动行为变化**：oracleAddress 不再在 `initAddressBookRegistry()` 时填充，改为 oracleService 首次查询时 lazy init
- **fetcher 包**：`getAllAaveV3NetworksFromAddressBook()` 从 fallback 降级为纯 ABI + RPC fallback，address-book 根 barrel import 可消除
- **SDK spoke.name 稳定性风险**：如果 SDK 改变 `spoke.name` 值，spokeName 会随之变化。但 SDK name 是协议官方命名，稳定性高于 address-book key
- **SDK spoke.name 唯一性**：当前 10 个 spoke name 全局唯一，但非合约级保证。功能性唯一性由 spokeKey（`chainId:spokeAddress`）保证，spokeName 仅展示用

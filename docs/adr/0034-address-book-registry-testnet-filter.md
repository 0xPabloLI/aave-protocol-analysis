# ADR-0034: addressBookRegistry 用 testnet 过滤替代 AAVE_CHAIN_ID_TO_RPC_KEY 白名单

## 状态

Implemented

## 上下文

`addressBookRegistry.ts` 原先使用 `isSupportedChain(chainId)` 过滤地址簿条目——以 `AAVE_CHAIN_ID_TO_RPC_KEY` 的 key 集合作为白名单。这意味着：

1. **新链被自动排除**：address-book 升级添加新链后，若 `AAVE_CHAIN_ID_TO_RPC_KEY` 尚未同步更新，新链的 pool/oracle 地址不会出现在 registry 中
2. **与 auto-discovery 矛盾**：`ProviderPool.executeWithAutoRpc`（ADR-0027）已实现三层 RPC 自动发现（硬编码 → viem/chains → chainid.network），但 `isSupportedChain` 白名单阻止了 auto-discovery 被触发——链根本不会进入 `POOL_CONFIGS`，更不会执行 `executeWithAutoRpc`
3. **双重维护负担**：每次 address-book 新增链，需要同时更新 shared-config 的 RPC URL 列表，否则 registry 会静默丢弃该链

实际影响：Monad（chain 143）在 address-book v4.57.0 加入后，因 `AAVE_CHAIN_ID_TO_RPC_KEY` 缺少 `143`，`POOL_CONFIGS` 无 Monad 条目，`onchainDataService` 从未查询其 deficit，导致 API 返回 `deficitFallbackReserveIds`。

## 决策

### 1. 用 `isTestnetKey(key)` 替代 `isSupportedChain(chainId)`

```typescript
const isTestnetKey = (key: string): boolean =>
  key.includes('Sepolia') || key.includes('Fuji');
```

- **过滤逻辑反转**：从"只允许白名单中的链"变为"排除已知的 testnet 链"
- **新链自动纳入**：address-book 新增的任何 mainnet 链自动进入 registry，无需手动更新 shared-config
- **RPC 可用性由下游保证**：`executeWithAutoRpc` 的三层发现确保即使 shared-config 没有硬编码 RPC，链仍可被查询

### 2. Snapshot 测试改为动态 snapshot

`addressBookRegistry.test.ts` 中的手写 `SYNCED_V3_POOL_CONFIGS` / `SYNCED_V4_SPOKE_CONFIGS` fixture 数组彻底移除。改为从 address-book 运行时数据动态提取期望值：

- **V3**: 从 `AaveAddressBook` 的 keys 过滤 `AaveV3*` + 非 testnet + 有 `POOL` + `ORACLE`，直接与 registry 断言一致性
- **V4**: 从 `AaveAddressBook` 的 `SPOKES` 提取有 oracle 且在 `DEFAULT_SPOKE_HUB_TOPOLOGY` 中的 spoke，与 registry 断言一致性
- **SDK topology**: 从 `DEFAULT_SPOKE_HUB_TOPOLOGY` 动态生成，不再手写 `SDK_SPOKE_HUB_TOPOLOGY`

这样 address-book 升级后测试自动适应，不需要手动同步 fixture。

### 3. Dependabot address-book 升级频率从 weekly 改为 daily

新链更快被发现和集成。

## 理由

1. **信任 address-book 的 mainnet 链**：`@aave-dao/aave-address-book` 只包含 Aave 治理部署的链，testnet 链的命名规范稳定（`Sepolia`/`Fuji`），用字符串匹配足够可靠
2. **消除双重维护**：不再需要 shared-config 和 address-book 之间的手动同步
3. **auto-discovery 语义一致**：ADR-0027 的三层 RPC 发现设计初衷就是"新链无需部署即可用"，但 `isSupportedChain` 白名单违背了这一前提
4. **Dependabot 可用性**：弹性断言让 CI 不再因计数变化而 fail，address-book 升级 PR 可正常 auto-merge

## 替代方案

### 保留 `isSupportedChain`，每次新链手动添加 RPC

- 需要双重维护（address-book + shared-config）
- 新链有延迟（等 shared-config 更新 + 部署）
- **未采纳**：与 auto-discovery 架构矛盾

### 用 chainId 数组替代字符串匹配

```typescript
const TESTNET_CHAIN_IDS = new Set([11155111, 43113]);
```

- 需要每次新 testnet 上线时更新
- **未采纳**：address-book 的命名规范更稳定

## 后果

- **新链零手动配置**：address-book 升级后新链自动纳入（假设 `executeWithAutoRpc` 能发现 RPC）
- **shared-config 仅作为优化**：`AAVE_CHAIN_ID_TO_RPC_KEY` 和 `AAVE_RPC_URLS_BY_CHAIN_KEY` 仍应尽快更新，提供更高质量的硬编码 RPC URL，但不再是链可用性的前置条件
- **testnet 命名假设**：如果 address-book 未来引入非 `Sepolia`/`Fuji` 命名的 testnet 链，`isTestnetKey` 需要更新
- **Dependabot 自动流转**：弹性断言 + daily schedule 使 address-book 升级可自动完成

## 关联

- ADR-0027（分层 RPC 解析）：auto-discovery 的前提，本次改动使其真正可用
- ADR-0026（addressBook 动态化）：本次实现的部分前提（消除白名单依赖）
- ADR-0030（Merkl parent-child）：同一 session 中的 opportunityType + databaseId 修复

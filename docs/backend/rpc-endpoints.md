# RPC Endpoints Configuration

On-chain data (`deficit`, `baseVariableBorrowRate`) is fetched via `UiPoolDataProvider.getReservesHumanized()` using RPC endpoints.

## Configuration Location

```
packages/aave-shared-config/index.js
├── AAVE_RPC_URLS_BY_CHAIN_KEY         // RPC URLs by chain name (private + public)
├── AAVE_CHAIN_ID_TO_RPC_KEY           // chainId → chain name mapping
└── getAaveRpcUrlsByChainId()          // Helper function
```

## RPC Endpoints by Chain (Public Only)

| Chain | chainId | Public RPC Endpoints |
|-------|---------|----------------------|
| Ethereum | 1 | `ethereum-rpc.publicnode.com`, `eth-mainnet.public.blastapi.io`, `eth.drpc.org`, `1rpc.io/eth` |
| Polygon | 137 | `gateway.tenderly.co/public/polygon`, `polygon-pokt.nodies.app`, `polygon-bor-rpc.publicnode.com`, `rpc-mainnet.matic.quiknode.pro`, `polygon.drpc.org`, `1rpc.io/matic` |
| Avalanche | 43114 | `api.avax.network/ext/bc/C/rpc`, `avalanche.drpc.org`, `1rpc.io/avax/c`, `avalanche-c-chain-rpc.publicnode.com` |
| Arbitrum | 42161 | `arb1.arbitrum.io/rpc`, `1rpc.io/arb`, `arbitrum.drpc.org`, `arbitrum-one-rpc.publicnode.com` |
| Base | 8453 | `1rpc.io/base`, `base.llamarpc.com`, `base.publicnode.com`, `base-mainnet.public.blastapi.io`, `base.drpc.org` |
| Optimism | 10 | `public-op-mainnet.fastnode.io`, `optimism-rpc.publicnode.com`, `optimism.drpc.org`, `1rpc.io/op` |
| Metis | 1088 | `andromeda.metis.io/?owner=1088`, `metis-rpc.publicnode.com`, `metis.drpc.org`, `metis-andromeda.gateway.tenderly.co` |
| Gnosis | 100 | `gnosis-rpc.publicnode.com`, `rpc.gnosischain.com`, `1rpc.io/gnosis`, `gnosis.drpc.org`, `gnosis.api.onfinality.io/public` |
| BNB | 56 | `bsc.publicnode.com`, `bsc-mainnet.public.blastapi.io`, `1rpc.io/bnb`, `bsc.drpc.org` |
| Scroll | 534352 | `rpc.scroll.io`, `scroll-rpc.publicnode.com`, `scroll.drpc.org`, `1rpc.io/scroll` |
| zkSync | 324 | `mainnet.era.zksync.io`, `zksync.drpc.org`, `1rpc.io/zksync2-era`, `rpc.ankr.com/zksync_era`, `zksync-era.public-rpc.com` |
| Linea | 59144 | `1rpc.io/linea`, `linea.drpc.org`, `linea-rpc.publicnode.com`, `rpc.linea.build` |
| Sonic | 146 | `rpc.soniclabs.com`, `sonic.drpc.org`, `sonic-rpc.publicnode.com` |
| Celo | 42220 | `rpc.ankr.com/celo`, `celo.drpc.org`, `forno.celo.org`, `celo-mainnet.gateway.tatum.io` |
| Soneium | 1868 | `soneium.drpc.org`, `rpc.soneium.org`, `soneium-rpc.publicnode.com`, `soneium.gateway.tenderly.co` |
| Mantle | 5000 | `rpc.mantle.xyz`, `mantle.publicnode.com`, `mantle.drpc.org`, `mantle.gateway.tenderly.co` |
| MegaETH | 4326 | `mainnet.megaeth.com/rpc` |
| Plasma | 9745 | `rpc.plasma.to` |
| Ink | 57073 | `ink.drpc.org` |
| Blast | 81457 | `rpc.blast.io`, `blast.drpc.org`, `blast-rpc.publicnode.com` |
| opBNB | 204 | `opbnb-mainnet-rpc.bnbchain.org`, `opbnb.drpc.org`, `opbnb-rpc.publicnode.com` |
| zkLink Nova | 810180 | `rpc.zklink.io` |
| Manta | 169 | `pacific-rpc.manta.network/http`, `manta-pacific.drpc.org`, `1rpc.io/manta` |
| Berachain | 80094 | `rpc.berachain.com`, `berachain.drpc.org`, `berachain-rpc.publicnode.com` |
| Flare | 14 | `flare-api.flare.network/ext/C/rpc`, `rpc.ankr.com/flare` |
| Palm | 11297108109 | _(private only - requires Infura API key)_ |
| Abstract | 2741 | _(private only - requires Alchemy API key)_ |

> **Note**: Palm and Abstract chains have no working public RPC endpoints. They require private API keys (Infura/Alchemy) to function.

## Architecture

On-chain data is fetched **concurrently per-chain**, allowing all RPCs to be tried:

- **Cron schedule**: Every 1 minute at second :10 (markets at :00)
- **Per-RPC timeout**: 15 seconds
- **No overall timeout**: All chains run concurrently, each tries all RPC endpoints
- **Per-chain cache**: Each chain has its own `updatedAt` timestamp
- **Cache TTL**: 30 minutes (on-chain data changes infrequently)

## Fetch Flow

```
Cron :10 每分钟
   ↓
启动所有链并发 (Promise.allSettled)
   ↓
Chain 1: RPC1(15s) → 失败 → RPC2(15s) → 成功 → 更新 chain cache
Chain 2: RPC1(15s) → 成功 → 更新 chain cache
Chain 3: RPC1(15s) → 失败 → RPC2(15s) → 失败 → ... → 全部失败 → 保留旧 cache
...
   ↓
Markets 读取时 (每分钟 :00)
   ↓
遍历 per-chain cache，只取 TTL 内的数据
```

## Failover Strategy

1. RPC endpoints are tried in order for each chain (first success wins)
2. Each chain updates its own cache entry independently
3. On RPC failure: cached data within 30-min TTL is preserved
4. If no valid cache: `deficit` defaults to `"0"`, `baseVariableBorrowRate` calculated via reverse formula
5. Provider health tracking via `ethProviderService.ts`

## Per-chain Cache 内存

| 项目 | 估算 |
|------|------|
| 链数 | ~19（排除测试网） |
| 每链 reserve 数 | 约 5–20，平均 ~12 |
| 单条缓存 | `chainId` + `updatedAt` + `Map<tokenAddress, { deficit?, baseVariableBorrowRate? }>` |
| 单条数据 | 2 个 string（约 20–40 字符的 BigInt 字符串） |

**粗算**：19 × (1 个 Map + 12 × (42 字符地址 + 约 60 字符两个字段)) ≈ 19 × 1.3KB ≈ **25–50 KB**。

与「单一大 Map<chainId:tokenAddress, data>」相比，只是按 chain 分桶，总数据量相同，多的是 19 个 `updatedAt` 和 19 个 Map 的桶结构，内存增加可忽略。**结论：per-chain cache 对内存负担可忽略。**

---

## On-chain 数据来源对比

| 对比项 | 原设计/文档描述 | 当前实现 |
|--------|-----------------|----------|
| **deficit** | `pool.getReserveDeficit(asset)`，按资产单独调，每链 N 次 RPC | `UiPoolDataProvider.getReservesHumanized()` 一次调用，humanized 响应里含 `deficit`（Aave v3.3.0+） |
| **baseVariableBorrowRate** | 来自 `getReservesHumanized()` 的 ReserveData | 同上，同一次 humanized 响应 |
| **每链 RPC 次数** | 1（humanized）+ N（每个 reserve 一次 getReserveDeficit） | **1**（仅 getReservesHumanized） |
| **合约/接口** | Pool + UiPoolDataProvider | 仅 **UiPoolDataProvider**（`@aave/contract-helpers`） |
| **数据内容** | deficit（raw）、baseVariableBorrowRate（RAY） | 相同：deficit（raw）、baseVariableBorrowRate（RAY） |

**结论**：来源都是链上只读调用，数据含义与精度一致；当前实现用 **单次 getReservesHumanized() 替代「humanized + 每资产 getReserveDeficit」**，RPC 次数从 1+N 降为 1，逻辑更简单、延迟更低。

---

## Adding New RPC Endpoints

1. Edit `packages/aave-shared-config/index.js`
2. Add URLs to `AAVE_RPC_URLS_BY_CHAIN_KEY[chainName]`
3. Ensure `AAVE_CHAIN_ID_TO_RPC_KEY` has the chainId → chainName mapping

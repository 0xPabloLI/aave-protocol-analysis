# RPC Endpoints Configuration

On-chain data (`deficit`, `baseVariableBorrowRate`) is fetched via `UiPoolDataProvider.getReservesHumanized()` using public RPC endpoints.

## Configuration Location

```
packages/aave-shared-config/index.js
├── AAVE_PUBLIC_RPC_URLS_BY_CHAIN_KEY  // RPC URLs by chain name
├── AAVE_CHAIN_ID_TO_RPC_KEY           // chainId → chain name mapping
└── getAavePublicRpcUrlsByChainId()    // Helper function
```

## RPC Endpoints by Chain

| Chain | chainId | RPC Endpoints |
|-------|---------|---------------|
| Ethereum | 1 | `ethereum-rpc.publicnode.com`, `eth-mainnet.public.blastapi.io`, `rpc.ankr.com/eth`, `eth.drpc.org`, `cloudflare-eth.com`, `1rpc.io/eth` |
| Polygon | 137 | `gateway.tenderly.co/public/polygon`, `polygon-pokt.nodies.app`, `polygon-bor-rpc.publicnode.com`, `polygon-rpc.com`, `polygon-mainnet.public.blastapi.io`, `rpc-mainnet.matic.quiknode.pro`, `polygon.drpc.org`, `1rpc.io/matic` |
| Avalanche | 43114 | `api.avax.network/ext/bc/C/rpc`, `ava-mainnet.public.blastapi.io/ext/bc/C/rpc`, `rpc.ankr.com/avalanche`, `avalanche.drpc.org`, `1rpc.io/avax/c`, `avalanche-c-chain-rpc.publicnode.com` |
| Arbitrum | 42161 | `arb1.arbitrum.io/rpc`, `rpc.ankr.com/arbitrum`, `1rpc.io/arb`, `arbitrum.drpc.org`, `arbitrum-one-rpc.publicnode.com` |
| Base | 8453 | `1rpc.io/base`, `base.llamarpc.com`, `base.publicnode.com`, `base-mainnet.public.blastapi.io`, `base.drpc.org` |
| Optimism | 10 | `public-op-mainnet.fastnode.io`, `optimism-rpc.publicnode.com`, `optimism.drpc.org`, `1rpc.io/op`, `rpc.ankr.com/optimism` |
| Metis | 1088 | `andromeda.metis.io/?owner=1088`, `metis-rpc.publicnode.com`, `metis.drpc.org`, `metis-andromeda.gateway.tenderly.co` |
| Gnosis | 100 | `gnosis-rpc.publicnode.com`, `rpc.gnosischain.com`, `1rpc.io/gnosis`, `gnosis.drpc.org`, `gnosis.api.onfinality.io/public` |
| BNB | 56 | `bsc.publicnode.com`, `bsc-mainnet.public.blastapi.io`, `1rpc.io/bnb`, `bsc.drpc.org`, `rpc.ankr.com/bsc` |
| Scroll | 534352 | `rpc.scroll.io`, `rpc.ankr.com/scroll`, `scroll-rpc.publicnode.com`, `scroll.drpc.org`, `1rpc.io/scroll` |
| zkSync | 324 | `mainnet.era.zksync.io`, `zksync.drpc.org`, `1rpc.io/zksync2-era`, `rpc.ankr.com/zksync_era`, `zksync-era.public-rpc.com` |
| Linea | 59144 | `1rpc.io/linea`, `linea.drpc.org`, `linea-rpc.publicnode.com`, `rpc.linea.build` |
| Sonic | 146 | `rpc.soniclabs.com`, `sonic.drpc.org`, `sonic-rpc.publicnode.com` |
| Celo | 42220 | `rpc.ankr.com/celo`, `celo.drpc.org`, `forno.celo.org`, `celo-mainnet.gateway.tatum.io` |
| Soneium | 1868 | `soneium.drpc.org`, `rpc.soneium.org`, `soneium-rpc.publicnode.com`, `soneium.gateway.tenderly.co` |
| Mantle | 5000 | `rpc.mantle.xyz`, `mantle.publicnode.com`, `mantle.drpc.org`, `mantle.gateway.tenderly.co` |
| MegaETH | 4326 | `mainnet.megaeth.com/rpc` |
| Plasma | 9745 | `rpc.plasma.to` |
| Ink | 57073 | `ink.drpc.org`, `rpc.inkonchain.com` |

## Architecture

On-chain data is fetched **asynchronously** from markets, allowing longer timeouts:

- **Cron schedule**: Every 5 minutes (async from markets every 1 min)
- **Per-chain timeout**: 30 seconds
- **Overall timeout**: 120 seconds
- **Cache TTL**: 30 minutes (on-chain data changes infrequently)

## Failover Strategy

1. RPC endpoints are tried in order (first success wins)
2. Per-chain results are cached independently
3. On RPC failure: use cached data within 30-min TTL
4. If no cache: `deficit` defaults to `"0"`, `baseVariableBorrowRate` calculated from reverse formula
5. Provider health tracking via `ethProviderService.ts`

## Adding New RPC Endpoints

1. Edit `packages/aave-shared-config/index.js`
2. Add URLs to `AAVE_PUBLIC_RPC_URLS_BY_CHAIN_KEY[chainName]`
3. Ensure `AAVE_CHAIN_ID_TO_RPC_KEY` has the chainId → chainName mapping

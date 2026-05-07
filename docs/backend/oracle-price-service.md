# Oracle Price Service

从链上 AaveOracle 合约批量获取 V3 + V4 市场价格，写入内存缓存 + `data/debug/oracle-prices.json`。

## 架构

```
cron (每60秒) → refreshOracleCache()
  ├── V3: 24 个 Pool (14 条独立链)
  │     Pool.getReservesList() → AaveOracle.getAssetsPrices([])
  │     匹配键: chainId:tokenAddr
  ├── V4: 10 个 Spoke (全部在 Ethereum)
  │     Spoke.getReserveCount() → AaveOracle.getReservesPrices([])
  │     + reserveTokens 映射 (1h 缓存, 仅首刷/过期时调用 getReserve())
  │     匹配键: chainId:spokeAddr:tokenAddr
  ├── leanPriceCache (Map, O(1) 查询)
  └── 输出: data/debug/oracle-prices.json
```

价格精度统一为 8 位小数 (1e8，Chainlink 标准)。

## 关键文件

| 文件 | 职责 |
|---|---|
| `backend/src/services/oracleService.ts` | V3/V4 oracle 获取 + 内存缓存 + debug 写入 |
| `backend/src/cacheTtl.ts` | `oracleTtlMs: 30_000` + cron 表达式 |
| `backend/src/services/updateScheduler.ts` | cron 调度注册 |
| `backend/src/services/ethProviderService.ts` | RPC 提供者管理（健康追踪、失败回退） |
| `packages/aave-shared-config/index.js` | 各链 RPC URL（含 Infura/Alchemy/Ankr 私有 key） |
| `backend/src/env.ts` | 环境变量加载（dotenv → 私有 RPC key 注入） |
| `data/debug/oracle-prices.json` | 运行时输出 (~50KB) |

## 数据流

1. **Cron 轮询**（60 秒间隔）
2. 24 个 V3 Pool + 10 个 V4 Spoke **并行获取**（每池内部 RPC 重试回退）
3. V4 reserveToken 映射 1h 缓存，避免每轮 63 次无效调用
4. 写入内存 `cachedSnapshot` + `leanPriceCache`（TTL = 60 秒）
5. 同步写入 `data/debug/oracle-prices.json`
6. 通过 `getV3OraclePrice()` / `getV4OraclePrice()` 暴露 O(1) 查询

## V3 Pool 映射（24 个实例）

| Pool Key | Chain | Pool 地址 |
|---|---|---|
| AaveV3Ethereum | 1 (Ethereum) | `0x87870Bca...` |
| AaveV3EthereumLido | 1 | `0x4e033931...` |
| AaveV3EthereumEtherFi | 1 | `0x0AA97c28...` |
| AaveV3EthereumHorizon | 1 | `0xAe05Cd22...` |
| AaveV3Arbitrum | 42161 | `0x794a6135...` |
| AaveV3Avalanche | 43114 | `0x794a6135...` |
| AaveV3Base | 8453 | `0xA238Dd80...` |
| AaveV3BNB | 56 | `0x6807dc92...` |
| AaveV3Celo | 42220 | `0x3E59A313...` |
| AaveV3Gnosis | 100 | `0xb5020155...` |
| AaveV3Linea | 59144 | `0xc47b8C00...` |
| AaveV3Mantle | 5000 | `0x458F2934...` |
| AaveV3MegaETH | 4326 | `0x7e324AbC...` |
| AaveV3Metis | 1088 | `0x90df0255...` |
| AaveV3Optimism | 10 | `0x794a6135...` |
| AaveV3Polygon | 137 | `0x794a6135...` |
| AaveV3Plasma | 9745 | `0x925a2A72...` |
| AaveV3Scroll | 534352 | `0x11fCfe75...` |
| AaveV3Soneium | 1868 | `0xDd3d7A7d...` |
| AaveV3Sonic | 146 | `0x5362dBb1...` |
| AaveV3XLayer | 196 | `0xE3F3Caef...` |
| AaveV3zkSync | 324 | `0x78e30497...` |
| AaveV3Harmony | 1666600000 | `0x794a6135...` |
| AaveV3Ink | 57073 | `0x2816cf15...` |

## V4 Spoke 映射（10 个实例）

| 地址 | 合约名 | Oracle 地址 |
|---|---|---|
| `0x973a02...` | BLUECHIP_SPOKE | `0xdA1266a7...` |
| `0x94e7A5...` | MAIN_SPOKE | `0x99B2B6CE...` |
| `0x58131E...` | ETHENA_CORRELATED_SPOKE | `0x9b91a094...` |
| `0xba1B3D...` | ETHENA_ECOSYSTEM_SPOKE | `0xc390dbe9...` |
| `0xbF10BD...` | ETHERFI_E_SPOKE | `0xd8B153Fa...` |
| `0xe19004...` | LIDO_E_SPOKE | `0x664D73b6...` |
| `0x3131FE...` | KELP_E_SPOKE | `0x37C31699...` |
| `0xD8B936...` | FOREX_SPOKE | `0xB3CE6E7b...` |
| `0x65407b...` | GOLD_SPOKE | `0x0083421f...` |
| `0x7EC68b...` | LOMBARD_BTC_SPOKE | `0x198Cac7f...` |

## RPC 重试机制

每个 Pool/Spoke 获取顺序：
1. 从 `ethProviderService.getProvidersForChain(chainId, rpcUrls)` 获取健康候选列表
2. 按优先级依次尝试（公共 RPC 优先，私有 RPC 兜底）
3. 成功 → `reportProviderSuccess`，失败 → `reportProviderFailure` + 尝试下一个
4. 全部失败 → warn 日志

私有 RPC key（`.env` 注入）：`INFURA_PROJECT_ID`、`ALCHEMY_API_KEY`、`ANKR_API_KEY`。

## 与 onchainDataService 的关系

两个服务独立，不整合：

| 维度 | oracleService | onchainDataService |
|---|---|---|---|
| 合约 | AaveOracle (V3+V4) | UiPoolDataProvider |
| 地址配置 | 硬编码静态列表 | AaveAddressBook 动态发现 |
| 数据 | oracle 价格（USD） | deficit, baseVariableBorrowRate |
| TTL | 60 秒 | 30 分钟 |
| 刷新间隔 | 60 秒 | 1 分钟 |
| reserveToken 映射 | 1 小时缓存（几乎不变） | — |

**V4 reserveToken 两层 TTL 设计：** 价格每 60 秒刷新，但 `reserveId → tokenAddress` 映射 1 小时才重新查一次（只在 Aave 治理加减储备时才变化），避免每轮 63 次无效 `getReserve()` 调用。

**注意：** `backend/src/env.ts` 必须用动态 `import('@internal/aave-shared-config')` 而非静态 import，否则 `dotenv.config()` 先于 shared-config 执行导致所有私有 RPC key 为 `undefined`。

## 对外 API

数据通过 cron-write/API-read-only 模式暴露：

| 函数 | 用途 | 消费状态 |
|---|---|---|
| `refreshOracleCache()` | cron + 启动 warmup 写入 | ✅ updateScheduler + server.ts |
| `getV3OraclePrice(chainId, tokenAddr)` | 查 V3 代币价格，O(1) | 待接入 |
| `getV4OraclePrice(chainId, spokeAddr, tokenAddr)` | 查 V4 代币价格，O(1) | 待接入 |
| `getOraclePricesFromCache()` | 拿完整 JSON snapshot | 待接入 |
| `getLeanOracleCacheStatus()` | 查缓存健康状态 | 待接入 |
| `getOracleCacheStatus()` | 查完整 snapshot 健康状态 | 待接入 |

## 验证结果

```
V3:  275/275 SDK 代币匹配，0 SDK-only 缺口
V4:   59/59  SDK 代币匹配，0 SDK-only 缺口
P50 差异: 0.00%
P99 差异: 0.16%
Max 差异: 0.51% (Metis)
```

Oracle 链上价格与 Aave SDK API 价格完全一致，差异均在亚秒级刷新时差范围内。

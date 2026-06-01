# Backend Hardcode and External Imports

## 1. Source Of Truth

| 主题 | 来源 | 本地使用 |
|---|---|---|
| On-chain addresses | `@bgd-labs/aave-address-book` | `backend/src/services/onchainDataService.ts` |
| On-chain reserve reader | `@aave/contract-helpers` (`UiPoolDataProvider`) | `backend/src/services/onchainDataService.ts` |
| Shared RPC registry | `@internal/aave-shared-config` | `backend/src/services/ethProviderService.ts` |
| Markets data | `@aave/client` (GraphQL API) | `packages/aave-fetcher/src/index.ts` (root fetcher) |

## 2. 当前策略（On-chain Data）

- **Markets**：从 Aave SDK (`@aave/client`) 获取，包含大部分字段
- **On-chain only**：`deficit` + `baseVariableBorrowRate` 从 RPC 获取
- **发现机制**：动态解析 `@bgd-labs/aave-address-book` 的 `AaveV3*` 导出
- **缓存**：RPC 失败时使用 5 分钟内的缓存数据

## 2.1 ABI 来源策略

所有合约 ABI 遵循 **upstream + local 二层架构**。业务文件**禁止**本地硬编码 ABI。

### 二层结构

| 层 | 含义 | 来源 | 细分 |
|---|---|---|---|
| Upstream | 上游包原生导出 | `@aave-dao/aave-address-book/abis/*` | upstream |
| Upstream | 共享包导出 | `@internal/aave-rpc-infra` | shared |
| Local | 后端本地补充（仅 `V4_ORACLE_PRICES_ABI`） | `backend/src/abis/` | local |

`abis/index.ts` 只 re-export 本地定义。上游 ABI 由消费侧直接从上游包 import。

### 约束

- `backend/src/services/**` 内**禁止** inline ABI 数组字面量
- services **禁止** `from '@aave-dao/aave-address-book'` 根 barrel import（用 `/abis/*` 深路径）
- `addressBookRegistry.ts` 例外（它导入地址数据，非 ABI）
- CI 测试：`no-inline-abi.test.ts` + `abi-drift.test.ts`

详见 [abi-bridge-layer-review.md](./abi-bridge-layer-review.md)

## 3. 环境变量

- RPC 不支持环境变量覆写，统一来自 shared RPC registry
- 详见 `docs/backend/rpc-endpoints.md`

## 4. 非自动化项（保留人工）

| 项目 | 原因 | 处理方式 |
|---|---|---|
| 地址簿未覆盖链 | 上游 SDK 无 fallback metadata | 等待上游更新 |
| RPC 质量 | 运行时基础设施问题 | 监控告警 + 更新 shared RPC 列表 |
| 新链支持 | 需要 RPC 端点 | 更新 `packages/aave-shared-config/index.js` |
| V4 TREASURY_SPOKE | `ITreasurySpoke` 无 oracle，address-book 不提供 `TREASURY_SPOKE_ORACLE` | sync 脚本自动跳过并输出日志 |

### V4 Spoke Oracle 同步规则

`addressBookRegistry` 在运行时从 `@aave-dao/aave-address-book` 遍历 `AaveV4*.SPOKES` 提取 spoke+oracle 对。规则：
- 有 `_SPOKE_ORACLE` / `_ESPOKE_ORACLE` 的 spoke → 进入 `V4_SPOKE_ENTRIES`
- 无 oracle 的 spoke（如 `TREASURY_SPOKE`）→ 自动跳过（`V4_SKIP_SPOKES` 硬编码排除）
- Spoke→Hub 映射 (`V4_SPOKE_TO_HUB`) 维护在 registry 内，multi-hub spokes（如 `BLUECHIP_SPOKE`）生成多个 entry

## 6. Aave V3 合约地址参考

以下地址来自 `@bgd-labs/aave-address-book`（当前版本 4.44.22），用于 on-chain fallback 读取。

> **注意**：地址随上游包更新而变化，以 `npm list @bgd-labs/aave-address-book` 输出的版本为准。

### 主网地址表

| 网络 | Chain ID | UI_POOL_DATA_PROVIDER | POOL_ADDRESSES_PROVIDER | POOL |
|------|----------|----------------------|------------------------|------|
| **Ethereum** | 1 | `0x56b7A1012765C285afAC8b8F25C69Bf10ccfE978` | `0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e` | `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2` |
| Ethereum Lido | 1 | `0x56b7A1012765C285afAC8b8F25C69Bf10ccfE978` | `0xcfBf336fe147D643B9Cb705648500e101504B16d` | `0x4e033931ad43597d96D6bcc25c280717730B58B1` |
| Ethereum EtherFi | 1 | `0x56b7A1012765C285afAC8b8F25C69Bf10ccfE978` | `0xeBa440B438Ad808101d1c451C1C5322c90BEFCdA` | `0x0AA97c284e98396202b6A04024F5E2c65026F3c0` |
| Ethereum Horizon | 1 | `0x56b7A1012765C285afAC8b8F25C69Bf10ccfE978` | `0x5D39E06b825C1F2B80bf2756a73e28eFAA128ba0` | `0xAe05Cd22df81871bc7cC2a04BeCfb516bFe332C8` |
| **Optimism** | 10 | `0xa6741111f4CcB5162Ec6A825465354Ed8c6F7095` | `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb` | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| **BNB** | 56 | `0x632b5Dfc315b228bfE779E6442322Ad8a110Ea13` | `0xff75B6da14FfbbfD355Daf7a2731456b3562Ba6D` | `0x6807dc923806fE8Fd134338EABCA509979a7e0cB` |
| **Gnosis** | 100 | `0xD14F4d3495d5096a31F33605F2D0803bbe2EAdc0` | `0x36616cf17557639614c1cdDb356b1B83fc0B2132` | `0xb50201558B00496A145fE76f7424749556E326D8` |
| **Polygon** | 137 | `0xFa1A7c4a8A63C9CAb150529c26f182cBB5500944` | `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb` | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| **Sonic** | 146 | `0x4F3F69979ED28c962028582B1760E98B1a117097` | `0x5C2e738F6E27bCE0F7558051Bf90605dD6176900` | `0x5362dBb1e601abF3a4c14c22ffEdA64042E5eAA3` |
| **ZkSync** | 324 | `0x419FFd4736671bbe1d9122d797345774Bd5db3b0` | `0x2A3948BB219D6B2Fa83D64100006391a96bE6cb7` | `0x78e30497a3c7527d953c6B1E3541b021A98Ac43c` |
| **Metis** | 1088 | `0xE970Db949A75702bB5A280125742078cF39CE568` | `0xB9FABd7500B2C6781c35Dd48d54f81fc2299D7AF` | `0x90df02551bB792286e8D4f13E0e357b4Bf1D6a57` |
| **Soneium** | 1868 | `0xc69299Ddd3a704F6954c8Ae1AD00e0892d77Aee4` | `0x82405D1a189bd6cE4667809C35B37fBE136A4c5B` | `0xDd3d7A7d03D9fD9ef45f3E587287922eF65CA38B` |
| **MegaEth** | 4326 | `0x1aB55bBdD5DF0782BBCf73553Af93BC6B29A286B` | `0x46Dcd5F4600319b02649Fd76B55aA6c1035CA478` | `0x7e324AbC5De01d112AfC03a584966ff199741C28` |
| **Mantle** | 5000 | `0x077df1990bF703fb1687515747ddb13621133649` | `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f` | `0x458F293454fE0d67EC0655f3672301301DD51422` |
| **Base** | 8453 | `0xb84A20e848baE3e13897934bB4e74E2225f4546B` | `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D` | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` |
| **Plasma** | 9745 | `0xdA549478Fd5C2BdB9e5eB000D0ff2554771598C7` | `0x061D8e131F26512348ee5FA42e2DF1bA9d6505E9` | `0x925a2A7214Ed92428B5b1B090F80b25700095e12` |
| **Arbitrum** | 42161 | `0x13c833256BD767da2320d727a3691BAff3770E39` | `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb` | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| **Celo** | 42220 | `0xe48424542b30b0b8D1Dc09099aceE407f40b4491` | `0x9F7Cf9417D5251C59fE94fB9147feEe1aAd9Cea5` | `0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402` |
| **Avalanche** | 43114 | `0x3518E8927A7827CDdAf841872453003CA95906A3` | `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb` | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| Ink Whitelabel | 57073 | `0xF1485fb7DBFa5db0B368FeA808FD6ff945c36064` | `0x4172E6aAEC070ACB31aaCE343A58c93E4C70f44D` | `0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA` |
| **Linea** | 59144 | `0x898813Dd328BD3D7353c77aD0B1C0E10F3773E29` | `0x89502c3731F69DDC95B65753708A07F8Cd0373F4` | `0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac` |
| **Scroll** | 534352 | `0x6926c8195a8840099Daa643C2d9aDE18C0D233d9` | `0x69850D0B276776781C063771b161bd8894BCdD04` | `0x11fCfe756c05AD438e312a7fd934381537D3cFfe` |

### 快速查询脚本

```bash
# 查询特定链的完整地址（以 Sonic 为例）
node -e "const { AaveV3Sonic } = require('@bgd-labs/aave-address-book'); console.log(JSON.stringify(AaveV3Sonic, null, 2));"

# 列出所有支持的 AaveV3 市场
node -e "const a = require('@bgd-labs/aave-address-book'); Object.keys(a).filter(k => k.startsWith('AaveV3') && !/(Sepolia|Fuji|Goerli)/.test(k)).forEach(k => console.log(k));"
```

### 地址用途说明

| 合约 | 用途 |
|------|------|
| `UI_POOL_DATA_PROVIDER` | 读取 reserve 状态（on-chain data: `deficit`, `baseVariableBorrowRate`） |
| `POOL_ADDRESSES_PROVIDER` | 获取 Pool 及相关合约地址的注册中心 |
| `POOL` | 核心借贷池合约 |
| `ORACLE` | 价格预言机 |
| `AAVE_PROTOCOL_DATA_PROVIDER` | 协议数据读取（备用） |
| `MULTICALL3_ADDRESS` | Multicall3 聚合合约（CREATE2 确定性地址 `0xcA11bde05977b3631167028862bE2a173976CA11`，来源 [mds1/multicall](https://github.com/mds1/multicall)）；来源：`@internal/aave-rpc-infra` |

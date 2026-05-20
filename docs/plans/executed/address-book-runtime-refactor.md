# 重构：address-book 统一运行时消费 + 遍历合并

> **Status: Executed** (2026-05-19)
> 
> **Outcome:** 新建 [addressBookRegistry.ts](file:///Users/pabloli/Documents/code/aave-protocol-analysis/backend/src/services/addressBookRegistry.ts) 统一 V3/V4 运行时遍历，删除预生成基础设施（`oracle-pool-configs.ts` + `sync-oracle-pool-configs.ts` + CI workflow），oracleService 和 onchainDataService 消费 registry 常量。179 tests pass, ci:remote green.
> 
> **Root cause resolved:** oracleService 不再依赖 `npm run sync:oracle-pool-configs` 预生成，address-book 升级后自动生效。
> 
> **Related:** AAV-170 (completed) — address-book-runtime-refactor 列为其 follow-up。
>
> **Follow-up (2026-05-20):** V4 路径也加了 `isSupportedChain(chainId)` 白名单过滤，与 V3 行为一致。地址簿出现新 V4 链时，只需在 `aave-shared-config` 加 RPC 配置即可生效。

## 范围声明

**In scope：** `@aave-dao/aave-address-book` 派生的 V3 pool / V4 spoke 配置统一为运行时消费。

**Out of scope：** `scripts/sync-coingecko-platform-map.ts` — 它从 CoinGecko **外部 API** 拉数据并生成
`packages/aave-fetcher/src/generated/coingecko-platform-by-chain-id.ts`，不是 address-book 派生，保留 sync 模型。

## 现状

| Service | 消费方式 | address-book import | 配置来源 |
|---------|---------|---------------------|---------|
| `aave-fetcher` | 运行时 | `import * as addressBook` | npm 包，升级即生效 |
| `onchainDataService` | 运行时 | `import * as AaveAddressBook` | npm 包，升级即生效 |
| `oracleService` | 预生成 | `import { SYNCED_* } from '../generated/...'` | `npm run sync:oracle-pool-configs` → 静态文件 |

**问题：** oracleService 依赖 `scripts/sync-oracle-pool-configs.ts` 预生成 `backend/src/generated/oracle-pool-configs.ts`。
每次 `@aave-dao/aave-address-book` 升级，必须跑 sync 脚本，否则 oracle 配置 stale。当前由 GitHub Actions
workflow `.github/workflows/oracle-pool-config-sync.yml` 定时跑并自动开 PR — 链路长且与 onchain/fetcher 不对称。

**遍历次数现状：** 3 次
- `onchainDataService.buildPoolConfigs()` — V3 运行时遍历
- `onchainDataService.buildV4SpokeConfigs()` — V4 运行时遍历
- `scripts/sync-oracle-pool-configs.ts` — 构建期 V3+V4 各一次（生成 `SYNCED_*` 后运行时只是数组 `.map`）

**合并后：1 次遍历** — `AaveV3*` / `AaveV4*` key prefix 互斥，单次 `Object.entries(AaveAddressBook)` 同时产出 V3 + V4 entries。

## 目标

1. oracleService 改为运行时 `import * as AaveAddressBook`，和 onchainDataService/fetcher 一致
2. 删除 `backend/src/generated/oracle-pool-configs.ts`、`scripts/sync-oracle-pool-configs.ts`、对应 GitHub workflow
3. 抽取共享的 address-book 遍历模块 `addressBookRegistry`，oracleService 与 onchainDataService 共用一次遍历结果
4. **保留**所有现有过滤规则与命名映射（无静默回归）

---

## Step 0: Inventory（合并语义前的事实清单）

合并前必须显式承认两个 builder 当前的语义差异，避免静默回归。

### V3 过滤规则差异

| Builder | 过滤逻辑 | 实际排除 |
|---------|---------|---------|
| `onchainDataService.buildPoolConfigs()` | `key.includes('Sepolia') \|\| key.includes('Fuji')` | 不排 Fantom mainnet |
| `scripts/sync-oracle-pool-configs.ts` `EXCLUDED_POOLS` | 显式黑名单 10 个 | 排 Fantom mainnet + 全部 testnet |

**为什么不能用 schema 字段过滤：** `@aave-dao/aave-address-book` 的每个 export **没有 `TESTNET` / `IS_MAINNET` 字段**，
无法 schema-driven 区分 mainnet/testnet。可选方案对比：

| 方案 | solidity | 缺点 |
|------|---------|------|
| **复用 `AAVE_CHAIN_ID_TO_RPC_KEY` 作为白名单**（采纳） | 最高 — 与运行时 RPC 配置同源，零维护成本 | 无 |
| 在 registry 内新维护一份 mainnet chainId 白名单 | 中 | 与 `AAVE_CHAIN_ID_TO_RPC_KEY` 两边漂移 |
| testnet chainId 黑名单 | 中 | 未来新 testnet 名字漏判 |
| `key.includes('Sepolia')` keyword（onchain 现状） | 低 | 漏 Fuji、未来新 testnet 命名风险 |
| 显式 pool key 黑名单（sync 脚本现状） | 低 | 每个新 testnet 都得手动加 |

**关键发现：** `packages/aave-shared-config/index.js` 已暴露 `AAVE_CHAIN_ID_TO_RPC_KEY`（[line 285](file:///Users/pabloli/Documents/code/aave-protocol-analysis/packages/aave-shared-config/index.js#L285)）。
它本身就是「我们运维支持的 chain」的 single source of truth — 没配 RPC 的 chain 即使
在 address-book 里也跑不通。直接 `import { AAVE_CHAIN_ID_TO_RPC_KEY } from '@internal/aave-shared-config'`
即可，不要在 registry 里再维护一份。

**收敛策略：**
- V3 用 `chainId in AAVE_CHAIN_ID_TO_RPC_KEY` 过滤
- Fantom（250）天然排除 — 不在 `AAVE_CHAIN_ID_TO_RPC_KEY` 里
- MegaEth（4326）天然包含 — 已在 `AAVE_CHAIN_ID_TO_RPC_KEY` line 297
- 未来新增 chain 只在 `aave-shared-config` 一处更新

**对 onchainDataService 的影响：** 现状是 `key.includes('Sepolia')` 过滤后用 `getAaveRpcUrlsByChainId()`
拿 RPC。改为白名单过滤后，行为更严格但效果一致 — 没在白名单的 chain 之前也拿不到 RPC（`getAaveRpcUrlsByChainId` 返回 `[]`），
只是把 silent skip 提前到 entry 构建期。

### V3 必需字段差异

| Field | oracleService | onchainDataService |
|-------|---------------|--------------------|
| `POOL` | ✅ 必需 | ✅ 必需 |
| `CHAIN_ID` | ✅ 必需 | ✅ 必需 |
| `ORACLE` | ✅ 必需 | — |
| `UI_POOL_DATA_PROVIDER` | — | ✅ 必需 |
| `POOL_ADDRESSES_PROVIDER` | — | ✅ 必需 |

**收敛策略：** `V3PoolEntry` 把 `oracleAddress` / `uiPoolDataProviderAddress` / `poolAddressesProvider`
都做成 optional，消费方在自己的 filter step 里 narrow（oracle 缺失 → 不进 oracle 列表；UI 缺失 → 不进 onchain 列表）。

### V4 SpokeName 生成机制冲突 ⚠️

| Builder | 实际写入的 `spokeName` | 示例 |
|---------|---------------------|------|
| `onchainDataService.buildV4SpokeConfigs()`（当前代码） | **直接用 raw `spokeKey`** ([line 239](file:///Users/pabloli/Documents/code/aave-protocol-analysis/backend/src/services/onchainDataService.ts#L239)) | `MAIN_SPOKE`、`ETHENA_CORRELATED_SPOKE`、`LOMBARD_BTC_SPOKE` |
| `sync-oracle-pool-configs.ts` `spokeKeyToName` | 算法：去 `_SPOKE`/`_ESPOKE` + 驼峰化 | `Main`、`EthenaCorrelated`、`LombardBtc` |

> 注：`V4_SPOKE_NAME_MAP` 已被删除。`V4_SPOKE_TO_HUB` 仍在
> [onchainDataService.ts:200](file:///Users/pabloli/Documents/code/aave-protocol-analysis/backend/src/services/onchainDataService.ts#L200)
> 使用，本 PR 迁入 registry。

**这意味着：** 同一个 spoke 在 oracle / onchain 两个数据流里 spokeName **目前就是不一致的**
（例：onchain 写 `MAIN_SPOKE`、oracle 写 `Main`）。这本身是个隐性 bug — 任何想跨两个数据流 join
spoke 的下游消费方都会失败。

**收敛策略：** 以 `onchainDataService` 现行行为（raw `spokeKey`）为准 — 因为：
1. 它是已经写入 DB / API 的事实标准
2. 算法去前缀有信息丢失（无法回推 `Main` 是 `MAIN_SPOKE` 还是 `MAIN_ESPOKE`）
3. raw key 在 address-book 中是 stable 的命名键

oracleService 切换到 registry 后，`spokeName` 自动从 `Main` 变成 `MAIN_SPOKE`。需检查
[oracleService.ts:166-200](file:///Users/pabloli/Documents/code/aave-protocol-analysis/backend/src/services/oracleService.ts#L166) 和
[persistenceService.ts:405-467](file:///Users/pabloli/Documents/code/aave-protocol-analysis/backend/src/services/persistenceService.ts#L405) —
若 spokeName 进入 DB `poolKey` 字段或 API 响应，需要走 DB 迁移或保留兼容。

### V4 其他规则

| 规则 | 来源 | registry 是否承接 |
|------|------|-----------------|
| 跳过 `TREASURY_SPOKE`（无 oracle） | sync 脚本通过 oracle 缺失自动跳过；onchain 显式 `continue` | ✅ 显式 hardcode `TREASURY_SPOKE` 黑名单（语义更清晰） |
| `V4_SPOKE_TO_HUB` 映射 | onchain 私有 | ✅ 移入 registry — registry 是 V4 spoke 唯一权威源 |
| `HUB` 解析（`hubs[hubKey]`） | onchain 私有 | ✅ 移入 registry |
| 多 chain V4 支持 | onchain 遍历所有 `AaveV4*`；sync 脚本只看 `AaveV4Ethereum` | ✅ 采用 onchain 的全量遍历（更通用） |

---

## Step 1: 新建 `backend/src/services/addressBookRegistry.ts`

**单次遍历**产出 V3 + V4 全部 entries（key prefix 互斥，无重复遍历开销）。

```typescript
import * as AaveAddressBook from '@aave-dao/aave-address-book';
import { AAVE_CHAIN_ID_TO_RPC_KEY } from '@internal/aave-shared-config';

// === V3 ===
export interface V3PoolEntry {
  poolKey: string;                        // 如 AaveV3Ethereum
  chainId: number;
  poolAddress: string;                    // lowercased
  oracleAddress?: string;                 // 缺失 → 不进 oracle 列表
  uiPoolDataProviderAddress?: string;     // 缺失 → 不进 onchain 列表
  poolAddressesProvider?: string;
}

// 白名单 = 已配 RPC 的 chain（authoritative source）
const isSupportedChain = (chainId: number): boolean =>
  Object.prototype.hasOwnProperty.call(AAVE_CHAIN_ID_TO_RPC_KEY, chainId);

// === V4 ===
export interface V4SpokeEntry {
  spokeKey: string;                       // raw key 如 MAIN_SPOKE — 同时也是 spokeName
  chainId: number;
  spokeAddress: string;                   // lowercased
  hubKey: string;                         // 如 CORE_HUB
  hubAddress: string;                     // lowercased
  oracleAddress?: string;                 // 来自 SPOKES[`${spokeKey}_ORACLE`]
}

// 唯一仍需要的 V4 映射 — 从 onchainDataService.ts 整体迁入
// Note: Record<string, string[]> (multi-hub support). BLUECHIP_SPOKE → [CORE_HUB, PRIME_HUB].
// Each (spokeKey, hubKey) combo produces a separate V4SpokeEntry.
const V4_SPOKE_TO_HUB: Record<string, string[]> = {
  MAIN_SPOKE: ['CORE_HUB'],
  BLUECHIP_SPOKE: ['CORE_HUB', 'PRIME_HUB'],
  LIDO_ESPOKE: ['CORE_HUB'],
  ETHERFI_ESPOKE: ['CORE_HUB'],
  KELP_ESPOKE: ['CORE_HUB'],
  ETHENA_CORRELATED_SPOKE: ['PLUS_HUB'],
  ETHENA_ECOSYSTEM_SPOKE: ['PLUS_HUB'],
  FOREX_SPOKE: ['PLUS_HUB'],
  GOLD_SPOKE: ['PLUS_HUB'],
  LOMBARD_BTC_SPOKE: ['PRIME_HUB'],
};
const V4_SKIP_SPOKES = new Set(['TREASURY_SPOKE']);

function buildAll(): { v3: V3PoolEntry[]; v4Spokes: V4SpokeEntry[] } {
  const v3: V3PoolEntry[] = [];
  const v4Spokes: V4SpokeEntry[] = [];

  for (const [key, value] of Object.entries(AaveAddressBook)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, any>;
    const chainId = Number(v.CHAIN_ID);
    if (!Number.isFinite(chainId) || chainId <= 0) continue;

    if (key.startsWith('AaveV3')) {
      if (!isSupportedChain(chainId)) continue;
      const poolAddress = typeof v.POOL === 'string' ? v.POOL.toLowerCase() : '';
      if (!poolAddress) continue;
      v3.push({
        poolKey: key,
        chainId,
        poolAddress,
        oracleAddress: typeof v.ORACLE === 'string' ? v.ORACLE.toLowerCase() : undefined,
        uiPoolDataProviderAddress: typeof v.UI_POOL_DATA_PROVIDER === 'string' ? v.UI_POOL_DATA_PROVIDER : undefined,
        poolAddressesProvider: typeof v.POOL_ADDRESSES_PROVIDER === 'string' ? v.POOL_ADDRESSES_PROVIDER : undefined,
      });
    } else if (key.startsWith('AaveV4')) {
      const hubs = v.HUBS as Record<string, string> | undefined;
      const spokes = v.SPOKES as Record<string, string> | undefined;
      if (!hubs || !spokes) continue;

      for (const [spokeKey, spokeAddr] of Object.entries(spokes)) {
        if (!spokeKey.endsWith('_SPOKE') && !spokeKey.endsWith('_ESPOKE')) continue;
        if (V4_SKIP_SPOKES.has(spokeKey)) continue;
        if (typeof spokeAddr !== 'string') continue;
        const hubKeys = V4_SPOKE_TO_HUB[spokeKey];
        if (!hubKeys || hubKeys.length === 0) continue;

        for (const hubKey of hubKeys) {
          const hubAddr = hubs[hubKey];
          if (typeof hubAddr !== 'string') continue;

          v4Spokes.push({
            spokeKey,
            chainId,
            spokeAddress: spokeAddr.toLowerCase(),
            hubKey,
            hubAddress: hubAddr.toLowerCase(),
            oracleAddress: typeof spokes[`${spokeKey}_ORACLE`] === 'string' ? spokes[`${spokeKey}_ORACLE`].toLowerCase() : undefined,
          });
        }
      }
    }
  }
  return { v3, v4Spokes };
}

const _all = buildAll();
export const V3_ENTRIES: readonly V3PoolEntry[] = _all.v3;
export const V4_SPOKE_ENTRIES: readonly V4SpokeEntry[] = _all.v4Spokes;
```

文件头部注释必须记录：
- V3 白名单源 = `AAVE_CHAIN_ID_TO_RPC_KEY`（新链上线时只在 `aave-shared-config` 加 RPC 即生效，无双写）
- spokeKey 就是 spokeName（不再做 `_SPOKE` 去前缀，与 onchainDataService 现行一致）
- V4 spoke→hub 是多对多映射（`Record<string, string[]>`），`BLUECHIP_SPOKE` → `[CORE_HUB, PRIME_HUB]`，每对 combo 生成独立 entry
- 「这是 address-book 的唯一权威 narrowing 层，不要在消费方重复 filter」

---

## Step 2: oracleService 改为消费 `addressBookRegistry`

```typescript
// before
import { SYNCED_V3_POOL_CONFIGS, SYNCED_V4_SPOKE_CONFIGS, type SyncedV3PoolConfig, type SyncedV4SpokeConfig } from '../generated/oracle-pool-configs.js';

// after
import { V3_ENTRIES, V4_SPOKE_ENTRIES } from './addressBookRegistry.js';

const V3_POOL_CONFIGS: V3PoolConfig[] = V3_ENTRIES
  .filter((e) => !!e.oracleAddress)
  .map((e) => ({ poolKey: e.poolKey, chainId: e.chainId, poolAddress: e.poolAddress, oracleAddress: e.oracleAddress! }));

const V4_SPOKE_CONFIGS = V4_SPOKE_ENTRIES
  .filter((e) => !!e.oracleAddress)
  .map((e) => ({ spokeName: e.spokeKey, chainId: e.chainId, spokeAddress: e.spokeAddress, oracleAddress: e.oracleAddress! }));
```

⚠️ **Behavior change**: V4 `spokeName` 从 `SPOKE_NAME_MAP` 映射（如 `Bluechip`、`Main`）变为 raw key（`MAIN_SPOKE`、`BLUECHIP_SPOKE`）。
统一向 onchainDataService 现行行为对齐。移除 `// Run npm run sync:oracle-pool-configs to refresh.` 注释。
**同时删除** `SPOKE_NAME_MAP` 常量 — 不再需要。`CHAIN_NAME_BY_ID` 保留（仍用于日志）。

⚠️ **DB 影响**: `persistenceService.ts:467` 使用 `v4.spokeName` 作为 `oracle_source_configs` 表的 `pool_key`（`v4|${spokeName}`）。
spokeName 变更后，新 cycle 会在 DB 中写入新的 `pool_key`，旧 key 的行不再更新但保留在归档中。
**不需要 DB migration** — 这是归档表，新旧数据共存可接受。但需确认无下游查询依赖旧 `pool_key` 格式。

## Step 3: onchainDataService 改为消费 `addressBookRegistry`

```typescript
import { V3_ENTRIES, V4_SPOKE_ENTRIES } from './addressBookRegistry.js';

const POOL_CONFIGS = new Map<string, OnchainConfig>(
  V3_ENTRIES
    .filter((e) => e.uiPoolDataProviderAddress && e.poolAddressesProvider)
    .map((e) => [e.poolAddress, {
      poolAddress: e.poolAddress,
      chainId: e.chainId,
      uiPoolDataProviderAddress: e.uiPoolDataProviderAddress!,
      poolAddressesProvider: e.poolAddressesProvider!,
      defaultRpcUrls: getAaveRpcUrlsByChainId(e.chainId),
    }]),
);

const V4_SPOKE_CONFIGS: V4SpokeConfig[] = V4_SPOKE_ENTRIES.map((e) => ({
  spokeName: e.spokeKey,            // 与现行 `spokeName: spokeKey` 行为完全一致
  chainId: e.chainId,
  spokeAddress: e.spokeAddress,
  hubAddress: e.hubAddress,
  hubName: e.hubKey,
  defaultRpcUrls: getAaveRpcUrlsByChainId(e.chainId),
}));
```

删除：
- `buildPoolConfigs()`、`buildV4SpokeConfigs()`
- `V4_SPOKE_TO_HUBS`（迁入 registry）
- `normalizeAddress()`（如不再使用）

> 注：`SPOKE_NAME_MAP` 在 oracleService.ts Step 2 中一并删除。

---

## Step 4: 删除预生成基础设施

| 路径 | 动作 |
|------|------|
| `backend/src/generated/oracle-pool-configs.ts` | 删除 |
| `backend/src/generated/` | 如目录变空，删除 |
| `scripts/sync-oracle-pool-configs.ts` | 删除 |
| `package.json` `scripts.sync:oracle-pool-configs` | 删除 |
| `.github/workflows/oracle-pool-config-sync.yml` | **删除整个 workflow**（不是「移除 --check 步骤」— 仓库内无 `--check` 调用） |
| `docs/backend/HARDCODE-AND-EXTERNAL-IMPORTS.md` line 35 | 更新 sync 脚本描述 |
| `docs/architecture/workspace-boundaries.md` line 19 | 移除 `scripts/sync-oracle-pool-configs.ts ↔ generated/...` 条目 |
| `AGENTS.md` | 检索 `sync:oracle-pool-configs` / `generated/oracle-pool-configs`，更新或移除引用 |

CoinGecko 相关脚本与 workflow **不动**。

---

## Step 5: 验证

### 5.1 Snapshot 一致性测试（必须）

新增 `backend/src/services/__tests__/addressBookRegistry.snapshot.test.ts`：
- 在切换 import 之前先跑：dump 当前 `SYNCED_V3_POOL_CONFIGS` + `SYNCED_V4_SPOKE_CONFIGS` + `POOL_CONFIGS` + `V4_SPOKE_CONFIGS` 到 fixture
- 切换 import 之后跑：assert registry 派生结果与 fixture **逐字段 deep equal**
- 通过后保留为 regression test（fixture 随 address-book 升级可重新生成）

### 5.2 命令

```bash
npm run build -w aave-dashboard-backend
npm run test -w aave-dashboard-backend
npm run ci:remote   # 验证移除 sync workflow 后 CI 仍 green
```

### 5.3 手动 spot-check

跑一次 oracleService / onchainDataService 的真实接口（dev 环境），对比 PR 前后输出：
- `/api/markets` 中 V3 pool 列表
- `/api/markets` 中 V4 spoke 列表 + hubName 字段

---

## 风险与注意

| 风险 | 缓解 |
|------|------|
| 模块加载期遍历失败导致进程崩溃 | registry 的两个 builder 全部 wrap try/catch，缺字段 silently skip + `console.warn`，和现有 builder 行为一致 |
| `V3_EXCLUDED` 决策被遗忘 | registry 文件头部注释 + 单测断言 `Fantom` 不在 entries 中 |
| 新增 V4 spoke 未在 `V4_SPOKE_TO_HUB` | snapshot test list 全部 spokeKey → 新 spoke 出现时 test diff 自动报警 |
| `BLUECHIP_SPOKE → PRIME_HUB` 映射丢失（multi-hub）| `V4_SPOKE_TO_HUB` 使用 `Record<string, string[]>`，单测断言 `BLUECHIP_SPOKE` 对应 2 个 hub |
| address-book major bump 后字段消失 | snapshot test 兜底 |
| oracle spokeName 变更影响 DB `oracle_source_configs` 的 `pool_key` | 归档表，新旧 key 共存可接受；`ON CONFLICT` upsert 确保新 cycle 写入新 key，旧行自然过期 |
| GitHub workflow 删除影响其他流程 | workflow 仅 commit 一个文件（`oracle-pool-configs.ts`），删除该文件后 workflow 自然无用，无外部依赖 |

---

## 改动范围

| 文件 | 动作 |
|------|------|
| `backend/src/services/addressBookRegistry.ts` | **新建** |
| `backend/src/services/__tests__/addressBookRegistry.snapshot.test.ts` | **新建** |
| `backend/src/services/oracleService.ts` | 修改 — import + filter + 移除 sync 注释 |
| `backend/src/services/onchainDataService.ts` | 修改 — import + filter + 删除 builder 函数 + 删除 V4 map |
| `backend/src/generated/oracle-pool-configs.ts` | **删除** |
| `scripts/sync-oracle-pool-configs.ts` | **删除** |
| `.github/workflows/oracle-pool-config-sync.yml` | **删除** |
| `package.json` | 修改 — 移除 `sync:oracle-pool-configs` |
| `docs/backend/HARDCODE-AND-EXTERNAL-IMPORTS.md` | 修改 |
| `docs/architecture/workspace-boundaries.md` | 修改 |
| `AGENTS.md` | 修改（如有引用） |

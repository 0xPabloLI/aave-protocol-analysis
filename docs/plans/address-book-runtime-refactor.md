# 重构：address-book 统一运行时消费 + 遍历合并

## 现状

| Service | 消费方式 | address-book import | 配置来源 |
|---------|---------|---------------------|---------|
| `aave-fetcher` | 运行时 | `import * as addressBook` | npm 包，升级即生效 |
| `onchainDataService` | 运行时 | `import * as AaveAddressBook` | npm 包，升级即生效 |
| `oracleService` | 预生成 | `import { SYNCED_* } from '../generated/...'` | `npm run sync:oracle-pool-configs` → 静态文件 |

**问题：** oracleService 依赖 `scripts/sync-oracle-pool-configs.ts` 预生成 `backend/src/generated/oracle-pool-configs.ts`。每次 `@aave-dao/aave-address-book` 升级，必须手动跑 sync 脚本，否则配置 stale。

## 目标

1. oracleService 改为运行时 `import * as AaveAddressBook`，和 onchainDataService/fetcher 一致
2. 删除 `backend/src/generated/` 目录和 `scripts/sync-oracle-pool-configs.ts`
3. 抽取共享的 address-book 遍历逻辑，oracleService 和 onchainDataService 共用一次遍历结果

## 重构方案

### Step 1: 抽取 `backend/src/services/addressBookRegistry.ts`

共享的 address-book 遍历模块，模块加载时执行一次（和现有 `buildPoolConfigs()` / `buildV4SpokeConfigs()` 模式一致）：

```typescript
import * as AaveAddressBook from '@aave-dao/aave-address-book';

// V3 entries
interface V3PoolEntry {
  poolKey: string;
  chainId: number;
  poolAddress: string;
  oracleAddress?: string;
  uiPoolDataProviderAddress?: string;
  poolAddressesProvider?: string;
}

// V4 spoke entries
interface V4SpokeEntry {
  spokeName: string;
  chainId: number;
  spokeAddress: string;
  hubAddress: string;
  hubName: string;
  oracleAddress?: string;
}

function buildV3Entries(): V3PoolEntry[] { /* 遍历 AaveV3* exports */ }
function buildV4SpokeEntries(): V4SpokeEntry[] { /* 遍历 AaveV4* SPOKES/HUBS */ }

export const V3_ENTRIES = buildV3Entries();
export const V4_SPOKE_ENTRIES = buildV4SpokeEntries();
```

**遍历次数：** 模块加载时 1 次 V3 + 1 次 V4，和现状相同（onchainDataService 内部 1 次，oracleService 通过 generated 文件间接 1 次）。合并后各减少到 1 次。

### Step 2: oracleService 改为消费 `addressBookRegistry`

```typescript
// before
import { SYNCED_V3_POOL_CONFIGS, SYNCED_V4_SPOKE_CONFIGS } from '../generated/oracle-pool-configs.js';

// after
import { V3_ENTRIES, V4_SPOKE_ENTRIES } from './addressBookRegistry.js';
```

oracleService 只需要 `oracleAddress`，从 `V3_ENTRIES` / `V4_SPOKE_ENTRIES` 中提取即可。

### Step 3: onchainDataService 改为消费 `addressBookRegistry`

```typescript
// before (internal)
const POOL_CONFIGS = buildPoolConfigs();  // 遍历 AaveV3*
const V4_SPOKE_CONFIGS = buildV4SpokeConfigs();  // 遍历 AaveV4*

// after
import { V3_ENTRIES, V4_SPOKE_ENTRIES } from './addressBookRegistry.js';
// 从 V3_ENTRIES 中提取 uiPoolDataProviderAddress + poolAddressesProvider
// 从 V4_SPOKE_ENTRIES 中提取 hubAddress + hubName
```

### Step 4: 删除预生成基础设施

- 删除 `backend/src/generated/oracle-pool-configs.ts`
- 删除 `scripts/sync-oracle-pool-configs.ts`
- 删除 `scripts/sync-coingecko-platform-map.ts`（如果也可改为运行时消费）
- 移除 `package.json` 中 `sync:oracle-pool-configs` 和 CI `--check` 步骤
- 更新 `AGENTS.md`

### Step 5: CI 调整

`ci:remote` 中 `npm run sync:oracle-pool-configs -- --check` 步骤移除（不再需要检查 generated 文件是否 stale）。

## 风险与注意

| 风险 | 缓解 |
|------|------|
| address-book 是 npm 包，进程运行期间不会变 | 和 fetcher/onchainDataService 现状一致，已验证可行 |
| `buildV3Entries()` 遍历在模块加载时执行 | 和现有 `buildPoolConfigs()` 模式一致，只是提取到共享模块 |
| sync 脚本的 `--check` CI 门禁消失 | 不需要：address-book 升级即生效，不存在 stale 文件问题 |
| CoinGecko platform map 是否也改运行时 | 待评估，可能保留 sync 脚本（因为涉及外部 API 数据映射） |

## 改动范围

| 文件 | 动作 |
|------|------|
| `backend/src/services/addressBookRegistry.ts` | **新建** — 共享 address-book 遍历 |
| `backend/src/services/oracleService.ts` | 修改 — import 改为 addressBookRegistry |
| `backend/src/services/onchainDataService.ts` | 修改 — import 改为 addressBookRegistry，删除内部 buildPoolConfigs/buildV4SpokeConfigs |
| `backend/src/generated/oracle-pool-configs.ts` | **删除** |
| `scripts/sync-oracle-pool-configs.ts` | **删除** |
| `package.json` | 修改 — 移除 sync:oracle-pool-configs 脚本 |
| `AGENTS.md` | 修改 — 移除 sync 相关说明 |

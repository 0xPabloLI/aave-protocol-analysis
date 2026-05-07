/**
 * Oracle Price Service - Fetches AaveOracle prices for V3 and V4 reserves
 *
 * Architecture:
 * - V3: 24 oracle instances across 14 independent chains (Ethereum has 4)
 * - V4: 10 spoke-level oracle instances on Ethereum only (per-spoke prices)
 * - Cron-write / API-read-only pattern (same as onchainDataService)
 * - Memory cache with 30s TTL (oracle prices update ~every block)
 * - Debug output: data/debug/oracle-prices.json
 */

import { Contract, providers } from 'ethers';
import { getAaveRpcUrlsByChainId } from '@internal/aave-shared-config';
import { withTimeout } from '../lib/timeout.js';
import { ethProviderService } from './ethProviderService.js';
import { logger } from '../logger.js';
import { BACKEND_CACHE_TTL_MS } from '../cacheTtl.js';
import { mkdir, rename, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DEBUG_FILE = resolve(REPO_ROOT, 'data', 'debug', 'oracle-prices.json');

const ORACLE_RPC_TIMEOUT_MS = 15_000;

async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  replacer?: (key: string, value: unknown) => unknown,
): Promise<void> {
  const payload = JSON.stringify(value, replacer as any, 2);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tempPath, payload, 'utf-8');
  await rename(tempPath, filePath);
}

// ============================================================
// V3 Pool ABI (minimal: getReservesList)
// ============================================================
const V3_POOL_ABI = [
  {
    inputs: [],
    name: 'getReservesList',
    outputs: [{ internalType: 'address[]', name: '', type: 'address[]' }],
    stateMutability: 'view',
    type: 'function',
  },
];

// ============================================================
// V3 Oracle ABI (minimal: getAssetsPrices)
// ============================================================
const V3_ORACLE_ABI = [
  {
    inputs: [{ internalType: 'address[]', name: 'assets', type: 'address[]' }],
    name: 'getAssetsPrices',
    outputs: [{ internalType: 'uint256[]', name: '', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
];

// ============================================================
// V4 Spoke ABI (minimal: getReserveCount + getReserve)
// ============================================================
const V4_SPOKE_ABI = [
  {
    inputs: [],
    name: 'getReserveCount',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'reserveId', type: 'uint256' }],
    name: 'getReserve',
    outputs: [
      {
        components: [
          { internalType: 'address', name: 'underlying', type: 'address' },
          { internalType: 'address', name: 'hub', type: 'address' },
          { internalType: 'uint16', name: 'assetId', type: 'uint16' },
          { internalType: 'uint8', name: 'decimals', type: 'uint8' },
          { internalType: 'uint24', name: 'collateralRisk', type: 'uint24' },
          { internalType: 'uint8', name: 'flags', type: 'uint8' },
          { internalType: 'uint32', name: 'dynamicConfigKey', type: 'uint32' },
        ],
        internalType: 'struct ISpoke.Reserve',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
];

// ============================================================
// V4 Oracle ABI (minimal: getReservesPrices)
// ============================================================
const V4_ORACLE_ABI = [
  {
    inputs: [{ internalType: 'uint256[]', name: 'reserveIds', type: 'uint256[]' }],
    name: 'getReservesPrices',
    outputs: [{ internalType: 'uint256[]', name: '', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
];

// ============================================================
// V3 Pool Configs (from AaveOracle-V3-价格读取指南.md)
// ============================================================
interface V3PoolConfig {
  poolKey: string;
  chainId: number;
  chainName: string;
  poolAddress: string;
  oracleAddress: string;
}

const V3_POOL_CONFIGS: V3PoolConfig[] = [
  { poolKey: 'AaveV3Ethereum', chainId: 1, chainName: 'Ethereum', poolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', oracleAddress: '0x54586bE62E3c3580375aE3723C145253060Ca0C2' },
  { poolKey: 'AaveV3EthereumLido', chainId: 1, chainName: 'Ethereum', poolAddress: '0x4e033931ad43597d96D6bcc25c280717730B58B1', oracleAddress: '0xE3C061981870C0C7b1f3C4F4bB36B95f1F260BE6' },
  { poolKey: 'AaveV3EthereumEtherFi', chainId: 1, chainName: 'Ethereum', poolAddress: '0x0AA97c284e98396202b6A04024F5E2c65026F3c0', oracleAddress: '0x43b64f28A678944E0655404B0B98E443851cC34F' },
  { poolKey: 'AaveV3EthereumHorizon', chainId: 1, chainName: 'Ethereum', poolAddress: '0xAe05Cd22df81871bc7cC2a04BeCfb516bFe332C8', oracleAddress: '0x985BcfAB7e0f4EF2606CC5b64FC1A16311880442' },
  { poolKey: 'AaveV3Arbitrum', chainId: 42161, chainName: 'Arbitrum', poolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', oracleAddress: '0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7' },
  { poolKey: 'AaveV3Avalanche', chainId: 43114, chainName: 'Avalanche', poolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', oracleAddress: '0xEBd36016B3eD09D4693Ed4251c67Bd858c3c7C9C' },
  { poolKey: 'AaveV3Base', chainId: 8453, chainName: 'Base', poolAddress: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', oracleAddress: '0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156' },
  { poolKey: 'AaveV3BNB', chainId: 56, chainName: 'BNB', poolAddress: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB', oracleAddress: '0x39bc1bfDa2130d6Bb6DBEfd366939b4c7aa7C697' },
  { poolKey: 'AaveV3Celo', chainId: 42220, chainName: 'Celo', poolAddress: '0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402', oracleAddress: '0x1e693D088ceFD1E95ba4c4a5F7EeA41a1Ec37e8b' },
  { poolKey: 'AaveV3Gnosis', chainId: 100, chainName: 'Gnosis', poolAddress: '0xb50201558B00496A145fE76f7424749556E326D8', oracleAddress: '0xeb0a051be10228213BAEb449db63719d6742F7c4' },
  { poolKey: 'AaveV3Linea', chainId: 59144, chainName: 'Linea', poolAddress: '0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac', oracleAddress: '0xCFDAdA7DCd2e785cF706BaDBC2B8Af5084d595e9' },
  { poolKey: 'AaveV3Mantle', chainId: 5000, chainName: 'Mantle', poolAddress: '0x458F293454fE0d67EC0655f3672301301DD51422', oracleAddress: '0x47a063CfDa980532267970d478EC340C0F80E8df' },
  { poolKey: 'AaveV3MegaETH', chainId: 4326, chainName: 'MegaETH', poolAddress: '0x7e324AbC5De01d112AfC03a584966ff199741C28', oracleAddress: '0x421117D7319E96d831972b3F7e970bbfe29C4F21' },
  { poolKey: 'AaveV3Metis', chainId: 1088, chainName: 'Metis', poolAddress: '0x90df02551bB792286e8D4f13E0e357b4Bf1D6a57', oracleAddress: '0x38D36e85E47eA6ff0d18B0adF12E5fC8984A6f8e' },
  { poolKey: 'AaveV3Optimism', chainId: 10, chainName: 'Optimism', poolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', oracleAddress: '0xD81eb3728a631871a7eBBaD631b5f424909f0c77' },
  { poolKey: 'AaveV3Polygon', chainId: 137, chainName: 'Polygon', poolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', oracleAddress: '0xb023e699F5a33916Ea823A16485e259257cA8Bd1' },
  { poolKey: 'AaveV3Plasma', chainId: 9745, chainName: 'Plasma', poolAddress: '0x925a2A7214Ed92428B5b1B090F80b25700095e12', oracleAddress: '0x33E0b3fc976DC9C516926BA48CfC0A9E10a2aAA5' },
  { poolKey: 'AaveV3Scroll', chainId: 534352, chainName: 'Scroll', poolAddress: '0x11fCfe756c05AD438e312a7fd934381537D3cFfe', oracleAddress: '0x04421D8C506E2fA2371a08EfAaBf791F624054F3' },
  { poolKey: 'AaveV3Soneium', chainId: 1868, chainName: 'Soneium', poolAddress: '0xDd3d7A7d03D9fD9ef45f3E587287922eF65CA38B', oracleAddress: '0x20040a64612555042335926d72B4E5F667a67fA1' },
  { poolKey: 'AaveV3Sonic', chainId: 146, chainName: 'Sonic', poolAddress: '0x5362dBb1e601abF3a4c14c22ffEdA64042E5eAA3', oracleAddress: '0xD63f7658C66B2934Bd234D79D06aEF5290734B30' },
  { poolKey: 'AaveV3XLayer', chainId: 196, chainName: 'XLayer', poolAddress: '0xE3F3Caefdd7180F884c01E57f65Df979Af84f116', oracleAddress: '0x91FC11136d5615575a0fC5981Ab5C0C54418E2C6' },
  { poolKey: 'AaveV3zkSync', chainId: 324, chainName: 'zkSync', poolAddress: '0x78e30497a3c7527d953c6B1E3541b021A98Ac43c', oracleAddress: '0xC7F58Fca663a8d377B6D0c9703C697f56dC40088' },
  { poolKey: 'AaveV3Harmony', chainId: 1666600000, chainName: 'Harmony', poolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', oracleAddress: '0x3C90887Ede8D65ccb2777A5d577beAb2548280AD' },
  { poolKey: 'AaveV3Ink', chainId: 57073, chainName: 'Ink', poolAddress: '0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA', oracleAddress: '0x4758213271BFdC72224A7a8742dC865fC97756e1' },
];

// ============================================================
// V4 Spoke Configs (from AaveOracle-V4-Price-Fetch.md, Ethereum only)
// ============================================================
interface V4SpokeConfig {
  spokeName: string;
  chainId: number;
  chainName: string;
  spokeAddress: string;
  oracleAddress: string;
}

const V4_SPOKE_CONFIGS: V4SpokeConfig[] = [
  { spokeName: 'BLUECHIP_SPOKE', chainId: 1, chainName: 'Ethereum', spokeAddress: '0x973a023A77420ba610f06b3858aD991Df6d85A08', oracleAddress: '0xdA1266a7b8620819dAE3F8bd6B546Da36e505bB8' },
  { spokeName: 'MAIN_SPOKE', chainId: 1, chainName: 'Ethereum', spokeAddress: '0x94e7A5dCbE816e498b89aB752661904E2F56c485', oracleAddress: '0x99B2B6CEa9C3D2fd8F4d90f86741C44B212a6127' },
  { spokeName: 'ETHENA_CORRELATED_SPOKE', chainId: 1, chainName: 'Ethereum', spokeAddress: '0x58131E79531caB1d52301228d1f7b842F26B9649', oracleAddress: '0x9b91a0943CADf554742E8Fb358B1cC4ae4F85F01' },
  { spokeName: 'ETHENA_ECOSYSTEM_SPOKE', chainId: 1, chainName: 'Ethereum', spokeAddress: '0xba1B3D55D249692b669A164024A838309B7508AF', oracleAddress: '0xc390dbe9fc00D6db73C52d375642b47008C33c90' },
  { spokeName: 'ETHERFI_E_SPOKE', chainId: 1, chainName: 'Ethereum', spokeAddress: '0xbF10BDfE177dE0336aFD7fcCF80A904E15386219', oracleAddress: '0xd8B153FaAA8f2b1bC774916FEd333A4F3dE48792' },
  { spokeName: 'LIDO_E_SPOKE', chainId: 1, chainName: 'Ethereum', spokeAddress: '0xe1900480ac69f0B296841Cd01cC37546d92F35Cd', oracleAddress: '0x664D73b6C3591333Fd79510f7ce9ef81228824F5' },
  { spokeName: 'KELP_E_SPOKE', chainId: 1, chainName: 'Ethereum', spokeAddress: '0x3131FE68C4722e726fe6B2819ED68e514395B9a4', oracleAddress: '0x37C316996C714Bf906743071e04E62220b3271ac' },
  { spokeName: 'FOREX_SPOKE', chainId: 1, chainName: 'Ethereum', spokeAddress: '0xD8B93635b8C6d0fF98CbE90b5988E3F2d1Cd9da1', oracleAddress: '0xB3CE6E7b6d389a66eA4a3777bA07219d00FB3a9D' },
  { spokeName: 'GOLD_SPOKE', chainId: 1, chainName: 'Ethereum', spokeAddress: '0x65407b940966954b23dfA3caA5C0702bB42984DC', oracleAddress: '0x0083421fd178749af2201ddA5A7C3feB5790B80c' },
  { spokeName: 'LOMBARD_BTC_SPOKE', chainId: 1, chainName: 'Ethereum', spokeAddress: '0x7EC68b5695e803e98a21a9A05d744F28b0a7753D', oracleAddress: '0x198Cac7f54FFc7d709Ac0FEc4B6454CE73e21D3D' },
];

// ============================================================
// Data Types
// ============================================================

export interface OraclePriceEntry {
  rawPrice: string;
  priceUsd: number;
}

export interface V3OraclePoolResult {
  poolKey: string;
  chainId: number;
  oracleAddress: string;
  assets: Record<string, OraclePriceEntry>; // key = assetAddress (lowercase)
}

export interface V4OracleSpokeResult {
  spokeName: string;
  chainId: number;
  spokeAddress: string;
  oracleAddress: string;
  reserves: Record<number, OraclePriceEntry>; // key = reserveId
  /** Mapping from reserveId (string) to underlying token address (lowercase) */
  reserveTokens: Record<string, string>;
}

export interface OraclePricesSnapshot {
  version: 'v3+v4';
  updatedAt: number;
  updatedAtISO: string;
  v3: V3OraclePoolResult[];
  v4: V4OracleSpokeResult[];
}

// ============================================================
// In-Memory Cache
// ============================================================

/** Full snapshot for debug output */
let cachedSnapshot: OraclePricesSnapshot | null = null;
/** Lean price lookup: "chainId:tokenAddr" → priceUsd (V3 + V4 merged) */
let leanPriceCache: Map<string, number> = new Map();
let leanPriceUpdatedAt = 0;
/** V4 reserveToken mapping cache: spokeKey → { tokens, updatedAt } (1h TTL) */
const V4_RESERVE_TOKEN_TTL_MS = 3_600_000; // 1 hour
const V4_RESERVE_TOKEN_CACHE = new Map<string, { tokens: Record<string, string>; updatedAt: number }>();
let refreshInProgress: Promise<void> | null = null;

// ============================================================
// V3 Fetch
// ============================================================

async function fetchV3PoolPrices(
  config: V3PoolConfig,
  provider: providers.Provider,
  rpcUrl: string
): Promise<V3OraclePoolResult> {
  const poolContract = new Contract(config.poolAddress, V3_POOL_ABI, provider);
  const oracleContract = new Contract(config.oracleAddress, V3_ORACLE_ABI, provider);

  const assets: string[] = await withTimeout(
    poolContract.getReservesList(),
    ORACLE_RPC_TIMEOUT_MS,
    `V3 Pool getReservesList timeout for ${config.poolKey} via ${rpcUrl}`
  ) as string[];

  const rawPrices: string[] = (
    await withTimeout(
      oracleContract.getAssetsPrices(assets),
      ORACLE_RPC_TIMEOUT_MS,
      `V3 Oracle getAssetsPrices timeout for ${config.poolKey} via ${rpcUrl}`
    ) as any[]
  ).map((p: any) => p.toString());

  const priceMap: Record<string, OraclePriceEntry> = {};
  for (let i = 0; i < assets.length; i++) {
    const addr = assets[i].toLowerCase();
    const raw = rawPrices[i];
    priceMap[addr] = {
      rawPrice: raw,
      priceUsd: Number(raw) / 1e8,
    };
  }

  return {
    poolKey: config.poolKey,
    chainId: config.chainId,
    oracleAddress: config.oracleAddress,
    assets: priceMap,
  };
}

// ============================================================
// V4 Fetch
// ============================================================

async function fetchV4SpokePrices(
  config: V4SpokeConfig,
  provider: providers.Provider,
  rpcUrl: string
): Promise<V4OracleSpokeResult> {
  const spokeContract = new Contract(config.spokeAddress, V4_SPOKE_ABI, provider);
  const oracleContract = new Contract(config.oracleAddress, V4_ORACLE_ABI, provider);

  const reserveCountBN = await withTimeout(
    spokeContract.getReserveCount(),
    ORACLE_RPC_TIMEOUT_MS,
    `V4 Spoke getReserveCount timeout for ${config.spokeName} via ${rpcUrl}`
  ) as any;

  const reserveCount = Number(reserveCountBN);
  if (reserveCount === 0) {
    return {
      spokeName: config.spokeName,
      chainId: config.chainId,
      spokeAddress: config.spokeAddress,
      oracleAddress: config.oracleAddress,
      reserves: {},
      reserveTokens: {},
    };
  }

  const reserveIds = Array.from({ length: reserveCount }, (_, i) => i);
  const rawPrices: string[] = (
    await withTimeout(
      oracleContract.getReservesPrices(reserveIds),
      ORACLE_RPC_TIMEOUT_MS,
      `V4 Oracle getReservesPrices timeout for ${config.spokeName} via ${rpcUrl}`
    ) as any[]
  ).map((p: any) => p.toString());

  const priceMap: Record<number, OraclePriceEntry> = {};
  for (let i = 0; i < reserveIds.length; i++) {
    const raw = rawPrices[i];
    priceMap[reserveIds[i]] = {
      rawPrice: raw,
      priceUsd: Number(raw) / 1e8,
    };
  }

  // Reserve token mapping: use cached version if fresh, else fetch on-chain
  const spokeKey = `${config.chainId}:${config.spokeAddress.toLowerCase()}`;
  const cachedMapping = V4_RESERVE_TOKEN_CACHE.get(spokeKey);
  const now = Date.now();
  let reserveTokens: Record<string, string>;

  if (cachedMapping && (now - cachedMapping.updatedAt) < V4_RESERVE_TOKEN_TTL_MS) {
    reserveTokens = cachedMapping.tokens;
  } else {
    reserveTokens = {};
    const reserveResults = await Promise.allSettled(
      reserveIds.map((rid) =>
        withTimeout(
          spokeContract.getReserve(rid),
          ORACLE_RPC_TIMEOUT_MS,
          `V4 Spoke getReserve(${rid}) timeout for ${config.spokeName}`
        ) as any
      )
    );
    reserveResults.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        reserveTokens[String(reserveIds[i])] = (r.value.underlying as string).toLowerCase();
      } else {
        logger.debug(`⚠️  Oracle V4: Failed to fetch reserve ${reserveIds[i]} details for ${config.spokeName}`);
      }
    });
    V4_RESERVE_TOKEN_CACHE.set(spokeKey, { tokens: reserveTokens, updatedAt: now });
  }

  return {
    spokeName: config.spokeName,
    chainId: config.chainId,
    spokeAddress: config.spokeAddress,
    oracleAddress: config.oracleAddress,
    reserves: priceMap,
    reserveTokens,
  };
}

// ============================================================
// Main Refresh
// ============================================================

export async function refreshOracleCache(): Promise<void> {
  if (refreshInProgress) {
    logger.debug('Oracle cache refresh already in progress, skipping');
    return;
  }

  refreshInProgress = (async () => {
    try {
      const startTime = Date.now();

      const v3Results: V3OraclePoolResult[] = [];
      const v4Results: V4OracleSpokeResult[] = [];

      // ============================================================
      // Fetch all V3 pools and V4 spokes in parallel, each with RPC retry
      // ============================================================

      async function fetchV3WithRetry(config: V3PoolConfig): Promise<V3OraclePoolResult | null> {
        const rpcUrls = getAaveRpcUrlsByChainId(config.chainId);
        if (rpcUrls.length === 0) {
          logger.debug(`⏭️  Oracle V3: Skipping ${config.poolKey} (chain ${config.chainId}), no RPC URLs`);
          return null;
        }
        const candidates = ethProviderService.getProvidersForChain(config.chainId, rpcUrls);
        if (candidates.length === 0) {
          logger.warn(`⏭️  Oracle V3: Skipping ${config.poolKey} (chain ${config.chainId}), no healthy RPC`);
          return null;
        }
        for (const candidate of candidates) {
          try {
            const result = await fetchV3PoolPrices(config, candidate.provider, candidate.rpcUrl);
            ethProviderService.reportProviderSuccess(config.chainId, candidate.rpcUrl);
            logger.debug(`✅ Oracle V3: ${config.poolKey} - ${Object.keys(result.assets).length} assets via ${candidate.rpcUrl}`);
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ethProviderService.reportProviderFailure(config.chainId, candidate.rpcUrl, message);
            logger.warn(`❌ Oracle V3: ${config.poolKey} failed via ${candidate.rpcUrl}: ${message}`);
          }
        }
        logger.warn(`❌ Oracle V3: ${config.poolKey} failed on all RPC candidates`);
        return null;
      }

      async function fetchV4WithRetry(config: V4SpokeConfig): Promise<V4OracleSpokeResult | null> {
        const rpcUrls = getAaveRpcUrlsByChainId(config.chainId);
        if (rpcUrls.length === 0) {
          logger.debug(`⏭️  Oracle V4: Skipping ${config.spokeName} (chain ${config.chainId}), no RPC URLs`);
          return null;
        }
        const candidates = ethProviderService.getProvidersForChain(config.chainId, rpcUrls);
        if (candidates.length === 0) {
          logger.warn(`⏭️  Oracle V4: Skipping ${config.spokeName} (chain ${config.chainId}), no healthy RPC`);
          return null;
        }
        for (const candidate of candidates) {
          try {
            const result = await fetchV4SpokePrices(config, candidate.provider, candidate.rpcUrl);
            ethProviderService.reportProviderSuccess(config.chainId, candidate.rpcUrl);
            logger.debug(`✅ Oracle V4: ${config.spokeName} - ${Object.keys(result.reserves).length} reserves via ${candidate.rpcUrl}`);
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ethProviderService.reportProviderFailure(config.chainId, candidate.rpcUrl, message);
            logger.warn(`❌ Oracle V4: ${config.spokeName} failed via ${candidate.rpcUrl}: ${message}`);
          }
        }
        logger.warn(`❌ Oracle V4: ${config.spokeName} failed on all RPC candidates`);
        return null;
      }

      const v3Settled = await Promise.allSettled(V3_POOL_CONFIGS.map(fetchV3WithRetry));
      for (const s of v3Settled) {
        if (s.status === 'fulfilled' && s.value) v3Results.push(s.value);
      }

      const v4Settled = await Promise.allSettled(V4_SPOKE_CONFIGS.map(fetchV4WithRetry));
      for (const s of v4Settled) {
        if (s.status === 'fulfilled' && s.value) v4Results.push(s.value);
      }

      const now = Date.now();
      cachedSnapshot = {
        version: 'v3+v4',
        updatedAt: now,
        updatedAtISO: new Date(now).toISOString(),
        v3: v3Results,
        v4: v4Results,
      };

      // Build lean price cache: "chainId:tokenAddr" → priceUsd
      const newLean = new Map<string, number>();
      for (const pool of v3Results) {
        for (const [addr, entry] of Object.entries(pool.assets)) {
          newLean.set(`${pool.chainId}:${addr}`, entry.priceUsd);
        }
      }
      for (const spoke of v4Results) {
        for (const [ridStr, tokenAddr] of Object.entries(spoke.reserveTokens)) {
          const entry = spoke.reserves[Number(ridStr)];
          if (entry) {
            newLean.set(`${spoke.chainId}:${spoke.spokeAddress.toLowerCase()}:${tokenAddr}`, entry.priceUsd);
          }
        }
      }
      leanPriceCache = newLean;
      leanPriceUpdatedAt = now;

      // Write debug file
      try {
        await writeJsonAtomic(DEBUG_FILE, cachedSnapshot, (_key: string, value: unknown) => {
          if (typeof value === 'bigint') return value.toString();
          return value;
        });
        logger.debug(`📄 Oracle prices written to ${DEBUG_FILE}`);
      } catch (fileError) {
        logger.warn(`⚠️  Failed to write oracle prices debug file: ${fileError instanceof Error ? fileError.message : String(fileError)}`);
      }

      const elapsed = Date.now() - startTime;
      const totalV3Assets = v3Results.reduce((sum, r) => sum + Object.keys(r.assets).length, 0);
      const totalV4Reserves = v4Results.reduce((sum, r) => sum + Object.keys(r.reserves).length, 0);
      logger.info(`✅ Oracle cache refresh: ${v3Results.length} V3 pools (${totalV3Assets} assets), ${v4Results.length} V4 spokes (${totalV4Reserves} reserves) in ${elapsed}ms`);
    } finally {
      refreshInProgress = null;
    }
  })();

  return refreshInProgress;
}

// ============================================================
// Read Interface
// ============================================================

function isLeanCacheFresh(): boolean {
  if (!leanPriceUpdatedAt) return false;
  return (Date.now() - leanPriceUpdatedAt) < BACKEND_CACHE_TTL_MS.oracleTtlMs;
}

/** Get V3 token price by (chainId, tokenAddress), O(1). Returns undefined if stale or not found. */
export function getV3OraclePrice(chainId: number, tokenAddress: string): number | undefined {
  if (!isLeanCacheFresh()) return undefined;
  return leanPriceCache.get(`${chainId}:${tokenAddress.toLowerCase()}`);
}

/** Get V4 token price by (chainId, spokeAddress, tokenAddress), O(1). Returns undefined if stale or not found. */
export function getV4OraclePrice(chainId: number, spokeAddress: string, tokenAddress: string): number | undefined {
  if (!isLeanCacheFresh()) return undefined;
  return leanPriceCache.get(`${chainId}:${spokeAddress.toLowerCase()}:${tokenAddress.toLowerCase()}`);
}

/**
 * Returns the most recent full oracle snapshot, or null if not yet warmed.
 * Read-only — never triggers a refresh.
 */
export function getCachedOraclePricesSnapshot(): OraclePricesSnapshot | null {
  return cachedSnapshot;
}

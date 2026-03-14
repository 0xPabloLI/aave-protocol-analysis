/**
 * Deficit Service - Lightweight on-chain deficit fetcher
 * 
 * Fetches ONLY the `deficit` field from UiPoolDataProvider.getReservesHumanized()
 * for all chains. Deficit is the only data point not available from Aave API.
 * 
 * Architecture:
 * - Called in parallel with Aave API fetch during markets refresh
 * - Returns Map<chainId:tokenAddress, deficitString>
 * - Graceful degradation: if RPC fails, deficit is simply absent from response
 */

import { UiPoolDataProvider } from '@aave/contract-helpers';
import * as AaveAddressBook from '@bgd-labs/aave-address-book';
import { getAavePublicRpcUrlsByChainId } from '@internal/aave-shared-config';
import { ethProviderService } from './ethProviderService.js';
import { logger } from '../logger.js';

const DEFICIT_PER_CHAIN_TIMEOUT_MS = 15_000; // 15s timeout per RPC attempt
const DEFICIT_OVERALL_TIMEOUT_MS = 60_000; // 60s overall timeout (same as markets)

interface OnchainConfig {
  chainId: number;
  chainName: string;
  uiPoolDataProviderAddress: string;
  poolAddressesProvider: string;
  defaultRpcUrls: string[];
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

function normalizeAddress(addr: string): string {
  return addr.toLowerCase().trim();
}

function buildChainConfigs(): Map<number, OnchainConfig> {
  const configs = new Map<number, OnchainConfig>();
  
  for (const [key, value] of Object.entries(AaveAddressBook)) {
    if (!key.startsWith('AaveV3')) continue;
    if (!value || typeof value !== 'object') continue;
    
    // Skip testnets (same filter as markets fetcher)
    if (key.includes('Sepolia') || key.includes('Fuji')) continue;
    
    const chainId = Number((value as any).CHAIN_ID);
    const uiPoolDataProviderAddress = (value as any).UI_POOL_DATA_PROVIDER;
    const poolAddressesProvider = (value as any).POOL_ADDRESSES_PROVIDER;
    
    if (!Number.isFinite(chainId) || chainId <= 0) continue;
    if (typeof uiPoolDataProviderAddress !== 'string') continue;
    if (typeof poolAddressesProvider !== 'string') continue;
    
    // Skip if already have this chain (prefer non-Lido/EtherFi markets)
    if (configs.has(chainId)) {
      if (/Lido|EtherFi/i.test(key)) continue;
    }
    
    const chainName = key.replace(/^AaveV3/, '');
    configs.set(chainId, {
      chainId,
      chainName,
      uiPoolDataProviderAddress,
      poolAddressesProvider,
      defaultRpcUrls: getAavePublicRpcUrlsByChainId(chainId),
    });
  }
  
  return configs;
}

const CHAIN_CONFIGS = buildChainConfigs();

async function fetchDeficitForChain(
  config: OnchainConfig
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const rpcCandidates = ethProviderService.getProvidersForChain(config.chainId, config.defaultRpcUrls);
  
  for (const { rpcUrl, provider } of rpcCandidates) {
    try {
      const uiPoolDataProvider = new UiPoolDataProvider({
        uiPoolDataProviderAddress: config.uiPoolDataProviderAddress,
        provider,
        chainId: config.chainId,
      });
      
      const humanized = await withTimeout(
        uiPoolDataProvider.getReservesHumanized({
          lendingPoolAddressProvider: config.poolAddressesProvider,
        }),
        DEFICIT_PER_CHAIN_TIMEOUT_MS,
        `Deficit fetch timeout for chain ${config.chainId}`
      );
      
      const reserves = (humanized as any).reservesData ?? [];
      
      for (const reserve of reserves) {
        const addr = normalizeAddress(String(reserve.underlyingAsset || ''));
        if (!addr) continue;
        
        // deficit from getReservesHumanized() (Aave v3.3.0+)
        const deficit = reserve.deficit?.toString?.() ?? String(reserve.deficit ?? '0');
        const key = `${config.chainId}:${addr}`;
        result.set(key, deficit);
      }
      
      ethProviderService.reportProviderSuccess(config.chainId, rpcUrl);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ethProviderService.reportProviderFailure(config.chainId, rpcUrl, message);
      logger.debug(`Deficit fetch failed for chain ${config.chainId} via ${rpcUrl}: ${message}`);
    }
  }
  
  // All RPC endpoints failed for this chain
  logger.warn(`All RPC endpoints failed for chain ${config.chainId}, deficit data unavailable`);
  return result; // Empty map
}

/**
 * Internal implementation - fetches deficit for all chains in parallel.
 */
async function fetchAllDeficitsInternal(): Promise<Map<string, string>> {
  const startTime = Date.now();
  const chainIds = Array.from(CHAIN_CONFIGS.keys());
  
  logger.info(`🔗 Fetching deficit data from ${chainIds.length} chains...`);
  
  const results = await Promise.allSettled(
    chainIds.map(chainId => {
      const config = CHAIN_CONFIGS.get(chainId);
      if (!config) return Promise.resolve(new Map<string, string>());
      return fetchDeficitForChain(config);
    })
  );
  
  // Merge all results
  const merged = new Map<string, string>();
  let successCount = 0;
  let failCount = 0;
  
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      for (const [key, value] of result.value) {
        merged.set(key, value);
      }
      if (result.value.size > 0) successCount++;
    } else {
      failCount++;
    }
  }
  
  const elapsed = Date.now() - startTime;
  logger.info(`✅ Deficit fetch complete: ${merged.size} reserves from ${successCount} chains in ${elapsed}ms (${failCount} chains failed)`);
  
  return merged;
}

/**
 * Fetch deficit for all known chains in parallel with overall timeout.
 * Returns Map<"chainId:tokenAddress", deficitString>
 * 
 * Graceful degradation:
 * - If a chain's RPC fails, that chain's reserves won't have deficit data
 * - If overall timeout is reached, returns partial results collected so far
 * - Overall function never throws; partial success is acceptable
 */
export async function fetchAllDeficits(): Promise<Map<string, string>> {
  try {
    return await withTimeout(
      fetchAllDeficitsInternal(),
      DEFICIT_OVERALL_TIMEOUT_MS,
      'Overall deficit fetch timeout'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`⚠️ Deficit fetch failed with overall timeout: ${message}`);
    return new Map(); // Return empty map on overall timeout
  }
}

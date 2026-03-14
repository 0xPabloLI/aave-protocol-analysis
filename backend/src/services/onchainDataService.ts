/**
 * On-chain Data Service - Fetches data only available from on-chain RPC
 * 
 * Fetches `deficit` and `baseVariableBorrowRate` from UiPoolDataProvider.getReservesHumanized()
 * for all chains. These are the only data points not available from Aave API.
 * 
 * Architecture:
 * - Called in parallel with Aave API fetch during markets refresh
 * - Returns OnchainReserveData map with both fields
 * - Independent cache TTL (5 min) for graceful degradation
 * - If RPC fails, uses cached data within TTL; otherwise fields are absent
 */

import { UiPoolDataProvider } from '@aave/contract-helpers';
import * as AaveAddressBook from '@bgd-labs/aave-address-book';
import { getAavePublicRpcUrlsByChainId } from '@internal/aave-shared-config';
import { ethProviderService } from './ethProviderService.js';
import { logger } from '../logger.js';

const ONCHAIN_PER_CHAIN_TIMEOUT_MS = 15_000; // 15s timeout per RPC attempt
const ONCHAIN_OVERALL_TIMEOUT_MS = 60_000; // 60s overall timeout (same as markets)

/**
 * On-chain reserve data - fields only available from RPC
 */
export interface OnchainReserveData {
  deficit?: string;
  baseVariableBorrowRate?: string;
}

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

async function fetchOnchainDataForChain(
  config: OnchainConfig
): Promise<Map<string, OnchainReserveData>> {
  const result = new Map<string, OnchainReserveData>();
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
        ONCHAIN_PER_CHAIN_TIMEOUT_MS,
        `On-chain fetch timeout for chain ${config.chainId}`
      );
      
      const reserves = (humanized as any).reservesData ?? [];
      
      for (const reserve of reserves) {
        const addr = normalizeAddress(String(reserve.underlyingAsset || ''));
        if (!addr) continue;
        
        const key = `${config.chainId}:${addr}`;
        const data: OnchainReserveData = {};
        
        // deficit from getReservesHumanized() (Aave v3.3.0+)
        if (reserve.deficit !== undefined && reserve.deficit !== null) {
          data.deficit = reserve.deficit?.toString?.() ?? String(reserve.deficit);
        }
        
        // baseVariableBorrowRate from interest rate strategy
        if (reserve.baseVariableBorrowRate !== undefined && reserve.baseVariableBorrowRate !== null) {
          data.baseVariableBorrowRate = reserve.baseVariableBorrowRate?.toString?.() ?? String(reserve.baseVariableBorrowRate);
        }
        
        if (Object.keys(data).length > 0) {
          result.set(key, data);
        }
      }
      
      ethProviderService.reportProviderSuccess(config.chainId, rpcUrl);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ethProviderService.reportProviderFailure(config.chainId, rpcUrl, message);
      logger.debug(`On-chain fetch failed for chain ${config.chainId} via ${rpcUrl}: ${message}`);
    }
  }
  
  // All RPC endpoints failed for this chain
  logger.warn(`All RPC endpoints failed for chain ${config.chainId}, on-chain data unavailable`);
  return result; // Empty map
}

/**
 * Internal implementation - fetches on-chain data for all chains in parallel.
 */
async function fetchAllOnchainDataInternal(): Promise<Map<string, OnchainReserveData>> {
  const startTime = Date.now();
  const chainIds = Array.from(CHAIN_CONFIGS.keys());
  
  logger.info(`🔗 Fetching on-chain data (deficit, baseVariableBorrowRate) from ${chainIds.length} chains...`);
  
  const results = await Promise.allSettled(
    chainIds.map(chainId => {
      const config = CHAIN_CONFIGS.get(chainId);
      if (!config) return Promise.resolve(new Map<string, OnchainReserveData>());
      return fetchOnchainDataForChain(config);
    })
  );
  
  // Merge all results
  const merged = new Map<string, OnchainReserveData>();
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
  logger.info(`✅ On-chain fetch complete: ${merged.size} reserves from ${successCount} chains in ${elapsed}ms (${failCount} chains failed)`);
  
  return merged;
}

/**
 * Fetch on-chain data for all known chains in parallel with overall timeout.
 * Returns Map<"chainId:tokenAddress", OnchainReserveData>
 * 
 * Graceful degradation:
 * - If a chain's RPC fails, that chain's reserves won't have on-chain data
 * - If overall timeout is reached, returns partial results collected so far
 * - Overall function never throws; partial success is acceptable
 */
export async function fetchAllOnchainData(): Promise<Map<string, OnchainReserveData>> {
  try {
    return await withTimeout(
      fetchAllOnchainDataInternal(),
      ONCHAIN_OVERALL_TIMEOUT_MS,
      'Overall on-chain fetch timeout'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`⚠️ On-chain fetch failed with overall timeout: ${message}`);
    return new Map(); // Return empty map on overall timeout
  }
}

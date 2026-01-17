import { writeFile, mkdir } from 'fs/promises';
import { chainId, AaveClient } from "@aave/client";
import { markets } from "@aave/client/actions";
import * as addressBook from "@bgd-labs/aave-address-book";

// 创建 Aave 客户端实例
const client = AaveClient.create();
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { brevisApi } from './brevis-api.js';
import {
  MerklCampaignBreakdown,
  MerklOpportunityData,
  MerklOpportunityGroup,
  processMerklData,
  findMatchingMerklOpportunities,
  formatMerklBreakdown
} from './merkl-api.js';
import {
  MeritDataItem,
  MeritAprEntry,
  fetchMeritData,
  getMeritDataFromMarket
} from './merit-api.js';
import type { BrevisCampaignItem, BrevisDataItem } from './brevis-api.js';

interface NetworkInfo {
  name: string;
  chainId: number;
  poolAddress: string;
}

interface MarketData {
  timestamp: string;
  totalNetworks: number;
  chainIds: number[];
  networkInfo: NetworkInfo[];
  markets: any[];
  errors: string[];
}

interface FormattedReserveData {
  marketName: string;
  chainName: string;
  chainId: number;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string; // underlying token address
  aTokenAddress: string | null; // aToken address
  vTokenAddress: string | null; // variableDebtToken address
  supplyApy: number | undefined; // APY 百分比值（如 5.2 表示 5.2%）
  borrowApy: number | undefined; // APY 百分比值（如 5.2 表示 5.2%）
  supplyIncentives: number[]; // Protocol supply incentives 百分比值数组
  borrowIncentives: number[]; // Protocol borrow incentives 百分比值数组
  meritSupplys?: MeritAprEntry[];
  meritBorrows?: MeritAprEntry[];
  merklSupplys?: MerklOpportunityGroup[];
  merklBorrows?: MerklOpportunityGroup[];
  merklHolds?: MerklOpportunityGroup[];
  brevisSupplys?: BrevisCampaignItem[];
  brevisBorrows?: BrevisCampaignItem[];
}

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

/**
 * Converts APR to APY using monthly compounding
 * Assumes users claim rewards once per month and reinvest them
 * Formula: APY = (1 + APR/12)^12 - 1
 *
 * This function is used to align incentive calculations with other protocol APYs
 * throughout the app, providing more accurate representations of compound returns.
 *
 * @param apr - Annual Percentage Rate as a decimal (e.g., 0.05 for 5%)
 * @returns APY as a decimal
 */
export const convertAprToApy = (apr: number): number => {
  const monthlyRate = apr / 12;
  const apy = Math.pow(1 + monthlyRate, 12) - 1;
  return apy;
};

// 从 baseDataset 构建链-代币索引：chainNameLower -> Set<tokenSymbolLower>
function buildChainTokenIndex(baseDataset: FormattedReserveData[]): Record<string, Set<string>> {
  const index: Record<string, Set<string>> = {};
  
  baseDataset.forEach(item => {
    const chainName = item.chainName.toLowerCase();
    if (!chainName) return;
    if (!index[chainName]) index[chainName] = new Set<string>();
    const tokenSymbol = item.tokenSymbol;
    // 将 tokenSymbol 转换为小写，以便与 Brevis description（已转换为小写）匹配
    if (tokenSymbol) index[chainName].add(tokenSymbol.toLowerCase());
  });
  
  logger.info(`🗂️  Built chain-token index: ${Object.keys(index).length} chains`);
  Object.entries(index).forEach(([chain, tokens]) => {
    logger.info(`   • ${chain}: ${tokens.size} tokens`);
  });
  return index;
}

function getAllAaveV3Networks(): NetworkInfo[] {
  // 获取所有 AaveV3 网络（排除测试网）
  const aaveV3Networks = Object.keys(addressBook).filter(key => 
    key.startsWith('AaveV3') && 
    !key.includes('Sepolia') && 
    !key.includes('Fuji')
  );

  const networkInfo: NetworkInfo[] = aaveV3Networks.map(networkName => {
    const network = (addressBook as any)[networkName];
    return {
      name: networkName,
      chainId: network.CHAIN_ID,
      poolAddress: network.POOL
    };
  }).filter(info => info.chainId); // 只保留有chainId的网络

  return networkInfo;
}


// Brevis APR 提取：基于 Aave 市场链/代币列表匹配 campaign 数据
async function fetchBrevisAprs(
  baseDataset: FormattedReserveData[]
): Promise<BrevisDataIndex> {
  try {
    logger.info('🌐 Fetching Brevis Incentra Aave campaign data...');
    
    // 获取所有 Aave campaign 数据（包含原始响应数据）
    const brevisResult = await brevisApi.getAaveCampaignsData();
    const brevisIndex: BrevisDataIndex = brevisResult.index;
    
    // 输出原始 Brevis 数据（包括原始 API 响应），方便查看和调试
    await mkdir(DATA_DIR, { recursive: true });
    const totalSupply = Object.values(brevisIndex).reduce((sum, item) => sum + item.brevisSupplys.length, 0);
    const totalBorrow = Object.values(brevisIndex).reduce((sum, item) => sum + item.brevisBorrows.length, 0);
    
    await writeFile(
      join(DATA_DIR, 'brevis-raw-data.json'),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        totalSupplyCampaigns: totalSupply,
        totalBorrowCampaigns: totalBorrow,
        indexedBy: 'chainId-tokenAddress',
        // 原始 API 响应数据（用于调试和问题排查）
        rawProtocolsList: brevisResult.rawProtocolsList,
        rawProtocolDetails: brevisResult.rawProtocolDetails,
        // 处理后的索引数据
        index: brevisIndex
      }, null, 2),
      'utf-8'
    );
    logger.info(`💾 Brevis raw data saved to ${join(DATA_DIR, 'brevis-raw-data.json')}`);
    
    logger.info(`✅ Indexed Brevis campaign data for ${Object.keys(brevisIndex).length} chain-token combinations`);
    logger.info(`   Supply campaigns: ${totalSupply}, Borrow campaigns: ${totalBorrow}`);
    
    return brevisIndex;
  } catch (error) {
    logger.error('❌ Error fetching Brevis APR data:', error);
    return {};
  }
}



// 从 Aave 市场数据创建基础数据集
function createBaseDatasetFromMarkets(markets: any[]): FormattedReserveData[] {
  const baseDataset: FormattedReserveData[] = [];

  markets.forEach(market => {
    const marketName = market.name || 'Unknown';
    const chainName = market.chain?.name || 'Unknown';
    const chainId = market.chain?.chainId || 0;

    if (market.supplyReserves && Array.isArray(market.supplyReserves)) {
      market.supplyReserves.forEach((reserve: any) => {
        // 过滤掉 isFrozen=true 或 isPaused=true 的 supply reserves
        if (reserve.isFrozen === true || reserve.isPaused === true) {
          return;
        }

        const tokenSymbol = reserve.underlyingToken?.symbol || 'Unknown';
        const tokenAddress = reserve.underlyingToken?.address || '';
        const aTokenAddress = reserve.aToken?.address ?? null;
        const vTokenAddress = reserve.vToken?.address ?? null;
        
        // 检查 supplyCap，如果为 1 则将 supplyApy 设置为 undefined（因为对用户没有意义）
        const supplyCapValue = reserve.supplyInfo?.supplyCap?.amount?.value;
        const supplyCapIsOne = supplyCapValue !== undefined && parseFloat(supplyCapValue) === 1;
        // 使用 value*100 转换为百分比值，不使用 formatted（会截断精度）
        const supplyApyValue = reserve.supplyInfo?.apy?.value;
        const supplyApy = supplyCapIsOne || !supplyApyValue
          ? undefined
          : parseFloat(supplyApyValue) * 100;
        
        // 检查 borrowingState 是否为 "DISABLED"，如果是则表示该 token 不能被 borrow
        const isBorrowDisabledByState = reserve.borrowInfo?.borrowingState === "DISABLED";
        
        // 检查 borrowCap，如果为 1 则将 borrowApy 设置为 undefined（因为对用户没有意义）
        const borrowCapValue = reserve.borrowInfo?.borrowCap?.amount?.value;
        const borrowCapIsOne = borrowCapValue !== undefined && parseFloat(borrowCapValue) === 1;
        const isBorrowDisabled = isBorrowDisabledByState || borrowCapIsOne;
        // 使用 value*100 转换为百分比值，不使用 formatted（会截断精度）
        const borrowApyValue = reserve.borrowInfo?.apy?.value;
        const borrowApy = isBorrowDisabled || !borrowApyValue
          ? undefined 
          : parseFloat(borrowApyValue) * 100;
        
        // 从 reserve.incentives 中提取 protocol supply 和 borrow incentives
        // 使用 value*100 转换为百分比值数组
        const protocolSupplyIncentives: number[] = [];
        const protocolBorrowIncentives: number[] = [];
        
        if (reserve.incentives && Array.isArray(reserve.incentives)) {
          reserve.incentives.forEach((incentive: any) => {
            if (incentive.__typename === 'AaveSupplyIncentive') {
              const aprValue = incentive.extraSupplyApr?.value || incentive.supplyApr?.value;
              if (aprValue) {
                protocolSupplyIncentives.push(parseFloat(aprValue) * 100);
              }
            } else if (incentive.__typename === 'AaveBorrowIncentive') {
              // AaveBorrowIncentive 可能使用 extraBorrowApr 或其他字段名
              const aprValue = incentive.extraBorrowApr?.value || incentive.borrowApr?.value;
              if (aprValue) {
                protocolBorrowIncentives.push(parseFloat(aprValue) * 100);
              }
            }
          });
        }
        
        // 创建完整的结构化数据，包含所有激励字段
        // 空值初始化为 undefined，以便在 JSON 序列化时省略
        baseDataset.push({
          marketName,
          chainName,
          chainId,
          tokenName: reserve.underlyingToken?.name || 'Unknown',
          tokenSymbol,
          tokenAddress,
          aTokenAddress,
          vTokenAddress,
          supplyApy,
          borrowApy,
          // Protocol incentives - 从 reserve.incentives 提取
          supplyIncentives: protocolSupplyIncentives.length > 0 ? protocolSupplyIncentives : undefined as any,
          borrowIncentives: protocolBorrowIncentives.length > 0 ? protocolBorrowIncentives : undefined as any
        });
      });
    }
  });

  return baseDataset;
}

// 将 Merit、Merkl 和 Brevis 激励数据填充到基础数据集中
// 类型别名：用于数据索引
type MeritDataIndex = Record<string, MeritDataItem>;
type MerklDataIndex = Record<string, MerklOpportunityData[]>;
type BrevisDataIndex = Record<string, BrevisDataItem>;

function enrichDatasetWithIncentiveData(
  baseDataset: FormattedReserveData[],
  meritData: MeritDataIndex,
  merklData: MerklDataIndex,
  brevisData: BrevisDataIndex
): FormattedReserveData[] {
  return baseDataset.map(item => {
    const meritItemData = getMeritDataFromMarket(item.marketName, item.chainName, item.tokenSymbol, meritData);
    
    // 如果有 Merit 数据，直接更新对应字段
    if (meritItemData) {
      // 只有当数组不为空时才赋值，否则保持 undefined
      item.meritSupplys = meritItemData.meritSupplys.length > 0 ? meritItemData.meritSupplys : undefined;
      item.meritBorrows = meritItemData.meritBorrows.length > 0 ? meritItemData.meritBorrows : undefined;
    }
    
    // 获取对应的 Merkl 数据并更新
    const matchedOpportunities = findMatchingMerklOpportunities(item, merklData);
    
    if (matchedOpportunities.length > 0) {
      // 用于 CSV 格式化的平铺 breakdowns（带 opportunityLink 以保持对应关系）
      const supplyBreakdowns: MerklCampaignBreakdown[] = [];
      const borrowBreakdowns: MerklCampaignBreakdown[] = [];
      const holdBreakdowns: MerklCampaignBreakdown[] = [];
      
      // 用于 JSON 的分组数据（按 opportunity 分组，避免重复）
      const supplyOpportunities: MerklOpportunityGroup[] = [];
      const borrowOpportunities: MerklOpportunityGroup[] = [];
      const holdOpportunities: MerklOpportunityGroup[] = [];
      
      // 收集所有 matchedOpportunities 中的 breakdowns
      for (const opp of matchedOpportunities) {
        if (opp.opportunityLink) {
          if (opp.supply.length > 0) {
            // 为 CSV 格式化：添加 opportunityLink（临时用于格式化）
            const supplyWithLinks = opp.supply.map(b => ({ ...b, opportunityLink: opp.opportunityLink }));
            supplyBreakdowns.push(...supplyWithLinks);
            // 为 JSON：按 opportunity 分组（不包含 opportunityLink 在 breakdown 中）
            supplyOpportunities.push({
              opportunityLink: opp.opportunityLink,
              ...(opp.name && { name: opp.name }),
              ...(opp.description && { description: opp.description }),
              breakdowns: opp.supply
            });
          }
          if (opp.borrow.length > 0) {
            const borrowWithLinks = opp.borrow.map(b => ({ ...b, opportunityLink: opp.opportunityLink }));
            borrowBreakdowns.push(...borrowWithLinks);
            borrowOpportunities.push({
              opportunityLink: opp.opportunityLink,
              ...(opp.name && { name: opp.name }),
              ...(opp.description && { description: opp.description }),
              breakdowns: opp.borrow
            });
          }
          if (opp.hold.length > 0) {
            const holdWithLinks = opp.hold.map(b => ({ ...b, opportunityLink: opp.opportunityLink }));
            holdBreakdowns.push(...holdWithLinks);
            holdOpportunities.push({
              opportunityLink: opp.opportunityLink,
              ...(opp.name && { name: opp.name }),
              ...(opp.description && { description: opp.description }),
              breakdowns: opp.hold
            });
          }
        } else {
          // 如果没有链接，直接添加 breakdowns
          if (opp.supply.length > 0) {
            supplyBreakdowns.push(...opp.supply);
            supplyOpportunities.push({
              opportunityLink: '', // 空链接，但保持结构一致
              ...(opp.name && { name: opp.name }),
              ...(opp.description && { description: opp.description }),
              breakdowns: opp.supply
            });
          }
          if (opp.borrow.length > 0) {
            borrowBreakdowns.push(...opp.borrow);
            borrowOpportunities.push({
              opportunityLink: '',
              ...(opp.name && { name: opp.name }),
              ...(opp.description && { description: opp.description }),
              breakdowns: opp.borrow
            });
          }
          if (opp.hold.length > 0) {
            holdBreakdowns.push(...opp.hold);
            holdOpportunities.push({
              opportunityLink: '',
              ...(opp.name && { name: opp.name }),
              ...(opp.description && { description: opp.description }),
              breakdowns: opp.hold
            });
          }
        }
      }
      
      // 用于 JSON：按 opportunity 分组的数据（避免重复，结构清晰）
      if (supplyOpportunities.length > 0) {
        item.merklSupplys = supplyOpportunities;
      }
      if (borrowOpportunities.length > 0) {
        item.merklBorrows = borrowOpportunities;
      }
      if (holdOpportunities.length > 0) {
        item.merklHolds = holdOpportunities;
      }
    }
    
    // 获取对应的 Brevis 数据并更新
    // 尝试通过 chainId + tokenAddress 匹配
    let brevisInfo: BrevisDataItem | undefined;
    
    if (item.tokenAddress) {
      const tokenKey = `${item.chainId}-${item.tokenAddress.toLowerCase()}`;
      brevisInfo = brevisData[tokenKey];
    }
    
    if (brevisInfo) {
      // 只有当数组不为空时才赋值
      if (brevisInfo.brevisSupplys.length > 0) {
        item.brevisSupplys = brevisInfo.brevisSupplys;
      }
      if (brevisInfo.brevisBorrows.length > 0) {
        item.brevisBorrows = brevisInfo.brevisBorrows;
      }
    }
    
    return item;
  });
}


/* Token 别名映射表：不同渠道可能使用不同名称指向同一个 token
const tokenAliases: Record<string, string[]> = {
  //'usdt': ['usd₮', 'usdt0', 'usd₮0'],
  //'usdc': ['usdce', 'usdc.e'],
  //'btcb': ['btc.b'],
  //'wbtc': ['wbtc.e'],
  'weth': ['eth'],  // eth 统一归一化为 weth
  'gho': ['sgho']
};*/


function generateCSV(data: FormattedReserveData[]): string {
  if (data.length === 0) return '';

  // CSV 头部
  const headers = [
    'Market Name',
    'Chain Name', 
    'Chain ID',
    'Token Name',
    'Token Symbol',
    'Token Address',
    'Supply APY (%)',
    'Borrow APY (%)',
    'Supply Incentives (%)',
    'Borrow Incentives (%)',
    'Merit Supplys',
    'Merit Borrows',
    'Merkl Supplys',
    'Merkl Borrows',
    'Merkl Holds',
    'Brevis Supplys',
    'Brevis Borrows'
  ];

  // 生成 CSV 行
  const csvRows = [
    headers.join(','),
    ...data.map(row => [
      `"${row.marketName}"`,
      `"${row.chainName}"`,
      row.chainId.toString(),
      `"${row.tokenName}"`,
      `"${row.tokenSymbol}"`,
      `"${row.tokenAddress}"`,
      row.supplyApy !== undefined ? row.supplyApy.toString() : '',
      row.borrowApy !== undefined ? row.borrowApy.toString() : '',
      (row.supplyIncentives && row.supplyIncentives.length > 0) ? `"${row.supplyIncentives.join(';')}"` : '',
      (row.borrowIncentives && row.borrowIncentives.length > 0) ? `"${row.borrowIncentives.join(';')}"` : '',
      // 格式化 meritSupplys：平铺所有数据，格式为 "APR1:selfApr1:link1:startDate1:endDate1;APR2:selfApr2:link2:startDate2:endDate2"
      (row.meritSupplys && row.meritSupplys.length > 0) 
        ? `"${row.meritSupplys.map(e => {
            const parts = [e.apr.toString()];
            if (e.selfApr !== undefined) parts.push(e.selfApr.toString());
            parts.push(e.link, e.startDate, e.endDate);
            if (e.requiredBorrowTokens) parts.push(`req:${e.requiredBorrowTokens.join(',')}`);
            return parts.join(':');
          }).join(';')}"` 
        : '',
      // 格式化 meritBorrows：平铺所有数据，格式同上
      (row.meritBorrows && row.meritBorrows.length > 0) 
        ? `"${row.meritBorrows.map(e => {
            const parts = [e.apr.toString()];
            if (e.selfApr !== undefined) parts.push(e.selfApr.toString());
            parts.push(e.link, e.startDate, e.endDate);
            if (e.requiredSupplyTokens) parts.push(`req:${e.requiredSupplyTokens.join(',')}`);
            return parts.join(':');
          }).join(';')}"` 
        : '',
      // 从分组数据中提取 breakdowns 用于 CSV 格式化（带 opportunityLink）
      `"${formatMerklBreakdown(
        row.merklSupplys?.flatMap(g => 
          g.breakdowns.map(b => ({ ...b, opportunityLink: g.opportunityLink }))
        ) || []
      )}"`,
      `"${formatMerklBreakdown(
        row.merklBorrows?.flatMap(g => 
          g.breakdowns.map(b => ({ ...b, opportunityLink: g.opportunityLink }))
        ) || []
      )}"`,
      `"${formatMerklBreakdown(
        row.merklHolds?.flatMap(g => 
          g.breakdowns.map(b => ({ ...b, opportunityLink: g.opportunityLink }))
        ) || []
      )}"`,
      // Brevis Supplys：格式为 "APR1:link1:startDate1:endDate1:message1;APR2:link2:startDate2:endDate2:message2"
      (row.brevisSupplys && row.brevisSupplys.length > 0) 
        ? `"${row.brevisSupplys.map(c => {
            const parts = [c.apr.toString(), c.link, c.startDate, c.endDate, c.message || ''];
            return parts.join(':');
          }).join(';')}"` 
        : '',
      // Brevis Borrows：格式同上
      (row.brevisBorrows && row.brevisBorrows.length > 0) 
        ? `"${row.brevisBorrows.map(c => {
            const parts = [c.apr.toString(), c.link, c.startDate, c.endDate, c.message || ''];
            return parts.join(':');
          }).join(';')}"` 
        : ''
    ].join(','))
  ];

  return csvRows.join('\n');
}

// 从所有链获取 Aave 市场数据
async function fetchAaveMarketData(): Promise<MarketData> {
  logger.info('🔄 Fetching Aave markets data from all networks...');
  
  // 获取所有 AaveV3 网络信息
  const networkInfo = getAllAaveV3Networks();
  const chainIds = [...new Set(networkInfo.map(info => info.chainId))]; // 去重
  
  logger.info(`🌐 Found ${networkInfo.length} AaveV3 networks across ${chainIds.length} unique chains`);
  logger.info('📋 Networks:');
  networkInfo.forEach(info => {
    logger.info(`   • ${info.name} (Chain ID: ${info.chainId})`);
  });
  
  logger.info('\n🚀 Fetching markets data...');
  
  let marketList: any[] = [];
  let supportedChainIds: number[] = [];
  let errors: string[] = [];
  
  // 逐个尝试每个链ID，获取marketList和supportedChainIds
  for (const chainIdValue of chainIds) {
    let retries = 3;
    let lastError: any = null;
    
    while (retries > 0) {
      try {
        logger.debug(`   Trying Chain ID: ${chainIdValue} (${4 - retries}/3 attempts)`);
        const result = await markets(client, {
          chainIds: [chainId(chainIdValue)],
        });
      
      // @aave/client 使用 Result<T, E> 模式，需要检查 isOk() 或 isErr()
      if (result && typeof result === 'object' && 'isErr' in result && typeof result.isErr === 'function') {
        if (result.isErr()) {
          const errorInfo = result.error;
          const errorMsg = `Chain ${chainIdValue}: ${errorInfo.name || 'UnknownError'}${errorInfo.message ? ` - ${errorInfo.message}` : ''}`;
          lastError = new Error(errorMsg);
          retries--;
          
          if (retries > 0) {
            const delayMs = 2000 * (4 - retries); // 递增延迟：2s, 4s, 6s
            logger.warn(`   ⚠️ Chain ${chainIdValue}: API error, retrying in ${delayMs}ms... (${errorMsg})`);
            if (errorInfo.stack) {
              logger.debug(`   Chain ${chainIdValue} error stack: ${errorInfo.stack}`);
            }
            await new Promise(resolve => setTimeout(resolve, delayMs));
            continue; // 继续重试
          } else {
            errors.push(errorMsg);
            logger.error(`   ❌ ${errorMsg}`);
            if (errorInfo.stack) {
              logger.debug(`   Chain ${chainIdValue} error stack: ${errorInfo.stack}`);
            }
            break; // 重试次数用完，跳出循环
          }
        }
        
        // 成功的情况，使用 result.value
        if (result.value && Array.isArray(result.value) && result.value.length > 0) {
          marketList.push(...result.value);
          supportedChainIds.push(chainIdValue);
          logger.info(`   ✅ Chain ${chainIdValue}: Found ${result.value.length} markets`);
          break; // 成功获取数据，跳出重试循环
        } else {
          logger.warn(`   ⚠️ Chain ${chainIdValue}: No markets found (result.value is empty or undefined)`);
          break; // 虽然没有数据，但不是错误，不需要重试
        }
      } else if (result && typeof result === 'object' && 'value' in result) {
        // 兼容旧的返回格式
        if (result.value && Array.isArray(result.value) && result.value.length > 0) {
          marketList.push(...result.value);
          supportedChainIds.push(chainIdValue);
          logger.info(`   ✅ Chain ${chainIdValue}: Found ${result.value.length} markets`);
          break; // 成功获取数据，跳出重试循环
        } else {
          logger.warn(`   ⚠️ Chain ${chainIdValue}: No markets found (result.value is empty array or undefined)`);
          break; // 虽然没有数据，但不是错误，不需要重试
        }
      } else if (result && Array.isArray(result) && result.length > 0) {
        // 直接返回数组的情况
        marketList.push(...result);
        supportedChainIds.push(chainIdValue);
        logger.info(`   ✅ Chain ${chainIdValue}: Found ${result.length} markets`);
        break; // 成功获取数据，跳出重试循环
      } else {
        logger.warn(`   ⚠️ Chain ${chainIdValue}: No markets found (unexpected result format: ${JSON.stringify(result).substring(0, 200)})`);
        break; // 虽然没有数据，但不是错误，不需要重试
      }
      } catch (error) {
        lastError = error;
        retries--;
        
        if (retries > 0) {
          const delayMs = 2000 * (4 - retries); // 递增延迟：2s, 4s, 6s
          logger.warn(`   ⚠️ Chain ${chainIdValue}: Attempt failed, retrying in ${delayMs}ms... (${error instanceof Error ? error.message : String(error)})`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        } else {
          const errorMsg = `Chain ${chainIdValue}: ${error instanceof Error ? error.message : String(error)}`;
          errors.push(errorMsg);
          logger.error(`   ❌ Chain ${chainIdValue}: ${error instanceof Error ? error.message : String(error)}`);
          if (error instanceof Error && error.stack) {
            logger.debug(`   Chain ${chainIdValue} error stack: ${error.stack}`);
          }
        }
      }
    }
  }
  
  const marketData: MarketData = {
    timestamp: new Date().toISOString(),
    totalNetworks: networkInfo.length,
    chainIds: supportedChainIds,
    networkInfo: networkInfo.filter(info => supportedChainIds.includes(info.chainId)),
    markets: marketList,
    errors: errors,
  };

  logger.info(`\n✅ Successfully fetched markets data`);
  logger.info(`📊 Found ${marketList.length} markets total from ${supportedChainIds.length} chains`);
  
  if (errors.length > 0) {
    logger.warn(`⚠️ ${errors.length} chains had errors or no data`);
  }

  // 确保 data 文件夹存在
  await mkdir(DATA_DIR, { recursive: true });
  
  // 保存原始数据到JSON文件
  const outputPath = join(DATA_DIR, 'aave-all-markets-data.json');
  await writeFile(outputPath, JSON.stringify(marketData, null, 2), 'utf-8');
  
  return marketData;
}

async function fetchAaveMarkets(): Promise<void> {
  try {
    // 从所有链获取市场数据（已包含保存原始数据到文件）
    const marketData = await fetchAaveMarketData();
    
    // 格式化数据并保存到新文件
    logger.info('\n📊 Formatting market data...');
    
    // 第一步：从 Aave 市场数据创建基础数据集
    logger.info('📊 Creating base dataset from Aave markets...');
    const baseDataset = createBaseDatasetFromMarkets(marketData.markets);
    logger.info(`✅ Created base dataset with ${baseDataset.length} token combinations`);

    // 获取 Merit APR 数据（已包含索引和时间范围）
    const meritData = await fetchMeritData();
    
    // 获取 Merkl 数据（内部会保存原始数据文件）
    const merklData = await processMerklData();
    
    // 获取 Brevis APR 数据（使用 baseDataset 匹配 campaign）
    const brevisData = await fetchBrevisAprs(baseDataset);
    
    // 第二步：将 Merit、Merkl 和 Brevis 激励数据填充到基础数据集中
    logger.info('💾 Enriching dataset with incentive data (Merit, Merkl & Brevis)...');
    const enrichedData = enrichDatasetWithIncentiveData(baseDataset, meritData, merklData, brevisData);
    
    logger.info(`🎯 Final dataset contains ${enrichedData.length} token combinations`);
    
    // 保存格式化的JSON数据（包含时间戳元数据）
    // 使用从 fetchAaveMarketData 返回的时间戳，而不是重新生成
    const formattedJsonPath = join(DATA_DIR, 'aave-formatted-data.json');
    const dataWithMetadata = {
      _metadata: {
        timestamp: marketData.timestamp, // 使用从 fetchAaveMarketData 返回的时间戳
        version: '1.0',
        dataCount: enrichedData.length,
      },
      data: enrichedData,
    };
    // 使用自定义 replacer 函数，确保 undefined 字段被完全省略，null 也会被转换为 undefined 并省略
    await writeFile(formattedJsonPath, JSON.stringify(dataWithMetadata, (key, value) => {
      // 将 null 转换为 undefined，这样会被省略（JSON.stringify 默认会省略 undefined）
      // 注意：JSON.stringify 默认行为：
      // - undefined: 被省略（不序列化）
      // - null: 序列化为 "null"（会出现在 JSON 中）
      // 所以我们把 null 也转换为 undefined 来省略它
      return value === null ? undefined : (value === undefined ? undefined : value);
    }, 2), 'utf-8');
    
    // 生成CSV格式
    const csvData = generateCSV(enrichedData);
    const csvPath = join(DATA_DIR, 'aave-formatted-data.csv');
    await writeFile(csvPath, csvData, 'utf-8');
    
    const outputPath = join(DATA_DIR, 'aave-all-markets-data.json');
    logger.info(`💾 Original data saved to ${outputPath}`);
    logger.info(`📊 Formatted JSON saved to ${formattedJsonPath}`);
    logger.info(`📈 CSV data saved to ${csvPath}`);
    logger.info(`📁 File location: ${DATA_DIR}`);
    logger.info(`📈 Total markets: ${marketData.markets.length}`);
    logger.info(`🪙 Total reserves: ${enrichedData.length}`);
    logger.info(`🌐 Networks discovered: ${marketData.totalNetworks}`);
    logger.info(`✅ Supported networks: ${marketData.networkInfo.length}`);
    logger.info(`⛓️ Supported chains: ${marketData.chainIds.length}`);
    if (marketData.errors.length > 0) {
      logger.warn(`❌ Failed chains: ${marketData.errors.length}`);
    }
    
  } catch (error) {
    logger.error('💥 Unexpected error:', error);
    
    const networkInfo = getAllAaveV3Networks();
    const chainIds = [...new Set(networkInfo.map(info => info.chainId))];
    
    // 即使出错也保存错误信息到文件
    const errorData: MarketData = {
      timestamp: new Date().toISOString(),
      totalNetworks: networkInfo.length,
      chainIds: chainIds,
      networkInfo: networkInfo,
      markets: [],
      errors: [error instanceof Error ? error.message : String(error)],
    };
    
    try {
      // 确保 data 文件夹存在
      await mkdir(DATA_DIR, { recursive: true });
      const errorPath = join(DATA_DIR, 'aave-all-markets-error.json');
      await writeFile(errorPath, JSON.stringify(errorData, null, 2), 'utf-8');
      logger.info(`💾 Error data saved to ${errorPath}`);
    } catch (writeError) {
      logger.error('❌ Failed to save error data:', writeError);
    }
  }
}

// 导出主函数,以便其他模块可以调用
export async function fetchAaveMarketsData(): Promise<void> {
  return fetchAaveMarkets();
}

// 执行主函数
fetchAaveMarkets().catch(error => {
  logger.error('❌ Failed to fetch Aave markets:', error);
  process.exit(1);
});

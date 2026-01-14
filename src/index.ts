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
  fetchMeritData,
  getMeritDataFromMarket
} from './merit-api.js';

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
  meritSupplys?: Array<{
    apr: number; // APR 百分比值
    selfApr?: number; // Self APR 百分比值（如果有对应的 self- 前缀的 key）
    link: string;
    startDate: string;
    endDate: string;
    requiredBorrowTokens?: string[];
    startBlock?: string; // 仅用于 CSV
    endBlock?: string; // 仅用于 CSV
  }>;
  meritBorrows?: Array<{
    apr: number; // APR 百分比值
    selfApr?: number; // Self APR 百分比值（如果有对应的 self- 前缀的 key）
    link: string;
    startDate: string;
    endDate: string;
    requiredSupplyTokens?: string[];
    startBlock?: string; // 仅用于 CSV
    endBlock?: string; // 仅用于 CSV
  }>;
  merklSupplys?: MerklOpportunityGroup[]; // 按 opportunity 分组的 supply 数据
  merklBorrows?: MerklOpportunityGroup[]; // 按 opportunity 分组的 borrow 数据
  merklHolds?: MerklOpportunityGroup[]; // 按 opportunity 分组的 hold 数据
  brevisSupplyApr?: number | undefined;  // Brevis Network Linea Surge Supply APR
  brevisBorrowApr?: number | undefined;   // Brevis Network Linea Surge Borrow APR
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


// Brevis APR 提取：基于 Aave 市场链/代币列表匹配描述
async function fetchBrevisAprs(
  chainTokenIndex: Record<string, Set<string>>
): Promise<Record<string, { supplyApr: number | null; borrowApr: number | null }>> {
  try {
    logger.info('🌐 Fetching Brevis Network Linea Surge APR data...');
    
    // 获取所有活动数据
    const allActivities = await brevisApi.getAllActivities();
    
    // 输出原始 Brevis 数据，方便查看
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(
      join(DATA_DIR, 'brevis-raw-activities.json'),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        totalActivities: allActivities.length,
        activities: allActivities
      }, null, 2),
      'utf-8'
    );
    logger.info(`💾 Brevis raw activities saved to ${join(DATA_DIR, 'brevis-raw-activities.json')}`);

    // 只处理 Aave 相关的活动
    const aaveActivities = allActivities.filter(activity => 
      activity.protocol === 'Aave' && 
      activity.description.toLowerCase().includes('aave')
    );
    
    logger.info(`✅ Found ${aaveActivities.length} Aave activities from Brevis`);
    
    // 构建索引：key 为 `${chainKey}-${token}` (小写)，value 为 APR 数据
    const brevisIndex: Record<string, { supplyApr: number | null; borrowApr: number | null }> = {};

    let matchedActivities = 0;
    let chainMatched = 0;
    let tokenMatched = 0;

    for (const activity of aaveActivities) {
      const descLower = activity.description.toLowerCase();
      const isSupply = descLower.includes('supply');
      const isBorrow = descLower.includes('borrow');

      // 匹配 chain
      let matchedChain: string | null = null;
      for (const chainKey of Object.keys(chainTokenIndex)) {
        if (descLower.includes(chainKey)) {
          matchedChain = chainKey;
          break;
        }
      }
      
      if (!matchedChain) continue;
      chainMatched++;

      // 匹配 token：检查索引中的标准名称和所有别名
      const tokens = Array.from(chainTokenIndex[matchedChain] || []);
      let matchedToken: string | null = null;
      
      for (const token of tokens) {
        // 检查标准名称
        if (descLower.includes(token)) {
          matchedToken = token;
          break;
        }
        if (matchedToken) break;
      }
      
      if (!matchedToken) continue;
      tokenMatched++;

      const key = `${matchedChain}-${matchedToken}`;
      
      if (!(key in brevisIndex)) {
        brevisIndex[key] = { supplyApr: null, borrowApr: null };
      }

      if (activity.lastWeekApr !== null && activity.lastWeekApr !== undefined) {
        if (isSupply) {
          if (brevisIndex[key].supplyApr === null || activity.lastWeekApr > brevisIndex[key].supplyApr!) {
            brevisIndex[key].supplyApr = activity.lastWeekApr;
          }
        } else if (isBorrow) {
          if (brevisIndex[key].borrowApr === null || activity.lastWeekApr > brevisIndex[key].borrowApr!) {
            brevisIndex[key].borrowApr = activity.lastWeekApr;
          }
        } else {
          // 默认视为 supply
          if (brevisIndex[key].supplyApr === null || activity.lastWeekApr > brevisIndex[key].supplyApr!) {
            brevisIndex[key].supplyApr = activity.lastWeekApr;
          }
        }
        matchedActivities++;
      }
    }
    
    logger.info(`✅ Indexed Brevis APR data for ${Object.keys(brevisIndex).length} chain-token pairs`);
    logger.info(`   Matches: chain=${chainMatched}, token=${tokenMatched}, activities=${matchedActivities}`);
    
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
        const aTokenAddress = reserve.aToken?.address || undefined;
        const vTokenAddress = reserve.vToken?.address || undefined;
        
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
function enrichDatasetWithIncentiveData(
  baseDataset: FormattedReserveData[],
  meritData: Record<string, MeritDataItem>,
  merklData: Record<string, MerklOpportunityData[]>,
  brevisData: Record<string, { supplyApr: number | null; borrowApr: number | null }>
): FormattedReserveData[] {
  return baseDataset.map(item => {
    const indexKey = `${item.chainName.toLowerCase()}-${item.tokenSymbol.toLowerCase()}`;
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
              breakdowns: opp.supply
            });
          }
          if (opp.borrow.length > 0) {
            const borrowWithLinks = opp.borrow.map(b => ({ ...b, opportunityLink: opp.opportunityLink }));
            borrowBreakdowns.push(...borrowWithLinks);
            borrowOpportunities.push({
              opportunityLink: opp.opportunityLink,
              breakdowns: opp.borrow
            });
          }
          if (opp.hold.length > 0) {
            const holdWithLinks = opp.hold.map(b => ({ ...b, opportunityLink: opp.opportunityLink }));
            holdBreakdowns.push(...holdWithLinks);
            holdOpportunities.push({
              opportunityLink: opp.opportunityLink,
              breakdowns: opp.hold
            });
          }
        } else {
          // 如果没有链接，直接添加 breakdowns
          if (opp.supply.length > 0) {
            supplyBreakdowns.push(...opp.supply);
            supplyOpportunities.push({
              opportunityLink: '', // 空链接，但保持结构一致
              breakdowns: opp.supply
            });
          }
          if (opp.borrow.length > 0) {
            borrowBreakdowns.push(...opp.borrow);
            borrowOpportunities.push({
              opportunityLink: '',
              breakdowns: opp.borrow
            });
          }
          if (opp.hold.length > 0) {
            holdBreakdowns.push(...opp.hold);
            holdOpportunities.push({
              opportunityLink: '',
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
    // Brevis 数据主要在 Linea 链上，chainId 为 59144
    // 根据 chainName 和 tokenSymbol 匹配（indexKey 格式：chainName-tokenSymbol）
    const brevisInfo = brevisData[indexKey];
    if (brevisInfo) {
      // 只有当值不为 null 时才赋值，否则保持 undefined（保留 0 值，因为 0 是有效值）
      item.brevisSupplyApr = brevisInfo.supplyApr !== null ? brevisInfo.supplyApr : undefined as any;
      item.brevisBorrowApr = brevisInfo.borrowApr !== null ? brevisInfo.borrowApr : undefined as any;
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
    'Brevis Supply APR (%)',
    'Brevis Borrow APR (%)'
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
      (row.brevisSupplyApr !== undefined && row.brevisSupplyApr !== null) ? row.brevisSupplyApr : '',
      (row.brevisBorrowApr !== undefined && row.brevisBorrowApr !== null) ? row.brevisBorrowApr : ''
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
    try {
      logger.debug(`   Trying Chain ID: ${chainIdValue}`);
      const result = await markets(client, {
        chainIds: [chainId(chainIdValue)],
      });
      
      if (result && typeof result === 'object' && 'value' in result && result.value.length > 0) {
        marketList.push(...result.value);
        supportedChainIds.push(chainIdValue);
        logger.info(`   ✅ Chain ${chainIdValue}: Found ${result.value.length} markets`);
      } else if (result && Array.isArray(result) && result.length > 0) {
        marketList.push(...result);
        supportedChainIds.push(chainIdValue);
        logger.info(`   ✅ Chain ${chainIdValue}: Found ${result.length} markets`);
      } else {
        logger.warn(`   ⚠️ Chain ${chainIdValue}: No markets found`);
      }
    } catch (error) {
      const errorMsg = `Chain ${chainIdValue}: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(errorMsg);
      logger.error(`   ❌ Chain ${chainIdValue}: ${error instanceof Error ? error.message : String(error)}`);
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
    
    // 构建 Brevis 解析用的链/代币索引（基于 baseDataset，确保数据一致性）
    const chainTokenIndex = buildChainTokenIndex(baseDataset);

    // 获取 Merit APR 数据（已包含索引和时间范围）
    const meritData = await fetchMeritData();
    
    // 获取 Merkl 数据（内部会保存原始数据文件）
    const merklData = await processMerklData();
    
    // 获取 Brevis APR 数据（使用链/代币索引匹配描述）
    const brevisData = await fetchBrevisAprs(chainTokenIndex);
    
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

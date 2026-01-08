import { writeFile, mkdir } from 'fs/promises';
import { chainId, AaveClient } from "@aave/client";
import { markets } from "@aave/client/actions";
import * as addressBook from "@bgd-labs/aave-address-book";

// 创建 Aave 客户端实例
const client = AaveClient.create();
import fetch from 'node-fetch';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { brevisApi } from './brevis-api.js';
import {
  MerklCampaignBreakdown,
  MerklOpportunityData,
  processMerklData,
  calculateActiveCampaignApr,
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
  supplyApy: string;
  borrowApy: string | null;
  supplyIncentives: string[]; // Protocol supply incentives from reserve.incentives (AaveSupplyIncentive)
  borrowIncentives: string[]; // Protocol borrow incentives from reserve.incentives (AaveBorrowIncentive)
  meritSupplyApr: string[]; // Merit supply APR
  meritBorrowApr: string[]; // Merit borrow APR
  meritSelfSupply: string[]; // Merit self supply APR
  meritSelfBorrow: string[]; // Merit self borrow APR
  meritSupplyWithBorrowRequirement?: Array<{
    apr: string;
    requiredBorrowTokens: string[]; // 需要 borrow 的 token 列表，如果是 'multiple' 则表示任意 token
    isSelf?: boolean; // 是否为 self 格式
  }>;
  meritBorrowWithSupplyRequirement?: Array<{
    apr: string;
    requiredSupplyTokens: string[]; // 需要 supply 的 token 列表，如果是 'multiple' 则表示任意 token
    isSelf?: boolean; // 是否为 self 格式
  }>;
  merklSupplyApr: number; // 所有匹配 opportunities 的 APR 值总和
  merklBorrowApr: number; // 所有匹配 opportunities 的 APR 值总和
  merklHoldApr: number; // 所有匹配 opportunities 的 APR 值总和
  merklSupplyAprBreakdowns: MerklCampaignBreakdown[]; // 合并所有匹配 opportunities 的 breakdowns
  merklBorrowAprBreakdowns: MerklCampaignBreakdown[]; // 合并所有匹配 opportunities 的 breakdowns
  merklHoldAprBreakdowns: MerklCampaignBreakdown[]; // 合并所有匹配 opportunities 的 breakdowns
  brevisSupplyApr: number | null;  // Brevis Network Linea Surge Supply APR
  brevisBorrowApr: number | null;   // Brevis Network Linea Surge Borrow APR
  totalIncentiveSupplyApy: number; // 所有激励 APR 转换为 APY 后的总和
  totalSupplyApy: number; // 原生 supplyApy + totalIncentiveSupplyApy
  totalIncentiveBorrowApy: number; // 所有激励 APR 转换为 APY 后的总和
  totalBorrowApy: number | null; // 原生 borrowApy + totalIncentiveBorrowApy
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
        const aTokenAddress = reserve.aToken?.address || null;
        const vTokenAddress = reserve.vToken?.address || null;
        
        // 检查 borrowingState 是否为 "DISABLED"，如果是则表示该 token 不能被 borrow
        const isBorrowDisabled = reserve.borrowInfo?.borrowingState === "DISABLED";
        const borrowApy = isBorrowDisabled
          ? null 
          : (reserve.borrowInfo?.apy?.formatted || reserve.borrowInfo?.apy?.value || null);
        
        // 从 reserve.incentives 中提取 protocol supply 和 borrow incentives
        const protocolSupplyIncentives: string[] = [];
        const protocolBorrowIncentives: string[] = [];
        
        if (reserve.incentives && Array.isArray(reserve.incentives)) {
          reserve.incentives.forEach((incentive: any) => {
            if (incentive.__typename === 'AaveSupplyIncentive' && incentive.extraSupplyApr?.formatted) {
              protocolSupplyIncentives.push(incentive.extraSupplyApr.formatted);
            } else if (incentive.__typename === 'AaveBorrowIncentive') {
              // AaveBorrowIncentive 可能使用 extraBorrowApr 或其他字段名
              const borrowApr = incentive.extraBorrowApr?.formatted || incentive.borrowApr?.formatted;
              if (borrowApr) {
                protocolBorrowIncentives.push(borrowApr);
              }
            }
          });
        }
        
        // 创建完整的结构化数据，包含所有激励字段
        baseDataset.push({
          marketName,
          chainName,
          chainId,
          tokenName: reserve.underlyingToken?.name || 'Unknown',
          tokenSymbol,
          tokenAddress,
          aTokenAddress,
          vTokenAddress,
          supplyApy: reserve.supplyInfo?.apy?.formatted || reserve.supplyInfo?.apy?.value || '0',
          borrowApy,
          // Protocol incentives - 从 reserve.incentives 提取
          supplyIncentives: protocolSupplyIncentives,
          borrowIncentives: protocolBorrowIncentives,
          // Merit APR 激励字段 - 初始化为空数组
          meritSupplyApr: [],
          meritBorrowApr: [],
          meritSelfSupply: [],
          meritSelfBorrow: [],
          meritSupplyWithBorrowRequirement: undefined,
          meritBorrowWithSupplyRequirement: undefined,
          // Merkl APR 激励字段 - 初始化为 0
          merklSupplyApr: 0,
          merklBorrowApr: 0,
          merklHoldApr: 0,
          merklSupplyAprBreakdowns: [],
          merklBorrowAprBreakdowns: [],
          merklHoldAprBreakdowns: [],
          // Brevis APR 激励字段 - 初始化为 null
          brevisSupplyApr: null,
          brevisBorrowApr: null,
          // 总 APY 字段 - 初始化为 0，将在 enrichDatasetWithIncentiveData 中计算
          totalIncentiveSupplyApy: 0,
          totalSupplyApy: 0,
          totalIncentiveBorrowApy: 0,
          totalBorrowApy: null
        });
      });
    }
  });

  return baseDataset;
}




// 计算总激励 APR 和总 APY
function calculateTotalApy(item: FormattedReserveData): void {
  // 计算 Supply 激励 APR 总和
  let totalSupplyIncentiveApr = 0;
  
  // 1. Protocol supply incentives (supplyIncentives)
  item.supplyIncentives.forEach(incentive => {
    const apr = parseFloat(incentive);
    if (!isNaN(apr)) {
      totalSupplyIncentiveApr += apr / 100; // 转换为小数
    }
  });
  
  // 2. Merit supply APR (meritSupplyApr)
  item.meritSupplyApr.forEach(apr => {
    const aprValue = parseFloat(apr);
    if (!isNaN(aprValue)) {
      totalSupplyIncentiveApr += aprValue / 100; // 转换为小数
    }
  });
  
  // 3. Merit self supply APR (meritSelfSupply)
  item.meritSelfSupply.forEach(apr => {
    const aprValue = parseFloat(apr);
    if (!isNaN(aprValue)) {
      totalSupplyIncentiveApr += aprValue / 100; // 转换为小数
    }
  });
  
  // 4. Merit supply with borrow requirement APR (meritSupplyWithBorrowRequirement)
  if (item.meritSupplyWithBorrowRequirement && item.meritSupplyWithBorrowRequirement.length > 0) {
    item.meritSupplyWithBorrowRequirement.forEach(req => {
      const aprValue = parseFloat(req.apr);
      if (!isNaN(aprValue)) {
        totalSupplyIncentiveApr += aprValue / 100; // 转换为小数
      }
    });
  }
  
  // 5. Merkl supply APR (merklSupplyApr)
  if (item.merklSupplyApr > 0) {
    totalSupplyIncentiveApr += item.merklSupplyApr / 100; // 转换为小数
  }
  
  // 6. Brevis supply APR (brevisSupplyApr)
  if (item.brevisSupplyApr !== null && item.brevisSupplyApr > 0) {
    totalSupplyIncentiveApr += item.brevisSupplyApr / 100; // 转换为小数
  }
  
  // 转换为 APY
  item.totalIncentiveSupplyApy = convertAprToApy(totalSupplyIncentiveApr);
  
  // 计算总 Supply APY = 原生 supplyApy + totalIncentiveSupplyApy
  const nativeSupplyApy = parseFloat(item.supplyApy);
  if (!isNaN(nativeSupplyApy)) {
    item.totalSupplyApy = (nativeSupplyApy / 100) + item.totalIncentiveSupplyApy;
  } else {
    item.totalSupplyApy = item.totalIncentiveSupplyApy;
  }
  
  // 计算 Borrow 激励 APR 总和
  let totalBorrowIncentiveApr = 0;
  
  // 1. Protocol borrow incentives (borrowIncentives)
  item.borrowIncentives.forEach(incentive => {
    const apr = parseFloat(incentive);
    if (!isNaN(apr)) {
      totalBorrowIncentiveApr += apr / 100; // 转换为小数
    }
  });
  
  // 2. Merit borrow APR (meritBorrowApr)
  item.meritBorrowApr.forEach(apr => {
    const aprValue = parseFloat(apr);
    if (!isNaN(aprValue)) {
      totalBorrowIncentiveApr += aprValue / 100; // 转换为小数
    }
  });
  
  // 3. Merit self borrow APR (meritSelfBorrow)
  item.meritSelfBorrow.forEach(apr => {
    const aprValue = parseFloat(apr);
    if (!isNaN(aprValue)) {
      totalBorrowIncentiveApr += aprValue / 100; // 转换为小数
    }
  });
  
  // 4. Merit borrow with supply requirement APR (meritBorrowWithSupplyRequirement)
  if (item.meritBorrowWithSupplyRequirement && item.meritBorrowWithSupplyRequirement.length > 0) {
    item.meritBorrowWithSupplyRequirement.forEach(req => {
      const aprValue = parseFloat(req.apr);
      if (!isNaN(aprValue)) {
        totalBorrowIncentiveApr += aprValue / 100; // 转换为小数
      }
    });
  }
  
  // 5. Merkl borrow APR (merklBorrowApr)
  if (item.merklBorrowApr > 0) {
    totalBorrowIncentiveApr += item.merklBorrowApr / 100; // 转换为小数
  }
  
  // 6. Brevis borrow APR (brevisBorrowApr)
  if (item.brevisBorrowApr !== null && item.brevisBorrowApr > 0) {
    totalBorrowIncentiveApr += item.brevisBorrowApr / 100; // 转换为小数
  }
  
  // 转换为 APY
  item.totalIncentiveBorrowApy = convertAprToApy(totalBorrowIncentiveApr);
  
  // 计算总 Borrow APY = 原生 borrowApy + totalIncentiveBorrowApy
  if (item.borrowApy !== null) {
    const nativeBorrowApy = parseFloat(item.borrowApy);
    if (!isNaN(nativeBorrowApy)) {
      item.totalBorrowApy = (nativeBorrowApy / 100) + item.totalIncentiveBorrowApy;
    } else {
      item.totalBorrowApy = item.totalIncentiveBorrowApy;
    }
  } else {
    item.totalBorrowApy = item.totalIncentiveBorrowApy > 0 ? item.totalIncentiveBorrowApy : null;
  }
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
      item.meritSupplyApr = meritItemData.meritSupplyApr.length > 0 ? meritItemData.meritSupplyApr : [];
      item.meritBorrowApr = meritItemData.meritBorrowApr.length > 0 ? meritItemData.meritBorrowApr : [];
      item.meritSelfSupply = meritItemData.meritSelfSupply.length > 0 ? meritItemData.meritSelfSupply : [];
      item.meritSelfBorrow = meritItemData.meritSelfBorrow.length > 0 ? meritItemData.meritSelfBorrow : [];
      // 处理需要先 supply 的 borrow APR 信息
      if (meritItemData.meritBorrowWithSupplyRequirement.length > 0) {
        item.meritBorrowWithSupplyRequirement = meritItemData.meritBorrowWithSupplyRequirement;
      }
      // 处理需要先 borrow 的 supply APR 信息
      if (meritItemData.meritSupplyWithBorrowRequirement.length > 0) {
        item.meritSupplyWithBorrowRequirement = meritItemData.meritSupplyWithBorrowRequirement;
      }
    }
    
    // 获取对应的 Merkl 数据并更新
    const matchedOpportunities = findMatchingMerklOpportunities(item, merklData);
    
    if (matchedOpportunities.length > 0) {
      const supplyBreakdowns: MerklCampaignBreakdown[] = [];
      const borrowBreakdowns: MerklCampaignBreakdown[] = [];
      const holdBreakdowns: MerklCampaignBreakdown[] = [];
      
      // 先收集所有 matchedOpportunities 中的 breakdowns
      for (const opp of matchedOpportunities) {
        if (opp.supply.length > 0) {
          supplyBreakdowns.push(...opp.supply);
        }
        if (opp.borrow.length > 0) {
          borrowBreakdowns.push(...opp.borrow);
        }
        if (opp.hold.length > 0) {
          holdBreakdowns.push(...opp.hold);
        }
      }
      
      // 一次性计算所有 breakdowns 的总 APR
      item.merklSupplyApr = calculateActiveCampaignApr(supplyBreakdowns);
      item.merklBorrowApr = calculateActiveCampaignApr(borrowBreakdowns);
      item.merklHoldApr = calculateActiveCampaignApr(holdBreakdowns);
      item.merklSupplyAprBreakdowns = supplyBreakdowns;
      item.merklBorrowAprBreakdowns = borrowBreakdowns;
      item.merklHoldAprBreakdowns = holdBreakdowns;
    }
    
    // 获取对应的 Brevis 数据并更新
    // Brevis 数据主要在 Linea 链上，chainId 为 59144
    // 根据 chainName 和 tokenSymbol 匹配（indexKey 格式：chainName-tokenSymbol）
    const brevisInfo = brevisData[indexKey];
    if (brevisInfo) {
      item.brevisSupplyApr = brevisInfo.supplyApr;
      item.brevisBorrowApr = brevisInfo.borrowApr;
    }
    
    // 计算总激励 APY 和总 APY
    calculateTotalApy(item);
    
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
    'Merit Supply (%)',
    'Merit Borrow (%)',
    'Merit Self Supply (%)',
    'Merit Self Borrow (%)',
    'Merit Borrow With Supply Requirement',
    'Merit Supply With Borrow Requirement',
    'Merkl Supply APR (%)',
    'Merkl Borrow APR (%)',
    'Merkl Hold APR (%)',
    'Merkl Supply Campaigns',
    'Merkl Borrow Campaigns',
    'Merkl Hold Campaigns',
    'Brevis Supply APR (%)',
    'Brevis Borrow APR (%)',
    'Total Incentive Supply APY (%)',
    'Total Supply APY (%)',
    'Total Incentive Borrow APY (%)',
    'Total Borrow APY (%)'
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
      row.supplyApy,
      row.borrowApy || '',
      row.supplyIncentives.length > 0 ? `"${row.supplyIncentives.join(';')}"` : '',
      row.borrowIncentives.length > 0 ? `"${row.borrowIncentives.join(';')}"` : '',
      row.meritSupplyApr.length > 0 ? `"${row.meritSupplyApr.join(';')}"` : '',
      row.meritBorrowApr.length > 0 ? `"${row.meritBorrowApr.join(';')}"` : '',
      row.meritSelfSupply.length > 0 ? `"${row.meritSelfSupply.join(';')}"` : '',
      row.meritSelfBorrow.length > 0 ? `"${row.meritSelfBorrow.join(';')}"` : '',
      // 格式化 meritSupplyWithBorrowRequirement：格式为 "APR1:token1,token2;APR2:token3"
      row.meritSupplyWithBorrowRequirement && row.meritSupplyWithBorrowRequirement.length > 0
        ? `"${row.meritSupplyWithBorrowRequirement.map(req => `${req.apr}:${req.requiredBorrowTokens.join(',')}`).join('; ')}"`
        : '',
      // 格式化 meritBorrowWithSupplyRequirement：格式为 "APR1:token1,token2;APR2:token3"
      row.meritBorrowWithSupplyRequirement && row.meritBorrowWithSupplyRequirement.length > 0
        ? `"${row.meritBorrowWithSupplyRequirement.map(req => `${req.apr}:${req.requiredSupplyTokens.join(',')}`).join('; ')}"`
        : '',
      row.merklSupplyApr > 0 ? row.merklSupplyApr : '',
      row.merklBorrowApr > 0 ? row.merklBorrowApr : '',
      row.merklHoldApr > 0 ? row.merklHoldApr : '',
      `"${formatMerklBreakdown(row.merklSupplyAprBreakdowns)}"`,
      `"${formatMerklBreakdown(row.merklBorrowAprBreakdowns)}"`,
      `"${formatMerklBreakdown(row.merklHoldAprBreakdowns)}"`,
      row.brevisSupplyApr !== null ? row.brevisSupplyApr : '',
      row.brevisBorrowApr !== null ? row.brevisBorrowApr : '',
      row.totalIncentiveSupplyApy > 0 ? (row.totalIncentiveSupplyApy * 100).toFixed(6) : '',
      (row.totalSupplyApy * 100).toFixed(6),
      row.totalIncentiveBorrowApy > 0 ? (row.totalIncentiveBorrowApy * 100).toFixed(6) : '',
      row.totalBorrowApy !== null ? (row.totalBorrowApy * 100).toFixed(6) : ''
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
  
  /* 按链分组统计，仅用于console输出
  const marketsByChain = marketList.reduce((acc: Record<number, any[]>, market) => {
    const chainId = market.chain?.chainId || 0;
    if (!acc[chainId]) acc[chainId] = [];
    acc[chainId].push(market);
    return acc;
  }, {});
  logger.info('\n📋 Markets by Chain:');
  Object.entries(marketsByChain).forEach(([chainIdStr, chainMarkets]) => {
    const chainId = parseInt(chainIdStr);
    const networkNames = marketData.networkInfo
      .filter(info => info.chainId === chainId)
      .map(info => info.name.replace('AaveV3', ''))
      .join(', ');
    
    logger.info(`   Chain ${chainId} (${networkNames}): ${chainMarkets.length} markets`);
    chainMarkets.forEach((market, index) => {
      logger.info(`     ${index + 1}. ${market.name || 'Unknown'} - ${market.address || 'Unknown'}`);
      logger.debug(`        Market Size: ${market.totalMarketSize || 'N/A'}`);
      logger.debug(`        Liquidity: ${market.totalAvailableLiquidity || 'N/A'}`);
      logger.debug(`        Reserves: ${market.supplyReserves?.length || 0} supply, ${market.borrowReserves?.length || 0} borrow`);
    });
    logger.info('');
  });
  */

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

    // 获取 Merit APR 数据（已包含索引）
    const meritData = await fetchMeritData();
    
    // 获取 Merkl 数据（内部会保存原始数据文件）
    const merklData = await processMerklData();
    
    // 获取 Brevis APR 数据（使用链/代币索引匹配描述）
    const brevisData = await fetchBrevisAprs(chainTokenIndex);
    
    // 第二步：将 Merit、Merkl 和 Brevis 激励数据填充到基础数据集中
    logger.info('💾 Enriching dataset with incentive data (Merit, Merkl & Brevis)...');
    const formattedData = enrichDatasetWithIncentiveData(baseDataset, meritData, merklData, brevisData);
    
    logger.info(`🎯 Final dataset contains ${formattedData.length} token combinations`);
    
    // 保存格式化的JSON数据（包含时间戳元数据）
    // 使用从 fetchAaveMarketData 返回的时间戳，而不是重新生成
    const formattedJsonPath = join(DATA_DIR, 'aave-formatted-data.json');
    const dataWithMetadata = {
      _metadata: {
        timestamp: marketData.timestamp, // 使用从 fetchAaveMarketData 返回的时间戳
        version: '1.0',
        dataCount: formattedData.length,
      },
      data: formattedData,
    };
    await writeFile(formattedJsonPath, JSON.stringify(dataWithMetadata, null, 2), 'utf-8');
    
    // 生成CSV格式
    const csvData = generateCSV(formattedData);
    const csvPath = join(DATA_DIR, 'aave-formatted-data.csv');
    await writeFile(csvPath, csvData, 'utf-8');
    
    logger.info(`💾 Original data saved to ${outputPath}`);
    logger.info(`📊 Formatted JSON saved to ${formattedJsonPath}`);
    logger.info(`📈 CSV data saved to ${csvPath}`);
    logger.info(`📁 File location: ${DATA_DIR}`);
    logger.info(`📈 Total markets: ${marketData.markets.length}`);
    logger.info(`🪙 Total reserves: ${formattedData.length}`);
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

// 导出主函数，以便其他模块可以调用
export async function fetchAaveMarketsData(): Promise<void> {
  return fetchAaveMarkets();
}

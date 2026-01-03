import { writeFile, mkdir } from 'fs/promises';
import { chainId, AaveClient } from "@aave/client";
import { markets } from "@aave/client/actions";
import * as addressBook from "@bgd-labs/aave-address-book";

// 创建 Aave 客户端实例
const client = AaveClient.create();
import fetch from 'node-fetch';
import { join } from 'path';
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
  meritBorrowWithSupplyRequirement?: Array<{
    apr: string;
    requiredSupplyTokens: string[]; // 需要 supply 的 token 列表，如果是 'multiple' 则表示任意 token
    isSelf?: boolean; // 是否为 self 格式
  }>;
  meritSupplyWithBorrowRequirement?: Array<{
    apr: string;
    requiredBorrowTokens: string[]; // 需要 borrow 的 token 列表，如果是 'multiple' 则表示任意 token
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
}

interface MeritAPRResponse {
  previousAPR: any;
  currentAPR: {
    actionsAPR: Record<string, number | null>;
  };
}


// Merit 数据项结构
interface MeritDataItem {
  meritSupplyApr: string[];
  meritBorrowApr: string[];
  meritSelfSupply: string[];
  meritSelfBorrow: string[];
  meritBorrowWithSupplyRequirement: Array<{
    apr: string;
    requiredSupplyTokens: string[];
    isSelf?: boolean;
  }>;
  meritSupplyWithBorrowRequirement: Array<{
    apr: string;
    requiredBorrowTokens: string[];
    isSelf?: boolean;
  }>;
}

// 从 baseDataset 构建链-代币索引：chainNameLower -> Set<tokenSymbolLower>
function buildChainTokenIndex(baseDataset: FormattedReserveData[]): Record<string, Set<string>> {
  const index: Record<string, Set<string>> = {};
  
  baseDataset.forEach(item => {
    const chainName = item.chainName.toLowerCase();
    if (!chainName) return;
    if (!index[chainName]) index[chainName] = new Set<string>();
    const tokenSymbol = item.tokenSymbol;
    if (tokenSymbol) index[chainName].add(tokenSymbol);
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

async function fetchMeritData(): Promise<Record<string, MeritDataItem>> {
  try {
    logger.info('🎁 Fetching Merit APR data...');
    const response = await fetch('https://apps.aavechan.com/api/merit/aprs');
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json() as MeritAPRResponse;
    logger.info(`✅ Merit APR data fetched successfully`);
    
    const meritAPRs = data.currentAPR.actionsAPR;
    
    // 建立 Merit APR 数据索引
    // 作用：将原始 Merit APR 数据（键格式复杂，如 "ethereum-supply-weth"）转换为统一的索引格式
    // 输入：Record<string, number | null> - 原始数据，键可能包含多种格式（supply/borrow/prime/multiple/self- 等）
    // 输出：Record<chain-token, {...}> - 统一索引，键为 "chain-token" 格式（如 "ethereum-weth"）
    logger.info('🔍 Indexing Merit APR data...');
    const meritData: Record<string, MeritDataItem> = {};

    // 创建索引条目的辅助函数
    function createIndexEntry(indexKey: string) {
      if (!(indexKey in meritData)) {
        meritData[indexKey] = {
          meritSupplyApr: [],
          meritBorrowApr: [],
          meritSelfSupply: [],
          meritSelfBorrow: [],
          meritBorrowWithSupplyRequirement: [],
          meritSupplyWithBorrowRequirement: []
        };
      }
      return meritData[indexKey]!;
    }

    // 处理 supply/borrow 代币对的辅助函数
    function processTokenPair(
      supplyTokens: string[],
      borrowTokens: string[],
      chainKey: string,
      value: number | null,
      isSelfFormat: boolean = false
    ) {
      if (value === null) return;
      
      const aprValue = value.toString();

      const borrowTargets = borrowTokens.filter(t => t !== 'multiple');
      const supplyTargets = supplyTokens.filter(t => t !== 'multiple');
      const hasBorrowTokens = borrowTargets.length > 0;
      const hasBorrowMultiple = borrowTokens.includes('multiple');
      const hasSupplyTokens = supplyTargets.length > 0;

      // 情况 1: borrowToken 不是 'multiple'，为每个 borrow token 分别处理
      if (hasBorrowTokens) {
        for (const bt of borrowTargets) {
          const indexKey = `${chainKey.toLowerCase()}-${bt.toLowerCase()}`;
          const incentives = createIndexEntry(indexKey);

          if (supplyTokens.length > 0) {
            incentives.meritBorrowWithSupplyRequirement.push({
              apr: aprValue,
              requiredSupplyTokens: supplyTokens,
              isSelf: isSelfFormat
            });
          } else {
            addAprValue(incentives, aprValue, false, isSelfFormat);
          }
        }

        if (hasSupplyTokens) {
          for (const st of supplyTargets) {
            const supplyIndexKey = `${chainKey.toLowerCase()}-${st.toLowerCase()}`;
            const supplyIncentives = createIndexEntry(supplyIndexKey);
            supplyIncentives.meritSupplyWithBorrowRequirement.push({
              apr: aprValue,
              requiredBorrowTokens: borrowTokens,
              isSelf: isSelfFormat
            });
          }
        }
      }

      // 情况 2: borrowToken 是 'multiple'，为每个 supply token 分别处理
      if (hasBorrowMultiple && hasSupplyTokens) {
        for (const st of supplyTargets) {
          const indexKey = `${chainKey.toLowerCase()}-${st.toLowerCase()}`;
          const incentives = createIndexEntry(indexKey);
          incentives.meritSupplyWithBorrowRequirement.push({
            apr: aprValue,
            requiredBorrowTokens: ['multiple'],
            isSelf: isSelfFormat
          });
        }
      }

      // 情况 3: 只有 supply token，没有 borrow token（简单 supply 场景）
      if (!hasBorrowTokens && !hasBorrowMultiple && hasSupplyTokens) {
        for (const st of supplyTargets) {
          const indexKey = `${chainKey.toLowerCase()}-${st.toLowerCase()}`;
          const incentives = createIndexEntry(indexKey);
          addAprValue(incentives, aprValue, true, isSelfFormat);
        }
      }
    }

    // 遍历所有原始 Merit APR 数据，解析并构建索引
    Object.entries(meritAPRs).forEach(([key, value]) => {
      const parts = key.split('-');
      if (parts.length < 2) return;
      
      const isSelfFormat = key.startsWith('self-');
      const actualKey = isSelfFormat ? key.substring(5) : key;
      const actualParts = actualKey.split('-');
      
      if (actualParts.length < 2) return;
      
      let chainKey = parseChainKey(actualParts);
      
      let supplyTokens: string[] = [];
      let borrowTokens: string[] = [];

      if (actualKey.includes('-supply-') && actualKey.includes('-borrow-')) {
        const supplyIndex = actualParts.indexOf('supply');
        const borrowIndex = actualParts.indexOf('borrow');
        if (supplyIndex >= 0 && borrowIndex >= 0) {
          const rawSupplyToken = actualParts.slice(supplyIndex + 1, borrowIndex).join('-');
          const rawBorrowToken = actualParts.slice(borrowIndex + 1).join('-');
          supplyTokens = rawSupplyToken.includes('-or-') 
            ? rawSupplyToken.split('-or-')
                .map(t => t.toLowerCase())
                .filter(Boolean)
            : rawSupplyToken ? [rawSupplyToken.toLowerCase()] : [];
          borrowTokens = rawBorrowToken.includes('-or-')
            ? rawBorrowToken.split('-or-')
                .map(t => t.toLowerCase())
                .filter(Boolean)
            : rawBorrowToken ? [rawBorrowToken.toLowerCase()] : [];
        }
      } else if (actualKey.includes('-supply-')) {
        const token = actualParts[actualParts.length - 1].toLowerCase();
        if (token) supplyTokens = [token];
      } else if (actualKey.includes('-borrow-')) {
        const token = actualParts[actualParts.length - 1].toLowerCase();
        if (token) borrowTokens = [token];
      } else if (actualParts.length === 2 ) {
        const token = actualParts[1].toLowerCase();
        if (token) supplyTokens = [token];
      }

      if (supplyTokens.length > 0 || borrowTokens.length > 0) {
        processTokenPair(supplyTokens, borrowTokens, chainKey, value, isSelfFormat);
      }
    });

    logger.info(`✅ Indexed Merit data for ${Object.keys(meritData).length} chain-token combinations`);
    return meritData;
  } catch (error) {
    logger.error('❌ Error fetching Merit APR data:', error);
    return {};
  }
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
    await mkdir('data', { recursive: true });
    await writeFile(
      join('data', 'brevis-raw-activities.json'),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        totalActivities: allActivities.length,
        activities: allActivities
      }, null, 2),
      'utf-8'
    );
    logger.info('💾 Brevis raw activities saved to data/brevis-raw-activities.json');

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
          meritBorrowWithSupplyRequirement: undefined,
          meritSupplyWithBorrowRequirement: undefined,
          // Merkl APR 激励字段 - 初始化为 0
          merklSupplyApr: 0,
          merklBorrowApr: 0,
          merklHoldApr: 0,
          merklSupplyAprBreakdowns: [],
          merklBorrowAprBreakdowns: [],
          merklHoldAprBreakdowns: [],
          // Brevis APR 激励字段 - 初始化为 null
          brevisSupplyApr: null,
          brevisBorrowApr: null
        });
      });
    }
  });

  return baseDataset;
}

// 解析链名，处理特殊情况如 ethereum-prime
function parseChainKey(parts: string[]): string {
  // 注意：传入的 parts 已经移除了 self- 前缀
  if (parts.length >= 2 && parts[0] === 'ethereum' && parts[1] !== 'supply' && parts[1] !== 'borrow') {
    // ethereum-xxx 格式：ethereum-xxx-action-token (xxx 不是 supply 或 borrow)
    return `ethereum-${parts[1]}`;
  } else {
    // 标准格式：chain-action-token
    return parts[0];
  }
}

// 根据 marketName 和 tokenSymbol 获取对应的 meritData
function getMeritDataFromMarket(
  marketName: string,
  chainName: string,
  tokenSymbol: string,
  meritData: Record<string, MeritDataItem>
): MeritDataItem | null {
  // 根据 marketName 确定 chainKey
  let chainKey: string;
  if (marketName === 'AaveV3EthereumEtherFi') {
    chainKey = 'ethereum-etherfi';
  } else if (marketName === 'AaveV3EthereumLido') {
    chainKey = 'ethereum-prime';
  } else if (marketName === 'AaveV3EthereumHorizon') {
    chainKey = 'ethereum-horizon';
  } else {
    chainKey = chainName.toLowerCase();
  }

  // 尝试匹配 tokenSymbol，使用各种 fallback 策略
  const tokenLower = tokenSymbol.toLowerCase();
  
  // 生成所有可能的 tokenSymbol 变体用于匹配
  const tokenVariants: string[] = [tokenLower];
  
  // 1. 如果有小数点，去掉小数点
  if (tokenLower.includes('.')) {
    tokenVariants.push(tokenLower.replace(/\./g, ''));
  }
  
  // 2. 如果有₮，将₮转化为t
  if (tokenLower.includes('₮')) {
    tokenVariants.push(tokenLower.replace(/₮/g, 't'));
  }
  
  // 3. 如果是weth，换成eth
  if (tokenLower === 'weth') {
    tokenVariants.push('eth');
  }
  
  // 4. 如果结尾是.e，去掉.e
  if (tokenLower.endsWith('.e')) {
    tokenVariants.push(tokenLower.slice(0, -2));
  }
  
  // 5. 如果是usdt0或usd₮0，试一下usdt
  if (tokenLower === 'usdt0' || tokenLower === 'usd₮0') {
    tokenVariants.push('usdt');
  }

  // 去重
  const uniqueVariants = [...new Set(tokenVariants)];

  // 尝试每个变体来查找匹配的 meritData
  for (const variant of uniqueVariants) {
    const indexKey = `${chainKey}-${variant}`;
    if (meritData[indexKey]) {
      return meritData[indexKey];
    }
  }

  // 如果都没找到，返回 null
  return null;
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
      let merklSupplyApr = 0;
      let merklBorrowApr = 0;
      let merklHoldApr = 0;
      const supplyBreakdowns: MerklCampaignBreakdown[] = [];
      const borrowBreakdowns: MerklCampaignBreakdown[] = [];
      const holdBreakdowns: MerklCampaignBreakdown[] = [];
      
      for (const opp of matchedOpportunities) {
        if (opp.supply.length > 0) {
          const supplyApr = calculateActiveCampaignApr(opp.supply);
          if (supplyApr > 0) {
            merklSupplyApr += supplyApr;
          }
          supplyBreakdowns.push(...opp.supply);
        }
        if (opp.borrow.length > 0) {
          const borrowApr = calculateActiveCampaignApr(opp.borrow);
          if (borrowApr > 0) {
            merklBorrowApr += borrowApr;
          }
          borrowBreakdowns.push(...opp.borrow);
        }
        if (opp.hold.length > 0) {
          const holdApr = calculateActiveCampaignApr(opp.hold);
          if (holdApr > 0) {
            merklHoldApr += holdApr;
          }
          holdBreakdowns.push(...opp.hold);
        }
      }
      
      item.merklSupplyApr = merklSupplyApr;
      item.merklBorrowApr = merklBorrowApr;
      item.merklHoldApr = merklHoldApr;
      item.merklSupplyAprBreakdowns = supplyBreakdowns;
      item.merklBorrowAprBreakdowns = borrowBreakdowns;
      item.merklHoldAprBreakdowns = holdBreakdowns;
    }
    
    // 获取对应的 Brevis 数据并更新
    // Brevis 数据主要在 Linea 链上，chainId 为 59144
    // 根据 tokenAddress 匹配
    const brevisInfo = brevisData[indexKey];
    if (brevisInfo) {
      item.brevisSupplyApr = brevisInfo.supplyApr;
      item.brevisBorrowApr = brevisInfo.borrowApr;
    }
    
    return item;
  });
}

// 辅助函数：根据 isSelfFormat 添加 APR 值
// 作用：将 APR 值添加到对应的数组中
// 重要：使用 push() 方法，意味着如果同一个 chain-token 的同一字段被多次调用，所有值都会累积
// 例如：如果 "ethereum-weth" 的 supply APR 被调用 3 次（值分别为 "5.2", "1.0", "0.5"）
//       那么 meritSupplyApr 最终会是 ["5.2", "1.0", "0.5"]
function addAprValue(incentives: any, aprValue: string, isSupply: boolean, isSelfFormat: boolean) {
  if (isSupply) {
    if (isSelfFormat) {
      incentives.meritSelfSupply.push(aprValue);
    } else {
      incentives.meritSupplyApr.push(aprValue);
    }
  } else {
    if (isSelfFormat) {
      incentives.meritSelfBorrow.push(aprValue);
    } else {
      incentives.meritBorrowApr.push(aprValue);
    }
  }
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
      row.supplyApy,
      row.borrowApy || '',
      row.supplyIncentives.length > 0 ? `"${row.supplyIncentives.join(';')}"` : '',
      row.borrowIncentives.length > 0 ? `"${row.borrowIncentives.join(';')}"` : '',
      row.meritSupplyApr.length > 0 ? `"${row.meritSupplyApr.join(';')}"` : '',
      row.meritBorrowApr.length > 0 ? `"${row.meritBorrowApr.join(';')}"` : '',
      row.meritSelfSupply.length > 0 ? `"${row.meritSelfSupply.join(';')}"` : '',
      row.meritSelfBorrow.length > 0 ? `"${row.meritSelfBorrow.join(';')}"` : '',
      // 格式化 meritBorrowWithSupplyRequirement：格式为 "APR1:token1,token2;APR2:token3"
      row.meritBorrowWithSupplyRequirement && row.meritBorrowWithSupplyRequirement.length > 0
        ? `"${row.meritBorrowWithSupplyRequirement.map(req => `${req.apr}:${req.requiredSupplyTokens.join(',')}`).join('; ')}"`
        : '',
      // 格式化 meritSupplyWithBorrowRequirement：格式为 "APR1:token1,token2;APR2:token3"
      row.meritSupplyWithBorrowRequirement && row.meritSupplyWithBorrowRequirement.length > 0
        ? `"${row.meritSupplyWithBorrowRequirement.map(req => `${req.apr}:${req.requiredBorrowTokens.join(',')}`).join('; ')}"`
        : '',
      row.merklSupplyApr > 0 ? row.merklSupplyApr : '',
      row.merklBorrowApr > 0 ? row.merklBorrowApr : '',
      row.merklHoldApr > 0 ? row.merklHoldApr : '',
      `"${formatMerklBreakdown(row.merklSupplyAprBreakdowns)}"`,
      `"${formatMerklBreakdown(row.merklBorrowAprBreakdowns)}"`,
      `"${formatMerklBreakdown(row.merklHoldAprBreakdowns)}"`,
      row.brevisSupplyApr !== null ? row.brevisSupplyApr : '',
      row.brevisBorrowApr !== null ? row.brevisBorrowApr : ''
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
  await mkdir('data', { recursive: true });
  
  // 保存原始数据到JSON文件
  const outputPath = join('data', 'aave-all-markets-data.json');
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
    
    // 保存格式化的JSON数据
    const formattedJsonPath = join('data', 'aave-formatted-data.json');
    await writeFile(formattedJsonPath, JSON.stringify(formattedData, null, 2), 'utf-8');
    
    // 生成CSV格式
    const csvData = generateCSV(formattedData);
    const csvPath = join('data', 'aave-formatted-data.csv');
    await writeFile(csvPath, csvData, 'utf-8');
    
    logger.info(`💾 Original data saved to data/aave-all-markets-data.json`);
    logger.info(`📊 Formatted JSON saved to ${formattedJsonPath}`);
    logger.info(`📈 CSV data saved to ${csvPath}`);
    logger.info(`📁 File location: ${process.cwd()}/data/`);
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
      await mkdir('data', { recursive: true });
      const errorPath = join('data', 'aave-all-markets-error.json');
      await writeFile(errorPath, JSON.stringify(errorData, null, 2), 'utf-8');
      logger.info(`💾 Error data saved to ${errorPath}`);
    } catch (writeError) {
      logger.error('❌ Failed to save error data:', writeError);
    }
  }
}

// 执行主函数
fetchAaveMarkets().then(() => {
  logger.info('🏁 Process completed');
}).catch((error) => {
  logger.error('💥 Fatal error:', error);
  process.exit(1);
});

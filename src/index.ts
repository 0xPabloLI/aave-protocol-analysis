import { writeFile } from 'fs/promises';
import { evmAddress, chainId } from "@aave/client";
import { markets } from "@aave/client/actions";
import { client } from "./client.js";
import * as addressBook from "@bgd-labs/aave-address-book";
import fetch from 'node-fetch';

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

interface MerklCampaignBreakdown {
  campaignApr: number;
  campaignEndedAt: string;
  campaignId: string;
}

interface FormattedReserveData {
  marketName: string;
  chainName: string;
  chainId: number;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  supplyApy: string;
  borrowApy: string | null;
  incentiveSupplyApr: string | string[];
  incentiveBorrowApr: string | string[];
  selfIncentiveSupplyApr: string | string[];
  selfIncentiveBorrowApr: string | string[];
  multiple: boolean;
  merklSupplyApr: number;
  merklBorrowApr: number;
  merklSupplyAprBreakdowns: MerklCampaignBreakdown[];
  merklBorrowAprBreakdowns: MerklCampaignBreakdown[];
}

interface MeritAPRResponse {
  previousAPR: any;
  currentAPR: {
    actionsAPR: Record<string, number | null>;
  };
}

interface MerklOpportunity {
  id: string;
  action: string; // "LEND" or "BORROW"
  chainId: number;
  protocol: {
    id: string;
    name: string;
  };
  tokens: Array<{
    address: string;
    symbol: string;
    name: string;
  }>;
  rewardsRecord: {
    breakdowns: Array<{
      campaignId: string;
    }>;
  };
  aprRecord: {
    cumulated: number;
  };
}

interface MerklCampaignDetails {
  id: string;
  apr: number;
  endedAt: string;
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

async function fetchMeritAPRs(): Promise<Record<string, number | null>> {
  try {
    console.log('🎁 Fetching Merit APR data...');
    const response = await fetch('https://apps.aavechan.com/api/merit/aprs');
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json() as MeritAPRResponse;
    console.log(`✅ Merit APR data fetched successfully`);
    
    return data.currentAPR.actionsAPR;
  } catch (error) {
    console.error('❌ Error fetching Merit APR data:', error);
    return {};
  }
}

async function fetchMerklOpportunities(): Promise<MerklOpportunity[]> {
  try {
    console.log('🔄 Fetching Merkl opportunities for Aave...');
    const response = await fetch('https://api.merkl.xyz/v4/opportunities?name=aave');
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const opportunities = await response.json() as MerklOpportunity[];
    console.log(`✅ Found ${opportunities.length} Merkl opportunities`);
    
    return opportunities;
  } catch (error) {
    console.error('❌ Error fetching Merkl opportunities:', error);
    return [];
  }
}

async function fetchMerklCampaignDetails(campaignId: string): Promise<MerklCampaignDetails | null> {
  try {
    const response = await fetch(`https://api.merkl.xyz/v4/campaigns/${campaignId}`);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const campaign = await response.json() as any;
    
    // 将 timestamp 转换为日期字符串
    const endedAt = campaign.endTimestamp ? 
      new Date(campaign.endTimestamp * 1000).toISOString() : 
      '';
    
    return {
      id: campaignId,
      apr: campaign.apr || 0,
      endedAt
    };
  } catch (error) {
    console.error(`❌ Error fetching campaign ${campaignId}:`, error);
    return null;
  }
}

async function processMerklData(): Promise<Map<string, { supply: MerklCampaignBreakdown[], borrow: MerklCampaignBreakdown[] }>> {
  const opportunities = await fetchMerklOpportunities();
  const merklData = new Map<string, { supply: MerklCampaignBreakdown[], borrow: MerklCampaignBreakdown[] }>();
  
  console.log('🔍 Processing Merkl opportunities...');
  
  // 只处理 Aave 协议的机会
  const aaveOpportunities = opportunities.filter(opp => opp.protocol?.id === 'aave');
  console.log(`Filtered to ${aaveOpportunities.length} Aave opportunities (from ${opportunities.length} total)`);
  
  for (const opportunity of aaveOpportunities) {
    // 查找底层代币（通常不是 aToken）
    // 先找到所有符合条件的代币
    const candidateTokens = opportunity.tokens.filter(token => 
      (!token.symbol.startsWith('a') && !token.symbol.startsWith('variableDebt')) ||
      token.symbol === 'AAVE' // AAVE 本身是例外
    );
    
    // 如果没有找到符合条件的代币
    if (candidateTokens.length === 0) {
      console.log(`   ⚠️ No underlying token found for opportunity ${opportunity.id}`);
      continue;
    }
    
    // 如果有多个符合条件的代币，优先选择 USDE
    // 特殊情况：如果同时存在 sUSDE 和 USDR，优先选择 USDE
    let underlyingToken = candidateTokens.find(token => token.symbol === 'USDE');
    
    // 如果没有找到 USDE，使用第一个符合条件的代币
    if (!underlyingToken) {
      underlyingToken = candidateTokens[0];
    }
    
    const key = `${opportunity.chainId}-${underlyingToken.address.toLowerCase()}`;
    
    if (!merklData.has(key)) {
      merklData.set(key, { supply: [], borrow: [] });
    }
    
    const data = merklData.get(key)!;
    
    // 处理每个 campaign
    for (const rewardBreakdown of opportunity.rewardsRecord.breakdowns) {
      console.log(`   Processing campaign ${rewardBreakdown.campaignId}...`);
      const campaignDetails = await fetchMerklCampaignDetails(rewardBreakdown.campaignId);
      
      if (campaignDetails) {
        const breakdown: MerklCampaignBreakdown = {
          campaignApr: opportunity.aprRecord.cumulated, // 使用机会的累计 APR
          campaignEndedAt: campaignDetails.endedAt,
          campaignId: rewardBreakdown.campaignId
        };
        
        if (opportunity.action === 'LEND') {
          data.supply.push(breakdown);
        } else if (opportunity.action === 'BORROW') {
          data.borrow.push(breakdown);
        }
      }
      
      // 添加延迟避免 API 限制
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  
  console.log(`✅ Processed ${merklData.size} unique Merkl token combinations`);
  return merklData;
}

function formatMarketData(markets: any[], meritAPRs: Record<string, number | null>, merklData: Map<string, { supply: MerklCampaignBreakdown[], borrow: MerklCampaignBreakdown[] }>): FormattedReserveData[] {
  console.log('📊 Creating base dataset from Aave markets...');
  
  // 第一步：从 Aave 市场数据创建基础数据集
  const baseDataset = createBaseDatasetFromMarkets(markets);
  console.log(`✅ Created base dataset with ${baseDataset.length} token combinations`);
  
  // 第二步：建立 Merit APR 数据索引
  console.log('🔍 Indexing Merit APR data...');
  const meritIndex = createMeritIndex(meritAPRs);
  console.log(`✅ Indexed Merit data for ${meritIndex.size} chain-token combinations`);
  
  // 第三步：将 Merit 数据填充到基础数据集中
  console.log('💾 Filling Merit data into base dataset...');
  const filledDataset = fillMeritDataIntoBase(baseDataset, meritIndex, merklData);
  
  // 第四步：添加 Merit 中存在但基础数据集中没有的新 token 组合
  console.log('➕ Adding missing tokens from Merit...');
  const finalDataset = addMissingTokensFromMerit(filledDataset, meritIndex, merklData);
  
  console.log(`🎯 Final dataset contains ${finalDataset.length} token combinations`);
  return finalDataset;
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
        const tokenSymbol = reserve.underlyingToken?.symbol || 'Unknown';
        const tokenAddress = reserve.underlyingToken?.address || '';
        
        // 创建完整的结构化数据，包含所有激励字段
        baseDataset.push({
          marketName,
          chainName,
          chainId,
          tokenName: reserve.underlyingToken?.name || 'Unknown',
          tokenSymbol,
          tokenAddress,
          supplyApy: reserve.supplyInfo?.apy?.formatted || reserve.supplyInfo?.apy?.value || '0',
          borrowApy: reserve.borrowInfo?.apy?.formatted || reserve.borrowInfo?.apy?.value || null,
          // Merit APR 激励字段 - 初始化为空
          incentiveSupplyApr: '0',
          incentiveBorrowApr: '0',
          selfIncentiveSupplyApr: '0',
          selfIncentiveBorrowApr: '0',
          multiple: false,
          // Merkl APR 激励字段 - 初始化为空
          merklSupplyApr: 0,
          merklBorrowApr: 0,
          merklSupplyAprBreakdowns: [],
          merklBorrowAprBreakdowns: []
        });
      });
    }
  });

  return baseDataset;
}

// 解析链名，处理特殊情况如 ethereum-prime
function parseChainKey(parts: string[]): string {
  // 注意：传入的 parts 已经移除了 self- 前缀
  if (parts.length >= 2 && parts[0] === 'ethereum' && parts[1] === 'prime') {
    // ethereum-prime 格式：ethereum-prime-action-token
    return 'ethereum-prime';
  } else {
    // 标准格式：chain-action-token
    return parts[0];
  }
}

// 建立 Merit APR 数据索引
function createMeritIndex(meritAPRs: Record<string, number | null>): Map<string, {
  incentiveSupplyApr: string[];
  incentiveBorrowApr: string[];
  selfIncentiveSupplyApr: string[];
  selfIncentiveBorrowApr: string[];
  multiple: boolean;
}> {
  const meritIndex = new Map<string, {
    incentiveSupplyApr: string[];
    incentiveBorrowApr: string[];
    selfIncentiveSupplyApr: string[];
    selfIncentiveBorrowApr: string[];
    multiple: boolean;
  }>();

  // 创建索引条目的辅助函数
  function createIndexEntry(indexKey: string) {
    if (!meritIndex.has(indexKey)) {
      meritIndex.set(indexKey, {
        incentiveSupplyApr: [],
        incentiveBorrowApr: [],
        selfIncentiveSupplyApr: [],
        selfIncentiveBorrowApr: [],
        multiple: false
      });
    }
    return meritIndex.get(indexKey)!;
  }

  // 处理代币的辅助函数
  function processToken(
    key: string, 
    parts: string[], 
    tokenSymbol: string, 
    chainKey: string, 
    value: number | null,
    processor: (key: string, parts: string[], tokenSymbol: string, incentives: any, aprValue: string, isSelfFormat?: boolean) => void,
    isSelfFormat: boolean = false
  ) {
    const indexKey = `${chainKey.toLowerCase()}-${tokenSymbol.toLowerCase()}`;
    const incentives = createIndexEntry(indexKey);
    
    if (value !== null) {
      const aprValue = value.toString();
      processor(key, parts, tokenSymbol, incentives, aprValue, isSelfFormat);
    }
  }

  // 处理 supply/borrow 代币对的辅助函数
  function processTokenPair(
    key: string,
    parts: string[],
    supplyToken: string,
    borrowToken: string,
    chainKey: string,
    value: number | null,
    processor: (key: string, parts: string[], tokenSymbol: string, incentives: any, aprValue: string, isSelfFormat?: boolean) => void,
    isSelfFormat: boolean = false
  ) {
    // 处理 supply 代币
    if (supplyToken && supplyToken !== 'multiple') {
      processToken(key, parts, supplyToken, chainKey, value, processor, isSelfFormat);
    }
    
    // 处理 borrow 代币
    if (borrowToken && borrowToken !== 'multiple') {
      processToken(key, parts, borrowToken, chainKey, value, processor, isSelfFormat);
    }
    
    // 处理 multiple 代币（如果存在）
    if (supplyToken === 'multiple' || borrowToken === 'multiple') {
      processToken(key, parts, 'multiple', chainKey, value, processor, isSelfFormat);
    }
  }

  Object.entries(meritAPRs).forEach(([key, value]) => {
    const parts = key.split('-');
    if (parts.length < 2) return;
    
    // 检查是否为 self- 格式
    const isSelfFormat = key.startsWith('self-');
    const actualKey = isSelfFormat ? key.substring(5) : key; // 移除 self- 前缀
    const actualParts = actualKey.split('-');
    
    if (actualParts.length < 2) return;
    
    // 解析链名
    let chainKey = parseChainKey(actualParts);
    
    // 选择处理器（根据实际格式类型选择，self- 格式会写入 selfIncentive 字段）
    const processor = actualKey.includes('prime') ? processPrimeIncentive :
                     actualKey.includes('-multiple-') ? processMultipleIncentive :
                     actualKey.includes('-supply-') && actualKey.includes('-borrow-') ? processComplexIncentive :
                     processSimpleIncentive;
    
    // 处理 prime 格式
    if (actualKey.includes('prime')) {
      const tokenSymbol = actualParts[actualParts.length - 1];
      processToken(key, parts, tokenSymbol, chainKey, value, processor, isSelfFormat);
      return;
    }
    
    // 处理 multiple 格式
    if (actualKey.includes('multiple')) {
      const supplyIndex = actualParts.indexOf('supply');
      const borrowIndex = actualParts.indexOf('borrow');
      
      if (supplyIndex >= 0 && borrowIndex >= 0) {
        const supplyToken = actualParts.slice(supplyIndex + 1, borrowIndex).join('-').toLowerCase();
        const borrowToken = actualParts.slice(borrowIndex + 1).join('-').toLowerCase();
        
        processTokenPair(key, parts, supplyToken, borrowToken, chainKey, value, processor, isSelfFormat);
      }
      return;
    }
    
    // 处理复杂格式
    if (actualKey.includes('-supply-') && actualKey.includes('-borrow-')) {
      const supplyIndex = actualParts.indexOf('supply');
      const borrowIndex = actualParts.indexOf('borrow');
      
      if (supplyIndex >= 0 && borrowIndex >= 0) {
        const supplyToken = actualParts.slice(supplyIndex + 1, borrowIndex).join('-').toLowerCase();
        const borrowToken = actualParts.slice(borrowIndex + 1).join('-').toLowerCase();
        
        processTokenPair(key, parts, supplyToken, borrowToken, chainKey, value, processor, isSelfFormat);
      }
      return;
    }
    
    // 处理简单格式
    let tokenSymbol = '';
    if (actualKey.includes('-supply-') || actualKey.includes('-borrow-') || actualParts.length === 2) {
      tokenSymbol = actualParts[actualParts.length - 1];
    }
    
    if (tokenSymbol) {
      processToken(key, parts, tokenSymbol, chainKey, value, processor, isSelfFormat);
    }
  });

  return meritIndex;
}

// 将 Merit 数据填充到基础数据集中
function fillMeritDataIntoBase(
  baseDataset: FormattedReserveData[],
  meritIndex: Map<string, {
    incentiveSupplyApr: string[];
    incentiveBorrowApr: string[];
    selfIncentiveSupplyApr: string[];
    selfIncentiveBorrowApr: string[];
    multiple: boolean;
  }>,
  merklData: Map<string, { supply: MerklCampaignBreakdown[], borrow: MerklCampaignBreakdown[] }>
): FormattedReserveData[] {
  return baseDataset.map(item => {
    const indexKey = `${item.chainName.toLowerCase()}-${item.tokenSymbol.toLowerCase()}`;
    const meritData = meritIndex.get(indexKey);
    
    // 如果有 Merit 数据，直接更新对应字段
    if (meritData) {
      item.incentiveSupplyApr = formatIncentiveArray(meritData.incentiveSupplyApr);
      item.incentiveBorrowApr = formatIncentiveArray(meritData.incentiveBorrowApr);
      item.selfIncentiveSupplyApr = formatIncentiveArray(meritData.selfIncentiveSupplyApr);
      item.selfIncentiveBorrowApr = formatIncentiveArray(meritData.selfIncentiveBorrowApr);
      item.multiple = meritData.multiple;
    }
    
    // 获取对应的 Merkl 数据并更新
    const merklInfo = merklData.get(`${item.chainId}-${item.tokenAddress.toLowerCase()}`);
    if (merklInfo) {
      item.merklSupplyApr = merklInfo.supply.reduce((sum, breakdown) => sum + breakdown.campaignApr, 0);
      item.merklBorrowApr = merklInfo.borrow.reduce((sum, breakdown) => sum + breakdown.campaignApr, 0);
      item.merklSupplyAprBreakdowns = merklInfo.supply;
      item.merklBorrowAprBreakdowns = merklInfo.borrow;
    }
    
    return item;
  });
}

// 添加 Merit 中存在但基础数据集中没有的新 token 组合
function addMissingTokensFromMerit(
  filledDataset: FormattedReserveData[],
  meritIndex: Map<string, {
    incentiveSupplyApr: string[];
    incentiveBorrowApr: string[];
    selfIncentiveSupplyApr: string[];
    selfIncentiveBorrowApr: string[];
    multiple: boolean;
  }>,
  merklData: Map<string, { supply: MerklCampaignBreakdown[], borrow: MerklCampaignBreakdown[] }>
): FormattedReserveData[] {
  const chainMap: Record<string, number> = {
    'ethereum': 1,
    'avalanche': 43114,
    'base': 8453,
    'celo': 42220,
    'gnosis': 100,
    'arbitrum': 42161,
    'polygon': 137,
    'optimism': 10,
    'sonic': 146
  };

  const existingTokens = new Set(
    filledDataset.map(item => `${item.chainName.toLowerCase()}-${item.tokenSymbol.toLowerCase()}`)
  );

  const missingTokens: FormattedReserveData[] = [];

  meritIndex.forEach((meritData, indexKey) => {
    if (!existingTokens.has(indexKey)) {
      const [chainKey, tokenSymbol] = indexKey.split('-');
      const chainId = chainMap[chainKey];
      
      if (chainId) {
        const chainName = chainKey.charAt(0).toUpperCase() + chainKey.slice(1);
        
        // 直接创建完整的结构化数据
        missingTokens.push({
          marketName: `AaveV3${chainName}`,
          chainName,
          chainId,
          tokenName: tokenSymbol.toUpperCase(),
          tokenSymbol: tokenSymbol.toUpperCase(),
          tokenAddress: '0x0000000000000000000000000000000000000000', // 占位地址
          supplyApy: '0',
          borrowApy: null,
          // Merit APR 激励字段
          incentiveSupplyApr: formatIncentiveArray(meritData.incentiveSupplyApr),
          incentiveBorrowApr: formatIncentiveArray(meritData.incentiveBorrowApr),
          selfIncentiveSupplyApr: formatIncentiveArray(meritData.selfIncentiveSupplyApr),
          selfIncentiveBorrowApr: formatIncentiveArray(meritData.selfIncentiveBorrowApr),
          multiple: meritData.multiple,
          // Merkl APR 激励字段 - 初始化为空
          merklSupplyApr: 0,
          merklBorrowApr: 0,
          merklSupplyAprBreakdowns: [],
          merklBorrowAprBreakdowns: []
        });
      }
    }
  });

  console.log(`🔍 Found ${missingTokens.length} missing tokens from Merit APR`);
  if (missingTokens.length > 0) {
    console.log('Missing tokens:', missingTokens.map(t => `${t.chainName} ${t.tokenSymbol}`).join(', '));
  }

  return [...filledDataset, ...missingTokens];
}

// 辅助函数：根据 isSelfFormat 添加 APR 值
function addAprValue(incentives: any, aprValue: string, isSupply: boolean, isSelfFormat: boolean) {
  if (isSupply) {
    if (isSelfFormat) {
      incentives.selfIncentiveSupplyApr.push(aprValue);
    } else {
      incentives.incentiveSupplyApr.push(aprValue);
    }
  } else {
    if (isSelfFormat) {
      incentives.selfIncentiveBorrowApr.push(aprValue);
    } else {
      incentives.incentiveBorrowApr.push(aprValue);
    }
  }
}

// 处理 prime 激励 (ethereum-prime-supply-weth)
function processPrimeIncentive(key: string, parts: string[], tokenSymbol: string, incentives: any, aprValue: string, isSelfFormat: boolean = false) {
  // ethereum-prime-supply-weth → parts = ['ethereum', 'prime', 'supply', 'weth']
  // 需要从 index 3 开始获取代币符号
  if (matchesToken(parts.slice(3), tokenSymbol.toLowerCase())) {
    if (key.includes('-supply-')) {
      addAprValue(incentives, aprValue, true, isSelfFormat);
    } else if (key.includes('-borrow-')) {
      addAprValue(incentives, aprValue, false, isSelfFormat);
    }
  }
}

// 处理复杂激励 (supply-token-borrow-token)
// 例如: ethereum-supply-ebtc-borrow-wbtc-or-cbbtc
// 或: chain-supply-token1-or-token2-borrow-token3-or-token4
function processComplexIncentive(key: string, parts: string[], tokenSymbol: string, incentives: any, aprValue: string, isSelfFormat: boolean = false) {
  // 注意：这里假设了 supply 和 borrow 是小写
  const supplyIndex = parts.indexOf('supply');
  const borrowIndex = parts.indexOf('borrow');
  
  if (supplyIndex >= 0 && borrowIndex >= 0) {
    // 提取 supply 和 borrow 之间的代币符号（可能包含 or 连接的多个代币）
    const supplyTokenParts = parts.slice(supplyIndex + 1, borrowIndex);
    const supplyToken = supplyTokenParts.join('-').toLowerCase();
    
    // 提取 borrow 之后的代币符号（可能包含 or 连接的多个代币）
    const borrowTokenParts = parts.slice(borrowIndex + 1);
    const borrowToken = borrowTokenParts.join('-').toLowerCase();
    
    // 检查是否匹配 supply 代币
    // 对于 token1-or-token2 这种情况，需要检查代币是否在 or 分隔的列表中
    if (supplyToken === tokenSymbol.toLowerCase()) {
      addAprValue(incentives, aprValue, true, isSelfFormat);
    } else if (supplyToken.includes('-or-')) {
      // 处理 supply 的 or 连接情况
      const orTokens = supplyToken.split('-or-');
      if (orTokens.some(t => t === tokenSymbol.toLowerCase())) {
        addAprValue(incentives, aprValue, true, isSelfFormat);
      }
    }
    
    // 检查是否匹配 borrow 代币
    // 对于 wbtc-or-cbbtc 这种情况，需要检查代币是否在 or 分隔的列表中
    if (borrowToken === tokenSymbol.toLowerCase()) {
      addAprValue(incentives, aprValue, false, isSelfFormat);
    } else if (borrowToken.includes('-or-')) {
      // 处理 borrow 的 or 连接情况
      const orTokens = borrowToken.split('-or-');
      if (orTokens.some(t => t === tokenSymbol.toLowerCase())) {
        addAprValue(incentives, aprValue, false, isSelfFormat);
      }
    }
  }
}

// 处理 multiple 激励
// 例如: base-supply-cbbtc-borrow-multiple (cbbtc supply, 多个代币可以 borrow)
// 或: celo-supply-multiple-borrow-usdt (多个代币可以 supply, usdt borrow)
function processMultipleIncentive(key: string, parts: string[], tokenSymbol: string, incentives: any, aprValue: string, isSelfFormat: boolean = false) {
  incentives.multiple = true;
  
  const supplyIndex = parts.indexOf('supply');
  const borrowIndex = parts.indexOf('borrow');
  const multipleIndex = parts.indexOf('multiple');
  
  if (supplyIndex >= 0 && borrowIndex >= 0 && multipleIndex >= 0) {
    // 提取 supply 和 borrow 之间的代币符号
    const supplyTokenParts = parts.slice(supplyIndex + 1, borrowIndex);
    const supplyToken = supplyTokenParts.join('-').toLowerCase();
    
    // 提取 borrow 之后的代币符号
    const borrowTokenParts = parts.slice(borrowIndex + 1);
    const borrowToken = borrowTokenParts.join('-').toLowerCase();
    
    // 判断 multiple 在哪一侧
    if (supplyToken === 'multiple') {
      // supply-multiple-borrow-usdt: 多个代币可以 supply, usdt borrow
      // 给所有代币添加 supply APR（匹配任何代币）
      addAprValue(incentives, aprValue, true, isSelfFormat);
      
      // 检查是否是 borrow 的代币（可能包含 or 连接）
      if (borrowToken === tokenSymbol.toLowerCase()) {
        addAprValue(incentives, aprValue, false, isSelfFormat);
      } else if (borrowToken.includes('-or-')) {
        const orTokens = borrowToken.split('-or-');
        if (orTokens.some(t => t === tokenSymbol.toLowerCase())) {
          addAprValue(incentives, aprValue, false, isSelfFormat);
        }
      }
    } else if (borrowToken === 'multiple') {
      // supply-cbbtc-borrow-multiple: cbbtc supply, 多个代币可以 borrow
      // 检查是否是 supply 的代币（可能包含 or 连接）
      if (supplyToken === tokenSymbol.toLowerCase()) {
        addAprValue(incentives, aprValue, true, isSelfFormat);
      } else if (supplyToken.includes('-or-')) {
        const orTokens = supplyToken.split('-or-');
        if (orTokens.some(t => t === tokenSymbol.toLowerCase())) {
          addAprValue(incentives, aprValue, true, isSelfFormat);
        }
      }
      
      // 给所有代币添加 borrow APR（匹配任何代币）
      addAprValue(incentives, aprValue, false, isSelfFormat);
    }
  }
}

// 处理简单激励 (ethereum-supply-rlusd 或 ethereum-sgho)
function processSimpleIncentive(key: string, parts: string[], tokenSymbol: string, incentives: any, aprValue: string, isSelfFormat: boolean = false) {
  if (key.includes('-supply-') || key.includes('-borrow-')) {
    // ethereum-supply-rlusd → parts = ['ethereum', 'supply', 'rlusd']
    // 需要从 index 2 开始获取代币符号
    if (matchesToken(parts.slice(2), tokenSymbol.toLowerCase())) {
      if (key.includes('-supply-')) {
        addAprValue(incentives, aprValue, true, isSelfFormat);
      } else {
        addAprValue(incentives, aprValue, false, isSelfFormat);
      }
    }
  } else if (parts.length === 2 && matchesToken([parts[1]], tokenSymbol.toLowerCase())) {
    // 简单格式: ethereum-sgho → parts = ['ethereum', 'sgho']
    addAprValue(incentives, aprValue, true, isSelfFormat);
  }
}

// 创建格式化的储备数据（保留作为备用函数）
function createFormattedReserve(data: any): FormattedReserveData {
  const { incentives, merklInfo } = data;
  const merklSupplyApr = merklInfo.supply.reduce((sum: number, breakdown: any) => sum + breakdown.campaignApr, 0);
  const merklBorrowApr = merklInfo.borrow.reduce((sum: number, breakdown: any) => sum + breakdown.campaignApr, 0);

  return {
    marketName: data.marketName,
    chainName: data.chainName,
    chainId: data.chainId,
    tokenName: data.tokenName,
    tokenSymbol: data.tokenSymbol,
    tokenAddress: data.tokenAddress,
    supplyApy: data.supplyApy,
    borrowApy: data.borrowApy,
    incentiveSupplyApr: formatIncentiveArray(incentives.incentiveSupplyApr),
    incentiveBorrowApr: formatIncentiveArray(incentives.incentiveBorrowApr),
    selfIncentiveSupplyApr: formatIncentiveArray(incentives.selfIncentiveSupplyApr),
    selfIncentiveBorrowApr: formatIncentiveArray(incentives.selfIncentiveBorrowApr),
    multiple: incentives.multiple,
    merklSupplyApr,
    merklBorrowApr,
    merklSupplyAprBreakdowns: merklInfo.supply,
    merklBorrowAprBreakdowns: merklInfo.borrow
  };
}

// 格式化激励数组
function formatIncentiveArray(incentives: string[]): string | string[] {
  if (incentives.length === 0) return '0';
  return incentives.length === 1 ? incentives[0] : incentives;
}

// 查找 Merit APR 中存在但市场中没有的代币
function findMissingTokensFromMerit(meritAPRs: Record<string, number | null>, processedTokens: Set<string>) {
  const missingTokens: Array<{chainName: string, chainId: number, tokenSymbol: string, tokenName: string}> = [];
  const chainMap: Record<string, number> = {
    'ethereum': 1,
    'ethereum-prime': 1, // ethereum-prime 使用相同的链ID
    'avalanche': 43114,
    'base': 8453,
    'celo': 42220,
    'gnosis': 100,
    'arbitrum': 42161,
    'polygon': 137,
    'optimism': 10,
    'sonic': 146
  };

  Object.entries(meritAPRs).forEach(([key, value]) => {
    // 即使 value 为 null，我们也要处理键来查找缺失的代币
    
    const parts = key.split('-');
    if (parts.length < 2) return;
    
    let chainKey = parseChainKey(parts);
    
    const chainId = chainMap[chainKey];
    if (!chainId) return;
    
    // 提取代币符号
    let tokenSymbol = '';
    if (key.includes('-supply-') && key.includes('-borrow-')) {
      // 复杂格式，需要处理两个代币
      const supplyTokenIndex = parts.indexOf('supply') + 1;
      const borrowTokenIndex = parts.indexOf('borrow') + 1;
      
      // 处理 supply 代币
      if (supplyTokenIndex < parts.length) {
        tokenSymbol = parts[supplyTokenIndex];
        const tokenKey = `${chainKey.toLowerCase()}-${tokenSymbol.toLowerCase()}`;
        if (!processedTokens.has(tokenKey)) {
          missingTokens.push({
            chainName: chainKey,
            chainId: chainId,
            tokenSymbol: tokenSymbol,
            tokenName: tokenSymbol
          });
        }
      }
      
      // 处理 borrow 代币
      if (borrowTokenIndex < parts.length) {
        tokenSymbol = parts[borrowTokenIndex];
        const tokenKey = `${chainKey.toLowerCase()}-${tokenSymbol.toLowerCase()}`;
        if (!processedTokens.has(tokenKey)) {
          missingTokens.push({
            chainName: chainKey,
            chainId: chainId,
            tokenSymbol: tokenSymbol,
            tokenName: tokenSymbol
          });
        }
      }
      
      // 复杂格式处理完毕，直接返回
      return;
    } else if (key.includes('-supply-') || key.includes('-borrow-')) {
      tokenSymbol = parts[parts.length - 1];
    } else if (parts.length === 2) {
      tokenSymbol = parts[1];
    } else if (key.startsWith('self-') && parts.length === 3) {
      tokenSymbol = parts[2];
    } else {
      return;
    }
    
    const tokenKey = `${chainId}-${tokenSymbol.toLowerCase()}`;
    if (!processedTokens.has(tokenKey)) {
      // 检查是否已经添加了这个代币
      const alreadyAdded = missingTokens.some(t => 
        t.chainId === chainId && t.tokenSymbol.toLowerCase() === tokenSymbol.toLowerCase()
      );
      
      if (!alreadyAdded) {
        missingTokens.push({
          chainName: chainKey.charAt(0).toUpperCase() + chainKey.slice(1),
          chainId,
          tokenSymbol: tokenSymbol.toUpperCase(),
          tokenName: tokenSymbol.toUpperCase() // 使用符号作为名称
        });
      }
    }
  });

  return missingTokens;
}

function matchesChain(parts: string[], chainKey: string): boolean {
  if (parts[0] === 'self') {
    return parts[1] === chainKey;
  }
  return parts[0] === chainKey;
}

function matchesToken(parts: string[], tokenSymbol: string): boolean {
  const lastPart = parts[parts.length - 1];
  const normalizedToken = tokenSymbol.toLowerCase();
  
  // 直接匹配
  if (lastPart === normalizedToken) {
    return true;
  }
  
  // 特殊映射（只保留必要的）
  const tokenAliases: Record<string, string[]> = {
    'usdt': ['usd₮', 'usdt0', 'usd₮0'],
    'usdc': ['usdce', 'usdc.e'],
    'btcb': ['btc.b'],
    'wbtc': ['wbtc.e'],
    'weth': ['weth.e'],
    'sgho': ['gho'],
    'stkgho': ['gho'],
    'eth': ['weth']
  };
  
  // 通过别名匹配
  for (const [key, aliases] of Object.entries(tokenAliases)) {
    if (lastPart === key && aliases.includes(normalizedToken)) {
      return true;
    }
    if (aliases.includes(lastPart) && key === normalizedToken) {
      return true;
    }
  }
  
  return false;
}

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
    'Incentive Supply APR (%)',
    'Incentive Borrow APR (%)',
    'Self Incentive Supply APR (%)',
    'Self Incentive Borrow APR (%)',
    'Multiple',
    'Merkl Supply APR (%)',
    'Merkl Borrow APR (%)',
    'Merkl Supply Campaigns',
    'Merkl Borrow Campaigns'
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
      Array.isArray(row.incentiveSupplyApr) ? `"${row.incentiveSupplyApr.join(';')}"` : row.incentiveSupplyApr,
      Array.isArray(row.incentiveBorrowApr) ? `"${row.incentiveBorrowApr.join(';')}"` : row.incentiveBorrowApr,
      Array.isArray(row.selfIncentiveSupplyApr) ? `"${row.selfIncentiveSupplyApr.join(';')}"` : row.selfIncentiveSupplyApr,
      Array.isArray(row.selfIncentiveBorrowApr) ? `"${row.selfIncentiveBorrowApr.join(';')}"` : row.selfIncentiveBorrowApr,
      row.multiple.toString(),
      row.merklSupplyApr.toString(),
      row.merklBorrowApr.toString(),
      `"${row.merklSupplyAprBreakdowns.map(b => `${b.campaignApr}% (${b.campaignId})`).join('; ')}"`,
      `"${row.merklBorrowAprBreakdowns.map(b => `${b.campaignApr}% (${b.campaignId})`).join('; ')}"`
    ].join(','))
  ];

  return csvRows.join('\n');
}

async function fetchAaveMarkets(): Promise<void> {
  try {
    console.log('🔄 Fetching Aave markets data from all networks...');
    
    // 获取所有 AaveV3 网络信息
    const networkInfo = getAllAaveV3Networks();
    const chainIds = [...new Set(networkInfo.map(info => info.chainId))]; // 去重
    
    console.log(`🌐 Found ${networkInfo.length} AaveV3 networks across ${chainIds.length} unique chains`);
    console.log('📋 Networks:');
    networkInfo.forEach(info => {
      console.log(`   • ${info.name} (Chain ID: ${info.chainId})`);
    });
    
    console.log('\n🚀 Fetching markets data...');
    
    let allMarkets: any[] = [];
    let supportedChainIds: number[] = [];
    let errors: string[] = [];
    
    // 逐个尝试每个链ID
    for (const chainIdValue of chainIds) {
      try {
        console.log(`   Trying Chain ID: ${chainIdValue}`);
        const result = await markets(client, {
          chainIds: [chainId(chainIdValue)],
        });
        
        if (result && typeof result === 'object' && 'value' in result && result.value.length > 0) {
          allMarkets.push(...result.value);
          supportedChainIds.push(chainIdValue);
          console.log(`   ✅ Chain ${chainIdValue}: Found ${result.value.length} markets`);
        } else if (result && Array.isArray(result) && result.length > 0) {
          allMarkets.push(...result);
          supportedChainIds.push(chainIdValue);
          console.log(`   ✅ Chain ${chainIdValue}: Found ${result.length} markets`);
        } else {
          console.log(`   ⚠️ Chain ${chainIdValue}: No markets found`);
        }
      } catch (error) {
        const errorMsg = `Chain ${chainIdValue}: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(errorMsg);
        console.log(`   ❌ Chain ${chainIdValue}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const marketData: MarketData = {
      timestamp: new Date().toISOString(),
      totalNetworks: networkInfo.length,
      chainIds: supportedChainIds,
      networkInfo: networkInfo.filter(info => supportedChainIds.includes(info.chainId)),
      markets: allMarkets,
      errors: errors,
    };

    console.log(`\n✅ Successfully fetched markets data`);
    console.log(`📊 Found ${allMarkets.length} markets total from ${supportedChainIds.length} chains`);
    
    if (errors.length > 0) {
      console.log(`⚠️ ${errors.length} chains had errors or no data`);
    }
    
    // 按链分组统计
    const marketsByChain = allMarkets.reduce((acc: Record<number, any[]>, market) => {
      const chainId = market.chain?.chainId || 0;
      if (!acc[chainId]) acc[chainId] = [];
      acc[chainId].push(market);
      return acc;
    }, {});
    
    console.log('\n📋 Markets by Chain:');
    Object.entries(marketsByChain).forEach(([chainIdStr, chainMarkets]) => {
      const chainId = parseInt(chainIdStr);
      const networkNames = marketData.networkInfo
        .filter(info => info.chainId === chainId)
        .map(info => info.name.replace('AaveV3', ''))
        .join(', ');
      
      console.log(`   Chain ${chainId} (${networkNames}): ${chainMarkets.length} markets`);
      chainMarkets.forEach((market, index) => {
        console.log(`     ${index + 1}. ${market.name || 'Unknown'} - ${market.address || 'Unknown'}`);
        console.log(`        Market Size: ${market.totalMarketSize || 'N/A'}`);
        console.log(`        Liquidity: ${market.totalAvailableLiquidity || 'N/A'}`);
        console.log(`        Reserves: ${market.supplyReserves?.length || 0} supply, ${market.borrowReserves?.length || 0} borrow`);
      });
      console.log('');
    });

    // 保存原始数据到JSON文件
    const outputPath = 'aave-all-markets-data.json';
    await writeFile(outputPath, JSON.stringify(marketData, null, 2), 'utf-8');
    
    // 获取 Merit APR 数据
    const meritAPRs = await fetchMeritAPRs();
    
    // 获取 Merkl 数据
    const merklData = await processMerklData();
    
    // 格式化数据并保存到新文件
    console.log('\n📊 Formatting market data...');
    const formattedData = formatMarketData(allMarkets, meritAPRs, merklData);
    
    // 保存格式化的JSON数据
    const formattedJsonPath = 'aave-formatted-data.json';
    await writeFile(formattedJsonPath, JSON.stringify(formattedData, null, 2), 'utf-8');
    
    // 生成CSV格式
    const csvData = generateCSV(formattedData);
    const csvPath = 'aave-formatted-data.csv';
    await writeFile(csvPath, csvData, 'utf-8');
    
    console.log(`💾 Original data saved to ${outputPath}`);
    console.log(`📊 Formatted JSON saved to ${formattedJsonPath}`);
    console.log(`📈 CSV data saved to ${csvPath}`);
    console.log(`📁 File location: ${process.cwd()}/`);
    console.log(`📈 Total markets: ${marketData.markets.length}`);
    console.log(`🪙 Total reserves: ${formattedData.length}`);
    console.log(`🌐 Networks discovered: ${networkInfo.length}`);
    console.log(`✅ Supported networks: ${marketData.networkInfo.length}`);
    console.log(`⛓️ Supported chains: ${marketData.chainIds.length}`);
    if (errors.length > 0) {
      console.log(`❌ Failed chains: ${errors.length}`);
    }
    
  } catch (error) {
    console.error('💥 Unexpected error:', error);
    
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
      await writeFile('aave-all-markets-error.json', JSON.stringify(errorData, null, 2), 'utf-8');
      console.log('💾 Error data saved to aave-all-markets-error.json');
    } catch (writeError) {
      console.error('❌ Failed to save error data:', writeError);
    }
  }
}

// 执行主函数
fetchAaveMarkets().then(() => {
  console.log('🏁 Process completed');
}).catch((error) => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});

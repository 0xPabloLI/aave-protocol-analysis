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
    
    const data: MeritAPRResponse = await response.json();
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
    
    const opportunities: MerklOpportunity[] = await response.json();
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
    
    const campaign = await response.json();
    
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
  
  // Process all opportunities instead of limiting to 5
  console.log(`Processing ${opportunities.length} opportunities`);
  
  for (const opportunity of opportunities) {
    // 查找底层代币（通常不是 aToken）
    const underlyingToken = opportunity.tokens.find(token => 
      !token.symbol.startsWith('a') || 
      token.symbol === 'AAVE' // AAVE 本身是例外
    );
    
    if (!underlyingToken) {
      console.log(`   ⚠️ No underlying token found for opportunity ${opportunity.id}`);
      continue;
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
  const formattedData: FormattedReserveData[] = [];

  markets.forEach(market => {
    const marketName = market.name || 'Unknown';
    const chainName = market.chain?.name || 'Unknown';
    const chainId = market.chain?.chainId || 0;

    // 处理供应储备
    if (market.supplyReserves && Array.isArray(market.supplyReserves)) {
      market.supplyReserves.forEach((reserve: any) => {
        const tokenSymbol = reserve.underlyingToken?.symbol || 'Unknown';
        
        // 初始化激励数据
        const incentives = {
          incentiveSupplyApr: [] as string[],
          incentiveBorrowApr: [] as string[],
          selfIncentiveSupplyApr: [] as string[],
          selfIncentiveBorrowApr: [] as string[],
          multiple: false
        };

        // 匹配 Merit APR 数据
        const chainKey = getChainKey(chainName);
        if (chainKey) {
          // 匹配不同类型的激励
          Object.entries(meritAPRs).forEach(([key, value]) => {
            if (value === null) return;
            
            const aprValue = value.toString();
            
            // 解析 key 格式：chain-action-token 或 self-chain-action-token
            const parts = key.split('-');
            
            if (parts.length >= 3) {
              const isChainMatch = matchesChain(parts, chainKey);
              const isTokenMatch = matchesToken(parts, tokenSymbol.toLowerCase());
              
              if (isChainMatch && isTokenMatch) {
                if (key.startsWith('self-')) {
                  // self 类型激励
                  if (key.includes('-supply-')) {
                    incentives.selfIncentiveSupplyApr.push(aprValue);
                  } else if (key.includes('-borrow-')) {
                    incentives.selfIncentiveBorrowApr.push(aprValue);
                  }
                } else if (key.includes('-multiple-')) {
                  // multiple 类型激励
                  incentives.multiple = true;
                  
                  // 解析 multiple 激励的具体类型
                  // 格式如: celo-supply-multiple-borrow-usdt
                  const multipleMatch = key.match(/-multiple-(supply|borrow)-/);
                  if (multipleMatch) {
                    const actionType = multipleMatch[1];
                    if (actionType === 'supply') {
                      incentives.incentiveSupplyApr.push(aprValue);
                    } else if (actionType === 'borrow') {
                      incentives.incentiveBorrowApr.push(aprValue);
                    }
                  } else if (key.includes('-supply-multiple-')) {
                    incentives.incentiveSupplyApr.push(aprValue);
                  } else if (key.includes('-borrow-multiple-')) {
                    incentives.incentiveBorrowApr.push(aprValue);
                  }
                } else {
                  // 普通激励
                  if (key.includes('-supply-')) {
                    incentives.incentiveSupplyApr.push(aprValue);
                  } else if (key.includes('-borrow-')) {
                    incentives.incentiveBorrowApr.push(aprValue);
                  }
                }
              }
            }
          });
        }

        // 查找 Merkl 数据
        const tokenAddress = reserve.underlyingToken?.address || '';
        const merklKey = `${chainId}-${tokenAddress.toLowerCase()}`;
        const merklInfo = merklData.get(merklKey) || { supply: [], borrow: [] };
        
        // 计算总的 Merkl APR
        const merklSupplyApr = merklInfo.supply.reduce((sum, breakdown) => sum + breakdown.campaignApr, 0);
        const merklBorrowApr = merklInfo.borrow.reduce((sum, breakdown) => sum + breakdown.campaignApr, 0);

        formattedData.push({
          marketName,
          chainName,
          chainId,
          tokenName: reserve.underlyingToken?.name || 'Unknown',
          tokenSymbol,
          tokenAddress,
          supplyApy: reserve.supplyInfo?.apy?.formatted || reserve.supplyInfo?.apy?.value || '0',
          borrowApy: reserve.borrowInfo?.apy?.formatted || reserve.borrowInfo?.apy?.value || null,
          incentiveSupplyApr: incentives.incentiveSupplyApr.length === 0 ? '0' : 
            incentives.incentiveSupplyApr.length === 1 ? incentives.incentiveSupplyApr[0] : incentives.incentiveSupplyApr,
          incentiveBorrowApr: incentives.incentiveBorrowApr.length === 0 ? '0' : 
            incentives.incentiveBorrowApr.length === 1 ? incentives.incentiveBorrowApr[0] : incentives.incentiveBorrowApr,
          selfIncentiveSupplyApr: incentives.selfIncentiveSupplyApr.length === 0 ? '0' : 
            incentives.selfIncentiveSupplyApr.length === 1 ? incentives.selfIncentiveSupplyApr[0] : incentives.selfIncentiveSupplyApr,
          selfIncentiveBorrowApr: incentives.selfIncentiveBorrowApr.length === 0 ? '0' : 
            incentives.selfIncentiveBorrowApr.length === 1 ? incentives.selfIncentiveBorrowApr[0] : incentives.selfIncentiveBorrowApr,
          multiple: incentives.multiple,
          merklSupplyApr,
          merklBorrowApr,
          merklSupplyAprBreakdowns: merklInfo.supply,
          merklBorrowAprBreakdowns: merklInfo.borrow
        });
      });
    }
  });

  return formattedData;
}

function getChainKey(chainName: string): string | null {
  const chainMap: Record<string, string> = {
    'Ethereum': 'ethereum',
    'Arbitrum': 'arbitrum',
    'Avalanche': 'avalanche',
    'Base': 'base',
    'Polygon': 'polygon',
    'Optimism': 'optimism',
    'BSC': 'bsc',
    'BNB Chain': 'bsc',
    'Celo': 'celo',
    'Gnosis': 'gnosis',
    'Sonic': 'sonic',
    'zkSync': 'zksync',
    'Linea': 'linea',
    'Scroll': 'scroll',
    'Metis': 'metis',
    'Soneium': 'soneium'
  };
  
  return chainMap[chainName] || null;
}

function matchesChain(parts: string[], chainKey: string): boolean {
  if (parts[0] === 'self') {
    return parts[1] === chainKey;
  }
  return parts[0] === chainKey;
}

function matchesToken(parts: string[], tokenSymbol: string): boolean {
  // 获取最后一个部分作为 token 标识
  const lastPart = parts[parts.length - 1];
  
  // 特殊映射
  const tokenMap: Record<string, string[]> = {
    'usdt': ['usdt', 'usd₮'],
    'usdc': ['usdc', 'usdce'],
    'usdce': ['usdc', 'usdce'],
    'weth': ['weth'],
    'ethx': ['ethx'],
    'savax': ['savax'],
    'btcb': ['btcb', 'btc.b'],
    'gho': ['gho'],
    'ausd': ['ausd'],
    'cbbtc': ['cbbtc'],
    'lbtc': ['lbtc'],
    'wbtc': ['wbtc', 'wbtc.e'],
    'weeth': ['weeth'],
    'wsteth': ['wsteth'],
    'ezeth': ['ezeth'],
    'sts': ['sts'],
    'ws': ['ws'],
    'eurc': ['eurc'],
    'eure': ['eure'],
    'celo': ['celo'],
    'pyusd': ['pyusd'],
    'rlusd': ['rlusd'],
    'ebtc': ['ebtc'],
    'sgho': ['sgho'],
    'stkgho': ['stkgho']
  };
  
  const normalizedToken = tokenSymbol.toLowerCase();
  
  // 直接匹配
  if (lastPart === normalizedToken) {
    return true;
  }
  
  // 通过映射匹配
  for (const [key, values] of Object.entries(tokenMap)) {
    if (lastPart === key && values.includes(normalizedToken)) {
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

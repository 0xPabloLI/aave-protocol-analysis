import fetch from 'node-fetch';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { logger } from './logger.js';

export interface MerklCampaignBreakdown {
  campaignApr: number;
  campaignStartedAt: string;
  campaignEndedAt: string;
  campaignId: string;
}

// API 响应的完整类型（用于类型断言）
export interface MerklOpportunity {
  id: string;
  name?: string; // opportunity name for market detection
  action: string; // "LEND" or "BORROW" or "HOLD"
  chainId: number;
  explorerAddress?: string; // 用于索引的地址
  // protocol 字段已移除：已通过 mainProtocolId=aave 过滤，处理逻辑中未使用
  tokens?: Array<{
    address: string;
    symbol: string;
    name: string;
  }>; // 可选：处理逻辑中未使用
  rewardsRecord: {
    breakdowns: Array<{
      campaignId: string; // 实际使用的字段
      // API 可能返回其他字段，但处理逻辑中未使用
    }>;
  };
}

export interface MerklCampaignDetails {
  startedAt: string;
  endedAt: string;
  id: string;
  apr: number;
}

// Merkl 数据结构：每个 opportunity 存储一次
export interface MerklOpportunityData {
  supply: MerklCampaignBreakdown[];
  borrow: MerklCampaignBreakdown[];
  hold: MerklCampaignBreakdown[];
  marketName: string;
  chainId: number;
}

/**
 * 获取 Merkl opportunities（使用 mainProtocolId 参数，只返回 Aave 相关的数据）
 */
export async function fetchMerklOpportunities(): Promise<MerklOpportunity[]> {
  try {
    logger.info('🔄 Fetching Merkl opportunities for Aave...');
    const response = await fetch('https://api.merkl.xyz/v4/opportunities?mainProtocolId=aave');
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const opportunities = await response.json() as MerklOpportunity[];
    logger.info(`✅ Found ${opportunities.length} Merkl opportunities`);
    
    return opportunities;
  } catch (error) {
    logger.error('❌ Error fetching Merkl opportunities:', error);
    return [];
  }
}

/**
 * 获取 Merkl campaign 详情
 * In https://api.merkl.xyz/v4/opportunities?mainProtocolId=aave api, onChainCampaignId = Campaign ID in webpage, campaignId = Database ID in web page. 
 * https://api.merkl.xyz/v4/campaigns/${campaignId} use the second one as input parameter, but in response, their campaignId equals to the first one
 */
export async function fetchMerklCampaignDetails(campaignId: string): Promise<MerklCampaignDetails | null> {
  try {
    const response = await fetch(`https://api.merkl.xyz/v4/campaigns/${campaignId}`);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const campaign = await response.json() as any;
    
    // 将 timestamp 转换为日期字符串
    const startedAt = campaign.startTimestamp ? 
      new Date(campaign.startTimestamp * 1000).toISOString() : 
      '';
    const endedAt = campaign.endTimestamp ? 
      new Date(campaign.endTimestamp * 1000).toISOString() : 
      '';
    
    return {
      startedAt,
      endedAt,
      id: campaignId,
      apr: campaign.apr || 0
    };
  } catch (error) {
    logger.error(`❌ Error fetching campaign ${campaignId}:`, error);
    return null;
  }
}

/**
 * 从 Merkl opportunity name 解析对应的 Aave market name
 * 规则：
 * - 如果 name 包含 "horizon" → AaveV3EthereumHorizon
 * - 如果 name 包含 "prime" → AaveV3EthereumLido
 * - 如果 name 包含 "EtherFi" → AaveV3EthereumEtherFi
 * - 如果都不包含 → AaveV3Ethereum (默认)
 */
export function parseMarketNameFromOpportunityName(opportunityName: string | undefined, chainId: number): string {
  if (!opportunityName) {
    // 如果没有 name，根据 chainId 返回默认值
    return chainId === 1 ? 'AaveV3Ethereum' : 'Unknown';
  }
  
  const nameLower = opportunityName.toLowerCase();
  
  // 只对 chainId 1 (Ethereum) 进行特殊市场解析
  if (chainId === 1) {
    if (nameLower.includes('horizon')) {
      return 'AaveV3EthereumHorizon';
    } else if (nameLower.includes('prime')) {
      return 'AaveV3EthereumLido';
    } else if (nameLower.includes('etherfi')) {
      return 'AaveV3EthereumEtherFi';
    } else {
      return 'AaveV3Ethereum';
    }
  }
  
  // 对于其他 chainId，返回默认值（可以根据需要扩展）
  return 'Unknown';
}

/**
 * 处理 Merkl 数据，构建索引并返回
 * Merkl 索引：explorerAddress -> opportunities
 * 对于 chainId === 1，使用 marketName-chainId-explorerAddress 作为 key
 * 对于其他 chainId，使用 chainId-explorerAddress 作为 key
 */
export async function processMerklData(): Promise<Record<string, MerklOpportunityData[]>> {
  const opportunities = await fetchMerklOpportunities();
  const merklData: Record<string, MerklOpportunityData[]> = {};
  logger.info('🔍 Processing Merkl opportunities...');
  
  // 由于使用了 mainProtocolId=aave 参数，API 已经只返回 Aave 相关的数据，无需再过滤
  logger.info(`Processing ${opportunities.length} Aave opportunities`);
  
  // 优化：收集所有唯一的 campaignId，批量并发请求
  const uniqueCampaignIds = new Set<string>();
  for (const opp of opportunities) {
    if (opp.rewardsRecord?.breakdowns) {
      for (const breakdown of opp.rewardsRecord.breakdowns) {
        if (breakdown.campaignId) {
          uniqueCampaignIds.add(breakdown.campaignId);
        }
      }
    }
  }
  
  logger.info(`📦 Fetching ${uniqueCampaignIds.size} unique campaign details concurrently...`);
  
  // 并发请求所有 campaign details，使用缓存避免重复请求
  const campaignDetailsCache = new Map<string, MerklCampaignDetails | null>();
  const campaignPromises = Array.from(uniqueCampaignIds).map(async (campaignId) => {
    const details = await fetchMerklCampaignDetails(campaignId);
    campaignDetailsCache.set(campaignId, details);
    return { campaignId, details };
  });
  
  // 等待所有请求完成（并发执行）
  await Promise.all(campaignPromises);
  logger.info(`✅ Fetched ${campaignDetailsCache.size} campaign details`);
  
  // 处理所有 opportunities（现在可以快速从缓存中获取数据）
  for (const opp of opportunities) {
    if (!opp.explorerAddress) {
      logger.warn(`   ⚠️ No explorerAddress found for opportunity ${opp.id}`);
      continue;
    }
    
    // 只有在 chainId === 1 时才需要解析 marketName
    const marketName = opp.chainId === 1 
      ? parseMarketNameFromOpportunityName(opp.name, opp.chainId)
      : 'Unknown';
    const explorerAddress = opp.explorerAddress.toLowerCase();
    
    // 处理 campaign breakdowns（从缓存中快速获取）
    const breakdowns: MerklCampaignBreakdown[] = [];
    for (const rewardBreakdown of opp.rewardsRecord.breakdowns) {
      const campaignDetails = campaignDetailsCache.get(rewardBreakdown.campaignId);
      if (campaignDetails) {
        breakdowns.push({
          campaignApr: campaignDetails.apr,
          campaignStartedAt: campaignDetails.startedAt,
          campaignEndedAt: campaignDetails.endedAt,
          campaignId: rewardBreakdown.campaignId
        });
      }
    }
    
    // 创建 opportunity 数据对象，根据 action 直接设置对应数组
    const opportunityData: MerklOpportunityData = {
      supply: opp.action === 'LEND' ? breakdowns : [],
      borrow: opp.action === 'BORROW' ? breakdowns : [],
      hold: opp.action === 'HOLD' ? breakdowns : [],
      marketName,
      chainId: opp.chainId
    };
    
    // 创建索引键并添加到索引
    // 只有 chainId === 1 时才在索引键中包含 marketName
    const indexKey = opp.chainId === 1
      ? `${marketName}-${opp.chainId}-${explorerAddress}`
      : `${opp.chainId}-${explorerAddress}`;
    
    if (!merklData[indexKey]) {
      merklData[indexKey] = [];
    }
    merklData[indexKey]!.push(opportunityData);
  }
  
  // 从索引中提取所有 opportunities 用于保存
  const processedData = Object.values(merklData).flat();
  
  logger.info(`✅ Processed ${processedData.length} Merkl opportunities`);
  logger.info(`📊 Created index with ${Object.keys(merklData).length} token keys`);
  
  // 保存 Merkl 原始数据
  await mkdir('data', { recursive: true });
  const merklRawDataPath = join('data', 'merkl-raw-data.json');
  await writeFile(merklRawDataPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    rawOpportunities: opportunities,
    processedData,
    index: merklData
  }, null, 2), 'utf-8');
  logger.info(`💾 Merkl raw data saved to ${merklRawDataPath}`);
  
  return merklData;
}

/**
 * 计算当前时间范围内活跃的 campaign APR 总和
 */
export function calculateActiveCampaignApr(breakdowns: MerklCampaignBreakdown[]): number {
  const now = new Date();
  return breakdowns.reduce((sum, breakdown) => {
    const startTime = breakdown.campaignStartedAt ? new Date(breakdown.campaignStartedAt) : null;
    const endTime = breakdown.campaignEndedAt ? new Date(breakdown.campaignEndedAt) : null;
    // 只累加当前时间在开始和结束时间范围内的 campaign APR
    if (startTime && endTime && startTime <= now && endTime >= now) {
      return sum + breakdown.campaignApr;
    }
    return sum;
  }, 0);
}

/**
 * 根据 token 地址查找匹配的 Merkl opportunities
 */
export function findMatchingMerklOpportunities(
  item: { chainId: number; marketName: string; tokenAddress: string; aTokenAddress: string | null; vTokenAddress: string | null },
  merklData: Record<string, MerklOpportunityData[]>
): MerklOpportunityData[] {
  const matchedOpportunities: MerklOpportunityData[] = [];
  const seenOpportunities = new Set<MerklOpportunityData>();
  
  // 构建要检查的 token 地址列表（按优先级：underlying → aToken → vToken）
  const tokenAddressesToCheck: string[] = [
    item.tokenAddress.toLowerCase(),
    item.aTokenAddress?.toLowerCase(),
    item.vTokenAddress?.toLowerCase()
  ].filter((addr): addr is string => addr !== null && addr !== undefined);
  
  // 检查每个地址是否在索引中
  for (const tokenAddr of tokenAddressesToCheck) {
    const indexKey = item.chainId === 1
      ? `${item.marketName}-${item.chainId}-${tokenAddr}`
      : `${item.chainId}-${tokenAddr}`;
    
    const matchingOpportunities = merklData[indexKey];
    if (matchingOpportunities?.length > 0) {
      for (const opp of matchingOpportunities) {
        if (!seenOpportunities.has(opp)) {
          seenOpportunities.add(opp);
          matchedOpportunities.push(opp);
        }
      }
    }
  }
  
  return matchedOpportunities;
}

/**
 * 格式化 Merkl campaign breakdown 为字符串
 * 字段顺序：campaignApr, campaignStartedAt, campaignEndedAt, campaignId
 */
export function formatMerklBreakdown(breakdowns: MerklCampaignBreakdown[]): string {
  return breakdowns.map(b => {
    let startDate = 'N/A';
    if (b.campaignStartedAt) {
      const date = new Date(b.campaignStartedAt);
      startDate = date.toLocaleString('en-US', { 
        year: 'numeric', 
        month: '2-digit', 
        day: '2-digit', 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true
      });
    }
    let endDate = 'N/A';
    if (b.campaignEndedAt) {
      const date = new Date(b.campaignEndedAt);
      endDate = date.toLocaleString('en-US', { 
        year: 'numeric', 
        month: '2-digit', 
        day: '2-digit', 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true
      });
    }
    return `${b.campaignApr}% (${startDate} - ${endDate}, ${b.campaignId})`;
  }).join('; ');
}


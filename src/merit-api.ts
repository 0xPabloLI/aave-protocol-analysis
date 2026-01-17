import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

export interface MeritAPRResponse {
  previousAPR: any;
  currentAPR: {
    actionsAPR: Record<string, number | null>;
  };
}

// Campaign info 消息项（从 Campaign info 弹窗表格中提取）
export interface MeritCampaignInfo {
  action?: string; // Action 描述（如 "Supply USDC"）
  description?: string; // Description 文本（如 "Rewards are distributed using the following formula: ..."）
}

// Merit APR 条目（扁平化结构，timeRange 直接作为字段）
export interface MeritAprEntry {
  apr: number; // APR 百分比值（如 5.2 表示 5.2%）
  selfApr?: number; // Self APR 百分比值（如果有对应的 self- 前缀的 key）
  link: string;
  startDate: string;
  endDate: string;
  name?: string; // Campaign 名称（如 "Supply (Celo or ETH) and borrow USDT"）
  message?: MeritCampaignInfo[]; // Campaign 信息数组（从 Campaign info 弹窗表格中提取，可能有多条 action 和 description）
  requiredBorrowTokens?: string[]; // 需要 borrow 的 token 列表（用于 supply with borrow requirement）
  requiredSupplyTokens?: string[]; // 需要 supply 的 token 列表（用于 borrow with supply requirement）
  startBlock?: string; // 仅用于 CSV，不放入接口
  endBlock?: string; // 仅用于 CSV，不放入接口
}

// Merit 数据项结构（简化：只保留 supply 和 borrow）
export interface MeritDataItem {
  meritSupplys: MeritAprEntry[];
  meritBorrows: MeritAprEntry[];
}

/**
 * 解析链名，处理特殊情况如 ethereum-prime
 */
export function parseChainKey(parts: string[]): string {
  // 注意：传入的 parts 已经移除了 self- 前缀
  if (parts.length >= 2 && parts[0] === 'ethereum' && parts[1] !== 'supply' && parts[1] !== 'borrow') {
    // ethereum-xxx 格式：ethereum-xxx-action-token (xxx 不是 supply 或 borrow)
    return `ethereum-${parts[1]}`;
  } else {
    // 标准格式：chain-action-token
    return parts[0];
  }
}

/**
 * 根据链名获取 RPC URL
 */
function getRpcUrlsFromChainName(chainName: string): string[] {
  const prodRpcConfig: Record<string, { publicJsonRPCUrl: string[] }> = {
    ethereum: {
      publicJsonRPCUrl: [
        'https://mainnet.gateway.tenderly.co',
        'https://rpc.flashbots.net',
        'https://eth.llamarpc.com',
        'https://eth-mainnet.public.blastapi.io',
        'https://ethereum-rpc.publicnode.com',
      ],
    },
    polygon: {
      publicJsonRPCUrl: [
        'https://gateway.tenderly.co/public/polygon',
        'https://polygon-pokt.nodies.app',
        'https://polygon-bor-rpc.publicnode.com',
        'https://polygon-rpc.com',
        'https://polygon-mainnet.public.blastapi.io',
        'https://rpc-mainnet.matic.quiknode.pro',
      ],
    },
    avalanche: {
      publicJsonRPCUrl: [
        'https://api.avax.network/ext/bc/C/rpc',
        'https://ava-mainnet.public.blastapi.io/ext/bc/C/rpc',
        'https://rpc.ankr.com/avalanche',
      ],
    },
    arbitrum: {
      publicJsonRPCUrl: [
        'https://arb1.arbitrum.io/rpc',
        'https://rpc.ankr.com/arbitrum',
        'https://1rpc.io/arb',
      ],
    },
    base: {
      publicJsonRPCUrl: [
        'https://1rpc.io/base',
        'https://base.llamarpc.com',
        'https://base.publicnode.com',
        'https://base-mainnet.public.blastapi.io',
      ],
    },
    optimism: {
      publicJsonRPCUrl: [
        'https://public-op-mainnet.fastnode.io',
        'https://optimism-rpc.publicnode.com',
      ],
    },
    metis: {
      publicJsonRPCUrl: ['https://andromeda.metis.io/?owner=1088'],
    },
    gnosis: {
      publicJsonRPCUrl: ['https://gnosis-rpc.publicnode.com', 'https://rpc.gnosischain.com'],
    },
    bnb: {
      publicJsonRPCUrl: ['https://bsc.publicnode.com', 'wss://bsc.publicnode.com'],
    },
    scroll: {
      publicJsonRPCUrl: ['https://rpc.scroll.io', 'https://rpc.ankr.com/scroll'],
    },
    zksync: {
      publicJsonRPCUrl: ['https://mainnet.era.zksync.io'],
    },
    linea: {
      publicJsonRPCUrl: [
        'https://1rpc.io/linea',
        'https://linea.drpc.org',
        'https://linea-rpc.publicnode.com',
      ],
    },
    sonic: {
      publicJsonRPCUrl: [
        'https://rpc.soniclabs.com',
        'https://sonic.drpc.org',
        'https://sonic-rpc.publicnode.com',
      ],
    },
    celo: {
      publicJsonRPCUrl: ['https://rpc.ankr.com/celo', 'https://celo.drpc.org'],
    },
    soneium: {
      publicJsonRPCUrl: ['https://soneium.drpc.org', 'https://rpc.soneium.org'],
    },
    plasma: {
      publicJsonRPCUrl: ['https://rpc.plasma.to'],
    },
    ink: {
      publicJsonRPCUrl: ['https://ink.drpc.org'],
    },
  };

  const chainAliases: Record<string, string> = {
    'ethereum-etherfi': 'ethereum',
    'ethereum-prime': 'ethereum',
    'ethereum-horizon': 'ethereum',
    'arbitrum-one': 'arbitrum',
    'xdai': 'gnosis',
    'bsc': 'bnb',
    'binance': 'bnb',
  };

  const normalized = chainName.toLowerCase();
  const mappedChain = chainAliases[normalized] ?? normalized;
  const urls = prodRpcConfig[mappedChain]?.publicJsonRPCUrl ?? [];
  return urls.filter((url) => url.startsWith('http://') || url.startsWith('https://'));
}

/**
 * 获取 Merit APR 数据并构建索引
 * 总是获取时间范围信息（必选）
 */
export async function fetchMeritData(): Promise<Record<string, MeritDataItem>> {
  try {
    logger.info('🎁 Fetching Merit APR data...');
    const response = await fetch('https://apps.aavechan.com/api/merit/aprs');
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json() as MeritAPRResponse;
    logger.info(`✅ Merit APR data fetched successfully`);
    
    const meritAPRs = data.currentAPR.actionsAPR;
    
    // 获取时间范围信息（必选）
    const timeRanges = await fetchAllMeritTimeRanges(meritAPRs, { maxConcurrent: 5 });
    
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
          meritSupplys: [],
          meritBorrows: []
        };
      }
      return meritData[indexKey]!;
    }

    // 获取 key 对应的 link、时间范围、block、name 和 message 信息（处理 self- 前缀）
    function getLinkAndTimeRange(key: string): { link: string; startDate: string; endDate: string; startBlock?: string; endBlock?: string; name?: string; message?: MeritCampaignInfo[] } {
      const isSelfFormat = key.startsWith('self-');
      const baseKey = isSelfFormat ? key.substring(5) : key;
      
      // 查找 baseKey 的时间范围（self- 开头的 key 使用对应的非 self- key 的时间范围）
      const timeRangeData = timeRanges[baseKey];
      if (timeRangeData) {
        return {
          link: timeRangeData.link,
          startDate: timeRangeData.startDate,
          endDate: timeRangeData.endDate,
          startBlock: timeRangeData.startBlock,
          endBlock: timeRangeData.endBlock,
          ...(timeRangeData.name && { name: timeRangeData.name }),
          ...(timeRangeData.message && timeRangeData.message.length > 0 && { message: timeRangeData.message })
        };
      }
      
      // 如果找不到，返回默认值
      return {
        link: `https://apps.aavechan.com/merit/${baseKey}`,
        startDate: '',
        endDate: ''
      };
    }

    // 先收集所有 key 的信息，按 baseKey 分组
    interface KeyInfo {
      key: string;
      value: number;
      isSelf: boolean;
      supplyTokens: string[];
      borrowTokens: string[];
      chainKey: string;
    }
    
    const keyInfos: KeyInfo[] = [];
    const baseKeyMap = new Map<string, { nonSelf?: KeyInfo; self?: KeyInfo }>();
    
    // 第一遍遍历：收集所有 key 信息
    Object.entries(meritAPRs).forEach(([key, value]) => {
      if (value === null) return;
      
      const parts = key.split('-');
      if (parts.length < 2) return;
      
      const isSelfFormat = key.startsWith('self-');
      const actualKey = isSelfFormat ? key.substring(5) : key;
      const actualParts = actualKey.split('-');
      
      if (actualParts.length < 2) return;
      
      const chainKey = parseChainKey(actualParts);
      
      let supplyTokens: string[] = [];
      let borrowTokens: string[] = [];

      if (actualKey.includes('-supply-') && actualKey.includes('-borrow-')) {
        const supplyIndex = actualParts.indexOf('supply');
        const borrowIndex = actualParts.indexOf('borrow');
        if (supplyIndex >= 0 && borrowIndex >= 0) {
          const rawSupplyToken = actualParts.slice(supplyIndex + 1, borrowIndex).join('-');
          const rawBorrowToken = actualParts.slice(borrowIndex + 1).join('-');
          supplyTokens = rawSupplyToken.includes('-or-') 
            ? rawSupplyToken.split('-or-').map(t => t.toLowerCase()).filter(Boolean)
            : rawSupplyToken ? [rawSupplyToken.toLowerCase()] : [];
          borrowTokens = rawBorrowToken.includes('-or-')
            ? rawBorrowToken.split('-or-').map(t => t.toLowerCase()).filter(Boolean)
            : rawBorrowToken ? [rawBorrowToken.toLowerCase()] : [];
        }
      } else if (actualKey.includes('-supply-')) {
        const token = actualParts[actualParts.length - 1].toLowerCase();
        if (token) supplyTokens = [token];
      } else if (actualKey.includes('-borrow-')) {
        const token = actualParts[actualParts.length - 1].toLowerCase();
        if (token) borrowTokens = [token];
      } else if (actualParts.length === 2) {
        const token = actualParts[1].toLowerCase();
        if (token) supplyTokens = [token];
      }

      if (supplyTokens.length > 0 || borrowTokens.length > 0) {
        const info: KeyInfo = { key, value, isSelf: isSelfFormat, supplyTokens, borrowTokens, chainKey };
        keyInfos.push(info);
        
        // 按 baseKey 分组（baseKey 就是去掉 self- 前缀的 key）
        const baseKey = actualKey;
        if (!baseKeyMap.has(baseKey)) {
          baseKeyMap.set(baseKey, {});
        }
        const group = baseKeyMap.get(baseKey)!;
        if (isSelfFormat) {
          group.self = info;
        } else {
          group.nonSelf = info;
        }
      }
    });

    // 第二遍遍历：处理每个 baseKey，合并 self 和非 self
    for (const [baseKey, group] of baseKeyMap.entries()) {
      const nonSelfInfo = group.nonSelf;
      const selfInfo = group.self;
      
      // 决定使用哪个 key 获取时间范围（优先使用 nonSelf，因为 self 会跳过获取时间范围）
      const keyForTimeRange = nonSelfInfo?.key || selfInfo?.key || baseKey;
      const { link, startDate, endDate, startBlock, endBlock, name, message } = getLinkAndTimeRange(keyForTimeRange);
      
      // 决定 APR 值
      const aprValue = nonSelfInfo?.value;
      const selfAprValue = selfInfo?.value;
      
      // 如果只有 self，没有 nonSelf，那就不创建条目（因为 self 应该和 nonSelf 配对）
      if (!nonSelfInfo && selfInfo) {
        // 这种情况理论上不应该出现，但为了健壮性，我们创建一个只有 selfApr 的条目
        // 实际上应该跳过，因为 self 应该和对应的 nonSelf 一起出现
        continue;
      }
      
      // 如果没有 nonSelf，跳过
      if (!nonSelfInfo) continue;
      
      const { supplyTokens, borrowTokens, chainKey } = nonSelfInfo;
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
            // borrow with supply requirement
            const entry: MeritAprEntry = {
              apr: aprValue!,
              selfApr: selfAprValue,
              requiredSupplyTokens: supplyTokens,
              link,
              startDate,
              endDate,
              startBlock,
              endBlock,
              ...(name && { name }),
              ...(message && message.length > 0 && { message })
            };
            incentives.meritBorrows.push(entry);
          } else {
            // 简单 borrow
            const entry: MeritAprEntry = {
              apr: aprValue!,
              selfApr: selfAprValue,
              link,
              startDate,
              endDate,
              startBlock,
              endBlock,
              ...(name && { name }),
              ...(message && message.length > 0 && { message })
            };
            incentives.meritBorrows.push(entry);
          }
        }

        if (hasSupplyTokens) {
          for (const st of supplyTargets) {
            const supplyIndexKey = `${chainKey.toLowerCase()}-${st.toLowerCase()}`;
            const supplyIncentives = createIndexEntry(supplyIndexKey);
            // supply with borrow requirement
            const entry: MeritAprEntry = {
              apr: aprValue!,
              selfApr: selfAprValue,
              requiredBorrowTokens: borrowTokens,
              link,
              startDate,
              endDate,
              startBlock,
              endBlock,
              ...(name && { name }),
              ...(message && message.length > 0 && { message })
            };
            supplyIncentives.meritSupplys.push(entry);
          }
        }
      }

      // 情况 2: borrowToken 是 'multiple'，为每个 supply token 分别处理
      if (hasBorrowMultiple && hasSupplyTokens) {
        for (const st of supplyTargets) {
          const indexKey = `${chainKey.toLowerCase()}-${st.toLowerCase()}`;
          const incentives = createIndexEntry(indexKey);
          // supply with borrow requirement (multiple)
          const entry: MeritAprEntry = {
            apr: aprValue!,
            selfApr: selfAprValue,
            requiredBorrowTokens: ['multiple'],
            link,
            startDate,
            endDate,
            startBlock,
            endBlock,
            ...(name && { name }),
              ...(message && message.length > 0 && { message })
          };
          incentives.meritSupplys.push(entry);
        }
      }

      // 情况 3: 只有 supply token，没有 borrow token（简单 supply 场景）
      if (!hasBorrowTokens && !hasBorrowMultiple && hasSupplyTokens) {
        for (const st of supplyTargets) {
          const indexKey = `${chainKey.toLowerCase()}-${st.toLowerCase()}`;
          const incentives = createIndexEntry(indexKey);
          const entry: MeritAprEntry = {
            apr: aprValue!,
            selfApr: selfAprValue,
            link,
            startDate,
            endDate,
            startBlock,
            endBlock,
            ...(name && { name }),
              ...(message && message.length > 0 && { message })
          };
          incentives.meritSupplys.push(entry);
        }
      }
    }

    logger.info(`✅ Indexed Merit data for ${Object.keys(meritData).length} chain-token combinations`);
    
    // 保存 Merit 原始数据
    await mkdir(DATA_DIR, { recursive: true });
    const meritRawDataPath = join(DATA_DIR, 'merit-raw-data.json');
    await writeFile(meritRawDataPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      rawAPRs: data.currentAPR.actionsAPR,
      timeRanges,
      index: meritData
    }, null, 2), 'utf-8');
    logger.info(`💾 Merit raw data saved to ${meritRawDataPath}`);
    
    return meritData;
  } catch (error) {
    logger.error('❌ Error fetching Merit APR data:', error);
    return {};
  }
}

/**
 * 批量获取所有 Merit key 的时间范围和链接信息
 * 这个函数会为每个唯一的 key 获取时间范围信息
 * 注意：跳过以 self- 开头的 key，因为它们与去掉 self- 前缀的 key 共享相同的 URL 和时间范围
 */
export async function fetchAllMeritTimeRanges(
  meritAPRs: Record<string, number | null>,
  options: { 
    maxConcurrent?: number;
  } = {}
): Promise<Record<string, { link: string; startDate: string; endDate: string; startBlock?: string; endBlock?: string; name?: string; message?: MeritCampaignInfo[] }>> {
  const { maxConcurrent = 5 } = options;
  
  const timeRanges: Record<string, { link: string; startDate: string; endDate: string; startBlock?: string; endBlock?: string; name?: string; message?: MeritCampaignInfo[] }> = {};
  const uniqueKeys = Object.keys(meritAPRs);
  
  if (uniqueKeys.length === 0) {
    return timeRanges;
  }
  
  // 过滤掉以下情况的 key：
  // 1. 值为 null 的 key（如 "avalanche-supply-savax": null），这些不需要获取时间范围
  // 2. 以 self- 开头的 key，因为它们与去掉 self- 前缀的 key 共享相同的 URL 和时间范围
  const keysToFetch = uniqueKeys.filter(key => {
    const value = meritAPRs[key];
    if (value === null) return false; // 跳过 null 值
    if (key.startsWith('self-')) return false; // 跳过 self- 前缀
    return true;
  });
  
  const skippedCount = uniqueKeys.length - keysToFetch.length;
  logger.info(`📅 Fetching time ranges for ${keysToFetch.length} Merit campaigns (skipping ${skippedCount} null/self- keys)...`);
  
  // 使用并发控制来避免过多请求
  const semaphore = { count: 0 };
  const results: Array<{ key: string; data: { link: string; startDate: string; endDate: string; startBlock?: string; endBlock?: string; name?: string; message?: MeritCampaignInfo[] } }> = [];
  
  const fetchWithLimit = async (key: string) => {
    while (semaphore.count >= maxConcurrent) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    semaphore.count++;
    try {
      const data = await fetchMeritTimeRange(key);
      results.push({ key, data });
    } catch (error) {
      // 静默失败，继续处理其他 key
    } finally {
      semaphore.count--;
    }
  };
  
  // 并发获取所有时间范围（只处理非 self- 开头的 key）
  await Promise.all(keysToFetch.map(key => fetchWithLimit(key)));
  
  // 构建结果映射
  for (const { key, data } of results) {
    timeRanges[key] = data;
  }
  
  logger.info(`✅ Fetched time ranges for ${Object.keys(timeRanges).length} Merit campaigns`);
  
  return timeRanges;
}

/**
 * 根据 marketName 和 tokenSymbol 获取对应的 meritData
 */
export function getMeritDataFromMarket(
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

// 全局浏览器实例（复用以提高性能）
let browserInstance: Browser | null = null;

/**
 * 获取或创建浏览器实例（单例模式）
 */
async function getBrowser(): Promise<Browser> {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
  }
  return browserInstance;
}

/**
 * 关闭浏览器实例
 */
export async function closeBrowser(): Promise<void> {
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/e44d6b35-b855-47a4-be25-c451781709dd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'src/merit-api.ts:614',message:'closeBrowser called',data:{hasInstance:!!browserInstance},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
  // #endregion
  if (browserInstance) {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/e44d6b35-b855-47a4-be25-c451781709dd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'src/merit-api.ts:617',message:'closing browser instance',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
    await browserInstance.close();
    browserInstance = null;
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/e44d6b35-b855-47a4-be25-c451781709dd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'src/merit-api.ts:620',message:'browser instance closed',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
  } else {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/e44d6b35-b855-47a4-be25-c451781709dd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'src/merit-api.ts:623',message:'no browser instance to close',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
  }
}

/**
 * 获取 Merit 页面 HTML 内容（静态 fetch，用于 name 和 date 提取）
 * name 和 date 在 SSR HTML 中就有，不需要 JavaScript 渲染
 * 这样可以减少性能消耗，避免不必要的 Puppeteer 调用
 */
async function fetchMeritPageHtmlStatic(key: string): Promise<string | null> {
  try {
    const url = `https://apps.aavechan.com/merit/${key}`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!response.ok) {
      logger.warn(`⚠️ Failed to fetch Merit page ${url}: HTTP ${response.status}`);
      return null;
    }
    
    return await response.text();
  } catch (error) {
    logger.error(`❌ Error fetching Merit page for key ${key}:`, error);
    return null;
  }
}

/**
 * 使用 browser rendering 提取 Campaign info
 * 打开 Campaign info 弹窗，从表格中提取 action 和 description
 */
async function extractCampaignInfoWithBrowser(key: string): Promise<MeritCampaignInfo[]> {
  try {
    const url = `https://apps.aavechan.com/merit/${key}`;
    
    const browser = await getBrowser();
    const page = await browser.newPage();
    
    try {
      // 设置视口和 User-Agent
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      // 导航到页面
      await page.goto(url, { 
        waitUntil: 'networkidle2',
        timeout: 30000 
      });
      
      // 等待页面加载
      await page.waitForSelector('body', { timeout: 10000 });
      
      // 等待页面完全加载（包括 JavaScript 执行）- 减少等待时间
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 尝试查找并点击 "Campaign info" 按钮
      // 方法1: 查找包含 "Campaign info" 文本的按钮
      try {
        const buttons = await page.$$('button');
        for (const button of buttons) {
          const text = await page.evaluate((el) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (el as any).textContent || '';
          }, button);
          if (text && /campaign\s+info/i.test(text)) {
            await button.click();
            await new Promise(resolve => setTimeout(resolve, 800));
            break;
          }
        }
      } catch (e) {
        // 静默失败，继续尝试其他方法
      }
      
      // 方法2: 尝试查找包含 "info" 的按钮（更宽泛的匹配）
      try {
        const infoButtonIndex = await page.$$eval('button', (buttons) => {
          return buttons.findIndex((btn) => {
            const text = btn.textContent || '';
            return /info/i.test(text) && text.length < 50;
          });
        });
        if (infoButtonIndex >= 0) {
          const buttons = await page.$$('button');
          if (buttons[infoButtonIndex]) {
            await buttons[infoButtonIndex].click();
            await new Promise(resolve => setTimeout(resolve, 800));
          }
        }
      } catch (e) {
        // 静默失败
      }
      
      // 从页面中提取表格数据
      // 查找包含 Action 和 Description 列的表格
      const campaignInfos = await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const infos: Array<{ action?: string; description?: string }> = [];
        
        // 查找所有表格
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc = (globalThis as any).document;
        if (!doc) return infos;
        
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tables = doc.querySelectorAll('table');
        
        for (let i = 0; i < tables.length; i++) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const table = tables[i] as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rows = table.querySelectorAll('tbody tr');
          
          for (let j = 0; j < rows.length; j++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const row = rows[j] as any;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const cells = row.querySelectorAll('td');
            if (cells.length >= 2) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const action = (cells[0] as any)?.textContent?.trim() || '';
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const description = (cells[1] as any)?.textContent?.trim() || '';
              
              // 验证：action 应该较短，description 应该较长
              // 不依赖文字匹配，只要表格有两列且内容合理就提取
              if (action.length > 0 && description.length > action.length && description.length > 20) {
                infos.push({ action, description });
              }
            }
          }
        }
        
        return infos;
      });
      
      if (campaignInfos.length > 0) {
        return campaignInfos as MeritCampaignInfo[];
      }
      
      return [];
    } finally {
      await page.close();
    }
  } catch (error) {
    // 静默失败，fallback 到其他方法
    return [];
  }
}

/**
 * 优先级 #1：从 DOM 直接提取日期
 * 使用 cheerio 解析 HTML，查找带有 class "text-xs whitespace-nowrap" 的 span 元素
 * 这种方法比正则表达式更可靠，能正确处理复杂的 HTML 结构
 */
function extractDatesFromDom(html: string): { startDate?: string; endDate?: string } {
  try {
    const $ = cheerio.load(html);
    
    // 查找所有带有 class "text-xs whitespace-nowrap" 的 span 元素
    const candidateSpans: string[] = [];
    $('span.text-xs.whitespace-nowrap').each((_index: number, element: any) => {
      const text = $(element).text().trim();
      if (text) {
        candidateSpans.push(text);
      }
    });
    
    // 过滤出符合日期格式的内容
    // 匹配格式：Mon/Tue/Wed/Thu/Fri/Sat/Sun + 月份缩写 + 日期 + 年份
    const dateRegex = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{4}$/;
    const dates = candidateSpans.filter((txt) => dateRegex.test(txt));
    
    if (dates.length >= 2) {
      return {
        startDate: dates[0],
        endDate: dates[1]
      };
    }
  } catch (error) {
    // 忽略错误，继续使用其他方法
  }
  
  return {};
}

/**
 * 优先级 #2：使用正则表达式匹配各种日期格式
 */
function extractDatesWithRegex(html: string): { startDate?: string; endDate?: string } {
  const dates: string[] = [];
  
  // 匹配各种日期格式
  const patterns = [
    // Thu Jan 01 2026
    /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{4}/g,
    // 2026-01-01 (ISO)
    /\d{4}-\d{2}-\d{2}/g,
    // Jan 1, 2026
    /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/g,
    // 01/01/2026 (美式)
    /\d{1,2}\/\d{1,2}\/\d{4}/g,
    // 01-01-2026
    /\d{1,2}-\d{1,2}-\d{4}/g
  ];
  
  for (const pattern of patterns) {
    const matches = html.match(pattern);
    if (matches) {
      dates.push(...matches);
    }
  }
  
  // 去重并排序
  const uniqueDates = [...new Set(dates)];
  
  if (uniqueDates.length >= 2) {
    // 尝试解析并排序日期，选择最早和最晚的
    const parsedDates = uniqueDates
      .map(dateStr => {
        try {
          const date = new Date(dateStr);
          if (!isNaN(date.getTime())) {
            return { original: dateStr, parsed: date };
          }
        } catch {
          // 忽略解析失败的日期
        }
        return null;
      })
      .filter((d): d is { original: string; parsed: Date } => d !== null)
      .sort((a, b) => a.parsed.getTime() - b.parsed.getTime());
    
    if (parsedDates.length >= 2) {
      return {
        startDate: parsedDates[0].original,
        endDate: parsedDates[parsedDates.length - 1].original
      };
    }
    
    // 如果无法解析，直接使用前两个
    return {
      startDate: uniqueDates[0],
      endDate: uniqueDates[1]
    };
  }
  
  return {};
}

/**
 * 优先级 #3：提取区块号
 */
function extractBlockNumbers(html: string): { startBlock?: string; endBlock?: string } {
  // 匹配 etherscan.io/block/ 链接中的区块号
  const blockPattern = /etherscan\.io\/block\/(\d+)/g;
  const matches: string[] = [];
  let match;
  
  while ((match = blockPattern.exec(html)) !== null) {
    matches.push(match[1]);
  }
  
  // 去重并转换为数字排序
  const uniqueBlocks = [...new Set(matches)]
    .map(block => parseInt(block, 10))
    .filter(block => !isNaN(block))
    .sort((a, b) => a - b);
  
  if (uniqueBlocks.length >= 2) {
    return {
      startBlock: uniqueBlocks[0].toString(),
      endBlock: uniqueBlocks[uniqueBlocks.length - 1].toString()
    };
  } else if (uniqueBlocks.length === 1) {
    return {
      startBlock: uniqueBlocks[0].toString()
    };
  }
  
  return {};
}

/**
 * 通过 RPC 查询区块时间戳
 */
async function getBlockTimestamp(blockNumber: string, chainName?: string): Promise<string | null> {
  try {
    // 根据链名选择 RPC 端点
    const rpcUrls = chainName ? getRpcUrlsFromChainName(chainName) : [];
    
    if (rpcUrls.length === 0) {
      return null;
    }
    
    for (const rpcUrl of rpcUrls) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      try {
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'eth_getBlockByNumber',
            params: [`0x${parseInt(blockNumber, 10).toString(16)}`, false],
            id: 1
          })
        });
        
        if (!response.ok) {
          continue;
        }
        
        const data = await response.json() as { result?: { timestamp?: string } };
        
        if (data.result?.timestamp) {
          // 将十六进制时间戳转换为日期字符串
          const timestamp = parseInt(data.result.timestamp, 16);
          const date = new Date(timestamp * 1000);
          return date.toISOString();
        }
      } catch {
        // ignore and try next rpc
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * 将区块号转换为日期
 */
async function convertBlocksToDates(
  startBlock?: string,
  endBlock?: string,
  chainName?: string
): Promise<{ startDate?: string; endDate?: string }> {
  const result: { startDate?: string; endDate?: string } = {};
  
  if (startBlock) {
    const startDate = await getBlockTimestamp(startBlock, chainName);
    if (startDate) {
      result.startDate = startDate;
    }
  }
  
  if (endBlock) {
    const endDate = await getBlockTimestamp(endBlock, chainName);
    if (endDate) {
      result.endDate = endDate;
    }
  }
  
  return result;
}

/**
 * 从 HTML 中提取 campaign 名称
 * 名称通常在页面主标题位置（如 "Borrow GHO", "Supply (Celo or ETH) and borrow USDT"）
 * 在 Next.js SSR 页面中，这些信息通常在 script 标签的 JSON 数据中
 */
function extractCampaignName(html: string): string | undefined {
  try {
    const $ = cheerio.load(html);
    const scriptContent = $('script').text();
    
    // 优先级 #1：从 script 标签中的 JSON 数据提取页面主标题
    // 查找常见的 campaign 名称模式
    const namePatterns = [
      // "Borrow GHO on Aave V3 Base" 格式（带完整描述）
      /"Borrow\s+[A-Z]+\s+on\s+Aave\s+V3\s+[A-Z]+"/i,
      // "Supply (Celo or ETH) and borrow USDT" 格式
      /"Supply\s*\([^)]+\)\s+and\s+borrow\s+[A-Z]+"/i,
      // "Supply Celo and borrow USDT" 格式
      /"Supply\s+[A-Z]+\s+and\s+borrow\s+[A-Z]+"/i,
      // "Supply Celo or ETH and borrow USDT" 格式
      /"Supply\s+[A-Z]+\s+or\s+[A-Z]+\s+and\s+borrow\s+[A-Z]+"/i,
      // "Borrow GHO" 格式（简单 borrow）
      /"Borrow\s+[A-Z]+"/i,
      // "Supply [TOKEN]" 格式（简单 supply）
      /"Supply\s+[A-Z]+"/i,
      // children 数组中的格式（带完整描述）
      /children":\["Borrow\s+[A-Z]+\s+on\s+Aave\s+V3\s+[A-Z]+"/i,
      /children":\["Supply\s*\([^)]+\)\s+and\s+borrow\s+[A-Z]+"/i,
      /children":\["Borrow\s+[A-Z]+"/i,
      /children":\["Supply\s+[A-Z]+"/i,
    ];
    
    for (const pattern of namePatterns) {
      const match = scriptContent.match(pattern);
      if (match) {
        let extracted = match[0]
          .replace(/^"|"$/g, '')
          .replace(/^children":\["/, '')
          .replace(/"$/, '');
        
        // 清理可能的转义字符
        extracted = extracted.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        
        if (extracted.length > 3 && extracted.length < 200) {
          return extracted;
        }
      }
    }
    
    // 优先级 #2：从 h1 标题提取（页面中可能有 "Last supply (celo or eth) and borrow usdt..."）
    const h1Text = $('h1').first().text().trim();
    if (h1Text && h1Text.length > 5) {
      // 尝试从 h1 文本中提取 campaign 名称（去掉 "Last" 和 "campaign round has ended" 等前缀后缀）
      const nameMatch = h1Text.match(/(?:Last\s+)?(Supply\s*(?:\([^)]+\))?\s+(?:and|or)\s+borrow\s+[A-Z]+)/i) ||
                       h1Text.match(/(?:Last\s+)?(Borrow\s+[A-Z]+)/i) ||
                       h1Text.match(/(?:Last\s+)?(Supply\s+[A-Z]+)/i);
      if (nameMatch && nameMatch[1]) {
        return nameMatch[1];
      }
      // 如果 h1 文本本身就很短且看起来像标题，直接使用
      if (h1Text.length < 100 && !h1Text.toLowerCase().includes('campaign round has ended')) {
        return h1Text;
      }
    }
    
    // 优先级 #3：使用正则从 HTML 文本中提取
    const nameRegex = /(?:Supply\s*(?:\([^)]+\))?\s+(?:and|or)\s+borrow\s+[A-Z]+|Borrow\s+[A-Z]+|Supply\s+[A-Z]+)/i;
    const htmlMatch = html.match(nameRegex);
    if (htmlMatch) {
      return htmlMatch[0];
    }
  } catch (error) {
    // 静默失败
  }
  
  return undefined;
}

/**
 * 从 HTML 中提取 campaign info（action 和 description）
 * 从 Campaign info 弹窗的表格中提取 action 和 description
 * 基于表格结构提取，不依赖具体的文字内容
 */
function extractCampaignInfo(html: string): MeritCampaignInfo[] {
  try {
    const $ = cheerio.load(html);
    const campaignInfos: MeritCampaignInfo[] = [];
    // 直接使用原始 HTML，因为 script 标签中的内容可能需要特殊处理
    const scriptContent = $('script').text();
    const rawHtml = html; // 保留原始 HTML 用于备用提取
    
    // 优先级 #1：从 HTML DOM 表格中提取（最可靠的方法）
    // 查找 Campaign info 弹窗中的表格：第一列是 Action，第二列是 Description
    $('table tbody tr').each((_index: number, element: any) => {
      const tds = $(element).find('td');
      if (tds.length >= 2) {
        const action = $(tds[0]).text().trim();
        const description = $(tds[1]).text().trim();
        
        // 只要表格有两列，就提取（不依赖文字内容验证）
        if (action && description && action.length > 0 && description.length > 0) {
          campaignInfos.push({ action, description });
        }
      }
    });
    
    // 优先级 #2：如果 DOM 中没有找到，从原始 HTML 中直接提取
    // HTML 中的格式可能是转义的：\"children\":\"Supply WETH\" 或未转义的："children":"Supply WETH"
    if (campaignInfos.length === 0) {
      // 在原始 HTML 中查找，支持转义和未转义的格式
      // 匹配格式：\"children\":\"Supply WETH\" 或 "children":"Supply WETH"
      const actionPattern = /(?:\\?"children\\?"\s*:\s*\\?")((?:Supply|Borrow|Stake|Hold)\s+[^"\\]{1,200})(?:\\?")/i;
      const actionMatch = rawHtml.match(actionPattern);
      
      if (actionMatch) {
        const action = actionMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
        const actionIndex = actionMatch.index || 0;
        
        // 在 action 之后查找 description（在 30000 字符内，因为中间可能有大量其他内容）
        const searchStart = actionIndex + actionMatch[0].length;
        const searchEnd = Math.min(searchStart + 30000, rawHtml.length);
        const searchRegion = rawHtml.substring(searchStart, searchEnd);
        
        // 查找 "Rewards are distributed" 开头的 description
        // 直接在原始 HTML 中查找（不限制在 searchRegion 中）
        const fullRewardsIndex = rawHtml.indexOf('Rewards are distributed', searchStart);
        if (fullRewardsIndex > 0 && fullRewardsIndex < searchStart + 30000) {
          // 向前查找 "children"，向后查找结束引号
          const beforeRewards = rawHtml.substring(Math.max(0, fullRewardsIndex - 200), fullRewardsIndex);
          const childrenMatch = beforeRewards.match(/(?:\\?")?children(?:\\?")?\s*:\s*(?:\\?")/);
          
          if (childrenMatch) {
            // description 文本从 "Rewards are distributed" 开始
            const descStart = fullRewardsIndex;
            let descEnd = descStart;
            let foundEnd = false;
            
            // 向后查找结束引号（在 "Rewards are distributed..." 之后）
            // 方法：查找 "Threshold)" 或类似模式，然后找到后面的第一个 }
            // 在 HTML 中，\" 是转义的引号，所以我们需要找到真正的结束位置
            const thresholdPattern = /Threshold\)/i;
            const thresholdMatch = rawHtml.substring(descStart, descStart + 200).match(thresholdPattern);
            
            if (thresholdMatch) {
              const thresholdEnd = descStart + thresholdMatch.index! + thresholdMatch[0].length;
              // 在 Threshold) 之后查找第一个 }，然后向前找到对应的引号
              const afterThreshold = rawHtml.substring(thresholdEnd, Math.min(thresholdEnd + 50, rawHtml.length));
              const closingBraceIndex = afterThreshold.indexOf('}');
              
              if (closingBraceIndex > 0) {
                // 向前查找引号（在 Threshold) 和 } 之间）
                const between = rawHtml.substring(thresholdEnd, thresholdEnd + closingBraceIndex);
                // 查找最后一个引号（可能是转义的 \"）
                const lastQuoteIndex = between.lastIndexOf('"');
                if (lastQuoteIndex > 0) {
                  // 检查这个引号是否是转义的
                  const isEscaped = lastQuoteIndex > 0 && between[lastQuoteIndex - 1] === '\\';
                  if (isEscaped) {
                    // 如果是转义的，description 应该到 Threshold) 结束
                    descEnd = thresholdEnd;
                  } else {
                    // 如果不是转义的，description 应该到这个引号
                    descEnd = thresholdEnd + lastQuoteIndex;
                  }
                  foundEnd = true;
                } else {
                  // 如果没有找到引号，description 应该到 Threshold) 结束
                  descEnd = thresholdEnd;
                  foundEnd = true;
                }
              }
            } else {
              // 如果没有找到 Threshold)，使用原来的方法
              const maxSearch = 200;
              for (let i = descStart; i < Math.min(descStart + maxSearch, rawHtml.length) && !foundEnd; i++) {
                if (rawHtml[i] === '"') {
                  const isEscaped = i > 0 && rawHtml[i - 1] === '\\';
                  if (!isEscaped && i + 1 < rawHtml.length) {
                    const nextChar = rawHtml[i + 1];
                    if (nextChar === '}' || nextChar === ']') {
                      descEnd = i;
                      foundEnd = true;
                    }
                  }
                }
              }
            }
            
            if (foundEnd) {
              const description = rawHtml.substring(descStart, descEnd)
                .replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
              
              // 验证 description
              if (description.startsWith('Rewards are distributed') && 
                  description.length > action.length && description.length > 20 && description.length < 1000) {
                campaignInfos.push({ action, description });
              }
            }
          }
        }
      }
    }
    
    // 优先级 #3：更精确的表格行匹配（备用方案）
    // 查找格式：["$","tr",...] 中包含两个 td
    if (campaignInfos.length === 0) {
      // 查找包含两个 td 的 tr 行
      const trWithTdsPattern = /"\$","tr"[^]]*"children":\[\["\\\$","td"[^]]*"children":"([^"]{3,200})"[^]]*\],\["\\\$","td"[^]]*"children":"([^"]{20,800})"[^]]*\]/g;
      const matches = [...scriptContent.matchAll(trWithTdsPattern)];
      
      for (const match of matches) {
        const action = match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
        const description = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
        
        if (action.length > 0 && description.length > action.length) {
          campaignInfos.push({ action, description });
        }
      }
    }
    
    // 去重：如果多个条目有相同的 action，只保留第一个
    const seenActions = new Set<string>();
    const uniqueInfos: MeritCampaignInfo[] = [];
    for (const info of campaignInfos) {
      if (info.action && !seenActions.has(info.action.toLowerCase())) {
        seenActions.add(info.action.toLowerCase());
        uniqueInfos.push(info);
      } else if (!info.action && info.description) {
        // 如果没有 action 但有 description，也保留
        uniqueInfos.push(info);
      }
    }
    
    return uniqueInfos.length > 0 ? uniqueInfos : [];
  } catch (error) {
    return [];
  }
}

/**
 * 获取 Merit 激励的时间范围和链接
 * 按照三层优先级策略提取数据
 * 返回包含 link、startDate、endDate、block、name 和 description 信息的对象
 */
export async function fetchMeritTimeRange(key: string): Promise<{ link: string; startDate: string; endDate: string; startBlock?: string; endBlock?: string; name?: string; message?: MeritCampaignInfo[] }> {
  const link = `https://apps.aavechan.com/merit/${key}`;
  const result: { link: string; startDate: string; endDate: string; startBlock?: string; endBlock?: string; name?: string; message?: MeritCampaignInfo[] } = {
    link,
    startDate: '',
    endDate: ''
  };
  
  try {
    // 获取页面 HTML（使用静态 fetch，name 和 date 在 SSR 中就有，不需要 Puppeteer）
    const html = await fetchMeritPageHtmlStatic(key);
    if (!html) {
      logger.warn(`⚠️ Failed to fetch HTML for key: ${key}`);
      return result;
    }
    
    // 提取 campaign 名称（使用静态 HTML，原来方法就很好，不需要 Puppeteer）
    const name = extractCampaignName(html);
    
    // 优先级 #1：使用 browser rendering 提取 campaign info（最可靠，不依赖文字匹配）
    let message = await extractCampaignInfoWithBrowser(key);
    
    // 优先级 #2：如果 browser rendering 失败，尝试从 HTML DOM 表格提取
    if (message.length === 0) {
      const $ = cheerio.load(html);
      $('table tbody tr').each((_index: number, element: any) => {
        const tds = $(element).find('td');
        if (tds.length >= 2) {
          const action = $(tds[0]).text().trim();
          const description = $(tds[1]).text().trim();
          if (action && description && action.length > 0 && description.length > 0) {
            message.push({ action, description });
          }
        }
      });
    }
    
    // 优先级 #3：最后方案 - 使用正则表达式从 HTML 中提取（不推荐，因为无法预设所有文字内容）
    if (message.length === 0) {
      message = extractCampaignInfo(html);
    }
    
    if (name) {
      result.name = name;
    }
    if (message.length > 0) {
      result.message = message;
    }
    
    // 优先级 #1：从 DOM 直接提取日期（基于 class "text-xs whitespace-nowrap" 的 span 元素）
    let dates = extractDatesFromDom(html);
    if (dates.startDate && dates.endDate) {
      result.startDate = dates.startDate;
      result.endDate = dates.endDate;
      
      // 同时尝试提取区块号（用于 CSV，不放入接口）
      const blocks = extractBlockNumbers(html);
      if (blocks.startBlock) result.startBlock = blocks.startBlock;
      if (blocks.endBlock) result.endBlock = blocks.endBlock;
      
      return result;
    }
    
    // 优先级 #2：使用正则表达式匹配各种日期格式
    dates = extractDatesWithRegex(html);
    if (dates.startDate && dates.endDate) {
      result.startDate = dates.startDate;
      result.endDate = dates.endDate;
      
      // 同时尝试提取区块号
      const blocks = extractBlockNumbers(html);
      if (blocks.startBlock) result.startBlock = blocks.startBlock;
      if (blocks.endBlock) result.endBlock = blocks.endBlock;
      
      return result;
    }
    
    // 优先级 #3：提取区块号并通过链查询转换为日期
    const blocks = extractBlockNumbers(html);
    if (blocks.startBlock || blocks.endBlock) {
      
      if (blocks.startBlock) result.startBlock = blocks.startBlock;
      if (blocks.endBlock) result.endBlock = blocks.endBlock;
      
      // 尝试通过 RPC 获取区块时间戳
      const parts = key.split('-');
      const chainName = parts[0];
      const blockDates = await convertBlocksToDates(blocks.startBlock, blocks.endBlock, chainName);
      if (blockDates.startDate) result.startDate = blockDates.startDate;
      if (blockDates.endDate) result.endDate = blockDates.endDate;
      
      // 如果仍然没有日期，使用空字符串（必填字段）
      if (!result.startDate) result.startDate = '';
      if (!result.endDate) result.endDate = '';
      
      return result;
    }
    
    logger.warn(`⚠️ Could not extract time range information for key: ${key}`);
    // 即使没有找到，也返回默认值（必填字段）
    return result;
    
  } catch (error) {
    logger.error(`❌ Error fetching time range for key ${key}:`, error);
    return result;
  }
}

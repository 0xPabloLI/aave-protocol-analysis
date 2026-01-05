import fetch from 'node-fetch';
import { logger } from './logger.js';

export interface MeritAPRResponse {
  previousAPR: any;
  currentAPR: {
    actionsAPR: Record<string, number | null>;
  };
}

// Merit 数据项结构
export interface MeritDataItem {
  meritSupplyApr: string[];
  meritBorrowApr: string[];
  meritSelfSupply: string[];
  meritSelfBorrow: string[];
  meritSupplyWithBorrowRequirement: Array<{
    apr: string;
    requiredBorrowTokens: string[];
    isSelf?: boolean;
  }>;
  meritBorrowWithSupplyRequirement: Array<{
    apr: string;
    requiredSupplyTokens: string[];
    isSelf?: boolean;
  }>;
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
 * 辅助函数：根据 isSelfFormat 添加 APR 值
 * 作用：将 APR 值添加到对应的数组中
 * 重要：使用 push() 方法，意味着如果同一个 chain-token 的同一字段被多次调用，所有值都会累积
 * 例如：如果 "ethereum-weth" 的 supply APR 被调用 3 次（值分别为 "5.2", "1.0", "0.5"）
 *       那么 meritSupplyApr 最终会是 ["5.2", "1.0", "0.5"]
 */
export function addAprValue(incentives: MeritDataItem, aprValue: string, isSupply: boolean, isSelfFormat: boolean) {
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

/**
 * 获取 Merit APR 数据并构建索引
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
          meritSupplyWithBorrowRequirement: [],
          meritBorrowWithSupplyRequirement: []
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

import { Request, Response } from 'express';
import { dataService } from '../services/dataService.js';
import { fetchAaveMarketsData } from '../../../dist/index.js';
import { MarketsResponse, MarketWithSpread, UpdateStatus } from '../types/index.js';

/**
 * 排序和筛选数据
 */
function sortAndFilterData(
  data: MarketWithSpread[],
  sort?: string,
  order: 'asc' | 'desc' = 'desc',
  chain?: string,
  market?: string,
  token?: string,
  minSupplyApy?: number,
  maxBorrowApy?: number
): MarketWithSpread[] {
  // First, filter out invalid entries (missing required fields)
  let filtered = data.filter((item) => {
    return (
      item.marketName &&
      item.marketName.trim() !== '' &&
      item.chainName &&
      item.chainName.trim() !== '' &&
      item.tokenSymbol &&
      item.tokenSymbol.trim() !== ''
    );
  });

  // 按链筛选
  if (chain) {
    const chains = chain.split(',').map(c => c.trim().toLowerCase());
    filtered = filtered.filter(item => 
      chains.includes(item.chainName.toLowerCase())
    );
  }

  // 按市场筛选
  if (market) {
    const markets = market.split(',').map(m => m.trim());
    filtered = filtered.filter(item => {
      const marketKey = `${item.marketName}-${item.chainName}`;
      return markets.includes(marketKey);
    });
  }

  // 按代币符号搜索
  if (token) {
    const tokenLower = token.toLowerCase();
    filtered = filtered.filter(item =>
      item.tokenSymbol.toLowerCase().includes(tokenLower) ||
      item.tokenName.toLowerCase().includes(tokenLower)
    );
  }

  // 最小 Supply APY 筛选
  if (minSupplyApy !== undefined) {
    filtered = filtered.filter(item => {
      const supplyApy = item.totalSupplyApy * 100; // 转换为百分比
      return supplyApy >= minSupplyApy;
    });
  }

  // 最大 Borrow APY 筛选
  if (maxBorrowApy !== undefined) {
    filtered = filtered.filter(item => {
      if (item.totalBorrowApy === null) return false;
      const borrowApy = item.totalBorrowApy * 100; // 转换为百分比
      return borrowApy <= maxBorrowApy;
    });
  }

  // 排序
  if (sort) {
    filtered.sort((a, b) => {
      let aVal: number | null = null;
      let bVal: number | null = null;

      switch (sort) {
        case 'totalSupplyApy':
          aVal = a.totalSupplyApy;
          bVal = b.totalSupplyApy;
          break;
        case 'totalBorrowApy':
          aVal = a.totalBorrowApy;
          bVal = b.totalBorrowApy;
          break;
        case 'apySpread':
          aVal = a.apySpread;
          bVal = b.apySpread;
          break;
        case 'supplyApy':
          aVal = parseFloat(a.supplyApy) / 100;
          bVal = parseFloat(b.supplyApy) / 100;
          break;
        case 'borrowApy':
          aVal = a.borrowApy ? parseFloat(a.borrowApy) / 100 : null;
          bVal = b.borrowApy ? parseFloat(b.borrowApy) / 100 : null;
          break;
        default:
          return 0;
      }

      // 处理 null 值
      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return 1; // null 值排在最后
      if (bVal === null) return -1;

      const diff = aVal - bVal;
      return order === 'asc' ? diff : -diff;
    });
  }

  return filtered;
}

/**
 * GET /api/markets
 * 获取所有市场数据
 */
export async function getMarkets(req: Request, res: Response): Promise<void> {
  try {
    const {
      sort,
      order = 'desc',
      chain,
      market,
      token,
      minSupplyApy,
      maxBorrowApy,
    } = req.query;

    // 获取数据
    const data = await dataService.getData();
    
    // 排序和筛选
    const sortedData = sortAndFilterData(
      data,
      sort as string | undefined,
      (order as 'asc' | 'desc') || 'desc',
      chain as string | undefined,
      market as string | undefined,
      token as string | undefined,
      minSupplyApy !== undefined ? parseFloat(minSupplyApy as string) : undefined,
      maxBorrowApy !== undefined ? parseFloat(maxBorrowApy as string) : undefined
    );

    const lastUpdated = dataService.getLastUpdated();
    const isStale = dataService.isStale();

    const response: MarketsResponse = {
      data: sortedData,
      lastUpdated: lastUpdated?.toISOString() || new Date().toISOString(),
      isStale,
      updateInProgress: getUpdateStatus().status === 'updating',
    };

    res.json(response);
  } catch (error) {
    console.error('Error getting markets:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * GET /api/markets/stats
 * 获取统计信息
 */
export async function getStats(req: Request, res: Response): Promise<void> {
  try {
    const data = await dataService.getData();

    // 统计链数
    const chains = new Set(data.map(item => item.chainName));
    
    // 统计代币数
    const tokens = new Set(data.map(item => item.tokenSymbol));

    res.json({
      totalMarkets: data.length,
      totalChains: chains.size,
      totalTokens: tokens.size,
      chains: Array.from(chains).sort(),
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * GET /api/chains
 * 获取所有链列表
 */
export async function getChains(req: Request, res: Response): Promise<void> {
  try {
    const data = await dataService.getData();
    const chains = new Set(data.map(item => item.chainName));
    res.json(Array.from(chains).sort());
  } catch (error) {
    console.error('Error getting chains:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * GET /api/markets/list
 * 获取所有市场列表（用于前端过滤器）
 */
export async function getMarketsList(req: Request, res: Response): Promise<void> {
  try {
    const data = await dataService.getData();
    const marketsMap = new Map<string, { marketName: string; chainName: string }>();
    
    data.forEach(item => {
      const key = `${item.marketName}-${item.chainName}`;
      if (!marketsMap.has(key)) {
        marketsMap.set(key, {
          marketName: item.marketName,
          chainName: item.chainName,
        });
      }
    });
    
    const markets = Array.from(marketsMap.values());
    res.json(markets);
  } catch (error) {
    console.error('Error getting markets list:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// 更新状态管理
let updateStatus: UpdateStatus = {
  status: 'idle',
  lastUpdated: null,
  lastSuccessfulUpdate: null,
};

export function getUpdateStatus(): UpdateStatus {
  return updateStatus;
}

export function setUpdateStatus(status: UpdateStatus): void {
  updateStatus = status;
}

/**
 * POST /api/markets/refresh
 * 手动触发数据刷新
 */
export async function refreshMarkets(req: Request, res: Response): Promise<void> {
  const currentStatus = getUpdateStatus();
  
  // 如果正在更新中，返回状态
  if (currentStatus.status === 'updating') {
    res.json({
      status: 'updating',
      message: 'Update already in progress',
      lastUpdated: currentStatus.lastUpdated,
    });
    return;
  }

  // 异步触发更新
  setUpdateStatus({
    status: 'updating',
    lastUpdated: currentStatus.lastUpdated,
    lastSuccessfulUpdate: currentStatus.lastSuccessfulUpdate,
  });

  // 立即返回，不等待更新完成
  res.json({
    status: 'updating',
    message: 'Update started',
    lastUpdated: currentStatus.lastUpdated,
  });

  // 在后台执行更新
  fetchAaveMarketsData()
    .then(async () => {
      // 更新成功后刷新缓存
      await dataService.refreshCache();
      const lastUpdated = dataService.getLastUpdated();
      const newStatus = getUpdateStatus();
      
      setUpdateStatus({
        status: 'idle',
        lastUpdated: lastUpdated?.toISOString() || null,
        lastSuccessfulUpdate: lastUpdated?.toISOString() || null,
      });
    })
    .catch((error) => {
      console.error('Error refreshing markets:', error);
      const newStatus = getUpdateStatus();
      setUpdateStatus({
        status: 'error',
        lastUpdated: newStatus.lastUpdated,
        lastSuccessfulUpdate: newStatus.lastSuccessfulUpdate,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}


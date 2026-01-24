import { Request, Response } from 'express';
import { dataService } from '../services/dataService.js';
import { fetchAaveMarketsData } from '../../../dist/index.js';
import { MarketsResponse, MarketWithSpread, UpdateStatus } from '../types/index.js';
import { withTimeout, UPDATE_TIMEOUT_MS } from '../utils/timeout.js';

/**
 * 检查数据新鲜度并在需要时自动更新
 * 使用锁机制防止并发更新
 */
async function checkAndUpdateDataIfStale(): Promise<void> {
  const isStale = dataService.isStale();
  const currentStatus = getUpdateStatus();

  // 如果数据过期且没有正在进行的更新，触发更新
  if (isStale && currentStatus.status !== 'updating') {
    console.log('🔄 Data is stale, triggering automatic update...');

    // 设置更新状态（作为锁）
    setUpdateStatus({
      status: 'updating',
      lastUpdated: currentStatus.lastUpdated,
      lastSuccessfulUpdate: currentStatus.lastSuccessfulUpdate,
    });

    // 执行更新，等待完成（带超时保护，避免因 Cloudflare 重试等导致的长时间阻塞）
    try {
      await withTimeout(fetchAaveMarketsData(), UPDATE_TIMEOUT_MS);

      // 更新成功后刷新缓存
      await dataService.refreshCache();
      const lastUpdated = dataService.getLastUpdated();

      setUpdateStatus({
        status: 'idle',
        lastUpdated: lastUpdated?.toISOString() || null,
        lastSuccessfulUpdate: lastUpdated?.toISOString() || null,
      });

      console.log('✅ Automatic update completed successfully');
    } catch (error) {
      console.error('❌ Automatic update failed:', error);
      const errorStatus = getUpdateStatus();
      
      // 如果是超时错误，特别标记
      const isTimeout = error instanceof Error && error.message.includes('timeout');
      if (isTimeout) {
        console.warn(`⏰ Update timed out after ${UPDATE_TIMEOUT_MS / 1000}s, resetting status to allow next update`);
      }
      
      setUpdateStatus({
        status: 'error',
        lastUpdated: errorStatus.lastUpdated,
        lastSuccessfulUpdate: errorStatus.lastSuccessfulUpdate,
        error: error instanceof Error ? error.message : String(error),
      });
      // 更新失败时继续使用缓存数据
      console.log('⚠️  Continuing with cached data after update failure');
    }
  } else if (currentStatus.status === 'updating') {
    console.log('⏳ Update already in progress, waiting...');
    // 如果已经有更新在进行，等待一小段时间让更新完成
    // 这样可以避免返回过期数据
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

/**
 * GET /api/markets
 * 获取所有市场数据
 * 自动检查数据新鲜度，如果超过1分钟则触发更新
 * 
 * 注意：所有排序和过滤逻辑已移至客户端处理，此端点不再接受查询参数
 */
export async function getMarkets(req: Request, res: Response): Promise<void> {
  try {
    // 检查数据新鲜度并自动更新
    await checkAndUpdateDataIfStale();

    // 获取数据（可能是刚更新的，也可能是缓存的）
    const data = await dataService.getData();

    // 过滤无效条目（缺少必需字段）
    const filteredData = data.filter((item) => {
      return (
        item.marketName &&
        item.marketName.trim() !== '' &&
        item.chainName &&
        item.chainName.trim() !== '' &&
        item.tokenSymbol &&
        item.tokenSymbol.trim() !== ''
      );
    });

    const lastUpdated = dataService.getLastUpdated();
    const isStale = dataService.isStale();

    const response: MarketsResponse = {
      data: filteredData,
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
 * 自动检查数据新鲜度，如果超过1分钟则触发更新
 */
export async function getStats(req: Request, res: Response): Promise<void> {
  try {
    // 检查数据新鲜度并自动更新
    await checkAndUpdateDataIfStale();

    const data = await dataService.getData();

    // 统计链数
    const chains = new Set(data.map(item => item.chainName));

    // 统计代币数
    const tokens = new Set(data.map(item => item.tokenSymbol));

    res.json({
      totalPools: data.length,
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
 * 自动检查数据新鲜度，如果超过1分钟则触发更新
 */
export async function getChains(req: Request, res: Response): Promise<void> {
  try {
    // 检查数据新鲜度并自动更新
    await checkAndUpdateDataIfStale();

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
 * 自动检查数据新鲜度，如果超过1分钟则触发更新
 */
export async function getMarketsList(req: Request, res: Response): Promise<void> {
  try {
    // 检查数据新鲜度并自动更新
    await checkAndUpdateDataIfStale();

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

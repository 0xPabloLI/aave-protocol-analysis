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
  let isStale = dataService.isStale();
  let currentStatus = getUpdateStatus();

  // 检查是否有卡住的更新（运行时间超过最大允许时间）
  // 如果更新超过最大时间，清除锁以允许新更新启动
  // 这样可以防止永久锁定，即使原始 promise 永远不会解析
  if (activeUpdatePromise && updateStartTime !== null) {
    const elapsed = Date.now() - updateStartTime;
    if (elapsed >= MAX_UPDATE_TIME_MS) {
      console.warn(`⚠️  Active update has been running for ${elapsed}ms (max: ${MAX_UPDATE_TIME_MS}ms), clearing lock to allow new updates...`);
      // 清除锁，允许新更新启动（原始 promise 仍在后台运行，但不阻塞新更新）
      activeUpdatePromise = null;
      updateStartTime = null;
      // 更新状态为错误
      setUpdateStatus({
        status: 'error',
        lastUpdated: currentStatus.lastUpdated,
        lastSuccessfulUpdate: currentStatus.lastSuccessfulUpdate,
        error: 'Update exceeded maximum time limit',
      });
      // 刷新状态快照，确保后续检查使用最新状态
      currentStatus = getUpdateStatus();
    }
  }

  // 如果有正在进行的更新，等待它完成
  if (activeUpdatePromise) {
    console.log('⏳ Update already in progress, waiting for completion...');
    try {
      await activeUpdatePromise;
    } catch {
      // 忽略错误，已经由更新函数处理
    }
    // 等待完成后，刷新状态快照并重新检查条件
    // 这是必要的，因为：1) 状态可能在等待期间被更新，2) 另一个请求可能已经启动了新更新
    currentStatus = getUpdateStatus();
    isStale = dataService.isStale(); // 重新检查数据是否过期
    // 如果等待后仍有活动更新或数据不再过期，直接返回
    if (activeUpdatePromise || !isStale) {
      return;
    }
    // 继续执行，检查是否需要触发新更新
  }

  // 如果数据过期且没有正在进行的更新，触发更新
  // 使用最新的状态快照（可能在上面被重置后更新）
  // 重要：在创建更新前再次检查 activeUpdatePromise，防止竞态条件
  if (isStale && !activeUpdatePromise && currentStatus.status !== 'updating') {
    console.log('🔄 Data is stale, triggering automatic update...');

    // 设置更新状态（作为锁）
    setUpdateStatus({
      status: 'updating',
      lastUpdated: currentStatus.lastUpdated,
      lastSuccessfulUpdate: currentStatus.lastSuccessfulUpdate,
    });
    
    // 刷新状态快照，确保后续检查使用最新状态
    currentStatus = getUpdateStatus();

    // 创建更新 Promise 并立即跟踪它
    // 关键：即使超时，也要等待原始 promise 完成，保持状态为 'updating' 直到完成
    const originalUpdatePromise = fetchAaveMarketsData();
    let timeoutOccurred = false;
    let timeoutId: NodeJS.Timeout | null = null;
    
    const updatePromise = (async () => {
      try {
        // 设置超时检测（只标记，不取消 promise）
        timeoutId = setTimeout(() => {
          timeoutOccurred = true;
          console.warn(`⏰ Update timed out after ${UPDATE_TIMEOUT_MS / 1000}s, but operation continues in background...`);
        }, UPDATE_TIMEOUT_MS);
        
        // 等待原始 promise 完成（无论是否超时）
        await originalUpdatePromise;
        
        // 清理超时定时器
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        
        // 更新成功后刷新缓存
        await dataService.refreshCache();
        const lastUpdated = dataService.getLastUpdated();

        if (timeoutOccurred) {
          console.log('⚠️  Update completed after timeout');
        }
        
        setUpdateStatus({
          status: 'idle',
          lastUpdated: lastUpdated?.toISOString() || null,
          lastSuccessfulUpdate: lastUpdated?.toISOString() || null,
        });
        console.log('✅ Automatic update completed successfully');
      } catch (error) {
        // 清理超时定时器
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        
        console.error('❌ Automatic update failed:', error);
        const errorStatus = getUpdateStatus();
        
        const errorMessage = timeoutOccurred
          ? `Update timeout after ${UPDATE_TIMEOUT_MS / 1000}s and then failed: ${error instanceof Error ? error.message : String(error)}`
          : (error instanceof Error ? error.message : String(error));
        
        setUpdateStatus({
          status: 'error',
          lastUpdated: errorStatus.lastUpdated,
          lastSuccessfulUpdate: errorStatus.lastSuccessfulUpdate,
          error: errorMessage,
        });
        // 更新失败时继续使用缓存数据
        console.log('⚠️  Continuing with cached data after update failure');
      } finally {
        // 清理超时定时器（确保清理）
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
        // 清除活动更新跟踪
        activeUpdatePromise = null;
        updateStartTime = null;
      }
    })();

    // 跟踪活动更新
    activeUpdatePromise = updatePromise;
    updateStartTime = Date.now();
    
    // 不等待 promise 完成，让调用者可以继续
    // 但通过 activeUpdatePromise 跟踪，防止并发
    updatePromise.catch(() => {
      // 错误已经在 promise 内部处理
    });
  } else if (getUpdateStatus().status === 'updating') {
    // 使用最新的状态检查，而不是可能过时的 currentStatus
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

// 跟踪当前正在执行的更新 Promise，防止并发更新
let activeUpdatePromise: Promise<void> | null = null;
let updateStartTime: number | null = null;
// 最大允许的更新时间（超时时间的 2 倍，用于强制重置卡住的更新）
const MAX_UPDATE_TIME_MS = UPDATE_TIMEOUT_MS * 2;

export function getUpdateStatus(): UpdateStatus {
  return updateStatus;
}

export function setUpdateStatus(status: UpdateStatus): void {
  updateStatus = status;
}

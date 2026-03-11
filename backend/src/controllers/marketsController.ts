import { Request, Response } from 'express';
import { dataService } from '../services/dataService.js';
import { fetchAaveMarketsData } from '../../../dist/index.js';
import { MarketsResponse, MarketWithSpread, UpdateStatus } from '../types/index.js';
import { withTimeout, UPDATE_TIMEOUT_MS } from '../utils/timeout.js';
import { logger } from '../logger.js';

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
      logger.warn(`⚠️  Active update has been running for ${elapsed}ms (max: ${MAX_UPDATE_TIME_MS}ms), clearing lock to allow new updates...`);
      // 增加生成计数器，标记当前更新已过期
      // 这样当原始 promise 完成时，可以检测到已经有新更新启动
      updateGeneration++;
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
    logger.info('⏳ Update already in progress, waiting for completion...');
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
    if (activeUpdatePromise !== null || !isStale) {
      return;
    }
    // 继续执行，检查是否需要触发新更新
  }

  // 如果数据过期且没有正在进行的更新，触发更新
  // 使用最新的状态快照（可能在上面被重置后更新）
  // 重要：在创建更新前再次检查 activeUpdatePromise，防止竞态条件
  if (isStale && !activeUpdatePromise && currentStatus.status !== 'updating') {
    // 获取调用栈信息，帮助追踪更新来源
    const stack = new Error().stack?.split('\n').slice(2, 5).join(' -> ') || 'unknown';
    logger.info(`🔄 Data is stale, triggering automatic update... [triggered by: ${stack}]`);

    // 设置更新状态（作为锁）
    setUpdateStatus({
      status: 'updating',
      lastUpdated: currentStatus.lastUpdated,
      lastSuccessfulUpdate: currentStatus.lastSuccessfulUpdate,
    });
    
    // 刷新状态快照，确保后续检查使用最新状态
    currentStatus = getUpdateStatus();
    logger.info(`📝 Update status set to 'updating' at ${new Date().toISOString()}, generation=${updateGeneration}`);

    // 创建更新 Promise 并立即跟踪它
    // 关键：即使超时，也要等待原始 promise 完成，保持状态为 'updating' 直到完成
    const originalUpdatePromise = fetchAaveMarketsData();
    // 捕获当前更新生成号，用于检测是否有新更新启动
    const currentGeneration = updateGeneration;
    let timeoutOccurred = false;
    let timeoutId: NodeJS.Timeout | null = null;
    
    // 创建更新 promise，使用立即执行函数来正确捕获 promise 引用
    const updatePromise = (() => {
      // 创建一个变量来存储 promise 引用，用于 finally 块中的比较
      let promiseRef: Promise<void> | null = null;
      
      const promise = (async () => {
        try {
          logger.info(`📊 Starting fetchAaveMarketsData() at ${new Date().toISOString()}, generation=${currentGeneration}`);
          // 设置超时检测（只标记，不取消 promise）
          timeoutId = setTimeout(() => {
            timeoutOccurred = true;
            logger.warn(`⏰ Update timed out after ${UPDATE_TIMEOUT_MS / 1000}s, but operation continues in background... [generation=${currentGeneration}]`);
          }, UPDATE_TIMEOUT_MS);
          
          // 等待原始 promise 完成（无论是否超时）
          await originalUpdatePromise;
          logger.info(`✅ fetchAaveMarketsData() completed at ${new Date().toISOString()}, generation=${currentGeneration}`);
          
          // 清理超时定时器
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          
          // 检查是否有新更新已启动（通过生成计数器检测）
          // 如果有新更新，不更新状态，避免用旧数据覆盖新更新的状态
          if (updateGeneration !== currentGeneration) {
            logger.warn('⚠️  Update completed but newer update has started, skipping status update to avoid overwriting');
            return;
          }
          
          // 更新成功后刷新缓存
          await dataService.refreshCache();
          const lastUpdated = dataService.getLastUpdated();

          if (timeoutOccurred) {
            logger.warn('⚠️  Update completed after timeout');
          }
          
          // 再次检查生成号（可能在 refreshCache 期间有新更新）
          if (updateGeneration !== currentGeneration) {
            logger.warn('⚠️  Update completed but newer update started during cache refresh, skipping status update');
            return;
          }
          
          setUpdateStatus({
            status: 'idle',
            lastUpdated: lastUpdated?.toISOString() || null,
            lastSuccessfulUpdate: lastUpdated?.toISOString() || null,
          });
          logger.info('✅ Automatic update completed successfully');
        } catch (error) {
          // 清理超时定时器
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          
          // 检查是否有新更新已启动
          if (updateGeneration !== currentGeneration) {
            logger.warn('⚠️  Update failed but newer update has started, skipping status update to avoid overwriting');
            return;
          }
          
          logger.error('❌ Automatic update failed:', error);
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
          logger.warn('⚠️  Continuing with cached data after update failure');
        } finally {
          // 清理超时定时器（确保清理）
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
          // 清除跟踪：如果 activeUpdatePromise 仍然指向当前 promise，则清除它
          // 这样可以防止已完成的旧 promise 阻塞后续检查
          // 即使有新更新启动（updateGeneration 改变），如果 activeUpdatePromise 仍然指向当前 promise，
          // 说明新更新还没有设置它的 promise，或者已经被其他逻辑清除，此时应该清除当前 promise
          // 注意：在 finally 块中直接使用 promiseRef，此时它已经被赋值为当前 promise
          if (activeUpdatePromise === promiseRef) {
            logger.info(`🧹 Clearing activeUpdatePromise at ${new Date().toISOString()}, generation=${currentGeneration}, currentGeneration=${updateGeneration}`);
            activeUpdatePromise = null;
            updateStartTime = null;
          } else {
            logger.warn(`⚠️  activeUpdatePromise was already cleared or replaced (generation=${currentGeneration}, currentGeneration=${updateGeneration})`);
          }
        }
      })();
      
      // 存储 promise 引用到闭包变量中，用于 finally 块中的比较
      promiseRef = promise;
      return promise;
    })();

    // 跟踪活动更新
    // 重要：在设置新 promise 之前，如果存在旧的 promise 引用，先清除它
    // 这样可以防止旧 promise（即使已完成）阻塞后续检查
    // 新更新启动时，应该立即替换旧的 promise 引用
    activeUpdatePromise = updatePromise;
    updateStartTime = Date.now();
    logger.info(`🚀 Update promise started at ${new Date().toISOString()}, generation=${updateGeneration}, timeout=${UPDATE_TIMEOUT_MS / 1000}s`);
    
    // 不等待 promise 完成，让调用者可以继续
    // 但通过 activeUpdatePromise 跟踪，防止并发
    updatePromise.catch(() => {
      // 错误已经在 promise 内部处理
    });
  } else if (getUpdateStatus().status === 'updating') {
    // 使用最新的状态检查，而不是可能过时的 currentStatus
    const elapsed = updateStartTime ? Date.now() - updateStartTime : 0;
    const hasActivePromise = activeUpdatePromise !== null;
    logger.info(`⏳ Update already in progress (status='updating', hasActivePromise=${hasActivePromise}, elapsed=${Math.round(elapsed / 1000)}s, generation=${updateGeneration}), waiting...`);
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
    const rawTokenPrices = dataService.getTokenPrices();
    const tokenPrices = rawTokenPrices
      ? Object.fromEntries(
          Object.entries(rawTokenPrices).map(([key, entry]) => [
            key,
            { price: entry.price },
          ])
        )
      : undefined;

    const response: MarketsResponse = {
      data: filteredData,
      lastUpdated: lastUpdated?.toISOString() || new Date().toISOString(),
      tokenPrices,
    };

    res.json(response);
  } catch (error) {
    logger.error('Error getting markets:', error);
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
// 更新生成计数器，用于防止超时的更新覆盖新更新的状态
let updateGeneration: number = 0;
// 最大允许的更新时间（超时时间的 2 倍，用于强制重置卡住的更新）
const MAX_UPDATE_TIME_MS = UPDATE_TIMEOUT_MS * 2;

export function getUpdateStatus(): UpdateStatus {
  return updateStatus;
}

export function setUpdateStatus(status: UpdateStatus): void {
  updateStatus = status;
}

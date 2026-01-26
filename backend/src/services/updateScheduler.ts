import cron from 'node-cron';
import { fetchAaveMarketsData } from '../../../dist/index.js';
import { dataService } from './dataService.js';
import { setUpdateStatus, getUpdateStatus } from '../controllers/marketsController.js';
import { UPDATE_TIMEOUT_MS } from '../utils/timeout.js';
import { logger } from '../logger.js';

// 跟踪定时任务启动的更新时间，用于检测卡住的更新
let scheduledUpdateStartTime: number | null = null;
// 当前更新的唯一 ID，用于检测是否有新更新启动
let currentScheduledUpdateId: number = 0;
// 最大允许的更新时间（超时时间的 2 倍，用于强制重置卡住的更新）
const MAX_UPDATE_TIME_MS = UPDATE_TIMEOUT_MS * 2;

/**
 * 启动定时更新任务
 * 每 1 分钟执行一次数据更新
 * 注意：此定时任务作为后备机制，主要的数据更新由 API 请求自动触发
 */
export function startUpdateScheduler(): void {
  logger.info('📅 Starting update scheduler (every 1 minute) as backup mechanism');

  // 每 1 分钟执行一次
  // node-cron 3.0.3 支持 6 位 cron 表达式（包含秒字段）
  // 使用 '0 * * * * *' 表示每分钟的第0秒执行（等价于 5 位表达式的 '*/1 * * * *'）
  cron.schedule('0 * * * * *', async () => {
    const currentStatus = getUpdateStatus();

    // 检查是否有卡住的更新（运行时间超过最大允许时间）
    // 如果更新超过最大时间，重置状态以允许新更新启动
    if (currentStatus.status === 'updating' && scheduledUpdateStartTime !== null) {
      const elapsed = Date.now() - scheduledUpdateStartTime;
      if (elapsed >= MAX_UPDATE_TIME_MS) {
        logger.warn(`⚠️  Scheduled update has been running for ${elapsed}ms (max: ${MAX_UPDATE_TIME_MS}ms), resetting status to allow new updates...`);
        // 重置状态为错误，允许新更新启动
        setUpdateStatus({
          status: 'error',
          lastUpdated: currentStatus.lastUpdated,
          lastSuccessfulUpdate: currentStatus.lastSuccessfulUpdate,
          error: 'Scheduled update exceeded maximum time limit',
        });
        scheduledUpdateStartTime = null;
        // 继续执行，检查是否需要触发新更新
      } else {
        // 如果正在更新中且未超时，跳过本次更新
        logger.info('⏭️  Update in progress, skipping scheduled update');
        return;
      }
    } else if (currentStatus.status === 'updating') {
      // 如果状态是 'updating' 但没有跟踪开始时间，可能是由 API 请求触发的更新
      // 这种情况下，我们仍然跳过，让 API 触发的更新完成
      const detailedStatus = getUpdateStatus();
      const elapsed = scheduledUpdateStartTime ? Date.now() - scheduledUpdateStartTime : 'unknown';
      logger.info(`⏭️  Update in progress (triggered by API), skipping scheduled update [status=${detailedStatus.status}, elapsed=${elapsed}ms, error=${detailedStatus.error || 'none'}, lastUpdated=${detailedStatus.lastUpdated || 'never'}]`);
      return;
    }

    // 检查数据是否过期
    const isStale = dataService.isStale();
    if (!isStale) {
      logger.info('✅ Data is fresh, skipping scheduled update');
      return;
    }

    logger.info('🔄 Starting scheduled data update (backup mechanism)...');

    // 记录更新开始时间，用于检测卡住的更新
    scheduledUpdateStartTime = Date.now();
    // 生成新的更新 ID，用于检测是否有新更新启动
    currentScheduledUpdateId++;
    const thisUpdateId = currentScheduledUpdateId;
    logger.info(`📝 Scheduled update started: id=${thisUpdateId}, time=${new Date().toISOString()}`);

    setUpdateStatus({
      status: 'updating',
      lastUpdated: currentStatus.lastUpdated,
      lastSuccessfulUpdate: currentStatus.lastSuccessfulUpdate,
    });

    // 启动更新 promise 并跟踪超时
    // 注意：即使超时，也继续等待原始 promise 完成，以确保缓存被刷新
    const originalUpdatePromise = fetchAaveMarketsData();
    let timeoutOccurred = false;
    let timeoutId: NodeJS.Timeout | null = null;
    
    try {
      // 设置超时检测（只标记，不取消 promise）
      timeoutId = setTimeout(() => {
        timeoutOccurred = true;
        logger.warn(`⏰ Scheduled update timed out after ${UPDATE_TIMEOUT_MS / 1000}s, but operation continues in background...`);
        // 超时后设置状态为错误，但继续等待 promise 完成
        const currentStatus = getUpdateStatus();
        setUpdateStatus({
          status: 'error',
          lastUpdated: currentStatus.lastUpdated,
          lastSuccessfulUpdate: currentStatus.lastSuccessfulUpdate,
          error: `Update timeout after ${UPDATE_TIMEOUT_MS / 1000}s`,
        });
      }, UPDATE_TIMEOUT_MS);
      
      // 等待原始 promise 完成（无论是否超时）
      // 这样可以确保即使超时，如果更新最终成功，缓存也会被刷新
      await originalUpdatePromise;
      
      // 清理超时定时器
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      
      // 更新成功后刷新缓存（即使已经超时，也要刷新缓存）
      await dataService.refreshCache();
      const lastUpdated = dataService.getLastUpdated();

      // 检查是否有新更新已启动（通过更新 ID 检查）
      // 如果有新更新，不更新状态，避免用旧数据覆盖新更新的状态
      if (currentScheduledUpdateId !== thisUpdateId) {
        logger.warn(`⚠️  Scheduled update id=${thisUpdateId} completed but newer update id=${currentScheduledUpdateId} has started, skipping status update`);
        return;
      }

      if (timeoutOccurred) {
        logger.warn(`⚠️  Scheduled update id=${thisUpdateId} completed after timeout, cache refreshed`);
      }
      
      // 设置状态为 idle
      setUpdateStatus({
        status: 'idle',
        lastUpdated: lastUpdated?.toISOString() || null,
        lastSuccessfulUpdate: lastUpdated?.toISOString() || null,
      });
      scheduledUpdateStartTime = null;
      logger.info(`✅ Scheduled update id=${thisUpdateId} completed successfully, status set to idle`);
    } catch (error) {
      // 清理超时定时器
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      
      logger.error(`❌ Scheduled update id=${thisUpdateId} failed:`, error);
      
      // 检查是否有新更新已启动（通过更新 ID 检查）
      if (currentScheduledUpdateId !== thisUpdateId) {
        logger.warn(`⚠️  Scheduled update id=${thisUpdateId} failed but newer update id=${currentScheduledUpdateId} has started, skipping status update`);
        return;
      }
      
      const errorMessage = timeoutOccurred
        ? `Update timeout after ${UPDATE_TIMEOUT_MS / 1000}s and then failed: ${error instanceof Error ? error.message : String(error)}`
        : (error instanceof Error ? error.message : String(error));
      
      const currentStatusForError = getUpdateStatus();
      setUpdateStatus({
        status: 'error',
        lastUpdated: currentStatusForError.lastUpdated,
        lastSuccessfulUpdate: currentStatusForError.lastSuccessfulUpdate,
        error: errorMessage,
      });
      scheduledUpdateStartTime = null;
      logger.info(`📝 Scheduled update id=${thisUpdateId} failed, status set to error`);
    }
  });
}

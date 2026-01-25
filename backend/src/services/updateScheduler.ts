import cron from 'node-cron';
import { fetchAaveMarketsData } from '../../../dist/index.js';
import { dataService } from './dataService.js';
import { setUpdateStatus, getUpdateStatus } from '../controllers/marketsController.js';
import { UPDATE_TIMEOUT_MS } from '../utils/timeout.js';

/**
 * 启动定时更新任务
 * 每 1 分钟执行一次数据更新
 * 注意：此定时任务作为后备机制，主要的数据更新由 API 请求自动触发
 */
export function startUpdateScheduler(): void {
  console.log('📅 Starting update scheduler (every 1 minute) as backup mechanism');

  // 每 1 分钟执行一次
  // node-cron 3.0.3 支持 6 位 cron 表达式（包含秒字段）
  // 使用 '0 * * * * *' 表示每分钟的第0秒执行（等价于 5 位表达式的 '*/1 * * * *'）
  cron.schedule('0 * * * * *', async () => {
    const currentStatus = getUpdateStatus();

    // 如果正在更新中，跳过本次更新
    if (currentStatus.status === 'updating') {
      console.log('⏭️  Update in progress, skipping scheduled update');
      return;
    }

    // 检查数据是否过期
    const isStale = dataService.isStale();
    if (!isStale) {
      console.log('✅ Data is fresh, skipping scheduled update');
      return;
    }

    console.log('🔄 Starting scheduled data update (backup mechanism)...');

    setUpdateStatus({
      status: 'updating',
      lastUpdated: currentStatus.lastUpdated,
      lastSuccessfulUpdate: currentStatus.lastSuccessfulUpdate,
    });

    // 启动更新 promise 并跟踪它
    const originalUpdatePromise = fetchAaveMarketsData();
    let timeoutOccurred = false;
    let timeoutId: NodeJS.Timeout | null = null;
    
    try {
      // 设置超时检测（只标记，不取消 promise）
      timeoutId = setTimeout(() => {
        timeoutOccurred = true;
        console.warn(`⏰ Scheduled update timed out after ${UPDATE_TIMEOUT_MS / 1000}s, but operation continues in background...`);
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
        console.log('⚠️  Scheduled update completed after timeout');
      }

      setUpdateStatus({
        status: 'idle',
        lastUpdated: lastUpdated?.toISOString() || null,
        lastSuccessfulUpdate: lastUpdated?.toISOString() || null,
      });

      console.log('✅ Scheduled update completed successfully');
    } catch (error) {
      // 清理超时定时器
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      
      console.error('❌ Scheduled update failed:', error);
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
    }
  });
}

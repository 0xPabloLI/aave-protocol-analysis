/**
 * 更新超时时间：3 分钟（180000ms）
 * 如果更新超过这个时间，会被取消并重置状态，避免因 Cloudflare 重试等导致的长时间阻塞
 */
export const UPDATE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

/**
 * 为异步操作添加超时保护
 * @param promise 要执行的异步操作
 * @param timeoutMs 超时时间（毫秒）
 * @returns Promise，如果超时会 reject
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = UPDATE_TIMEOUT_MS
): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Update timeout after ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });
  
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    // 如果主 promise 先完成，清理超时定时器，防止资源泄漏
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    return result;
  } catch (error) {
    // 如果超时发生，清理定时器（虽然已经触发，但为了完整性）
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    throw error;
  }
}

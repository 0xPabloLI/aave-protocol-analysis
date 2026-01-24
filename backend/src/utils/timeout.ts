/**
 * 更新超时时间：3 分钟（180000ms）
 * 如果更新超过这个时间，会被取消并重置状态，避免因 Cloudflare 重试等导致的长时间阻塞
 */
export const UPDATE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

/**
 * 创建一个超时 Promise
 */
export function createTimeoutPromise(timeoutMs: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Update timeout after ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });
}

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
  return Promise.race([
    promise,
    createTimeoutPromise(timeoutMs),
  ]);
}

import { BACKEND_TIMEOUT_MS } from '../cacheTtl.js';

/**
 * 更新超时时间：3 分钟（180000ms）
 * 如果更新超过这个时间，会被取消并重置状态，避免因 Cloudflare 重试等导致的长时间阻塞
 */
export const UPDATE_TIMEOUT_MS = BACKEND_TIMEOUT_MS.update;

/**
 * 为更新逻辑提供统一的超时阈值，具体的超时处理逻辑在调用方实现
 */
// 目前由 `marketsController` 和 `updateScheduler` 中的调用方各自实现超时逻辑。

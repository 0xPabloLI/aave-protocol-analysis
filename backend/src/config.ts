import { BACKEND_FETCH_TIMING_MS, BACKEND_TIME_MS, BACKEND_TIME_SECONDS } from './cacheTtl.js';
import { readNumberEnv } from '@internal/aave-shared-config';

// ============================================================
// V3/V4 Equality Configuration
// ============================================================


// Merkl API 重试/退避（forecast `/campaigns/{id}`、`/metrics`）
// 出站并发：`MERKL_FETCH_MAX_CONCURRENCY`（默认 5）由 `@internal/aave-shared-config`
// 的 `createMerklConcurrencyLimitedFetch` 统一约束（opportunities、campaign、merit 侧 Merkl 等）。
//
// Rate Limit 参考：https://docs.merkl.xyz/integrate-merkl/app#api-rate-limit
// - 默认限制：10 requests/second
// - 可通过申请 API Key（X-API-Key header）提升限额
//
// 当前配置：
// - 3 次重试 + 指数退避（1s → 2s → 4s，最大 10s）
// - 覆盖 ECONNRESET / 429 / 5xx 等瞬态错误
export const merklFetchConfig = {
  maxRetries: readNumberEnv('MERKL_FETCH_MAX_RETRIES', {
    defaultValue: 3,
    min: 0,
  }),
  baseDelayMs: readNumberEnv('MERKL_FETCH_BASE_DELAY_MS', {
    defaultValue: BACKEND_FETCH_TIMING_MS.merklRetryBaseDelay,
    min: 100,
  }),
  maxDelayMs: readNumberEnv('MERKL_FETCH_MAX_DELAY_MS', {
    defaultValue: BACKEND_FETCH_TIMING_MS.merklRetryMaxDelay,
    min: 1000,
  }),
};

// Oracle 价格异常阈值：当 oracle 价格与 SDK 价格差异超过此比例时，
// 覆盖为 oracle 价格并输出 logger.warn('oracle price anomaly', ...)
// 默认 1%（0.01），可通过 ORACLE_DIFF_THRESHOLD 环境变量覆盖
export const oracleDiffConfig = {
  threshold: readNumberEnv('ORACLE_DIFF_THRESHOLD', {
    defaultValue: 0.01,
    min: 0,
  }),
};

// CoinGecko API 请求的重试/退避配置
// Rate Limit 参考：https://docs.coingecko.com/docs/common-errors-rate-limit
// - Public API (Demo/Free): 约 30 次/分钟（可能因流量波动）
// - Pro API (Paid): 根据订阅计划，例如 1000 次/分钟
// 注意：所有 API 请求（包括 4xx 和 5xx 错误）都计入每分钟的 rate limit
// 
// 当前配置针对 Free tier（30 次/分钟）：
// - 请求间隔：2.5 秒（略大于 2 秒，留有余量）
// - 串行请求：避免并发导致短时间内消耗过多配额

export const coingeckoFetchConfig = {
  maxRetries: readNumberEnv('COINGECKO_FETCH_MAX_RETRIES', {
    defaultValue: 3,
    min: 0,
  }),
  baseDelayMs: readNumberEnv('COINGECKO_FETCH_BASE_DELAY_MS', {
    defaultValue: BACKEND_FETCH_TIMING_MS.coingeckoBaseDelay, // 2秒，用于指数退避的起始延迟
    min: 0,
  }),
  maxDelayMs: readNumberEnv('COINGECKO_FETCH_MAX_DELAY_MS', {
    defaultValue: BACKEND_TIME_MS.oneMinute, // 60秒，指数退避的最大延迟
    min: 0,
  }),
  // 429 错误的最小等待时间（秒），如果 Retry-After header 不存在或更小，使用此值
  // 设置为 60 秒，因为 rate limit 是按分钟计算的（Free tier: 30 次/分钟）
  // 等待 60 秒可以确保下一个时间窗口开始时重试
  rateLimitMinWaitSeconds: readNumberEnv('COINGECKO_RATE_LIMIT_MIN_WAIT_SECONDS', {
    defaultValue: BACKEND_TIME_SECONDS.oneMinute, // Free tier: ~30 calls/minute，等待 60 秒确保进入新的时间窗口
    min: 0,
  }),
  // 请求之间的最小间隔（毫秒），用于防止超过 rate limit
  // Free tier: 30 次/分钟 = 每 2 秒一次，设置为 2.5 秒留有余量
  minRequestIntervalMs: readNumberEnv('COINGECKO_MIN_REQUEST_INTERVAL_MS', {
    defaultValue: BACKEND_FETCH_TIMING_MS.coingeckoMinRequestInterval, // 2.5 秒，确保不超过 30 次/分钟的限制
    min: BACKEND_FETCH_TIMING_MS.coingeckoMinRequestIntervalFloor, // 最少 1 秒
  }),
};

function readNumberEnv(key, options) {
    const raw = process.env[key];
    if (raw === undefined)
        return options.defaultValue;
    const value = Number(raw);
    if (!Number.isFinite(value))
        return options.defaultValue;
    if (options.min !== undefined && value < options.min)
        return options.defaultValue;
    return value;
}
function readBooleanEnv(key, defaultValue) {
    const raw = process.env[key];
    if (raw === undefined)
        return defaultValue;
    return raw === 'true';
}
// Node 应用调用 Cloudflare Worker 的速率/重试配置
export const cloudflareWorkerConfig = {
    // 最小请求间隔（用于 scheduleDynamicSlot 速率限制）
    // 注意：如果 dynamicFailFast=true，此值在 429 重试时不会使用（因为不会重试）
    dynamicMinIntervalMs: readNumberEnv('CLOUDFLARE_DYNAMIC_MIN_INTERVAL_MS', {
        defaultValue: 60000, // 60s，与 DO 侧最小新建间隔对齐
        min: 0,
    }),
    dynamicMaxRetries: readNumberEnv('CLOUDFLARE_DYNAMIC_MAX_RETRIES', {
        defaultValue: 5,
        min: 0,
    }),
    dynamicCircuitBreakerMs: readNumberEnv('CLOUDFLARE_DYNAMIC_CIRCUIT_BREAKER_MS', {
        defaultValue: 120000,
        min: 0,
    }),
    // 如果为 true，遇到 429 时立即返回 null，让调用方 fallback 到 puppeteer
    // 如果为 false，会等待 dynamicMinIntervalMs 后重试
    // 注意：即使 fail-fast，dynamicMinIntervalMs 仍用于 scheduleDynamicSlot 的速率限制
    dynamicFailFast: readBooleanEnv('CLOUDFLARE_DYNAMIC_FAIL_FAST', true),
    // Worker 请求超时时间（毫秒），超时后立即 fallback 到 puppeteer
    dynamicTimeoutMs: readNumberEnv('CLOUDFLARE_DYNAMIC_TIMEOUT_MS', {
        defaultValue: 30000, // 30秒，如果 Worker 在30秒内没有响应，立即 fallback
        min: 5000, // 最少5秒
    }),
};
// Merkl API 请求的重试/退避配置
export const merklFetchConfig = {
    maxRetries: readNumberEnv('MERKL_FETCH_MAX_RETRIES', {
        defaultValue: 4,
        min: 0,
    }),
    baseDelayMs: readNumberEnv('MERKL_FETCH_BASE_DELAY_MS', {
        defaultValue: 1000,
        min: 0,
    }),
    maxDelayMs: readNumberEnv('MERKL_FETCH_MAX_DELAY_MS', {
        defaultValue: 15000,
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
        defaultValue: 2000, // 2秒，用于指数退避的起始延迟
        min: 0,
    }),
    maxDelayMs: readNumberEnv('COINGECKO_FETCH_MAX_DELAY_MS', {
        defaultValue: 60000, // 60秒，指数退避的最大延迟
        min: 0,
    }),
    // 429 错误的最小等待时间（秒），如果 Retry-After header 不存在或更小，使用此值
    // 设置为 60 秒，因为 rate limit 是按分钟计算的（Free tier: 30 次/分钟）
    // 等待 60 秒可以确保下一个时间窗口开始时重试
    rateLimitMinWaitSeconds: readNumberEnv('COINGECKO_RATE_LIMIT_MIN_WAIT_SECONDS', {
        defaultValue: 60, // Free tier: ~30 calls/minute，等待 60 秒确保进入新的时间窗口
        min: 0,
    }),
    // 请求之间的最小间隔（毫秒），用于防止超过 rate limit
    // Free tier: 30 次/分钟 = 每 2 秒一次，设置为 2.5 秒留有余量
    minRequestIntervalMs: readNumberEnv('COINGECKO_MIN_REQUEST_INTERVAL_MS', {
        defaultValue: 2500, // 2.5 秒，确保不超过 30 次/分钟的限制
        min: 1000, // 最少 1 秒
    }),
};
// Merit key 重定向别名配置
// 当访问某个 key 时，如果该 key 会重定向到另一个 key，在这里配置映射关系
// 这样可以避免重复请求，直接使用 canonical key 的数据
export const meritKeyAliases = {
    'sonic-supply-usdce': 'sonic-supply-usdc',
    // 添加更多已知的重定向别名映射
};
//# sourceMappingURL=config.js.map
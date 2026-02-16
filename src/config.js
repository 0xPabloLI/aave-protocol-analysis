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
// Merit key 重定向别名配置
// 当访问某个 key 时，如果该 key 会重定向到另一个 key，在这里配置映射关系
// 这样可以避免重复请求，直接使用 canonical key 的数据
export const meritKeyAliases = {
    'sonic-supply-usdce': 'sonic-supply-usdc',
    // 添加更多已知的重定向别名映射
};
//# sourceMappingURL=config.js.map
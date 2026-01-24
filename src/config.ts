type NumberEnvOptions = {
  defaultValue: number;
  min?: number;
};

function readNumberEnv(key: string, options: NumberEnvOptions): number {
  const raw = process.env[key];
  if (raw === undefined) return options.defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value)) return options.defaultValue;
  if (options.min !== undefined && value < options.min) return options.defaultValue;
  return value;
}

function readBooleanEnv(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return defaultValue;
  return raw === 'true';
}

// Node 应用调用 Cloudflare Worker 的速率/重试配置
export const cloudflareWorkerConfig = {
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
  dynamicFailFast: readBooleanEnv('CLOUDFLARE_DYNAMIC_FAIL_FAST', true),
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

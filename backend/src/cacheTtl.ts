export const BACKEND_TIME_MS = {
  oneMinute: 1 * 60 * 1000,
  fiveMinutes: 5 * 60 * 1000,
  tenMinutes: 10 * 60 * 1000,
  thirtyMinutes: 30 * 60 * 1000,
  sixHours: 6 * 60 * 60 * 1000,
  oneDay: 24 * 60 * 60 * 1000,
} as const;

export const BACKEND_TIME_SECONDS = {
  oneMinute: 60,
} as const;

export const BACKEND_FETCH_TIMING_MS = {
  coingeckoBaseDelay: 2 * 1000,
  coingeckoMinRequestInterval: 2500,
  coingeckoMinRequestIntervalFloor: 1000,
} as const;

// Node-cron 6-field format (includes seconds): at second 0, every minute.
export const BACKEND_SCHEDULE_CRON = {
  eachMinuteAtSecondZero: '0 * * * * *',
} as const;

export const BACKEND_CACHE_TTL_MS = {
  // Same-source near-realtime family.
  realtimeFamily: BACKEND_TIME_MS.oneMinute,
  marketsDataStaleThreshold: BACKEND_TIME_MS.oneMinute,
  merklLiteFileMaxAge: BACKEND_TIME_MS.oneMinute,
  merklForecastResultDefault: BACKEND_TIME_MS.oneMinute,
  merklForecastOpportunityMetaDefault: BACKEND_TIME_MS.oneMinute,
  merklOpportunitiesDefault: BACKEND_TIME_MS.oneMinute,

  // CoinGecko family.
  coingeckoSlowFamily: BACKEND_TIME_MS.sixHours,
  coingeckoFastFamily: BACKEND_TIME_MS.tenMinutes,
  coingeckoCategories: BACKEND_TIME_MS.sixHours,
  coingeckoFdv: BACKEND_TIME_MS.tenMinutes,
  coingeckoFdvMonitor: BACKEND_TIME_MS.sixHours,

  // Merkl metrics family.
  merklMetricsDefault: BACKEND_TIME_MS.thirtyMinutes,
  merklMetricsMin: BACKEND_TIME_MS.tenMinutes,
  merklMetricsMax: BACKEND_TIME_MS.sixHours,
  merklMetricsEmpty: BACKEND_TIME_MS.fiveMinutes,
} as const;

export const BACKEND_TIMEOUT_MS = {
  update: 3 * BACKEND_TIME_MS.oneMinute,
} as const;

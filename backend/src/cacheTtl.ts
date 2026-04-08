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
  merklRetryBaseDelay: 1000,
  merklRetryMaxDelay: 10 * 1000,
} as const;

// Node-cron 6-field format (includes seconds): at second 0, every minute.
export const BACKEND_SCHEDULE_CRON = {
  marketsBackupEveryMinuteAtSecond0: '0 * * * * *',
  // On-chain data refresh: every 1 min at second 10 (per-chain concurrent, 30-min TTL)
  onchainDataWarmEveryMinuteAtSecond10: '10 * * * * *',
  coingeckoFdvWarmEveryFiveMinutesAtSecond5: '5 */5 * * * *',
  coingeckoCategoriesWarmEverySixHoursAtSecond10: '10 0 */6 * * *',
  // Aligned with merklForecastResultDefault (10 min) for cron-write/API-read-only pattern.
  campaignForecastWarmEveryTenMinutesAtSecond30: '30 */10 * * * *',
} as const;

export const BACKEND_CACHE_TTL_MS = {
  // Markets near-realtime family.
  marketsDataStaleThreshold: BACKEND_TIME_MS.oneMinute,
  marketsServeStaleMax: BACKEND_TIME_MS.fiveMinutes,
  // On-chain data TTL: 30 min (deficit/baseVariableBorrowRate change infrequently)
  onchainCacheTtl: BACKEND_TIME_MS.thirtyMinutes,

  // Merkl forecast family.
  // forecastResult aligned with metricsMin since underlying metrics data won't change faster.
  merklForecastResultDefault: BACKEND_TIME_MS.tenMinutes,
  // opportunityMeta/liteFile/opportunities are metadata lookups, can be shorter.
  merklForecastOpportunityMetaDefault: BACKEND_TIME_MS.fiveMinutes,
  merklLiteFileMaxAge: BACKEND_TIME_MS.fiveMinutes,
  merklOpportunitiesDefault: BACKEND_TIME_MS.fiveMinutes,

  // CoinGecko family.
  coingeckoLongDataTtlMs: BACKEND_TIME_MS.sixHours,
  /** FDV cache TTL; matches FDV warm cron interval (5 min) so cron and request path share same freshness rule. */
  coingeckoFdv: BACKEND_TIME_MS.fiveMinutes,

  // Merkl metrics family (underlying data for forecast computation).
  // Dynamic TTL = observed cadence / 4, clamped to [min, max].
  merklMetricsDefault: BACKEND_TIME_MS.thirtyMinutes,
  merklMetricsMin: BACKEND_TIME_MS.tenMinutes,
  merklMetricsMax: BACKEND_TIME_MS.sixHours,
  // Empty = no dailyRewardsRecords yet; retry more frequently (below clamp min is intentional).
  merklMetricsEmpty: BACKEND_TIME_MS.tenMinutes,
} as const;

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
  // V3 and V4 refresh at the same time (parallel execution)
  // They fetch from different data sources, so no resource contention
  marketsBackupEveryMinuteAtSecond0: '0 * * * * *',
  // Option 3: V4 data refresh at the same time as V3 (parallel, not sequential)
  // V3 and V4 fetch from different API endpoints, so they can run concurrently
  v4DataRefreshEveryMinuteAtSecond0: '0 * * * * *',
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
  marketsServeHardStaleMax: BACKEND_TIME_MS.fiveMinutes,
  // On-chain data TTL: 30 min (deficit/baseVariableBorrowRate change infrequently)
  onchainCacheTtl: BACKEND_TIME_MS.thirtyMinutes,

  // ============================================================
  // Option 3: Independent V3 and V4 cache TTLs
  // ============================================================
  // V3 and V4 have separate snapshots with independent freshness policies.
  // This allows one to fail without affecting the other's availability.
  // At API read time, both snapshots are merged.
  v3DataStaleThreshold: BACKEND_TIME_MS.oneMinute,
  v3ServeHardStaleMax: BACKEND_TIME_MS.fiveMinutes,
  v4DataStaleThreshold: BACKEND_TIME_MS.oneMinute,
  v4ServeHardStaleMax: BACKEND_TIME_MS.fiveMinutes,

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
  // Zero-baseline max age: 1 day (typical Merkl metrics cadence) + 6h (merklMetricsMax buffer).
  // Beyond this window, zero-distributed forecast is considered unreliable; campaign is excluded.
  merklForecastZeroBaselineMaxAgeMs: BACKEND_TIME_MS.oneDay + BACKEND_TIME_MS.sixHours,
} as const;

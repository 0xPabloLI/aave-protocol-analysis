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
  // Markets (V3+V4 merged) refresh every minute
  marketsBackupEveryMinuteAtSecond0: '0 * * * * *',
  // On-chain data refresh: every 1 min at second 10 (per-chain concurrent, 30-min TTL)
  onchainDataWarmEveryMinuteAtSecond10: '10 * * * * *',
  // Oracle price refresh: every 60s (prices update ~every block; V4 reserveToken 1h cached)
  oraclePriceWarmEveryMinuteAtSecond0: '0 * * * * *',
  coingeckoFdvWarmEveryFiveMinutesAtSecond5: '5 */5 * * * *',
  coingeckoCategoriesWarmEverySixHoursAtSecond10: '10 0 */6 * * *',
  // Aligned with merklForecastResultDefault (10 min) for cron-write/API-read-only pattern.
  campaignForecastWarmEveryTenMinutesAtSecond30: '30 */10 * * * *',
  // Persistence (PostgreSQL): every 5 min at :30s, after markets (:00) + onchain (:10) + oracle (:00) settle.
  persistenceFlushEveryFiveMinutesAtSecond30: '30 */5 * * * *',
} as const;

export const BACKEND_CACHE_TTL_MS = {
  // Markets near-realtime family.
  marketsSoftTtlMs: BACKEND_TIME_MS.oneMinute,
  marketsHardTtlMs: BACKEND_TIME_MS.fiveMinutes,
  // On-chain data TTL: 30 min (deficit/baseVariableBorrowRate change infrequently)
  onchainTtlMs: BACKEND_TIME_MS.thirtyMinutes,
  // Oracle price TTL: 60s (prices update ~every block; V4 reserveToken mapping has 1h own TTL)
  oracleTtlMs: 60_000,

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

export const MERKL_TTL = {
  forecastResultSoftTtlMs: BACKEND_CACHE_TTL_MS.merklForecastResultDefault,
  forecastOpportunityMetaSoftTtlMs: BACKEND_CACHE_TTL_MS.merklForecastOpportunityMetaDefault,
  forecastOpportunityMetaHardTtlMs: Math.max(BACKEND_CACHE_TTL_MS.merklForecastOpportunityMetaDefault * 3, BACKEND_TIME_MS.thirtyMinutes),
  metricsSoftTtlMs: BACKEND_CACHE_TTL_MS.merklMetricsDefault,
  metricsHardTtlMs: Math.max(BACKEND_CACHE_TTL_MS.merklMetricsDefault * 3, BACKEND_TIME_MS.thirtyMinutes),
  forecastSnapshotHardTtlMs: Math.max(BACKEND_CACHE_TTL_MS.merklForecastResultDefault * 3, BACKEND_TIME_MS.thirtyMinutes),
  opportunitiesSoftTtlMs: BACKEND_CACHE_TTL_MS.merklOpportunitiesDefault,
} as const;

export const COINGECKO_TTL = {
  categoriesSoftTtlMs: BACKEND_CACHE_TTL_MS.coingeckoLongDataTtlMs,
  categoriesHardTtlMs: Math.max(BACKEND_CACHE_TTL_MS.coingeckoLongDataTtlMs * 3, BACKEND_TIME_MS.thirtyMinutes),
  fdvSoftTtlMs: BACKEND_CACHE_TTL_MS.coingeckoFdv,
  fdvHardTtlMs: Math.max(BACKEND_CACHE_TTL_MS.coingeckoFdv * 3, BACKEND_TIME_MS.thirtyMinutes),
} as const;

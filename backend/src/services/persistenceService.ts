/**
 * Persistence service — batch-writes market & oracle snapshots to PostgreSQL.
 *
 * Design highlights:
 * - Throttled to once every PERSIST_INTERVAL_MS (default 5 min).
 * - Skipped silently when DATABASE_URL is unset (treat persistence as opt-in).
 * - Uses parameterised INSERT (`$1, $2, …`) — never string concatenation.
 * - Idempotent via `ON CONFLICT (snapshot_ts, …) DO NOTHING` so a double
 *   call after a process restart does not duplicate rows.
 * - Failures only log a warning and never propagate, so persistence cannot
 *   take down the cron-write/API-read-only main flow.
 */
import { getPool, isPersistenceEnabled } from './dbPool.js';
import { logger } from '../logger.js';
import type { MarketsPayload, RuntimeReserveData } from '../../../dist/index.js';
import type { OraclePricesSnapshot } from './oracleService.js';

const PERSIST_INTERVAL_MS = Number.parseInt(process.env.PERSIST_INTERVAL_MS ?? '', 10) || 5 * 60 * 1000;

let lastPersistTs = 0;
let lastPersistSuccessTs = 0;
let lastErrorMessage: string | null = null;
let totalMarketsRowsWritten = 0;
let totalOracleRowsWritten = 0;
let warnedDisabled = false;

export interface PersistenceStatus {
  enabled: boolean;
  persistIntervalMs: number;
  lastAttemptTs: number | null;
  lastSuccessTs: number | null;
  secondsSinceLastSuccess: number | null;
  totalMarketsRowsWritten: number;
  totalOracleRowsWritten: number;
  lastError: string | null;
}

export function getPersistenceStatus(): PersistenceStatus {
  return {
    enabled: isPersistenceEnabled(),
    persistIntervalMs: PERSIST_INTERVAL_MS,
    lastAttemptTs: lastPersistTs || null,
    lastSuccessTs: lastPersistSuccessTs || null,
    secondsSinceLastSuccess: lastPersistSuccessTs
      ? Math.round((Date.now() - lastPersistSuccessTs) / 1000)
      : null,
    totalMarketsRowsWritten,
    totalOracleRowsWritten,
    lastError: lastErrorMessage,
  };
}

export interface PersistResult {
  skipped: 'disabled' | 'throttled' | null;
  marketsRowsWritten: number;
  oracleRowsWritten: number;
}

export async function persistSnapshotIfNeeded(
  payload: MarketsPayload | null,
  oracleSnapshot: OraclePricesSnapshot | null
): Promise<PersistResult> {
  if (!isPersistenceEnabled()) {
    if (!warnedDisabled) {
      logger.info('💾 Persistence disabled (DATABASE_URL not set) — snapshots will not be saved');
      warnedDisabled = true;
    }
    return { skipped: 'disabled', marketsRowsWritten: 0, oracleRowsWritten: 0 };
  }

  const now = Date.now();
  if (now - lastPersistTs < PERSIST_INTERVAL_MS) {
    return { skipped: 'throttled', marketsRowsWritten: 0, oracleRowsWritten: 0 };
  }
  // Set lastPersistTs upfront so a long-running write does not allow a second
  // concurrent invocation from the next cron tick.
  lastPersistTs = now;

  // Use a single timestamp for both tables so cross-table joins line up.
  const snapshotTs = new Date(now).toISOString();

  let marketsRowsWritten = 0;
  let oracleRowsWritten = 0;
  let success = true;

  if (payload && payload.data.length > 0) {
    try {
      marketsRowsWritten = await persistMarketSnapshot(payload, snapshotTs);
    } catch (error) {
      success = false;
      lastErrorMessage = error instanceof Error ? error.message : String(error);
      logger.warn('⚠️ Failed to persist market snapshot:', error);
    }
  }

  if (oracleSnapshot) {
    try {
      oracleRowsWritten = await persistOraclePrices(oracleSnapshot, snapshotTs);
    } catch (error) {
      success = false;
      lastErrorMessage = error instanceof Error ? error.message : String(error);
      logger.warn('⚠️ Failed to persist oracle prices:', error);
    }
  }

  if (success) {
    lastPersistSuccessTs = now;
    lastErrorMessage = null;
    totalMarketsRowsWritten += marketsRowsWritten;
    totalOracleRowsWritten += oracleRowsWritten;
    logger.info(
      `💾 Persisted snapshots: markets=${marketsRowsWritten} oracle=${oracleRowsWritten} ts=${snapshotTs}`
    );
  }

  return { skipped: null, marketsRowsWritten, oracleRowsWritten };
}

// ---------------------------------------------------------------------------
// Market snapshot writer
// ---------------------------------------------------------------------------

const MARKET_COLUMNS = [
  'snapshot_ts', 'reserve_id', 'chain_id', 'chain_name', 'market_name',
  'token_symbol', 'token_name', 'token_address', 'a_token_address', 'v_token_address',
  'decimals', 'token_price', 'supply_apy', 'borrow_apy', 'utilization_pct',
  'available_liquidity', 'total_variable_debt', 'reserve_size',
  'supply_cap', 'borrow_cap', 'deficit',
  'base_variable_borrow_rate', 'reserve_factor',
  'variable_rate_slope1', 'variable_rate_slope2', 'optimal_usage_rate',
  'supply_disabled', 'borrow_disabled', 'is_frozen', 'is_paused',
  'supply_incentives_apr', 'borrow_incentives_apr', 'incentive_details',
  'aave_pro_reserve_id',
  'hub_id', 'hub_name', 'hub_address',
  'spoke_id', 'spoke_name', 'spoke_address',
] as const;

async function persistMarketSnapshot(
  payload: MarketsPayload,
  snapshotTs: string
): Promise<number> {
  const pool = getPool();

  const rows = payload.data.map((reserve) => buildMarketRow(reserve, snapshotTs));
  if (rows.length === 0) return 0;

  // Postgres caps parameters per statement at 65535. With ~39 columns we can
  // safely send ~1600 rows; chunk anyway to be defensive.
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { text, values } = buildBulkInsert(
      'market_snapshots',
      MARKET_COLUMNS as unknown as string[],
      chunk,
      'ON CONFLICT (snapshot_ts, reserve_id) DO NOTHING'
    );
    const result = await pool.query(text, values);
    written += result.rowCount ?? 0;
  }
  return written;
}

function buildMarketRow(reserve: RuntimeReserveData, snapshotTs: string): unknown[] {
  return [
    snapshotTs,
    reserve.reserveId,
    reserve.chainId,
    reserve.chainName,
    reserve.marketName,
    reserve.tokenSymbol,
    reserve.tokenName,
    reserve.tokenAddress,
    reserve.aTokenAddress ?? null,
    reserve.vTokenAddress ?? null,
    reserve.decimals ?? null,
    nullableNumber(reserve.tokenPrice),
    nullableNumber(reserve.supplyApy),
    nullableNumber(reserve.borrowApy),
    nullableNumber(reserve.utilizationPct),
    nullableBigintString(reserve.availableLiquidity),
    nullableBigintString(reserve.totalVariableDebt),
    nullableBigintString(reserve.reserveSize),
    nullableBigintString(reserve.supplyCap),
    nullableBigintString(reserve.borrowCap),
    nullableBigintString(reserve.deficit),
    nullableNumber(reserve.baseVariableBorrowRate),
    nullableNumber(reserve.reserveFactor),
    nullableNumber(reserve.variableRateSlope1),
    nullableNumber(reserve.variableRateSlope2),
    nullableNumber(reserve.optimalUsageRate),
    reserve.supplyDisabled ?? null,
    reserve.borrowDisabled ?? null,
    reserve.isFrozen ?? null,
    reserve.isPaused ?? null,
    aggregateSupplyIncentivesApr(reserve),
    aggregateBorrowIncentivesApr(reserve),
    JSON.stringify(buildIncentiveDetails(reserve)),
    reserve.aaveProReserveId ?? null,
    reserve.hubId ?? null,
    reserve.hubName ?? null,
    reserve.hubAddress ?? null,
    reserve.spokeId ?? null,
    reserve.spokeName ?? null,
    reserve.spokeAddress ?? null,
  ];
}

// ---------------------------------------------------------------------------
// Oracle writer
// ---------------------------------------------------------------------------

const ORACLE_COLUMNS = [
  'snapshot_ts', 'chain_id', 'token_address', 'raw_price', 'price_usd', 'source', 'spoke_address',
] as const;

interface OracleRow {
  snapshotTs: string;
  chainId: number;
  tokenAddress: string;
  rawPrice: string;
  priceUsd: number;
  source: 'v3' | 'v4';
  spokeAddress: string | null;
}

async function persistOraclePrices(
  snap: OraclePricesSnapshot,
  snapshotTs: string
): Promise<number> {
  const pool = getPool();

  const rows: OracleRow[] = [];

  for (const v3 of snap.v3) {
    for (const [tokenAddr, entry] of Object.entries(v3.assets)) {
      rows.push({
        snapshotTs,
        chainId: v3.chainId,
        tokenAddress: tokenAddr.toLowerCase(),
        rawPrice: entry.rawPrice,
        priceUsd: entry.priceUsd,
        source: 'v3',
        spokeAddress: null,
      });
    }
  }

  for (const v4 of snap.v4) {
    for (const [reserveIdStr, entry] of Object.entries(v4.reserves)) {
      const tokenAddr = v4.reserveTokens[reserveIdStr];
      if (!tokenAddr) continue;
      rows.push({
        snapshotTs,
        chainId: v4.chainId,
        tokenAddress: tokenAddr.toLowerCase(),
        rawPrice: entry.rawPrice,
        priceUsd: entry.priceUsd,
        source: 'v4',
        spokeAddress: v4.spokeAddress.toLowerCase(),
      });
    }
  }

  if (rows.length === 0) return 0;

  // Deduplicate within a single batch to avoid `ON CONFLICT ... cannot affect
  // row a second time` errors when the same key appears more than once.
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    const key = `${r.chainId}|${r.tokenAddress}|${r.source}|${r.spokeAddress ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const CHUNK = 1000;
  let written = 0;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const tuples = chunk.map((r) => [
      r.snapshotTs, r.chainId, r.tokenAddress, r.rawPrice, r.priceUsd, r.source, r.spokeAddress,
    ]);
    const { text, values } = buildBulkInsert(
      'oracle_prices',
      ORACLE_COLUMNS as unknown as string[],
      tuples,
      'ON CONFLICT (snapshot_ts, chain_id, token_address, source, spoke_address) DO NOTHING'
    );
    const result = await pool.query(text, values);
    written += result.rowCount ?? 0;
  }
  return written;
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

function buildBulkInsert(
  table: string,
  columns: string[],
  rows: unknown[][],
  onConflict: string
): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const placeholders: string[] = [];
  let i = 1;
  for (const row of rows) {
    if (row.length !== columns.length) {
      throw new Error(`buildBulkInsert: row length ${row.length} != columns length ${columns.length}`);
    }
    const tuple = row.map(() => `$${i++}`).join(', ');
    placeholders.push(`(${tuple})`);
    values.push(...row);
  }
  const text =
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders.join(', ')} ${onConflict}`;
  return { text, values };
}

function nullableNumber(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

function nullableBigintString(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  // Validate that it parses as integer-shaped string (allow leading minus).
  const s = String(v);
  if (!/^-?\d+$/.test(s)) return null;
  return s;
}

// ---------------------------------------------------------------------------
// Incentive aggregation
// ---------------------------------------------------------------------------

/** Sum of all supply-side incentive APRs as a percentage (e.g. 5.5 = 5.5%). */
export function aggregateSupplyIncentivesApr(reserve: RuntimeReserveData): number | null {
  return aggregateIncentivesApr(
    reserve.supplyIncentives,
    reserve.meritSupplys,
    reserve.merklSupplys,
    reserve.brevisSupplys
  );
}

/** Sum of all borrow-side incentive APRs as a percentage. */
export function aggregateBorrowIncentivesApr(reserve: RuntimeReserveData): number | null {
  return aggregateIncentivesApr(
    reserve.borrowIncentives,
    reserve.meritBorrows,
    reserve.merklBorrows,
    reserve.brevisBorrows
  );
}

function aggregateIncentivesApr(
  legacy: number[] | undefined,
  merit: { apr?: number }[] | undefined,
  merkl: { breakdowns?: { campaignApr?: number | null }[] }[] | undefined,
  brevis: { breakdowns?: { campaignApr?: number | null }[] }[] | undefined
): number | null {
  let total = 0;
  let any = false;

  for (const v of legacy ?? []) {
    if (Number.isFinite(v)) {
      total += v * 100; // legacy ratios → percent
      any = true;
    }
  }
  for (const m of merit ?? []) {
    if (typeof m.apr === 'number' && Number.isFinite(m.apr)) {
      total += m.apr * 100; // merit apr is ratio
      any = true;
    }
  }
  for (const group of merkl ?? []) {
    for (const b of group.breakdowns ?? []) {
      if (typeof b.campaignApr === 'number' && Number.isFinite(b.campaignApr)) {
        total += b.campaignApr * 100;
        any = true;
      }
    }
  }
  for (const group of brevis ?? []) {
    for (const b of group.breakdowns ?? []) {
      if (typeof b.campaignApr === 'number' && Number.isFinite(b.campaignApr)) {
        total += b.campaignApr * 100;
        any = true;
      }
    }
  }
  return any ? Number(total.toFixed(6)) : null;
}

interface IncentiveDetails {
  legacySupply?: number[];
  legacyBorrow?: number[];
  merit?: { side: 'supply' | 'borrow'; apr: number }[];
  merkl?: { side: 'supply' | 'borrow' | 'hold'; aprs: number[] }[];
  brevis?: { side: 'supply' | 'borrow'; aprs: number[] }[];
}

function buildIncentiveDetails(reserve: RuntimeReserveData): IncentiveDetails {
  const out: IncentiveDetails = {};
  if (reserve.supplyIncentives?.length) out.legacySupply = reserve.supplyIncentives;
  if (reserve.borrowIncentives?.length) out.legacyBorrow = reserve.borrowIncentives;

  const merit: IncentiveDetails['merit'] = [];
  for (const m of reserve.meritSupplys ?? []) {
    if (typeof m.apr === 'number') merit.push({ side: 'supply', apr: m.apr });
  }
  for (const m of reserve.meritBorrows ?? []) {
    if (typeof m.apr === 'number') merit.push({ side: 'borrow', apr: m.apr });
  }
  if (merit.length) out.merit = merit;

  const merkl: IncentiveDetails['merkl'] = [];
  for (const [side, list] of [
    ['supply', reserve.merklSupplys] as const,
    ['borrow', reserve.merklBorrows] as const,
    ['hold', reserve.merklHolds] as const,
  ]) {
    for (const group of list ?? []) {
      const aprs = (group.breakdowns ?? [])
        .map((b) => b.campaignApr)
        .filter((v): v is number => typeof v === 'number');
      if (aprs.length) merkl.push({ side, aprs });
    }
  }
  if (merkl.length) out.merkl = merkl;

  const brevis: IncentiveDetails['brevis'] = [];
  for (const [side, list] of [
    ['supply', reserve.brevisSupplys] as const,
    ['borrow', reserve.brevisBorrows] as const,
  ]) {
    for (const group of list ?? []) {
      const aprs = (group.breakdowns ?? [])
        .map((b) => b.campaignApr)
        .filter((v): v is number => typeof v === 'number');
      if (aprs.length) brevis.push({ side, aprs });
    }
  }
  if (brevis.length) out.brevis = brevis;

  return out;
}

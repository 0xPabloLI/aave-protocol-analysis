/**
 * Persistence service — batch-writes market & oracle snapshots to PostgreSQL.
 *
 * Design highlights:
 * - Throttled to once every PERSIST_INTERVAL_MS (default 5 min).
 * - Skipped silently when DATABASE_URL is unset (treat persistence as opt-in).
 * - Uses parameterised INSERT (`$1, $2, …`) — never string concatenation.
 * - Content-hash change detection: only writes rows whose data actually changed
 *   since the last successful persist. Eliminates ~90%+ duplicate writes when
 *   Aave rates are stable across consecutive 5-min cycles.
 * - Idempotent via `ON CONFLICT (snapshot_ts, …) DO NOTHING` so a double
 *   call after a process restart does not duplicate rows.
 * - Failures only log a warning and never propagate, so persistence cannot
 *   take down the cron-write/API-read-only main flow.
 */
import crypto from 'node:crypto';
import { getPool, isPersistenceEnabled } from './dbPool.js';
import { logger } from '../logger.js';
import type { MarketsPayload, RuntimeReserveData } from '../../../dist/index.js';
import type { OraclePricesSnapshot } from './oracleService.js';

const PERSIST_INTERVAL_MS = Number.parseInt(process.env.PERSIST_INTERVAL_MS ?? '', 10) || 60 * 1000;

let lastPersistTs = 0;
let lastPersistSuccessTs = 0;
let lastErrorMessage: string | null = null;
let totalMarketsRowsWritten = 0;
let totalMarketConfigsRowsWritten = 0;
let totalOracleRowsWritten = 0;
let warnedDisabled = false;

// ── Content-hash change detection ──────────────────────────────────────────
// Each reserve/oracle-price row is hashed after a successful write. On the
// next persist cycle, only rows whose hash differs from the stored one are
// written. After a process restart these maps are empty → first cycle writes
// everything (acceptable: restart is infrequent).

const marketRowHashes = new Map<string, string>(); // key: reserveId → sha256 (snapshot table)
const marketConfigHashes = new Map<string, string>(); // key: reserveId → sha256 (config table)
const oraclePriceHashes = new Map<string, string>(); // key: chainId|tokenAddr|configId → sha256

export function computeHash(data: unknown[]): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(data))
    .digest('hex');
}

/** Exposed for tests: reset content-hash maps (simulates process restart). */
// ts-prune-ignore-next
export function resetPersistenceHashes(): void {
  marketRowHashes.clear();
  marketConfigHashes.clear();
  oraclePriceHashes.clear();
}

export interface PersistenceStatus {
  enabled: boolean;
  persistIntervalMs: number;
  lastAttemptTs: number | null;
  lastSuccessTs: number | null;
  secondsSinceLastSuccess: number | null;
  totalMarketsRowsWritten: number;
  totalMarketConfigsRowsWritten: number;
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
    totalMarketConfigsRowsWritten,
    totalOracleRowsWritten,
    lastError: lastErrorMessage,
  };
}

export interface PersistResult {
  skipped: 'disabled' | 'throttled' | null;
  marketsRowsWritten: number;
  marketConfigsRowsWritten: number;
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
    return { skipped: 'disabled', marketsRowsWritten: 0, marketConfigsRowsWritten: 0, oracleRowsWritten: 0 };
  }

  const now = Date.now();
  if (now - lastPersistTs < PERSIST_INTERVAL_MS) {
    return { skipped: 'throttled', marketsRowsWritten: 0, marketConfigsRowsWritten: 0, oracleRowsWritten: 0 };
  }
  // Set lastPersistTs upfront so a long-running write does not allow a second
  // concurrent invocation from the next cron tick.
  lastPersistTs = now;

  // Use a single timestamp for both tables so cross-table joins line up.
  const snapshotTs = new Date(now).toISOString();

  let marketsRowsWritten = 0;
  let marketConfigsRowsWritten = 0;
  let oracleRowsWritten = 0;
  let success = true;

  if (payload && payload.data.length > 0) {
    try {
      const results = await persistMarketSnapshot(payload, snapshotTs);
      marketsRowsWritten = results.snapshotsWritten;
      marketConfigsRowsWritten = results.configsWritten;
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
    totalMarketConfigsRowsWritten += marketConfigsRowsWritten;
    totalOracleRowsWritten += oracleRowsWritten;
    logger.info(
      `💾 Persisted snapshots: markets=${marketsRowsWritten} configs=${marketConfigsRowsWritten} oracle=${oracleRowsWritten} ts=${snapshotTs}`
    );
  }

  return { skipped: null, marketsRowsWritten, marketConfigsRowsWritten, oracleRowsWritten };
}

// ---------------------------------------------------------------------------
// Market snapshot writers (split: snapshots + configs)
// ---------------------------------------------------------------------------

const MARKET_COLUMNS = [
  'snapshot_ts', 'reserve_id',
  'token_price', 'supply_apy', 'borrow_apy', 'utilization_pct',
  'liquidity', 'borrowed', 'supplied', 'deficit',
  'supply_incentives_apr', 'borrow_incentives_apr', 'incentive_details',
] as const;

const MARKET_CONFIG_COLUMNS = [
  'snapshot_ts', 'reserve_id',
  'chain_id', 'chain_name', 'market_name',
  'token_symbol', 'token_name', 'token_address', 'decimals',
  'aave_pro_reserve_id',
  'a_token_address', 'v_token_address',
  'supply_cap', 'borrow_cap',
  'base_borrow_rate', 'protocol_fee',
  'slope_below_optimal', 'slope_above_optimal', 'optimal_utilization',
  'supply_disabled', 'borrow_disabled', 'is_frozen', 'is_paused',
  'hub_id', 'hub_name', 'hub_address',
  'spoke_id', 'spoke_name', 'spoke_address',
] as const;

interface MarketPersistResult {
  snapshotsWritten: number;
  configsWritten: number;
}

async function persistMarketSnapshot(
  payload: MarketsPayload,
  snapshotTs: string
): Promise<MarketPersistResult> {
  const snapshotsWritten = await persistMarketSnapshotsTable(payload, snapshotTs);
  const configsWritten = await persistMarketConfigsTable(payload, snapshotTs);
  return { snapshotsWritten, configsWritten };
}

async function persistMarketSnapshotsTable(
  payload: MarketsPayload,
  snapshotTs: string
): Promise<number> {
  const pool = getPool();

  const allRows = payload.data.map((reserve) => ({
    reserveId: reserve.reserveId,
    row: buildSnapshotRow(reserve, snapshotTs),
  }));
  if (allRows.length === 0) return 0;

  const changed: { reserveId: string; row: unknown[]; newHash: string }[] = [];
  for (const { reserveId, row } of allRows) {
    const newHash = computeHash(row.slice(1));
    if (marketRowHashes.get(reserveId) === newHash) continue;
    changed.push({ reserveId, row, newHash });
  }

  if (changed.length === 0) {
    logger.info('💾 Market snapshot unchanged — skipping write');
    return 0;
  }

  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < changed.length; i += CHUNK) {
    const chunk = changed.slice(i, i + CHUNK).map((c) => c.row);
    const { text, values } = buildBulkInsert(
      'market_snapshots',
      MARKET_COLUMNS as unknown as string[],
      chunk,
      'ON CONFLICT (snapshot_ts, reserve_id) DO NOTHING'
    );
    const result = await pool.query(text, values);
    written += result.rowCount ?? 0;

    for (const c of changed.slice(i, i + CHUNK)) {
      marketRowHashes.set(c.reserveId, c.newHash);
    }
  }
  return written;
}

async function persistMarketConfigsTable(
  payload: MarketsPayload,
  snapshotTs: string
): Promise<number> {
  const pool = getPool();

  const allRows = payload.data.map((reserve) => ({
    reserveId: reserve.reserveId,
    row: buildConfigRow(reserve, snapshotTs),
  }));
  if (allRows.length === 0) return 0;

  const changed: { reserveId: string; row: unknown[]; newHash: string }[] = [];
  for (const { reserveId, row } of allRows) {
    const newHash = computeHash(row.slice(1));
    if (marketConfigHashes.get(reserveId) === newHash) continue;
    changed.push({ reserveId, row, newHash });
  }

  if (changed.length === 0) {
    logger.info('💾 Market config unchanged — skipping write');
    return 0;
  }

  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < changed.length; i += CHUNK) {
    const chunk = changed.slice(i, i + CHUNK).map((c) => c.row);
    const { text, values } = buildBulkInsert(
      'market_configs',
      MARKET_CONFIG_COLUMNS as unknown as string[],
      chunk,
      'ON CONFLICT (snapshot_ts, reserve_id) DO NOTHING'
    );
    const result = await pool.query(text, values);
    written += result.rowCount ?? 0;

    for (const c of changed.slice(i, i + CHUNK)) {
      marketConfigHashes.set(c.reserveId, c.newHash);
    }
  }
  return written;
}

function buildSnapshotRow(reserve: RuntimeReserveData, snapshotTs: string): unknown[] {
  return [
    snapshotTs,
    reserve.reserveId,
    nullableNumber(reserve.tokenPrice),
    nullableNumber(reserve.supplyApy),
    nullableNumber(reserve.borrowApy),
    nullableNumber(reserve.utilizationPct),
    nullableBigintString(reserve.liquidity),
    nullableBigintString(reserve.borrowed),
    nullableBigintString(reserve.supplied),
    nullableBigintString(reserve.deficit),
    aggregateSupplyIncentivesApr(reserve),
    aggregateBorrowIncentivesApr(reserve),
    JSON.stringify(buildIncentiveDetails(reserve)),
  ];
}

function buildConfigRow(reserve: RuntimeReserveData, snapshotTs: string): unknown[] {
  return [
    snapshotTs,
    reserve.reserveId,
    reserve.chainId,
    reserve.chainName,
    reserve.marketName,
    reserve.tokenSymbol,
    reserve.tokenName,
    reserve.tokenAddress,
    reserve.decimals ?? null,
    reserve.aaveProReserveId ?? null,
    reserve.aTokenAddress ?? null,
    reserve.vTokenAddress ?? null,
    nullableBigintString(reserve.supplyCap),
    nullableBigintString(reserve.borrowCap),
    nullableNumber(reserve.baseBorrowRate),
    nullableNumber(reserve.protocolFee),
    nullableNumber(reserve.slopeBelowOptimal),
    nullableNumber(reserve.slopeAboveOptimal),
    nullableNumber(reserve.optimalUtilization),
    reserve.supplyDisabled ?? null,
    reserve.borrowDisabled ?? null,
    reserve.isFrozen ?? null,
    reserve.isPaused ?? null,
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

interface OracleConfigKey {
  source: 'v3' | 'v4';
  poolKey: string;
  chainId: number;
  poolAddress: string | null;
  oracleAddress: string;
  spokeAddress: string | null;
}

interface OracleRow {
  snapshotTs: string;
  chainId: number;
  tokenAddress: string;
  priceUsd: number;
  configId: number;
}

/**
 * Ensure every pool/spoke in the snapshot has a corresponding row in
 * oracle_source_configs.  Returns a map keyed by (source|poolKey) → config_id.
 * Uses INSERT … ON CONFLICT … DO UPDATE so repeated calls are idempotent
 * and last_seen_at stays current.
 */
async function ensureOracleSourceConfigs(
  snap: OraclePricesSnapshot
): Promise<Map<string, number>> {
  const pool = getPool();
  const configMap = new Map<string, number>();

  // Collect all unique sources
  const configs: OracleConfigKey[] = [];
  for (const v3 of snap.v3) {
    configs.push({
      source: 'v3',
      poolKey: v3.poolKey,
      chainId: v3.chainId,
      poolAddress: v3.poolAddress.toLowerCase(),
      oracleAddress: v3.oracleAddress.toLowerCase(),
      spokeAddress: null,
    });
  }
  for (const v4 of snap.v4) {
    configs.push({
      source: 'v4',
      poolKey: v4.spokeName,
      chainId: v4.chainId,
      poolAddress: null,
      oracleAddress: v4.oracleAddress.toLowerCase(),
      spokeAddress: v4.spokeAddress.toLowerCase(),
    });
  }

  if (configs.length === 0) return configMap;

  // Batch upsert
  const values: unknown[] = [];
  const placeholders: string[] = [];
  let i = 1;
  for (const c of configs) {
    placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
    values.push(c.source, c.poolKey, c.chainId, c.poolAddress, c.oracleAddress, c.spokeAddress);
  }

  const upsertSql = `
    INSERT INTO oracle_source_configs
      (source, pool_key, chain_id, pool_address, oracle_address, spoke_address)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (source, pool_key, chain_id, pool_address, oracle_address, spoke_address)
    DO UPDATE SET last_seen_at = NOW()
    RETURNING id, source, pool_key
  `;

  const result = await pool.query(upsertSql, values);
  for (const row of result.rows) {
    configMap.set(`${row.source}|${row.pool_key}`, row.id);
  }

  return configMap;
}

async function persistOraclePrices(
  snap: OraclePricesSnapshot,
  snapshotTs: string
): Promise<number> {
  const pool = getPool();

  const configMap = await ensureOracleSourceConfigs(snap);
  if (configMap.size === 0) return 0;

  const rows: OracleRow[] = [];

  for (const v3 of snap.v3) {
    const configId = configMap.get(`v3|${v3.poolKey}`);
    if (configId === undefined) continue;
    for (const [tokenAddr, entry] of Object.entries(v3.assets)) {
      rows.push({
        snapshotTs,
        chainId: v3.chainId,
        tokenAddress: tokenAddr.toLowerCase(),
        priceUsd: entry.priceUsd,
        configId,
      });
    }
  }

  for (const v4 of snap.v4) {
    const configId = configMap.get(`v4|${v4.spokeName}`);
    if (configId === undefined) continue;
    for (const [reserveIdStr, entry] of Object.entries(v4.reserves)) {
      const tokenAddr = v4.reserveTokens[reserveIdStr];
      if (!tokenAddr) continue;
      rows.push({
        snapshotTs,
        chainId: v4.chainId,
        tokenAddress: tokenAddr.toLowerCase(),
        priceUsd: entry.priceUsd,
        configId,
      });
    }
  }

  if (rows.length === 0) return 0;
  return writeOracleChunk(pool, rows);
}

const ORACLE_COLUMNS = [
  'snapshot_ts', 'chain_id', 'token_address', 'price_usd', 'config_id',
] as const;

async function writeOracleChunk(
  pool: ReturnType<typeof getPool>,
  rows: OracleRow[]
): Promise<number> {
  // 1. Deduplicate within batch.
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    const key = `${r.chainId}|${r.tokenAddress}|${r.configId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 2. Filter by content hash (cross-batch dedup: skip rows unchanged since last write).
  const changed: OracleRow[] = [];
  const newHashes: { key: string; hash: string }[] = [];
  for (const r of unique) {
    const key = `${r.chainId}|${r.tokenAddress}|${r.configId}`;
    const newHash = computeHash([r.priceUsd]);
    if (oraclePriceHashes.get(key) === newHash) continue;
    changed.push(r);
    newHashes.push({ key, hash: newHash });
  }

  if (changed.length === 0) return 0;

  const CHUNK = 1000;
  let written = 0;
  for (let i = 0; i < changed.length; i += CHUNK) {
    const chunk = changed.slice(i, i + CHUNK);
    const tuples = chunk.map((r) => [
      r.snapshotTs, r.chainId, r.tokenAddress, r.priceUsd, r.configId,
    ]);
    const { text, values } = buildBulkInsert(
      'oracle_prices',
      ORACLE_COLUMNS as unknown as string[],
      tuples,
      'ON CONFLICT (snapshot_ts, chain_id, token_address, config_id) DO NOTHING'
    );
    const result = await pool.query(text, values);
    written += result.rowCount ?? 0;

    // Update hashes per chunk so partial failures don't lose progress.
    for (const { key, hash } of newHashes.slice(i, i + CHUNK)) {
      oraclePriceHashes.set(key, hash);
    }
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

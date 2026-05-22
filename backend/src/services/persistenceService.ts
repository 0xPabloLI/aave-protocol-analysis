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
 * - For market_configs, the content hash is also persisted in a DB column
 *   (content_hash). On process restart, warmConfigHashes() loads these hashes
 *   from DB to pre-fill the in-memory map, so the first persist tick is a
 *   no-op when nothing changed (instead of writing all 354 rows).
 * - Idempotent via `ON CONFLICT (snapshot_ts, …) DO NOTHING` so a double
 *   call after a process restart does not duplicate rows.
 * - Failures only log a warning and never propagate, so persistence cannot
 *   take down the cron-write/API-read-only main flow.
 */
import crypto from 'node:crypto';
import { getPool, isPersistenceEnabled } from './dbPool.js';
import { logger } from '../logger.js';
import type { MarketsPayload, RuntimeReserveData } from '@internal/aave-shared-contracts';
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
// written. For market_configs, the hash is also persisted in the content_hash
// column so that on process restart we can warm the in-memory map from DB
// (see warmConfigHashes), avoiding a full rewrite of unchanged rows.

const marketRowHashes = new Map<string, string>(); // key: reserveId → sha256 (snapshot table)
const marketConfigHashes = new Map<string, string>(); // key: reserveId → sha256 (config table)
const oraclePriceHashes = new Map<string, string>(); // key: chainId|tokenAddr|configId → sha256

export function computeHash(data: unknown[]): string {
  // JSON.stringify is deterministic within the same V8 version (ECMA-262
  // mandates Number.prototype.toString output). Hashes stored in DB are
  // compared against hashes recomputed at runtime, so a V8 major upgrade
  // could theoretically break this — in practice V8 toString is stable
  // across LTS releases. If a Node.js major upgrade ever causes a mismatch,
  // the safe fallback is a one-time full rewrite (same as process restart).
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

/**
 * Warm marketConfigHashes from the latest rows in DB.
 * After a process restart, the in-memory map is empty, causing the first
 * persist tick to write all 354 rows even when unchanged. By loading the
 * content_hash of the latest row per reserve_id from DB, the first tick
 * becomes a no-op when nothing changed.
 *
 * Must be called after DB migrations (so content_hash column exists)
 * and before the cron scheduler starts.
 */
export async function warmConfigHashes(): Promise<number> {
  if (!isPersistenceEnabled()) return 0;

  const pool = getPool();
  const result = await pool.query(`
    SELECT DISTINCT ON (reserve_id) reserve_id, content_hash
    FROM market_configs
    WHERE content_hash IS NOT NULL
    ORDER BY reserve_id, snapshot_ts DESC
  `);

  for (const row of result.rows) {
    if (row.reserve_id && row.content_hash) {
      marketConfigHashes.set(row.reserve_id, row.content_hash);
    }
  }

  if (result.rows.length > 0) {
    logger.info(`💾 Warmed config hashes from DB: ${result.rows.length} reserves`);
  }
  return result.rows.length;
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
  'incentive_details',
] as const;

export const MARKET_CONFIG_COLUMNS = [
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
  'content_hash',
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

  const allRows = payload.data.map((reserve) => {
    const { row, hash } = buildConfigRow(reserve, snapshotTs);
    return { reserveId: reserve.reserveId, row, hash };
  });
  if (allRows.length === 0) return 0;

  const changed: { reserveId: string; row: unknown[]; hash: string }[] = [];
  for (const { reserveId, row, hash } of allRows) {
    if (marketConfigHashes.get(reserveId) === hash) continue;
    changed.push({ reserveId, row, hash });
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
      marketConfigHashes.set(c.reserveId, c.hash);
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
    JSON.stringify(buildIncentiveDetails(reserve)),
  ];
}

export function buildConfigRow(reserve: RuntimeReserveData, snapshotTs: string): { row: unknown[]; hash: string } {
  const data = [
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
  const hash = computeHash(data.slice(1));
  return { row: [...data, hash], hash };
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

const TABLE_NAME_RE = /^[a-z_][a-z0-9_]*$/;

function buildBulkInsert(
  table: string,
  columns: string[],
  rows: unknown[][],
  onConflict: string
): { text: string; values: unknown[] } {
  if (!TABLE_NAME_RE.test(table)) {
    throw new Error(`buildBulkInsert: invalid table name "${table}"`);
  }
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
// Per-campaign IncentiveDetails
// ---------------------------------------------------------------------------

export interface MeritCampaignEntry {
  key: string;
  apr: number;
  name?: string;
  endDate: string;
  link: string;
}

export interface MerklBreakdownEntry {
  key: string;
  apr: number;
  type?: string;
  endDate: string;
  startDate: string;
}

export interface MerklGroupEntry {
  groupId: string;
  link: string;
  name?: string;
  message?: string | null;
  breakdowns: MerklBreakdownEntry[];
  opportunityType?: string;
  netPositionConstraint?: {
    sourceSide: 'supply' | 'borrow';
    offsetReserveIds: string[];
  } | null;
}

export interface BrevisBreakdownEntry {
  key: string;
  apr: number;
  startDate: string;
  endDate: string;
}

export interface BrevisGroupEntry {
  groupId: string;
  link: string;
  breakdowns: BrevisBreakdownEntry[];
}

export interface PerCampaignIncentiveDetails {
  legacySupply?: number[];
  legacyBorrow?: number[];
  meritSupplys?: MeritCampaignEntry[];
  meritBorrows?: MeritCampaignEntry[];
  merklSupplys?: MerklGroupEntry[];
  merklBorrows?: MerklGroupEntry[];
  merklHolds?: MerklGroupEntry[];
  brevisSupplys?: BrevisGroupEntry[];
  brevisBorrows?: BrevisGroupEntry[];
}

export function buildIncentiveDetails(reserve: RuntimeReserveData): PerCampaignIncentiveDetails {
  const out: PerCampaignIncentiveDetails = {};

  if (reserve.supplyIncentives?.length) out.legacySupply = reserve.supplyIncentives;
  if (reserve.borrowIncentives?.length) out.legacyBorrow = reserve.borrowIncentives;

  const meritSupplys: MeritCampaignEntry[] = [];
  for (const m of reserve.meritSupplys ?? []) {
    const key = `${String(m.link ?? '')}::${String(m.endDate ?? '')}`;
    if (!key || key === '::') {
      logger.warn(`buildIncentiveDetails: skipping merit supply entry with invalid key (reserveId=${reserve.reserveId})`);
      continue;
    }
    meritSupplys.push({ key, apr: m.apr, name: m.name, endDate: m.endDate, link: m.link });
  }
  if (meritSupplys.length) out.meritSupplys = meritSupplys;

  const meritBorrows: MeritCampaignEntry[] = [];
  for (const m of reserve.meritBorrows ?? []) {
    const key = `${String(m.link ?? '')}::${String(m.endDate ?? '')}`;
    if (!key || key === '::') {
      logger.warn(`buildIncentiveDetails: skipping merit borrow entry with invalid key (reserveId=${reserve.reserveId})`);
      continue;
    }
    meritBorrows.push({ key, apr: m.apr, name: m.name, endDate: m.endDate, link: m.link });
  }
  if (meritBorrows.length) out.meritBorrows = meritBorrows;

  if (reserve.merklSupplys?.length) out.merklSupplys = buildMerklGroups(reserve.merklSupplys, reserve.reserveId);
  if (reserve.merklBorrows?.length) out.merklBorrows = buildMerklGroups(reserve.merklBorrows, reserve.reserveId);
  if (reserve.merklHolds?.length) out.merklHolds = buildMerklGroups(reserve.merklHolds, reserve.reserveId);

  if (reserve.brevisSupplys?.length) out.brevisSupplys = buildBrevisGroups(reserve.brevisSupplys, reserve.reserveId);
  if (reserve.brevisBorrows?.length) out.brevisBorrows = buildBrevisGroups(reserve.brevisBorrows, reserve.reserveId);

  return out;
}

function buildMerklGroups(
  groups: Array<{ link: string; name?: string; message?: string | null; opportunityType?: string; netPositionConstraint?: { sourceSide: 'supply' | 'borrow'; offsetReserveIds: string[] } | null; breakdowns: Array<{ campaignApr: number; campaignId: string; campaignStartedAt: string; campaignEndedAt: string; type?: string }> }>,
  _reserveId: string,
  _existingEntries?: MerklGroupEntry[]
): MerklGroupEntry[] {
  const existingByLink = new Map<string, MerklGroupEntry>();
  for (const entry of (_existingEntries ?? [])) {
    existingByLink.set(entry.link, entry);
  }
  return groups.map((group) => {
    const existing = existingByLink.get(group.link);
    const constraint = group.netPositionConstraint ?? existing?.netPositionConstraint ?? null;
    return {
    groupId: crypto.createHash('sha256').update(group.link).digest('hex').slice(0, 16),
    link: group.link,
    name: group.name,
    message: group.message ?? null,
    opportunityType: group.opportunityType,
    netPositionConstraint: constraint,
    breakdowns: (group.breakdowns ?? []).map((bd) => ({
      key: bd.campaignId ?? '',
      apr: bd.campaignApr,
      type: bd.type,
      endDate: bd.campaignEndedAt,
      startDate: bd.campaignStartedAt,
    })),
    };
  });
}

function buildBrevisGroups(
  groups: Array<{ link: string; breakdowns: Array<{ campaignApr: number; campaignId?: string; campaignStartedAt: string; campaignEndedAt: string }> }>,
  _reserveId: string
): BrevisGroupEntry[] {
  return groups.map((group) => ({
    groupId: crypto.createHash('sha256').update(group.link).digest('hex').slice(0, 16),
    link: group.link,
    breakdowns: (group.breakdowns ?? []).map((bd) => ({
      key: bd.campaignId ?? crypto.createHash('sha256').update(JSON.stringify([bd.campaignStartedAt, bd.campaignEndedAt, bd.campaignApr])).digest('hex').slice(0, 16),
      apr: bd.campaignApr,
      startDate: bd.campaignStartedAt,
      endDate: bd.campaignEndedAt,
    })),
  }));
}

// ── In-memory SUM derivation ────────────────────────────────────────────────

function isEntryExpired(endDate: string | undefined, now: Date): boolean {
  if (!endDate) return false;
  const ts = Date.parse(endDate);
  if (!Number.isFinite(ts)) return false;
  return now.getTime() > ts;
}

/**
 * Sum per-campaign APR from incentive details for a given side.
 * merklHolds 不参与聚合 — hold 是 Merkl HOLD action，与 supply/borrow 是不同的 action，
 * 前端不会把 hold APR 加到 supply/borrow 总 APR 中。
 */
// ts-prune-ignore-next
export function sumIncentiveAprFromDetails(
  details: PerCampaignIncentiveDetails | null | undefined,
  side: 'supply' | 'borrow',
  now?: Date
): number | null {
  if (!details) return null;
  const refNow = now ?? new Date();
  let total = 0;
  let any = false;

  if (side === 'supply' && details.legacySupply?.length) {
    for (const v of details.legacySupply) {
      if (Number.isFinite(v)) { total += v * 100; any = true; }
    }
  }
  if (side === 'borrow' && details.legacyBorrow?.length) {
    for (const v of details.legacyBorrow) {
      if (Number.isFinite(v)) { total += v * 100; any = true; }
    }
  }

  const meritEntries = side === 'supply' ? details.meritSupplys : details.meritBorrows;
  for (const m of meritEntries ?? []) {
    if (isEntryExpired(m.endDate, refNow)) continue;
    if (typeof m.apr === 'number' && Number.isFinite(m.apr)) { total += m.apr * 100; any = true; }
  }

  const merklGroups = side === 'supply' ? details.merklSupplys : details.merklBorrows;
  for (const group of merklGroups ?? []) {
    for (const bd of group.breakdowns ?? []) {
      if (isEntryExpired(bd.endDate, refNow)) continue;
      if (typeof bd.apr === 'number' && Number.isFinite(bd.apr)) { total += bd.apr * 100; any = true; }
    }
  }

  const brevisGroups = side === 'supply' ? details.brevisSupplys : details.brevisBorrows;
  for (const group of brevisGroups ?? []) {
    for (const bd of group.breakdowns ?? []) {
      if (isEntryExpired(bd.endDate, refNow)) continue;
      if (typeof bd.apr === 'number' && Number.isFinite(bd.apr)) { total += bd.apr * 100; any = true; }
    }
  }

  return any ? Number(total.toFixed(6)) : null;
}



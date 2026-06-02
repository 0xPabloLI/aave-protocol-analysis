/**
 * DB Migration: Remap V4 reserveId fourth segment from SDK hubName to hubAddress.
 *
 * Before: {chainId}:{spokeAddress}:{tokenAddr}:{hubName}  (hubName = "Core"/"Prime"/"Plus")
 * After:  {chainId}:{spokeAddress}:{tokenAddr}:{hubAddress} (hubAddress = "0xcca8..." lowercase)
 *
 * Usage:
 *   DRY_RUN=true npx tsx scripts/migrate-v4-reserveid-hubaddress.ts  # preview
 *   npx tsx scripts/migrate-v4-reserveid-hubaddress.ts               # execute
 *
 * Idempotent: running twice is a no-op (already-migrated rows have 42-char fourth segment).
 */

import * as AaveAddressBook from '@aave-dao/aave-address-book';

const SDK_HUBNAME_TO_HUBKEY: Record<string, string> = {
  Core: 'CORE_HUB',
  Prime: 'PRIME_HUB',
  Plus: 'PLUS_HUB',
};

function buildHubNameToHubAddressMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [, val] of Object.entries(AaveAddressBook)) {
    if (!val || typeof val !== 'object') continue;
    const v = val as Record<string, unknown>;
    if (!v.HUBS || typeof v.HUBS !== 'object') continue;
    const hubs = v.HUBS as Record<string, string>;
    for (const [hubKey, hubAddr] of Object.entries(hubs)) {
      if (typeof hubAddr !== 'string') continue;
      const sdkName = Object.entries(SDK_HUBNAME_TO_HUBKEY).find(([, k]) => k === hubKey)?.[0];
      if (sdkName) {
        map.set(sdkName, hubAddr.toLowerCase());
      }
    }
  }
  return map;
}

const ETH_ADDRESS_RE = /^0x[0-9a-f]{40}$/;

function validateHubAddress(addr: string): boolean {
  return ETH_ADDRESS_RE.test(addr);
}

function migrateReserveId(reserveId: string, hubNameMap: Map<string, string>): string | null {
  const parts = reserveId.split(':');
  if (parts.length !== 4) return null;
  const fourth = parts[3];
  if (fourth.startsWith('0x') && fourth.length === 42) return null;
  const hubAddress = hubNameMap.get(fourth);
  if (!hubAddress || !validateHubAddress(hubAddress)) return null;
  return `${parts[0]}:${parts[1]}:${parts[2]}:${hubAddress}`;
}

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN !== 'false' && !!process.env.DRY_RUN;
  const hubNameMap = buildHubNameToHubAddressMap();

  console.log('Hub name → address mapping:');
  for (const [name, addr] of hubNameMap) {
    console.log(`  ${name} → ${addr}`);
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log('\nNo DATABASE_URL set. Running in local/demo mode.');
    console.log('\nDemo migration examples:');
    const examples = [
      '1:0x94e7a5dcbe816e498b89ab752661904e2f56c485:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:Core',
      '1:0x94e7a5dcbe816e498b89ab752661904e2f56c485:0xdac17f958d2ee523a2206206994597c13d831ec7:Prime',
      '1:0x94e7a5dcbe816e498b89ab752661904e2f56c485:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2:Plus',
    ];
    for (const oldId of examples) {
      const newId = migrateReserveId(oldId, hubNameMap);
      console.log(`  ${oldId}`);
      console.log(`  → ${newId ?? '(no mapping, skipped)'}`);
    }
    return;
  }

  console.log(`\n${dryRun ? 'DRY RUN' : 'LIVE'} mode`);
  console.log(`Database: ${dbUrl.split('@')[1]?.slice(0, 30) ?? '(masked)'}...`);

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: dbUrl });

  try {
    const tables = ['market_snapshot', 'market_config_snapshot'];
    for (const table of tables) {
      const countResult = await pool.query(
        `SELECT COUNT(*) as cnt FROM ${table} WHERE reserve_id LIKE '%:%:%:Core' OR reserve_id LIKE '%:%:%:Prime' OR reserve_id LIKE '%:%:%:Plus'`
      );
      const count = Number(countResult.rows[0]?.cnt ?? 0);
      console.log(`\n${table}: ${count} rows to migrate`);

      if (count === 0) continue;

      if (dryRun) {
        const sampleResult = await pool.query(
          `SELECT reserve_id FROM ${table} WHERE reserve_id LIKE '%:%:%:Core' OR reserve_id LIKE '%:%:%:Prime' OR reserve_id LIKE '%:%:%:Plus' LIMIT 5`
        );
        for (const row of sampleResult.rows) {
          const newId = migrateReserveId(row.reserve_id, hubNameMap);
          console.log(`  ${row.reserve_id} → ${newId ?? '(no mapping)'}`);
        }
        continue;
      }

      const allowedHubNames = new Set(Object.keys(SDK_HUBNAME_TO_HUBKEY));
      for (const [hubName, hubAddress] of hubNameMap) {
        if (!allowedHubNames.has(hubName) || !validateHubAddress(hubAddress)) {
          console.warn(`  Skipping unsafe mapping: ${hubName} → ${hubAddress}`);
          continue;
        }
        const result = await pool.query(
          `UPDATE ${table} SET reserve_id = REPLACE(reserve_id, '${hubName}', '${hubAddress}') WHERE reserve_id LIKE '%:%:%:${hubName}'`
        );
        console.log(`  ${hubName} → ${hubAddress}: ${result.rowCount} rows updated`);
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});

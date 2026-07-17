#!/usr/bin/env node
/**
 * Aave UI ↔ Backend API Comparison Tool
 *
 * Compares Aave official GraphQL API data (V3 + V4) against
 * the backend /api/markets output, field by field with tolerance.
 *
 * Usage:
 *   node scripts/verification/compare-aave-ui/run-compare.mjs [--backend-url URL] [--no-v3] [--no-v4] [--output PATH]
 *
 * Options:
 *   --backend-url URL   Backend API URL (default: https://staging-api.aaveapy.com/api/markets)
 *   --local             Shortcut for --backend-url http://localhost:3001/api/markets
 *   --no-v3             Skip V3 comparison
 *   --no-v4             Skip V4 comparison
 *   --output PATH       Write JSON report to file (default: data/debug/aave-ui-comparison-report.json)
 */

import { fetchV3Markets } from './fetch-aave-v3.mjs';
import { fetchV4Reserves } from './fetch-aave-v4.mjs';
import { fetchBackendApi } from './fetch-backend-api.mjs';
import { compareReserves, generateReport, printSummary } from './diff-engine.mjs';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const args = process.argv.slice(2);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '../../../..');

let backendUrl = 'https://staging-api.aaveapy.com/api/markets';
let runV3 = true;
let runV4 = true;
let outputPath = join(repoRoot, 'data/debug/aave-ui-comparison-report.json');

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--backend-url' && args[i + 1]) {
    backendUrl = args[++i];
  } else if (args[i] === '--local') {
    backendUrl = 'http://localhost:3001/api/markets';
  } else if (args[i] === '--no-v3') {
    runV3 = false;
  } else if (args[i] === '--no-v4') {
    runV4 = false;
  } else if (args[i] === '--output' && args[i + 1]) {
    outputPath = args[++i];
  }
}

async function main() {
  console.log('=== Aave UI ↔ Backend API Comparison Tool ===\n');

  const backendReserves = await fetchBackendApi(backendUrl);

  const v4HubChainIds = runV4
    ? [...new Set(
        backendReserves
          .filter(r => r.version === 'v4' && r.chainId)
          .map(r => r.chainId),
      )].sort((a, b) => a - b)
    : [];

  const [v3Reserves, v4Reserves] = await Promise.all([
    runV3 ? fetchV3Markets() : Promise.resolve([]),
    runV4 && v4HubChainIds.length > 0 ? fetchV4Reserves(v4HubChainIds) : Promise.resolve([]),
  ]);

  if (runV4 && v4HubChainIds.length === 0) {
    console.log('[V4] No V4 hub chains found in backend data, skipping V4 comparison');
  }

  console.log('\n--- Running Comparison ---');
  const v3Result = runV3
    ? compareReserves(backendReserves, v3Reserves, 'v3')
    : { matched: [], missingInBackend: [], missingInAaveUi: [] };
  const v4Result = runV4
    ? compareReserves(backendReserves, v4Reserves, 'v4')
    : { matched: [], missingInBackend: [], missingInAaveUi: [] };

  const report = generateReport(v3Result, v4Result, backendUrl, {
    v3: runV3 ? 'https://api.v3.aave.com/graphql' : 'skipped',
    v4: runV4 ? 'https://api.aave.com/graphql' : 'skipped',
  });

  const exitCode = printSummary(report);

  const outDir = dirname(outputPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved to: ${outputPath}`);

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});

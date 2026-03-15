#!/usr/bin/env node
/**
 * Validates that Aave SDK reserves and on-chain (UiPoolDataProvider.getReservesHumanized)
 * reserve entries match per reserveId (marketName:chainId:tokenAddress).
 *
 * On-chain cache now covers all address-book pools (including same-chain markets
 * e.g. Ethereum main, Lido, EtherFi, Horizon). Comparison is by reserveId.
 *
 * Reports:
 * - In SDK but not in on-chain: reserve in payload has no matching on-chain entry for that pool.
 * - In on-chain but not in SDK: RPC returned the reserve but SDK supplyReserves do not include it.
 *
 * Run from repo root after build:
 *   npm run build && cd backend && npm run build && node scripts/validate-sdk-onchain-reserve-match.mjs
 *
 * Or from backend dir:
 *   node scripts/validate-sdk-onchain-reserve-match.mjs
 */

import { fetchMarketsPayload } from '../../dist/index.js';
import { refreshOnchainCache, getOnchainDataFromCache } from '../dist/services/onchainDataService.js';

async function main() {
  console.log('Fetching markets payload (Aave SDK)...');
  const payload = await fetchMarketsPayload();
  const sdkReserves = payload.data ?? [];
  const sdkKeys = new Set(sdkReserves.map((r) => r.reserveId));

  console.log('Refreshing on-chain cache (UiPoolDataProvider.getReservesHumanized, all pools)...');
  await refreshOnchainCache();
  const onchainMap = getOnchainDataFromCache();
  const onchainKeys = new Set(onchainMap.keys());

  const inSdkNotOnchain = [...sdkKeys].filter((k) => !onchainKeys.has(k));
  const inOnchainNotSdk = [...onchainKeys].filter((k) => !sdkKeys.has(k));

  const sdkByKey = new Map(sdkReserves.map((r) => [r.reserveId, r]));

  console.log('\n--- Reserve entry match (SDK vs on-chain, by reserveId) ---');
  console.log('SDK reserves (payload.data):', sdkKeys.size);
  console.log('On-chain reserves (cache):', onchainKeys.size);
  console.log('In SDK only (no on-chain entry):', inSdkNotOnchain.length);
  console.log('In on-chain only (no SDK entry):', inOnchainNotSdk.length);

  if (inSdkNotOnchain.length > 0) {
    console.log('\n--- In SDK but NOT in on-chain ---');
    inSdkNotOnchain.slice(0, 50).forEach((reserveId, i) => {
      const r = sdkByKey.get(reserveId);
      const label = r ? `${r.tokenSymbol} (${r.marketName}, ${r.chainId})` : reserveId;
      console.log(`  ${i + 1}. ${label}`);
    });
    if (inSdkNotOnchain.length > 50) {
      console.log(`  ... and ${inSdkNotOnchain.length - 50} more`);
    }
  }

  if (inOnchainNotSdk.length > 0) {
    console.log('\n--- In on-chain but NOT in SDK ---');
    inOnchainNotSdk.slice(0, 50).forEach((reserveId, i) => {
      console.log(`  ${i + 1}. ${reserveId}`);
    });
    if (inOnchainNotSdk.length > 50) {
      console.log(`  ... and ${inOnchainNotSdk.length - 50} more`);
    }
  }

  const { writeFileSync, existsSync, mkdirSync } = await import('fs');
  const { dirname, join } = await import('path');
  const { fileURLToPath } = await import('url');
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const reportPath = join(scriptDir, '../../data/debug/sdk-onchain-reserve-match-report.json');
  const outDir = dirname(reportPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const inSdkNotOnchainDetails = inSdkNotOnchain.map((reserveId) => {
    const r = sdkByKey.get(reserveId);
    return r ? { reserveId, chainId: r.chainId, tokenAddress: r.tokenAddress, tokenSymbol: r.tokenSymbol, marketName: r.marketName } : { reserveId };
  });
  const inOnchainNotSdkDetails = inOnchainNotSdk.map((reserveId) => ({ reserveId }));

  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        summary: {
          sdkReserveCount: sdkKeys.size,
          onchainReserveCount: onchainKeys.size,
          inSdkNotOnchainCount: inSdkNotOnchain.length,
          inOnchainNotSdkCount: inOnchainNotSdk.length,
        },
        inSdkNotOnchain: inSdkNotOnchainDetails,
        inOnchainNotSdk: inOnchainNotSdkDetails,
      },
      null,
      2
    )
  );
  console.log('\nReport written to data/debug/sdk-onchain-reserve-match-report.json');

  const hasMismatch = inSdkNotOnchain.length > 0 || inOnchainNotSdk.length > 0;
  process.exit(hasMismatch ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

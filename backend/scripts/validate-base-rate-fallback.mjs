#!/usr/bin/env node
/**
 * Validates calculateBaseRateFallback by comparing:
 * - On-chain baseVariableBorrowRate (from RPC)
 * - Fallback-computed baseVariableBorrowRate (from SDK: borrowApy, utilization, slopes)
 *
 * Counts: payload.data comes from fetchMarketsPayload() which EXCLUDES frozen/paused reserves.
 * scripts/validate-sdk-reserve-fields.mjs reads data/debug/aave-all-markets-data.json and counts
 * ALL supplyReserves (no filter), so it reports 275. Difference 275-240 = frozen/paused excluded by fetcher.
 *
 * Run from repo root after build:
 *   npm run build && cd backend && npm run build && node scripts/validate-base-rate-fallback.mjs
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { fetchMarketsPayload } from '../../dist/index.js';
import {
  refreshOnchainCache,
  getOnchainDataFromCache,
  calculateBaseRateFallback,
} from '../dist/services/onchainDataService.js';

const RAY = BigInt('1000000000000000000000000000');
const scriptDir = dirname(fileURLToPath(import.meta.url));

function rayToPct(rayStr) {
  const r = BigInt(rayStr);
  return Number((r * 10000n) / RAY) / 100;
}

/** If data/debug/aave-all-markets-data.json exists, return { total, frozenPaused }; else null. */
function getSdkFileReserveCounts() {
  const debugPath = join(scriptDir, '../../data/debug/aave-all-markets-data.json');
  try {
    const raw = readFileSync(debugPath, 'utf8');
    const data = JSON.parse(raw);
    const markets = data.markets || [];
    let total = 0;
    let frozenPaused = 0;
    for (const market of markets) {
      const supplyReserves = market.supplyReserves || [];
      for (const r of supplyReserves) {
        total++;
        if (r.isFrozen === true || r.isPaused === true) frozenPaused++;
      }
    }
    return { total, frozenPaused };
  } catch {
    return null;
  }
}

async function main() {
  const sdkFile = getSdkFileReserveCounts();
  if (sdkFile) {
    console.log('SDK file (aave-all-markets-data.json): total reserves', sdkFile.total, '(frozen/paused:', sdkFile.frozenPaused + ')');
  }

  console.log('Fetching markets payload...');
  const payload = await fetchMarketsPayload();
  console.log('Refreshing on-chain cache...');
  await refreshOnchainCache();
  const onchainMap = getOnchainDataFromCache();
  console.log('On-chain reserves in cache (keyed by reserveId):', onchainMap.size);

  const totalReserves = payload.data?.length ?? 0;
  const noBorrowInfo = payload.data?.filter((r) => r.borrowApy === undefined) ?? [];
  const noBorrowInfoCount = noBorrowInfo.length;

  // Keys are reserveId = marketName:chainId:tokenAddress; pool = marketName:chainId
  const poolsInCache = new Set([...onchainMap.keys()].map((k) => {
    const parts = k.split(':');
    return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : k;
  }));

  let withOnchain = 0;
  let match = 0;
  let mismatchFormula = 0;
  let nullFallback = 0;
  const mismatches = [];
  const reservesWithoutOnchainBase = [];

  for (const reserve of payload.data) {
    const onchain = onchainMap.get(reserve.reserveId);
    const actualRay = onchain?.baseVariableBorrowRate;

    if (actualRay === undefined || actualRay === null) {
      const poolKey = `${reserve.marketName}:${reserve.chainId}`;
      const reason = poolsInCache.has(poolKey)
        ? 'token_not_in_fetched_pool'
        : 'pool_not_in_cache';
      reservesWithoutOnchainBase.push({
        reserveId: reserve.reserveId,
        symbol: reserve.tokenSymbol,
        chainId: reserve.chainId,
        reason,
      });
      continue;
    }

    withOnchain += 1;
    const fallbackRay = calculateBaseRateFallback(
      reserve.borrowApy,
      reserve.utilizationPct,
      reserve.optimalUsageRate,
      reserve.variableRateSlope1,
      reserve.variableRateSlope2
    );
    if (fallbackRay === null) {
      nullFallback += 1;
      mismatches.push({
        reserveId: reserve.reserveId,
        symbol: reserve.tokenSymbol,
        actual: actualRay,
        fallback: null,
        reason: 'fallback returned null (missing SDK params)',
      });
      continue;
    }

    const actualBig = BigInt(actualRay);
    const fallbackBig = BigInt(fallbackRay);
    const diff = actualBig > fallbackBig ? actualBig - fallbackBig : fallbackBig - actualBig;
    const tolerance = (RAY * 1n) / 10000n;

    if (diff <= tolerance) {
      match += 1;
    } else {
      mismatchFormula += 1;
      mismatches.push({
        reserveId: reserve.reserveId,
        symbol: reserve.tokenSymbol,
        chainId: reserve.chainId,
        utilizationPct: reserve.utilizationPct,
        borrowApy: reserve.borrowApy,
        actual: actualRay,
        fallback: fallbackRay,
        actualPct: rayToPct(actualRay),
        fallbackPct: rayToPct(fallbackRay),
        diffRay: diff.toString(),
      });
    }
  }

  const noBorrowInfoButHaveOnchainBase = noBorrowInfo.filter((r) => {
    return onchainMap.get(r.reserveId)?.baseVariableBorrowRate != null;
  }).length;

  const noOnchainByReason = reservesWithoutOnchainBase.reduce((acc, r) => {
    acc[r.reason] = (acc[r.reason] || 0) + 1;
    return acc;
  }, {});

  console.log('\n--- Result ---');
  if (sdkFile) {
    console.log('Total reserves in SDK file (validate-sdk-reserve-fields):', sdkFile.total);
    console.log('Total reserves in payload (fetcher excludes frozen/paused):', totalReserves);
    console.log('Difference (frozen/paused excluded by fetcher):', sdkFile.total - totalReserves);
  } else {
    console.log('Total reserves (payload.data):', totalReserves);
  }
  console.log('');
  console.log('Reserves without borrowInfo (borrowApy undefined):', noBorrowInfoCount);
  console.log('  Of those, with on-chain base (→ null fallback):', noBorrowInfoButHaveOnchainBase);
  console.log('  Of those, without on-chain base (fallback not attempted):', noBorrowInfoCount - noBorrowInfoButHaveOnchainBase);
  console.log('');
  console.log('Reserves with on-chain baseVariableBorrowRate:', withOnchain);
  console.log('  Fallback matches (0.01% tolerance):', match);
  console.log('  Formula mismatch:', mismatchFormula);
  console.log('  Null fallback (missing SDK params):', nullFallback);
  console.log('');
  console.log('Reserves WITHOUT on-chain baseVariableBorrowRate:', reservesWithoutOnchainBase.length, '(全部计入报告 reservesWithoutOnchainBase)');
  console.log('  By reason:', JSON.stringify(noOnchainByReason, null, 0));

  const formulaMismatches = mismatches.filter((m) => m.diffRay != null);
  const nullFallbacksList = mismatches.filter((m) => m.reason != null);

  if (formulaMismatches.length > 0) {
    console.log('\n--- Formula mismatches ---');
    formulaMismatches.forEach((m, i) => {
      console.log(
        `${i + 1}. ${m.symbol} | ${m.reserveId} | util=${m.utilizationPct ?? '?'}% borrowApy=${m.borrowApy ?? '?'}%`
      );
      console.log(`   on-chain base=${m.actualPct}%  fallback base=${m.fallbackPct}%  diffRay=${m.diffRay}`);
    });
  }

  if (nullFallbacksList.length > 0) {
    console.log('\n--- Null fallbacks (missing borrowApy/slopes/util) ---');
    nullFallbacksList.forEach((m, i) => {
      console.log(`${i + 1}. ${m.symbol} | ${m.reserveId}`);
    });
  }

  if (reservesWithoutOnchainBase.length > 0 && reservesWithoutOnchainBase.length <= 80) {
    console.log('\n--- Reserves without on-chain base (sample by reason) ---');
    const byReason = {};
    reservesWithoutOnchainBase.forEach((r) => {
      if (!byReason[r.reason]) byReason[r.reason] = [];
      if (byReason[r.reason].length < 5) byReason[r.reason].push(`${r.symbol} ${r.reserveId}`);
    });
    Object.entries(byReason).forEach(([reason, examples]) => {
      console.log(`  ${reason}: ${examples.join('; ')}`);
    });
  }

  console.log('\nNote: APY→APR = SECONDS_PER_YEAR*((1+APY)^(1/SECONDS_PER_YEAR)-1).');

  const { writeFileSync, existsSync, mkdirSync } = await import('fs');
  const reportPath = join(scriptDir, '../../data/debug/base-rate-fallback-validation-report.json');
  const outDir = dirname(reportPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        summary: {
          sdkFileTotalReserves: sdkFile?.total ?? null,
          payloadTotalReserves: totalReserves,
          frozenPausedExcluded: sdkFile ? sdkFile.total - totalReserves : null,
          noBorrowInfoCount,
          noBorrowInfoButHaveOnchainBase,
          noBorrowInfoWithoutOnchainBase: noBorrowInfoCount - noBorrowInfoButHaveOnchainBase,
          withOnchainBase: withOnchain,
          match,
          mismatchFormula,
          nullFallback,
          withoutOnchainBase: reservesWithoutOnchainBase.length,
          withoutOnchainBaseByReason: noOnchainByReason,
        },
        noBorrowInfoReserveIds: noBorrowInfo.map((r) => r.reserveId),
        nullFallbacks: nullFallbacksList.map((m) => ({ reserveId: m.reserveId, symbol: m.symbol })),
        formulaMismatches: formulaMismatches.map((m) => ({
          reserveId: m.reserveId,
          symbol: m.symbol,
          chainId: m.chainId,
          actualPct: m.actualPct,
          fallbackPct: m.fallbackPct,
          diffRay: m.diffRay,
        })),
        reservesWithoutOnchainBaseCount: reservesWithoutOnchainBase.length,
        reservesWithoutOnchainBase: reservesWithoutOnchainBase,
      },
      null,
      2
    )
  );
  console.log('Report written to data/debug/base-rate-fallback-validation-report.json');

  process.exit(mismatchFormula > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

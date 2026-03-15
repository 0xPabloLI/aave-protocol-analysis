#!/usr/bin/env node
/**
 * For the single formula-mismatch reserve (SNX AaveV3Ethereum), fetches on-chain
 * reserve data (getReservesHumanized) and compares with Aave SDK params used for
 * baseVariableBorrowRate fallback. Prints which parameter(s) differ.
 *
 * Run from repo root after build:
 *   npm run build && cd backend && npm run build && node scripts/compare-snx-onchain-sdk-params.mjs
 *
 * Or from backend: node scripts/compare-snx-onchain-sdk-params.mjs
 */

import { UiPoolDataProvider } from '@aave/contract-helpers';
import * as AaveAddressBook from '@bgd-labs/aave-address-book';
import { getAaveRpcUrlsByChainId } from '@internal/aave-shared-config';
import { ethers } from 'ethers';
import { fetchMarketsPayload } from '../../dist/index.js';

const POOL_KEY = 'AaveV3Ethereum';
const CHAIN_ID = 1;
const SNX_TOKEN = '0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f';
const RESERVE_ID = `${POOL_KEY}:${CHAIN_ID}:${SNX_TOKEN.toLowerCase()}`;
const RAY = BigInt('1000000000000000000000000000');

function rayToPct(rayVal) {
  if (rayVal === undefined || rayVal === null) return undefined;
  const r = BigInt(String(rayVal));
  return Number((r * 10000n) / RAY) / 100;
}

async function main() {
  const value = AaveAddressBook[POOL_KEY];
  if (!value?.UI_POOL_DATA_PROVIDER || !value?.POOL_ADDRESSES_PROVIDER) {
    console.error('AaveV3Ethereum config not found in address book');
    process.exit(1);
  }

  const rpcUrls = getAaveRpcUrlsByChainId(CHAIN_ID);
  const rpcUrl = rpcUrls?.[0];
  if (!rpcUrl) {
    console.error('No RPC URL for chain 1');
    process.exit(1);
  }

  const provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl);
  const ui = new UiPoolDataProvider({
    uiPoolDataProviderAddress: value.UI_POOL_DATA_PROVIDER,
    provider,
    chainId: CHAIN_ID,
  });

  console.log('Fetching on-chain reserves (getReservesHumanized) for AaveV3Ethereum...');
  const humanized = await ui.getReservesHumanized({
    lendingPoolAddressProvider: value.POOL_ADDRESSES_PROVIDER,
  });
  const reserves = humanized?.reservesData ?? [];
  const onchainReserve = reserves.find(
    (r) => String(r.underlyingAsset || '').toLowerCase() === SNX_TOKEN.toLowerCase()
  );
  if (!onchainReserve) {
    console.error('SNX reserve not found in on-chain response');
    process.exit(1);
  }

  console.log('\nFetching SDK payload...');
  const payload = await fetchMarketsPayload();
  const sdkReserve = payload.data?.find((r) => r.reserveId === RESERVE_ID);
  if (!sdkReserve) {
    console.error('SNX reserve not found in payload');
    process.exit(1);
  }

  const onchain = {
    baseVariableBorrowRate: onchainReserve.baseVariableBorrowRate,
    variableRateSlope1: onchainReserve.variableRateSlope1,
    variableRateSlope2: onchainReserve.variableRateSlope2,
    optimalUsageRate: onchainReserve.optimalUsageRate ?? onchainReserve.optimalUsageRatio,
    availableLiquidity: onchainReserve.availableLiquidity,
    totalVariableDebt: onchainReserve.totalVariableDebt ?? onchainReserve.totalScaledVariableDebt,
    variableBorrowIndex: onchainReserve.variableBorrowIndex,
  };

  const sdk = {
    borrowApy: sdkReserve.borrowApy,
    utilizationPct: sdkReserve.utilizationPct,
    optimalUsageRate: sdkReserve.optimalUsageRate,
    variableRateSlope1: sdkReserve.variableRateSlope1,
    variableRateSlope2: sdkReserve.variableRateSlope2,
  };

  const fmt = (v) => (v === undefined || v === null ? '—' : String(v));
  const fmtPct = (v) => (v == null ? '—' : `${Number(v).toFixed(4)}%`);

  console.log('\n========== SNX AaveV3Ethereum 参数对比 ==========\n');

  console.log('--- baseVariableBorrowRate (链上真实值 vs 用 SDK 反推) ---');
  console.log('  On-chain (RAY):', fmt(onchain.baseVariableBorrowRate));
  console.log('  On-chain (%):', fmtPct(rayToPct(onchain.baseVariableBorrowRate)));

  console.log('\n--- 反推用参数：链上 vs SDK ---');
  const keys = [
    ['variableRateSlope1', 'variableRateSlope1', 'RAY'],
    ['variableRateSlope2', 'variableRateSlope2', 'RAY'],
    ['optimalUsageRate', 'optimalUsageRate', 'RAY'],
  ];
  for (const [label, onchainKey, unit] of keys) {
    const oc = onchain[onchainKey];
    const sd = sdk[onchainKey];
    const match = oc !== undefined && sd !== undefined && String(oc).trim() === String(sd).trim();
    console.log(`  ${label}:`);
    console.log('    On-chain:', fmt(oc), unit === 'RAY' && oc != null ? `(${fmtPct(rayToPct(oc))})` : '');
    console.log('    SDK:    ', fmt(sd), unit === 'RAY' && sd != null ? `(${fmtPct(rayToPct(sd))})` : '');
    console.log('    Match:  ', match ? '✓' : '✗');
  }

  console.log('\n  utilization (决定曲线上的点):');
  const ocLiq = onchain.availableLiquidity != null ? BigInt(String(onchain.availableLiquidity)) : null;
  const ocDebt =
    onchain.totalVariableDebt != null && onchain.variableBorrowIndex != null
      ? (BigInt(String(onchain.totalVariableDebt)) * BigInt(String(onchain.variableBorrowIndex))) / RAY
      : onchain.totalVariableDebt != null
        ? BigInt(String(onchain.totalVariableDebt))
        : null;
  const ocUtilPct =
    ocLiq != null && ocDebt != null && ocLiq + ocDebt > 0n
      ? Number((ocDebt * 10000n) / (ocLiq + ocDebt)) / 100
      : null;
  console.log('    On-chain (availableLiquidity + totalVariableDebt → util%):', ocUtilPct != null ? `${ocUtilPct.toFixed(4)}%` : '—');
  console.log('    SDK utilizationPct:', sdk.utilizationPct != null ? `${sdk.utilizationPct}%` : '—');
  console.log('    Match:', ocUtilPct != null && sdk.utilizationPct != null && Math.abs(ocUtilPct - sdk.utilizationPct) < 0.01 ? '✓' : '✗');

  console.log('\n  borrowApy (SDK 给出，链上无直接字段):');
  console.log('    SDK borrowApy:', sdk.borrowApy != null ? `${sdk.borrowApy}%` : '—');

  console.log('\n--- 结论 ---');
  const slope1Match = fmt(onchain.variableRateSlope1) === fmt(sdk.variableRateSlope1);
  const slope2Match = fmt(onchain.variableRateSlope2) === fmt(sdk.variableRateSlope2);
  const optimalMatch = fmt(onchain.optimalUsageRate) === fmt(sdk.optimalUsageRate);
  const utilMatch = ocUtilPct != null && sdk.utilizationPct != null && Math.abs(ocUtilPct - sdk.utilizationPct) < 0.05;
  if (slope1Match && slope2Match && optimalMatch && utilMatch) {
    console.log('  所有可对比参数一致；差异可能来自 borrowApy 精度或舍入。');
  } else {
    const diffs = [];
    if (!slope1Match) diffs.push('variableRateSlope1');
    if (!slope2Match) diffs.push('variableRateSlope2');
    if (!optimalMatch) diffs.push('optimalUsageRate');
    if (!utilMatch) diffs.push('utilization');
    console.log('  不一致参数:', diffs.join(', '));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

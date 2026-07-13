#!/usr/bin/env node
/**
 * 逐条校验：每个 reserve 从 Aave SDK 返回的数据里，我们依赖的字段是否都存在。
 * 若有某条 reserve 缺少某个字段，会列出 (reserveId -> 缺失的字段列表)。
 *
 * 使用: node scripts/verification/sdk-field-coverage.mjs
 * 依赖: data/debug/aave-all-markets-data.json（先跑一次 fetcher 生成）
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEBUG_PATH = join(__dirname, '..', '..', 'data', 'debug', 'aave-all-markets-data.json');

// 与 createBaseDatasetFromMarkets 一致的 SDK 路径（不含 market 顶层）
const SDK_FIELD_CHECKS = [
  { key: 'underlyingToken.symbol', get: (r) => r.underlyingToken?.symbol },
  { key: 'underlyingToken.address', get: (r) => r.underlyingToken?.address },
  { key: 'underlyingToken.name', get: (r) => r.underlyingToken?.name },
  { key: 'underlyingToken.decimals', get: (r) => r.underlyingToken?.decimals },
  { key: 'size.usdPerToken', get: (r) => r.size?.usdPerToken },
  { key: 'usdExchangeRate', get: (r) => r.usdExchangeRate },
  { key: 'size.usd', get: (r) => r.size?.usd },
  { key: 'borrowInfo.utilizationRate.value', get: (r) => r.borrowInfo?.utilizationRate?.value },
  { key: 'aToken.address', get: (r) => r.aToken?.address },
  { key: 'vToken.address', get: (r) => r.vToken?.address },
  { key: 'supplyInfo.supplyCap.amount.value', get: (r) => r.supplyInfo?.supplyCap?.amount?.value },
  { key: 'supplyInfo.supplyCap.usd', get: (r) => r.supplyInfo?.supplyCap?.usd },
  { key: 'supplyInfo.apy.value', get: (r) => r.supplyInfo?.apy?.value },
  { key: 'borrowInfo.borrowingState', get: (r) => r.borrowInfo?.borrowingState },
  { key: 'borrowInfo.borrowCap.amount.value', get: (r) => r.borrowInfo?.borrowCap?.amount?.value },
  { key: 'borrowInfo.borrowCap.usd', get: (r) => r.borrowInfo?.borrowCap?.usd },
  { key: 'borrowInfo.apy.value', get: (r) => r.borrowInfo?.apy?.value },
  { key: 'borrowInfo.availableLiquidity.amount.raw', get: (r) => r.borrowInfo?.availableLiquidity?.amount?.raw },
  { key: 'borrowInfo.total.amount.raw', get: (r) => r.borrowInfo?.total?.amount?.raw },
  { key: 'borrowInfo.reserveFactor.raw', get: (r) => r.borrowInfo?.reserveFactor?.raw },
  { key: 'borrowInfo.variableRateSlope1.raw', get: (r) => r.borrowInfo?.variableRateSlope1?.raw },
  { key: 'borrowInfo.variableRateSlope2.raw', get: (r) => r.borrowInfo?.variableRateSlope2?.raw },
  { key: 'borrowInfo.optimalUsageRate.raw', get: (r) => r.borrowInfo?.optimalUsageRate?.raw },
  { key: 'incentives', get: (r) => r.incentives }, // 允许空数组，但不能缺失
];

function hasValue(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  if (Array.isArray(v)) return true; // 空数组算存在
  return true;
}

function run() {
  let raw;
  try {
    raw = readFileSync(DEBUG_PATH, 'utf8');
  } catch (e) {
    console.error('缺少 data/debug/aave-all-markets-data.json，请先运行 fetcher 生成（如 npm run dev）');
    process.exit(1);
  }

  const data = JSON.parse(raw);
  const markets = data.markets || [];
  const results = []; // { reserveId, chainId, marketName, symbol, missing: [] }
  const missingByField = {}; // field -> count

  SDK_FIELD_CHECKS.forEach(({ key }) => {
    missingByField[key] = 0;
  });

  let totalReserves = 0;
  let excludedFrozenPaused = 0;

  for (const market of markets) {
    const marketName = market.name || 'Unknown';
    const chainName = market.chain?.name || 'Unknown';
    const chainId = market.chain?.chainId ?? 0;
    const supplyReserves = market.supplyReserves || [];

    for (const reserve of supplyReserves) {
      if (reserve.isFrozen === true || reserve.isPaused === true) {
        excludedFrozenPaused++;
        continue;
      }
      const symbol = reserve.underlyingToken?.symbol || '?';
      const addr = reserve.underlyingToken?.address || '';
      const reserveId = `${marketName}:${chainId}:${addr.toLowerCase()}`;
      totalReserves++;

      const missing = [];
      for (const { key, get } of SDK_FIELD_CHECKS) {
        const v = get(reserve);
        if (!hasValue(v)) {
          missing.push(key);
          missingByField[key]++;
        }
      }

      if (missing.length > 0) {
        results.push({
          reserveId,
          chainId,
          marketName,
          symbol,
          tokenAddress: addr.slice(0, 10) + '...',
          missing,
        });
      }
    }
  }

  // 输出（与 createBaseDatasetFromMarkets 一致：排除 frozen/paused）
  console.log('=== Aave SDK 逐条 Reserve 字段缺失校验 ===\n');
  console.log(`排除 frozen/paused 后 reserve 数: ${totalReserves}`);
  console.log(`(已排除 isFrozen/isPaused: ${excludedFrozenPaused} 条，与 fetchMarketsPayload 的 payload.data 条数应对齐，约 240)`);
  console.log(`存在至少一处字段缺失的 reserve 数: ${results.length}\n`);

  if (results.length === 0) {
    console.log('✅ 所有 reserve 的依赖字段在 SDK 返回中均存在，无缺失。');
    return;
  }

  console.log('--- 按字段统计：缺失该字段的 reserve 数量 ---');
  const byField = Object.entries(missingByField)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  byField.forEach(([field, count]) => {
    console.log(`  ${field}: ${count}`);
  });

  console.log('\n--- 存在字段缺失的 reserve 列表（reserveId, symbol, 缺失字段）---');
  results.forEach((r) => {
    console.log(`  ${r.reserveId} (${r.symbol}) missing: ${r.missing.join(', ')}`);
  });
}

run();

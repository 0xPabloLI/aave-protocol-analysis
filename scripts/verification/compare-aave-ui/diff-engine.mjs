const FIELD_RULES = [
  { field: 'supplyApy', tolerance: 0.05, unit: 'percent', description: 'Supply APY' },
  { field: 'borrowApy', tolerance: 0.05, unit: 'percent', description: 'Borrow APY' },
  { field: 'utilizationPct', tolerance: 0.1, unit: 'percent', description: 'Utilization' },
  { field: 'ltv', tolerance: 0.01, unit: 'percent', description: 'LTV' },
  { field: 'liquidationThreshold', tolerance: 0.01, unit: 'percent', description: 'Liquidation Threshold' },
  { field: 'supplyCap', tolerance: 5, unit: 'raw_amount', description: 'Supply Cap' },
  { field: 'borrowCap', tolerance: 5, unit: 'raw_amount', description: 'Borrow Cap' },
  { field: 'isFrozen', tolerance: 0, unit: 'boolean', description: 'Is Frozen' },
  { field: 'isPaused', tolerance: 0, unit: 'boolean', description: 'Is Paused' },
  { field: 'collateralFactor', tolerance: 0.01, unit: 'percent', description: 'Collateral Factor (V4)' },
];

function matchV3Reserve(backendReserve, aaveUiReserve) {
  return (
    backendReserve.chainId === aaveUiReserve.chainId &&
    backendReserve.tokenAddress === aaveUiReserve.tokenAddress
  );
}

function matchV4Reserve(backendReserve, aaveUiReserve) {
  if (backendReserve.aaveProReserveId && aaveUiReserve.reserveGraphqlId) {
    return backendReserve.aaveProReserveId === aaveUiReserve.reserveGraphqlId;
  }
  const backendChainId = backendReserve.spokeChainId ?? backendReserve.chainId;
  const uiChainId = aaveUiReserve.spokeChainId;
  const chainMatch = backendChainId === uiChainId && backendReserve.tokenAddress === aaveUiReserve.tokenAddress;
  if (!chainMatch) return false;
  if (backendReserve.spokeName && aaveUiReserve.spokeName) {
    return backendReserve.spokeName === aaveUiReserve.spokeName;
  }
  return true;
}

function rawToHumanReadable(rawStr, decimals) {
  if (!rawStr || decimals == null) return null;
  try {
    const intVal = BigInt(rawStr);
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = intVal / divisor;
    const frac = intVal % divisor;
    if (frac === BigInt(0)) return Number(whole);
    return parseFloat(whole.toString()) + parseFloat(frac.toString()) / parseFloat(divisor.toString());
  } catch {
    return null;
  }
}

function diffField(fieldName, backendVal, aaveUiVal, tolerance, unit, decimals) {
  if (backendVal == null && aaveUiVal == null) return null;
  if (backendVal == null || aaveUiVal == null) {
    return {
      field: fieldName,
      backend: backendVal,
      aaveUi: aaveUiVal,
      diff: null,
      tolerance,
      status: 'missing_value',
    };
  }

  if (unit === 'boolean') {
    if (backendVal === aaveUiVal) return null;
    return {
      field: fieldName,
      backend: backendVal,
      aaveUi: aaveUiVal,
      diff: null,
      tolerance: 0,
      status: 'mismatch',
    };
  }

  let bNum = typeof backendVal === 'string' ? parseFloat(backendVal) : backendVal;
  const uNum = typeof aaveUiVal === 'string' ? parseFloat(aaveUiVal) : aaveUiVal;

  if (unit === 'raw_amount' && typeof backendVal === 'string' && /^\d+$/.test(backendVal) && decimals != null) {
    const converted = rawToHumanReadable(backendVal, decimals);
    if (converted !== null) bNum = converted;
  }

  if (isNaN(bNum) || isNaN(uNum)) {
    return {
      field: fieldName,
      backend: backendVal,
      aaveUi: aaveUiVal,
      diff: null,
      tolerance,
      status: 'parse_error',
    };
  }

  const absTolerance = unit === 'percent' ? tolerance : 0;
  const relTolerance = unit === 'raw_amount' ? tolerance : 0;
  const diff = Math.abs(bNum - uNum);

  if (diff === 0) return null;

  if (absTolerance > 0 && diff <= absTolerance) {
    return { field: fieldName, backend: bNum, aaveUi: uNum, diff, tolerance: absTolerance, status: 'within_tolerance' };
  }

  if (relTolerance > 0 && uNum !== 0) {
    const relDiff = (diff / Math.abs(uNum)) * 100;
    if (relDiff <= relTolerance) {
      return { field: fieldName, backend: bNum, aaveUi: uNum, diff, tolerance: relTolerance, status: 'within_tolerance' };
    }
  }

  if (absTolerance > 0 || relTolerance > 0) {
    return { field: fieldName, backend: bNum, aaveUi: uNum, diff, tolerance: Math.max(absTolerance, relTolerance), status: 'out_of_tolerance' };
  }

  return { field: fieldName, backend: bNum, aaveUi: uNum, diff, tolerance: pctTolerance, status: 'out_of_tolerance' };
}

function buildKey(reserve, version) {
  if (version === 'v4') {
    if (reserve.aaveProReserveId || reserve.reserveGraphqlId) {
      return reserve.aaveProReserveId ?? reserve.reserveGraphqlId;
    }
    const chainId = reserve.spokeChainId ?? reserve.chainId;
    const spoke = reserve.spokeName ?? '';
    return `${chainId}:${reserve.tokenAddress}:${spoke}`;
  }
  return `${reserve.chainId}:${reserve.tokenAddress}`;
}

function compareReserves(backendReserves, aaveUiReserves, version) {
  const matchFn = version === 'v4' ? matchV4Reserve : matchV3Reserve;
  const relevantBackend = backendReserves.filter((r) => r.version === version);
  const relevantUi = aaveUiReserves.filter((r) => r.version === version);

  const uiByKey = new Map(relevantUi.map((r) => [buildKey(r, version), r]));
  const backendByKey = new Map(relevantBackend.map((r) => [buildKey(r, version), r]));

  const matched = [];
  const missingInBackend = [];
  const missingInAaveUi = [];

  for (const [key, uiReserve] of uiByKey) {
    const backendReserve = backendByKey.get(key);
    if (!backendReserve) {
      missingInBackend.push({ key, reserve: uiReserve });
      continue;
    }

    const mismatches = [];
    for (const rule of FIELD_RULES) {
      let backendVal = backendReserve[rule.field];
      let aaveUiVal = uiReserve[rule.field];
      const decimals = uiReserve.decimals ?? backendReserve.decimals ?? 18;
      const result = diffField(rule.field, backendVal, aaveUiVal, rule.tolerance, rule.unit, decimals);
      if (result) mismatches.push(result);
    }

    matched.push({
      key,
      tokenSymbol: backendReserve.tokenSymbol ?? uiReserve.tokenSymbol,
      chainId: backendReserve.chainId ?? uiReserve.chainId,
      version,
      reserveId: backendReserve.reserveId,
      mismatches,
    });
  }

  for (const [key, backendReserve] of backendByKey) {
    if (!uiByKey.has(key)) {
      missingInAaveUi.push({ key, reserve: backendReserve });
    }
  }

  return { matched, missingInBackend, missingInAaveUi };
}

function generateReport(v3Result, v4Result, backendSource, aaveUiSources) {
  const allMatched = [...v3Result.matched, ...v4Result.matched];
  const allMismatches = allMatched.flatMap((m) => m.mismatches);

  const statusCounts = { exact_match: 0, within_tolerance: 0, out_of_tolerance: 0, mismatch: 0, missing_value: 0, parse_error: 0 };
  for (const m of allMismatches) {
    statusCounts[m.status] = (statusCounts[m.status] ?? 0) + 1;
  }

  const fieldsWithZeroDiff = allMatched.reduce((count, m) => {
    const comparedFields = FIELD_RULES.filter(
      (r) => m.mismatches.every((mm) => mm.field !== r.field) &&
        m.mismatches.length < FIELD_RULES.length
    );
    return count + Math.max(0, FIELD_RULES.length - m.mismatches.length);
  }, 0);

  const outOfTolerance = allMismatches.filter((m) => m.status === 'out_of_tolerance');
  const withinTolerance = allMismatches.filter((m) => m.status === 'within_tolerance');

  return {
    timestamp: new Date().toISOString(),
    backendSource,
    aaveUiSources,
    summary: {
      totalReserves: {
        backendV3: v3Result.matched.length + v3Result.missingInAaveUi.length,
        backendV4: v4Result.matched.length + v4Result.missingInAaveUi.length,
        aaveUiV3: v3Result.matched.length + v3Result.missingInBackend.length,
        aaveUiV4: v4Result.matched.length + v4Result.missingInBackend.length,
      },
      matched: { v3: v3Result.matched.length, v4: v4Result.matched.length },
      missingInBackend: { v3: v3Result.missingInBackend.length, v4: v4Result.missingInBackend.length },
      missingInAaveUi: { v3: v3Result.missingInAaveUi.length, v4: v4Result.missingInAaveUi.length },
      fieldMismatches: {
        outOfTolerance: outOfTolerance.length,
        withinTolerance: withinTolerance.length,
        exactMatchFields: fieldsWithZeroDiff,
        booleanMismatch: statusCounts.mismatch,
        missingValue: statusCounts.missing_value,
      },
    },
    outOfTolerance: outOfTolerance.map((m) => ({
      ...m,
      ...(allMatched.find((am) => am.mismatches.includes(m)) ?? {}),
    })),
    withinTolerance: withinTolerance.slice(0, 50),
    v3MissingInBackend: v3Result.missingInBackend.map((m) => ({
      key: m.key,
      tokenSymbol: m.reserve.tokenSymbol,
      chainId: m.reserve.chainId,
    })),
    v3MissingInAaveUi: v3Result.missingInAaveUi.map((m) => ({
      key: m.key,
      tokenSymbol: m.reserve.tokenSymbol,
      chainId: m.reserve.chainId,
    })),
    v4MissingInBackend: v4Result.missingInBackend.map((m) => ({
      key: m.key,
      tokenSymbol: m.reserve.tokenSymbol,
      spokeChainId: m.reserve.spokeChainId,
    })),
    v4MissingInAaveUi: v4Result.missingInAaveUi.map((m) => ({
      key: m.key,
      tokenSymbol: m.reserve.tokenSymbol,
      chainId: m.reserve.chainId,
    })),
  };
}

function printSummary(report) {
  const s = report.summary;
  console.log('\n=== Aave UI ↔ Backend API Comparison Report ===\n');
  console.log(`Timestamp: ${report.timestamp}`);
  console.log(`Backend: ${report.backendSource}`);
  console.log(`Aave UI: V3=${report.aaveUiSources.v3}, V4=${report.aaveUiSources.v4}\n`);

  console.log('--- Reserve Matching ---');
  console.log(`  V3: ${s.matched.v3} matched, ${s.missingInBackend.v3} in Aave UI only, ${s.missingInAaveUi.v3} in Backend only`);
  console.log(`  V4: ${s.matched.v4} matched, ${s.missingInBackend.v4} in Aave UI only, ${s.missingInAaveUi.v4} in Backend only`);

  console.log('\n--- Field Comparison ---');
  console.log(`  Out of tolerance:  ${s.fieldMismatches.outOfTolerance}`);
  console.log(`  Within tolerance:  ${s.fieldMismatches.withinTolerance}`);
  console.log(`  Exact match:       ${s.fieldMismatches.exactMatchFields} field-reserve pairs`);
  console.log(`  Boolean mismatch:  ${s.fieldMismatches.booleanMismatch}`);
  console.log(`  Missing values:    ${s.fieldMismatches.missingValue}`);

  if (report.outOfTolerance.length > 0) {
    console.log('\n--- Out of Tolerance (top 20) ---');
    for (const m of report.outOfTolerance.slice(0, 20)) {
      const label = m.tokenSymbol ? `${m.tokenSymbol} (${m.chainId})` : m.key;
      console.log(`  ${label} | ${m.field}: backend=${m.backend}, aaveUi=${m.aaveUi}, diff=${m.diff?.toFixed(4)}, tolerance=${m.tolerance}`);
    }
    if (report.outOfTolerance.length > 20) {
      console.log(`  ... and ${report.outOfTolerance.length - 20} more`);
    }
  }

  if (report.v3MissingInBackend.length > 0 || report.v4MissingInBackend.length > 0) {
    console.log('\n--- In Aave UI but NOT in Backend ---');
    for (const m of [...report.v3MissingInBackend, ...report.v4MissingInBackend].slice(0, 20)) {
      console.log(`  ${m.tokenSymbol ?? m.key} (chain ${m.chainId ?? m.spokeChainId})`);
    }
  }

  if (report.v3MissingInAaveUi.length > 0 || report.v4MissingInAaveUi.length > 0) {
    console.log('\n--- In Backend but NOT in Aave UI ---');
    for (const m of [...report.v3MissingInAaveUi, ...report.v4MissingInAaveUi].slice(0, 20)) {
      console.log(`  ${m.tokenSymbol ?? m.key} (chain ${m.chainId})`);
    }
  }

  const hasIssues = s.fieldMismatches.outOfTolerance > 0 || s.fieldMismatches.booleanMismatch > 0;
  console.log(`\n=== Result: ${hasIssues ? 'ISSUES FOUND' : 'ALL CLEAR'} ===`);
  return hasIssues ? 1 : 0;
}

export { compareReserves, generateReport, printSummary, FIELD_RULES };

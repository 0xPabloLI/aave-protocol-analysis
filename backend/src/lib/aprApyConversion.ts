export function convertAprToApy(apr: number): number {
  const aprDecimal = apr / 100;
  const monthlyRate = aprDecimal / 12;
  const apyDecimal = Math.pow(1 + monthlyRate, 12) - 1;
  return apyDecimal * 100;
}

export function apyToApr(apy: number): number {
  const apyDecimal = apy / 100;
  const aprDecimal = 12 * (Math.pow(1 + apyDecimal, 1 / 12) - 1);
  return aprDecimal * 100;
}

export function computeTargetTotalAprIncentiveApr(
  targetApr: number,
  nativeApy: number,
  side: 'supply' | 'borrow',
): number {
  const targetApy = convertAprToApy(targetApr);
  if (side === 'supply') {
    const incentiveApy = targetApy - nativeApy;
    if (incentiveApy <= 0) return 0;
    return apyToApr(incentiveApy);
  }
  // Borrow: targetAPR = net borrow APY; incentive = nativeAPY - targetAPY (reduces borrow cost)
  const incentiveApy = nativeApy - targetApy;
  if (incentiveApy <= 0) return 0;
  return apyToApr(incentiveApy);
}

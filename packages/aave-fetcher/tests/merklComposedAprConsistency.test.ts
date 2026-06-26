/**
 * Integration test: validates that for Merkl composed (MULTILOG_DUTCH) opportunities,
 * the opportunity-level APR matches the primary campaign-level APR returned by the API.
 *
 * This verifies the core assumption documented in ADR-0030:
 *   Merkl API returns `opp.apr` and the primary campaign's `campaign.apr` as
 *   already-computed final values that include both composedCampaignsCompute
 *   and composedMultiplier effects.
 *
 * Merkl API structure: a composed opportunity has multiple campaigns with
 * `composedCampaignsCompute`, but only the first (primary) one has `apr > 0`
 * matching `opp.apr`. The rest are sub-campaigns with `apr = 0`.
 *
 * If this test fails, it means Merkl has changed their API behavior and our
 * resolveCampaignApr logic (which uses campaign.apr / 100) may no longer be correct.
 *
 * Run: MERKL_INTEGRATION=1 npx tsx --test packages/aave-fetcher/tests/merklComposedAprConsistency.test.ts
 * CI:  skipped unless MERKL_INTEGRATION=1 (avoids flaky CI from network issues)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const MERKL_API_BASE = 'https://api.merkl.xyz/v4';
const FETCH_TIMEOUT_MS = 30_000;

const skip = process.env.MERKL_INTEGRATION !== '1';

interface RawMerklCampaign {
  apr?: number;
  params?: {
    composedCampaignsCompute?: string;
  };
}

interface RawMerklOpportunity {
  id?: string;
  name?: string;
  type?: string;
  action?: string;
  chainId?: number;
  status?: string;
  apr?: number;
  campaigns?: RawMerklCampaign[];
}

function hasComposedCompute(c: RawMerklCampaign): boolean {
  return typeof c?.params?.composedCampaignsCompute === 'string' && !!c.params.composedCampaignsCompute;
}

async function fetchAllPages(): Promise<RawMerklOpportunity[]> {
  const all: RawMerklOpportunity[] = [];
  let page = 0;
  for (;;) {
    const url = `${MERKL_API_BASE}/opportunities?mainProtocolId=aave&status=LIVE&campaigns=true&page=${page}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Merkl API ${res.status}: ${url}`);
    const batch: RawMerklOpportunity[] = (await res.json()) as RawMerklOpportunity[];
    if (batch.length === 0) break;
    all.push(...batch);
    page++;
  }
  return all;
}

function getComposedOpportunities(opps: RawMerklOpportunity[]) {
  return opps.filter(opp => Array.isArray(opp.campaigns) && opp.campaigns.some(hasComposedCompute));
}

describe('Merkl composed APR consistency (integration)', { skip }, () => {
  it('every LIVE composed opportunity has opp.apr === primary campaign.apr', async () => {
    const opps = await fetchAllPages();
    const composed = getComposedOpportunities(opps);

    assert.ok(composed.length > 0, 'expected at least one composed opportunity in Merkl API');

    const mismatches: string[] = [];

    for (const opp of composed) {
      const primaryCampaign = opp.campaigns!.find(hasComposedCompute);
      if (!primaryCampaign) continue;

      const compute = primaryCampaign.params!.composedCampaignsCompute!;
      const oppApr = opp.apr;
      const campApr = primaryCampaign.apr;

      if (oppApr == null || campApr == null) {
        mismatches.push(
          `opp ${opp.id} (${opp.name}, chain=${opp.chainId}, compute=${compute}): ` +
          `opp.apr=${oppApr} campaign.apr=${campApr} — null/undefined`,
        );
        continue;
      }

      if (Math.abs(oppApr - campApr) > 0.01) {
        mismatches.push(
          `opp ${opp.id} (${opp.name}, chain=${opp.chainId}, compute=${compute}): ` +
          `opp.apr=${oppApr} ≠ campaign.apr=${campApr} (delta=${Math.abs(oppApr - campApr).toFixed(4)})`,
        );
      }
    }

    if (mismatches.length > 0) {
      assert.fail(
        `${mismatches.length} composed opportunity(ies) have mismatched opp.apr vs primary campaign.apr:\n` +
        mismatches.join('\n'),
      );
    }
  });

  it('known compute types (min(1,2) or 1-2) are still present in API data', async () => {
    const opps = await fetchAllPages();
    const composed = getComposedOpportunities(opps);

    const byCompute = new Map<string, number>();
    for (const opp of composed) {
      const primaryCampaign = opp.campaigns!.find(hasComposedCompute);
      if (!primaryCampaign) continue;
      const compute = primaryCampaign.params!.composedCampaignsCompute!;
      byCompute.set(compute, (byCompute.get(compute) ?? 0) + 1);
    }

    console.log(`Composed opportunities: ${composed.length}`);
    for (const [compute, count] of byCompute) {
      console.log(`  compute="${compute}": ${count}`);
    }

    assert.ok(
      byCompute.has('min(1,2)') || byCompute.has('1-2'),
      'expected at least one known compute type (min(1,2) or 1-2); if missing, Merkl may have changed composed campaign structure',
    );
  });
});

#!/usr/bin/env node
import { readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');
const snapshotPath = join(repoRoot, 'docs', 'api', 'aave-subgraph-deployments.snapshot.json');
const outputPath = join(repoRoot, 'docs', 'api', 'subgraph-rate-inputs-health.snapshot.json');

const SUBGRAPH_TIMEOUT_MS = 15_000;
const SUBGRAPH_MAX_RETRIES = 2;
const FALLBACK_CHAIN_IDS = new Set([1088, 5000, 9745, 57073, 4326]);

const SUBGRAPH_QUERY = `
query ReservesRateInputs {
  reserves(first: 3) {
    underlyingAsset
    decimals
    availableLiquidity
    totalScaledVariableDebt
    variableBorrowIndex
    reserveFactor
    variableRateSlope1
    variableRateSlope2
    baseVariableBorrowRate
    optimalUtilisationRate
  }
}
`;

function pickPreferredDeployment(current, candidate) {
  if (!current) return candidate;
  const currentIsCore = current.market === 'core';
  const candidateIsCore = candidate.market === 'core';
  if (!currentIsCore && candidateIsCore) return candidate;

  const currentIsId = (current.queryPath || '').startsWith('id/');
  const candidateIsId = (candidate.queryPath || '').startsWith('id/');
  if (!currentIsId && candidateIsId) return candidate;

  return current;
}

function classifyError(message) {
  const text = String(message || '').toLowerCase();
  if (text.includes('bad indexers') || text.includes('indexer not available') || text.includes('unavailable(no status')) {
    return 'indexer_unavailable';
  }
  if (text.includes('cannot query field')) return 'schema_incompatible';
  if (text.includes('timeout') || text.includes('aborted')) return 'timeout';
  if (text.includes('http ')) return 'http_error';
  return 'unknown_error';
}

function resolveSubgraphUrl(template, apiKey) {
  if (!template) return { url: null, skippedReason: 'missing_query_url_template' };
  if (!template.includes('{apiKey}')) return { url: template, skippedReason: null };
  if (!apiKey) return { url: null, skippedReason: 'missing_api_key' };
  return { url: template.replace('{apiKey}', encodeURIComponent(apiKey)), skippedReason: null };
}

async function fetchSubgraph(url) {
  for (let attempt = 0; attempt <= SUBGRAPH_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SUBGRAPH_TIMEOUT_MS);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: SUBGRAPH_QUERY }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const payload = await response.json();
      const errors = Array.isArray(payload?.errors) ? payload.errors : [];
      if (errors.length > 0) {
        const msg = errors.map((item) => item?.message || 'unknown graphql error').join('; ');
        throw new Error(msg);
      }

      const reserves = Array.isArray(payload?.data?.reserves) ? payload.data.reserves : [];
      return { ok: true, reserveCount: reserves.length };
    } catch (error) {
      if (attempt >= SUBGRAPH_MAX_RETRIES) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      const backoffMs = 300 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  return { ok: false, error: 'unexpected_unreachable_state' };
}

async function main() {
  const snapshotRaw = await readFile(snapshotPath, 'utf8');
  const snapshot = JSON.parse(snapshotRaw);
  const deployments = Array.isArray(snapshot?.deployments) ? snapshot.deployments : [];

  const chosenByChain = new Map();
  for (const deployment of deployments) {
    if (!deployment?.chainId || !deployment?.queryPath || !deployment?.queryUrlTemplate) continue;
    chosenByChain.set(
      deployment.chainId,
      pickPreferredDeployment(chosenByChain.get(deployment.chainId), deployment)
    );
  }

  const apiKey = process.env.THE_GRAPH_API_KEY || '';
  const results = [];

  for (const chainId of Array.from(chosenByChain.keys()).sort((a, b) => a - b)) {
    const deployment = chosenByChain.get(chainId);
    const { url, skippedReason } = resolveSubgraphUrl(deployment.queryUrlTemplate, apiKey);
    if (!url) {
      results.push({
        chainId,
        queryPath: deployment.queryPath,
        market: deployment.market || 'unknown',
        status: 'skipped',
        reason: skippedReason,
        guardedByOnchainFallback: FALLBACK_CHAIN_IDS.has(chainId),
      });
      continue;
    }

    const probe = await fetchSubgraph(url);
    if (probe.ok) {
      results.push({
        chainId,
        queryPath: deployment.queryPath,
        market: deployment.market || 'unknown',
        status: 'ok',
        reserveCount: probe.reserveCount,
        guardedByOnchainFallback: FALLBACK_CHAIN_IDS.has(chainId),
      });
      continue;
    }

    const reason = classifyError(probe.error);
    results.push({
      chainId,
      queryPath: deployment.queryPath,
      market: deployment.market || 'unknown',
      status: 'mismatch',
      reason,
      message: probe.error,
      guardedByOnchainFallback: FALLBACK_CHAIN_IDS.has(chainId),
    });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    sourceSnapshotGeneratedAt: snapshot.generatedAt || null,
    counts: {
      total: results.length,
      ok: results.filter((item) => item.status === 'ok').length,
      mismatch: results.filter((item) => item.status === 'mismatch').length,
      skipped: results.filter((item) => item.status === 'skipped').length,
    },
    mismatchesByReason: results
      .filter((item) => item.status === 'mismatch')
      .reduce((acc, item) => {
        acc[item.reason] = (acc[item.reason] || 0) + 1;
        return acc;
      }, {}),
  };

  await writeFile(
    outputPath,
    `${JSON.stringify({ summary, results }, null, 2)}\n`,
    'utf8'
  );

  console.log(`checked chains: ${summary.counts.total}`);
  console.log(`ok: ${summary.counts.ok}, mismatch: ${summary.counts.mismatch}, skipped: ${summary.counts.skipped}`);
  if (summary.counts.mismatch > 0) {
    const lines = results
      .filter((item) => item.status === 'mismatch')
      .map((item) => `- ${item.chainId} ${item.reason} fallback=${item.guardedByOnchainFallback ? 'yes' : 'no'}`);
    console.log('mismatch chains:\n' + lines.join('\n'));
  }
  if (summary.counts.skipped > 0) {
    const lines = results
      .filter((item) => item.status === 'skipped')
      .map((item) => `- ${item.chainId} ${item.reason}`);
    console.log('skipped chains:\n' + lines.join('\n'));
  }

  const unguardedMismatches = results.filter(
    (item) => item.status === 'mismatch' && !item.guardedByOnchainFallback
  );
  if (unguardedMismatches.length > 0) {
    console.error('\nunguarded mismatches detected (no on-chain fallback configured):');
    for (const item of unguardedMismatches) {
      console.error(`- chain ${item.chainId}: ${item.reason}`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});


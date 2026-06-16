/**
 * E2E test: validates that LLM models correctly parse
 * real Merkl opportunity descriptions into netPositionConstraint.
 *
 * Run: LLM_API_KEY=... LLM_BASE_URL=https://... npx tsx --test packages/aave-fetcher/tests/merklLlmClient-e2e.test.ts
 *
 * Skip: if LLM_API_KEY or LLM_BASE_URL is not set, all tests are skipped.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLlmPrompt,
  callLlmWithFallback,
  parseLlmResponse,
  type LlmAnalysisResult,
  type LlmClientConfig,
} from '../src/merklLlmClient.js';

const API_KEY = process.env.LLM_API_KEY;
const BASE_URL = process.env.LLM_BASE_URL;
const skip = !API_KEY || !BASE_URL;

const llmConfig: LlmClientConfig = {
  apiKey: API_KEY ?? '',
  baseUrl: BASE_URL ?? '',
  totalTimeoutMs: 30_000,
  perModelRetries: 1,
};

interface TestCase {
  name: string;
  opp: { type: string; action: string; description: string; tokenSymbols: string[] };
  expected: LlmAnalysisResult | null;
}

const CASES: TestCase[] = [
  {
    name: 'AAVE_V4_HUB_SUPPLY — net USDe supply minus USDe borrow',
    opp: {
      type: 'AAVE_V4_HUB_SUPPLY',
      action: 'Lend',
      description: 'Supply USDe, excluding borrowers of USDe and GHO',
      tokenSymbols: ['USDe', 'GHO'],
    },
    expected: { sourceSide: 'supply', offsetTokenSymbols: ['USDe', 'GHO'] },
  },
  {
    name: 'AAVE_SUPPLY — net wETH supply minus wETH borrow',
    opp: {
      type: 'AAVE_SUPPLY',
      action: 'Lend',
      description: 'Supply wETH, net of wETH borrowers',
      tokenSymbols: ['wETH'],
    },
    expected: { sourceSide: 'supply', offsetTokenSymbols: ['wETH'] },
  },
  {
    name: 'AAVE_BORROW — net GHO borrow minus GHO supply',
    opp: {
      type: 'AAVE_BORROW',
      action: 'Borrow',
      description: 'Borrow GHO, net of GHO suppliers',
      tokenSymbols: ['GHO'],
    },
    expected: { sourceSide: 'borrow', offsetTokenSymbols: ['GHO'] },
  },
  {
    name: 'MULTILOG_DUTCH — gross position (no net constraint)',
    opp: {
      type: 'MULTILOG_DUTCH',
      action: 'Lend',
      description: 'Supply USDC to earn rewards',
      tokenSymbols: ['USDC'],
    },
    expected: null,
  },
  {
    name: 'AAVE_V4_HUB_SUPPLY — net supply with single offset',
    opp: {
      type: 'AAVE_V4_HUB_SUPPLY',
      action: 'Lend',
      description: 'Net USDT0 lending, offset by USDT0 borrowing',
      tokenSymbols: ['USDT0'],
    },
    expected: { sourceSide: 'supply', offsetTokenSymbols: ['USDT0'] },
  },
];

function resultMatch(actual: LlmAnalysisResult | null, expected: LlmAnalysisResult | null): boolean {
  if (expected === null) return actual === null;
  if (actual === null) return false;
  if (actual.sourceSide !== expected.sourceSide) return false;
  const actualSet = new Set(actual.offsetTokenSymbols);
  const expectedSet = new Set(expected.offsetTokenSymbols);
  if (actualSet.size !== expectedSet.size) return false;
  for (const s of expectedSet) {
    if (!actualSet.has(s)) return false;
  }
  return true;
}

describe('E2E: LLM opportunity parsing with real models', { skip }, () => {
  for (const tc of CASES) {
    it(tc.name, async () => {
      const prompt = buildLlmPrompt(tc.opp);
      const outcome = await callLlmWithFallback(prompt, llmConfig);

      const result = outcome.tag === 'result' ? outcome.value : null;

      if (resultMatch(result, tc.expected)) {
        console.log(`  PASS: ${JSON.stringify(result)}`);
      } else {
        console.log(`  FAIL: expected ${JSON.stringify(tc.expected)}, got ${JSON.stringify(result)}`);
        console.log(`  Prompt snippet: ${prompt.slice(0, 200)}...`);
      }

      assert.ok(
        resultMatch(result, tc.expected),
        `expected ${JSON.stringify(tc.expected)}, got ${JSON.stringify(result)}`
      );
    });
  }

  it('parses all 5 cases with parseLlmResponse directly (synthetic)', () => {
    const syntheticResults = [
      '{"sourceSide":"supply","offsetTokenSymbols":["USDe","GHO"]}',
      '{"sourceSide":"supply","offsetTokenSymbols":["wETH"]}',
      '{"sourceSide":"borrow","offsetTokenSymbols":["GHO"]}',
      'null',
      '{"sourceSide":"supply","offsetTokenSymbols":["USDT0"]}',
    ];
    const expected: Array<LlmAnalysisResult | null> = CASES.map(c => c.expected);
    for (let i = 0; i < syntheticResults.length; i++) {
      const parsed = parseLlmResponse(syntheticResults[i]);
      assert.ok(resultMatch(parsed, expected[i]), `synthetic case ${i}: ${syntheticResults[i]}`);
    }
  });
});

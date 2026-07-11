import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LLM_FREE_MODELS,
  resolveModelAllowList,
  buildModelChain,
  fetchAvailableModels,
  resetPrimaryModelsCache,
  parseSseStream,
  parseMarkdownWrappedJson,
  parseLlmResponse,
  buildLlmPrompt,
  callLlmWithFallback,
  type LlmAnalysisResult,
  type LlmOutcome,
} from '../src/merklLlmClient.js';

function mockFetch(responseBody: unknown, ok = true, contentType = 'application/json') {
  return async (_url: string, _opts: RequestInit) =>
    new Response(
      typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody),
      { status: ok ? 200 : 500, headers: { 'content-type': contentType } }
    ) as Promise<Response>;
}

describe('B3: LLM client — model list + response parsing', () => {
  it('LLM_FREE_MODELS lists the SiliconFlow free-tier chat models', () => {
    assert.ok(LLM_FREE_MODELS.length > 0);
    assert.equal(LLM_FREE_MODELS[0], 'Qwen/Qwen3.5-9B');
  });

  it('resolveModelAllowList defaults to LLM_FREE_MODELS', () => {
    delete process.env.LLM_MODELS;
    assert.deepEqual(resolveModelAllowList(), [...LLM_FREE_MODELS]);
  });

  it('resolveModelAllowList uses LLM_MODELS override (comma-separated, trimmed)', () => {
    process.env.LLM_MODELS = ' Qwen/Qwen2.5-7B-Instruct , THUDM/GLM-4-9B-0414 ';
    assert.deepEqual(resolveModelAllowList(), ['Qwen/Qwen2.5-7B-Instruct', 'THUDM/GLM-4-9B-0414']);
    delete process.env.LLM_MODELS;
  });

  it('resolveModelAllowList ignores empty LLM_MODELS', () => {
    process.env.LLM_MODELS = '  ,  ';
    assert.deepEqual(resolveModelAllowList(), [...LLM_FREE_MODELS]);
    delete process.env.LLM_MODELS;
  });

  it('parseSseStream extracts content from SSE lines', () => {
    const sse = 'data: {"choices":[{"delta":{"content":"{\\"sourceSide\\":\\"supply\\"}"}}]}\ndata: [DONE]\n';
    assert.equal(parseSseStream(sse), '{"sourceSide":"supply"}');
  });

  it('parseSseStream returns empty string for no content lines', () => {
    const sse = 'data: [DONE]\n';
    assert.equal(parseSseStream(sse), '');
  });

  it('parseSseStream concatenates multiple content deltas', () => {
    const sse = 'data: {"choices":[{"delta":{"content":"{\\\"so"}}]}\ndata: {"choices":[{"delta":{"content":"urceSide\\\":\\\"supply\\\"}"}}]}\n';
    assert.equal(parseSseStream(sse), '{"sourceSide":"supply"}');
  });

  it('parseMarkdownWrappedJson extracts JSON from markdown code block', () => {
    const md = '```json\n{"sourceSide":"supply","offsetTokenSymbols":["USDe"]}\n```';
    assert.deepEqual(
      parseMarkdownWrappedJson(md),
      { sourceSide: 'supply', offsetTokenSymbols: ['USDe'] }
    );
  });

  it('parseMarkdownWrappedJson returns null for no code block', () => {
    assert.equal(parseMarkdownWrappedJson('no json here'), null);
  });

  it('parseLlmResponse parses plain JSON', () => {
    const result = parseLlmResponse('{"sourceSide":"borrow","offsetTokenSymbols":["GHO"]}');
    assert.deepEqual(result, { sourceSide: 'borrow', offsetTokenSymbols: ['GHO'] });
  });

  it('parseLlmResponse parses null response', () => {
    assert.equal(parseLlmResponse('null'), null);
  });

  it('parseLlmResponse parses markdown-wrapped JSON', () => {
    const md = '```json\n{"sourceSide":"supply","offsetTokenSymbols":["USDe"]}\n```';
    const result = parseLlmResponse(md) as LlmAnalysisResult;
    assert.deepEqual(result, { sourceSide: 'supply', offsetTokenSymbols: ['USDe'] });
  });

  it('parseLlmResponse parses SSE-wrapped response', () => {
    const sse = 'data: {"choices":[{"delta":{"content":"{\\\"sourceSide\\\":\\\"supply\\\",\\\"offsetTokenSymbols\\\":[\\\"USDe\\\"]}"}}]}';
    const result = parseLlmResponse(sse) as LlmAnalysisResult;
    assert.deepEqual(result, { sourceSide: 'supply', offsetTokenSymbols: ['USDe'] });
  });

  it('parseLlmResponse returns null for unparseable input', () => {
    assert.equal(parseLlmResponse('gibberish'), null);
  });

  it('parseLlmResponse validates sourceSide is supply or borrow', () => {
    assert.equal(parseLlmResponse('{"sourceSide":"invalid","offsetTokenSymbols":[]}'), null);
  });

  it('parseLlmResponse validates offsetTokenSymbols is array', () => {
    assert.equal(parseLlmResponse('{"sourceSide":"supply","offsetTokenSymbols":"not-array"}'), null);
  });

  it('buildModelChain returns models for primary config', async () => {
    const primary = { apiKey: 'p', baseUrl: 'https://p.com/v1' };
    const chain = await buildModelChain(primary);
    assert.ok(chain.length > 0);
    assert.equal(chain[0].config.apiKey, 'p');
  });

  it('buildModelChain returns empty when no config provided', async () => {
    const chain = await buildModelChain(undefined);
    assert.equal(chain.length, 0);
  });

  it('buildLlmPrompt includes opportunity type and description', () => {
    const prompt = buildLlmPrompt({
      type: 'AAVE_SUPPLY',
      action: 'Lend',
      description: 'Supply USDT0, excluding borrowers of USDe and GHO',
      tokenSymbols: ['USDT0', 'USDe', 'GHO'],
    });
    assert.ok(prompt.includes('AAVE_SUPPLY'));
    assert.ok(prompt.includes('Supply USDT0'));
    assert.ok(prompt.includes('USDT0, USDe, GHO'));
  });

  it('buildLlmPrompt output contains JSON schema instruction', () => {
    const prompt = buildLlmPrompt({
      type: 'MULTILOG_DUTCH',
      action: 'Borrow',
      description: 'Net borrowing USDC',
      tokenSymbols: ['USDC'],
    });
    assert.ok(prompt.includes('sourceSide'));
    assert.ok(prompt.includes('offsetTokenSymbols'));
    assert.ok(prompt.includes('Aave'));
    assert.ok(prompt.includes('EXAMPLES'));
  });
});

describe('B3: callLlmWithFallback — API call + fallback', () => {
  const config = { apiKey: 'test-key', baseUrl: 'https://example.com/v1', totalTimeoutMs: 5000 };

  it('returns parsed result on first model success', async () => {
    const fetch = mockFetch({
      choices: [{ message: { content: '{"sourceSide":"supply","offsetTokenSymbols":["USDe"]}' } }],
    });
    const result = await callLlmWithFallback('test prompt', config, fetch);
    assert.deepEqual(result, { tag: 'result', value: { sourceSide: 'supply', offsetTokenSymbols: ['USDe'] } });
  });

  it('returns null when LLM says null', async () => {
    const fetch = mockFetch({
      choices: [{ message: { content: 'null' } }],
    });
    const result = await callLlmWithFallback('test prompt', config, fetch);
    assert.deepEqual(result, { tag: 'result', value: null });
  });

  it('falls back to next model on non-ok response', async () => {
    let callCount = 0;
    const fetch = async (_url: string, _opts: RequestInit) => {
      callCount++;
      if (callCount === 1) return new Response('error', { status: 500 }) as Response;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"sourceSide":"borrow","offsetTokenSymbols":["GHO"]}' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      ) as Response;
    };
    const result = await callLlmWithFallback('test prompt', config, fetch);
    assert.deepEqual(result, { tag: 'result', value: { sourceSide: 'borrow', offsetTokenSymbols: ['GHO'] } });
    assert.ok(callCount >= 2);
  });

  it('returns unavailable when all models fail', async () => {
    const fetch = async () => new Response('error', { status: 500 }) as Response;
    const result = await callLlmWithFallback('test prompt', { ...config, totalTimeoutMs: 100 }, fetch);
    assert.deepEqual(result, { tag: 'unavailable' });
  });

  it('handles SSE streaming response', async () => {
    const sseBody = 'data: {"choices":[{"delta":{"content":"{\\"sourceSide\\":\\"supply\\",\\"offsetTokenSymbols\\":[\\"USDe\\"]}"}}]}\ndata: [DONE]\n';
    const fetch = mockFetch(sseBody, true, 'text/event-stream');
    const result = await callLlmWithFallback('test prompt', config, fetch);
    assert.deepEqual(result, { tag: 'result', value: { sourceSide: 'supply', offsetTokenSymbols: ['USDe'] } });
  });

  it('respects totalTimeoutMs', async () => {
    const slowFetch = async () => new Promise<Response>((resolve) => {
      setTimeout(() => resolve(new Response('timeout', { status: 500 })), 10000);
    });
    const result = await callLlmWithFallback('test prompt', { ...config, totalTimeoutMs: 50 }, slowFetch);
    assert.deepEqual(result, { tag: 'unavailable' });
  });

  it('returns unavailable when no config provided', async () => {
    const result = await callLlmWithFallback('test prompt', undefined);
    assert.deepEqual(result, { tag: 'unavailable' });
  });

  it('treats unparseable content as unanswered (falls through to next model)', async () => {
    let callCount = 0;
    const fetch = async (_url: string, _opts: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: 'I cannot determine that.' } }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }) as Response;
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'null' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }) as Response;
    };
    const result = await callLlmWithFallback('test prompt', { ...config, totalTimeoutMs: 5000 }, fetch);
    assert.deepEqual(result, { tag: 'result', value: null });
    assert.ok(callCount >= 2, 'should have tried a second model after unparseable response');
  });
});

describe('fetchAvailableModels — generic /models endpoint', () => {
  it('fetches chat model list from baseUrl/models', async () => {
    resetPrimaryModelsCache();
    const fakeModels = [
      { id: 'Qwen/Qwen3.5-9B' },
      { id: 'deepseek-ai/DeepSeek-V4-Pro' },
    ];
    const fetch = async (url: string) => {
      assert.ok(url.includes('/models'), `expected /models URL, got ${url}`);
      assert.ok(url.includes('sub_type=chat'), `expected sub_type=chat filter, got ${url}`);
      return new Response(JSON.stringify({ data: fakeModels }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }) as Response;
    };
    const result = await fetchAvailableModels('https://api.example.com/v1', 'test-key', fetch);
    assert.deepEqual(result, ['Qwen/Qwen3.5-9B', 'deepseek-ai/DeepSeek-V4-Pro']);
    resetPrimaryModelsCache();
  });

  it('sends Authorization header with apiKey', async () => {
    resetPrimaryModelsCache();
    let capturedAuth = '';
    const fetch = async (_url: string, opts: RequestInit) => {
      capturedAuth = opts.headers?.['Authorization' as keyof HeadersInit] as string ?? '';
      return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }) as Response;
    };
    await fetchAvailableModels('https://api.example.com/v1', 'my-secret-key', fetch);
    assert.equal(capturedAuth, 'Bearer my-secret-key');
    resetPrimaryModelsCache();
  });

  it('falls back to LLM_FREE_MODELS on fetch error', async () => {
    resetPrimaryModelsCache();
    const fetch = async () => new Response('error', { status: 500 }) as Response;
    const result = await fetchAvailableModels('https://api.example.com/v1', 'key', fetch);
    assert.equal(result.length, LLM_FREE_MODELS.length);
    assert.equal(result[0], LLM_FREE_MODELS[0]);
    resetPrimaryModelsCache();
  });

  it('falls back to LLM_FREE_MODELS on network error', async () => {
    resetPrimaryModelsCache();
    const fetch = async () => { throw new Error('network error'); };
    const result = await fetchAvailableModels('https://api.example.com/v1', 'key', fetch);
    assert.equal(result.length, LLM_FREE_MODELS.length);
    resetPrimaryModelsCache();
  });

  it('caches result on second call', async () => {
    resetPrimaryModelsCache();
    let callCount = 0;
    const fetch = async () => {
      callCount++;
      return new Response(JSON.stringify({ data: [{ id: 'cached-model' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }) as Response;
    };
    const first = await fetchAvailableModels('https://api.example.com/v1', 'key', fetch);
    assert.equal(callCount, 1);
    const second = await fetchAvailableModels('https://api.example.com/v1', 'key', fetch);
    assert.equal(callCount, 1);
    assert.deepEqual(first, second);
    resetPrimaryModelsCache();
  });

  it('resetPrimaryModelsCache clears cache', async () => {
    resetPrimaryModelsCache();
    let callCount = 0;
    const fetch = async () => {
      callCount++;
      return new Response(JSON.stringify({ data: [{ id: 'fresh-model' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }) as Response;
    };
    await fetchAvailableModels('https://api.example.com/v1', 'key', fetch);
    assert.equal(callCount, 1);
    resetPrimaryModelsCache();
    await fetchAvailableModels('https://api.example.com/v1', 'key', fetch);
    assert.equal(callCount, 2);
  });

  it('handles response with empty data array by falling back', async () => {
    resetPrimaryModelsCache();
    const fetch = async () => new Response(JSON.stringify({ data: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }) as Response;
    const result = await fetchAvailableModels('https://api.example.com/v1', 'key', fetch);
    assert.equal(result.length, LLM_FREE_MODELS.length);
    resetPrimaryModelsCache();
  });

  it('respects 10s timeout via AbortSignal', async () => {
    resetPrimaryModelsCache();
    const fetch = async (_url: string, opts: RequestInit) => {
      assert.ok(opts.signal instanceof AbortSignal, 'expected AbortSignal');
      return new Response(JSON.stringify({ data: [{ id: 'test' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }) as Response;
    };
    await fetchAvailableModels('https://api.example.com/v1', 'key', fetch);
    resetPrimaryModelsCache();
  });
});

describe('buildModelChain — with dynamic primary models', () => {
  it('keeps only free allow-list models that the provider serves, best-first', async () => {
    resetPrimaryModelsCache();
    const primary = { apiKey: 'p', baseUrl: 'https://primary.com/v1' };
    // Live list: two free models (out of order) + one paid model that must be dropped.
    const fetch = async (url: string) => {
      if (url.includes('/models')) {
        return new Response(JSON.stringify({ data: [
          { id: 'Qwen/Qwen3-8B' },          // free, lower priority
          { id: 'deepseek-ai/DeepSeek-V4-Pro' }, // paid → must be excluded
          { id: 'Qwen/Qwen3.5-9B' },        // free, top priority
        ] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }) as Response;
      }
      return new Response('not found', { status: 404 }) as Response;
    };
    const chain = await buildModelChain(primary, fetch);
    const models = chain.map(c => c.model);
    // Only free models, ordered by LLM_FREE_MODELS priority (3.5-9B before 3-8B).
    assert.deepEqual(models, ['Qwen/Qwen3.5-9B', 'Qwen/Qwen3-8B']);
    assert.ok(!models.includes('deepseek-ai/DeepSeek-V4-Pro'), 'paid models must be excluded');
    resetPrimaryModelsCache();
  });

  it('falls back to full free list when no live model intersects the allow-list', async () => {
    resetPrimaryModelsCache();
    const primary = { apiKey: 'p', baseUrl: 'https://primary.com/v1' };
    const fetch = async (url: string) => {
      if (url.includes('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'some-unknown-paid-model' }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }) as Response;
      }
      return new Response('not found', { status: 404 }) as Response;
    };
    const chain = await buildModelChain(primary, fetch);
    assert.equal(chain.length, LLM_FREE_MODELS.length);
    assert.equal(chain[0].model, LLM_FREE_MODELS[0]);
    resetPrimaryModelsCache();
  });

  it('falls back to LLM_FREE_MODELS when primary /models fails', async () => {
    resetPrimaryModelsCache();
    const primary = { apiKey: 'p', baseUrl: 'https://primary.com/v1' };
    const fetch = async (_url: string) => new Response('error', { status: 500 }) as Response;
    const chain = await buildModelChain(primary, fetch);
    assert.equal(chain.length, LLM_FREE_MODELS.length);
    assert.equal(chain[0].model, LLM_FREE_MODELS[0]);
    resetPrimaryModelsCache();
  });
});

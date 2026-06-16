import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LLM_FALLBACK_MODELS,
  OPENROUTER_FREE_MODELS_FALLBACK,
  buildModelChain,
  fetchAvailableModels,
  fetchOpenRouterFreeModels,
  resetOpenRouterCache,
  resetPrimaryModelsCache,
  parseSseStream,
  parseMarkdownWrappedJson,
  parseLlmResponse,
  buildLlmPrompt,
  callLlmWithFallback,
  type LlmAnalysisResult,
} from '../src/merklLlmClient.js';

function mockFetch(responseBody: unknown, ok = true, contentType = 'application/json') {
  return async (_url: string, _opts: RequestInit) =>
    new Response(
      typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody),
      { status: ok ? 200 : 500, headers: { 'content-type': contentType } }
    ) as Promise<Response>;
}

describe('B3: LLM client — model list + response parsing', () => {
  it('LLM_FALLBACK_MODELS has 12 entries for primary config', () => {
    assert.equal(LLM_FALLBACK_MODELS.length, 12);
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

  it('OPENROUTER_FREE_MODELS_FALLBACK has 20 entries starting with deepseek', () => {
    assert.equal(OPENROUTER_FREE_MODELS_FALLBACK.length, 20);
    assert.equal(OPENROUTER_FREE_MODELS_FALLBACK[0], 'deepseek/deepseek-v4-flash:free');
  });

  it('buildModelChain combines primary + openrouter models', async () => {
    const primary = { apiKey: 'p', baseUrl: 'https://p.com/v1' };
    const openrouter = { apiKey: 'o', baseUrl: 'https://openrouter.ai/api/v1' };
    const chain = await buildModelChain(primary, openrouter);
    assert.ok(chain.length > 0);
    assert.equal(chain[0].config.apiKey, 'p');
  });

  it('buildModelChain with only openrouter returns only openrouter models', async () => {
    const openrouter = { apiKey: 'o', baseUrl: 'https://openrouter.ai/api/v1' };
    const chain = await buildModelChain(undefined, openrouter);
    assert.ok(chain.length >= 1);
    for (const entry of chain) {
      assert.equal(entry.config.apiKey, 'o');
    }
  });

  it('fetchOpenRouterFreeModels returns fetched models on success', async () => {
    resetOpenRouterCache();
    const fakeModels = [
      { id: 'deepseek/deepseek-v4-flash:free', context_length: 128000 },
      { id: 'qwen/qwen3-coder:free', context_length: 64000 },
      { id: 'openrouter/free', context_length: 32000 },
    ];
    const fetch = async () => new Response(JSON.stringify({ data: fakeModels }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }) as Response;
    const result = await fetchOpenRouterFreeModels(fetch);
    assert.equal(result.length, 3);
    assert.equal(result[0], 'deepseek/deepseek-v4-flash:free');
    resetOpenRouterCache();
  });

  it('fetchOpenRouterFreeModels falls back to FALLBACK on fetch error', async () => {
    resetOpenRouterCache();
    const fetch = async () => new Response('error', { status: 500 }) as Response;
    const result = await fetchOpenRouterFreeModels(fetch);
    assert.equal(result.length, OPENROUTER_FREE_MODELS_FALLBACK.length);
    assert.equal(result[0], 'deepseek/deepseek-v4-flash:free');
    resetOpenRouterCache();
  });

  it('fetchOpenRouterFreeModels uses cache on second call', async () => {
    resetOpenRouterCache();
    let callCount = 0;
    const fetch = async () => {
      callCount++;
      return new Response(JSON.stringify({ data: [
        { id: 'test/model:free', context_length: 100000 },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } }) as Response;
    };
    const first = await fetchOpenRouterFreeModels(fetch);
    assert.equal(callCount, 1);
    const second = await fetchOpenRouterFreeModels(fetch);
    assert.equal(callCount, 1);
    assert.deepEqual(first, second);
    resetOpenRouterCache();
  });

  it('resetOpenRouterCache clears cache', async () => {
    resetOpenRouterCache();
    let callCount = 0;
    const fetch = async () => {
      callCount++;
      return new Response(JSON.stringify({ data: [
        { id: 'test/model:free', context_length: 100000 },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } }) as Response;
    };
    await fetchOpenRouterFreeModels(fetch);
    assert.equal(callCount, 1);
    resetOpenRouterCache();
    await fetchOpenRouterFreeModels(fetch);
    assert.equal(callCount, 2);
  });

  it('fetchOpenRouterFreeModels sorts by context_length descending', async () => {
    resetOpenRouterCache();
    const fakeModels = [
      { id: 'small/model:free', context_length: 32000 },
      { id: 'big/model:free', context_length: 200000 },
      { id: 'mid/model:free', context_length: 128000 },
    ];
    const fetch = async () => new Response(JSON.stringify({ data: fakeModels }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }) as Response;
    const result = await fetchOpenRouterFreeModels(fetch);
    assert.equal(result[0], 'big/model:free');
    assert.equal(result[1], 'mid/model:free');
    assert.equal(result[2], 'small/model:free');
    resetOpenRouterCache();
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
    resetOpenRouterCache();
    const fetch = mockFetch({
      choices: [{ message: { content: '{"sourceSide":"supply","offsetTokenSymbols":["USDe"]}' } }],
    });
    const result = await callLlmWithFallback('test prompt', undefined, config, fetch);
    assert.deepEqual(result, { sourceSide: 'supply', offsetTokenSymbols: ['USDe'] });
  });

  it('returns null when LLM says null', async () => {
    resetOpenRouterCache();
    const fetch = mockFetch({
      choices: [{ message: { content: 'null' } }],
    });
    const result = await callLlmWithFallback('test prompt', undefined, config, fetch);
    assert.equal(result, null);
  });

  it('falls back to next model on non-ok response', async () => {
    resetOpenRouterCache();
    let callCount = 0;
    const fetch = async (_url: string, _opts: RequestInit) => {
      callCount++;
      if (callCount === 1) return new Response('error', { status: 500 }) as Response;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"sourceSide":"borrow","offsetTokenSymbols":["GHO"]}' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      ) as Response;
    };
    const result = await callLlmWithFallback('test prompt', undefined, config, fetch);
    assert.deepEqual(result, { sourceSide: 'borrow', offsetTokenSymbols: ['GHO'] });
    assert.ok(callCount >= 2);
  });

  it('returns null when all models fail', async () => {
    resetOpenRouterCache();
    const fetch = async () => new Response('error', { status: 500 }) as Response;
    const result = await callLlmWithFallback('test prompt', undefined, { ...config, totalTimeoutMs: 100 }, fetch);
    assert.equal(result, null);
  });

  it('handles SSE streaming response', async () => {
    resetOpenRouterCache();
    const sseBody = 'data: {"choices":[{"delta":{"content":"{\\"sourceSide\\":\\"supply\\",\\"offsetTokenSymbols\\":[\\"USDe\\"]}"}}]}\ndata: [DONE]\n';
    const fetch = mockFetch(sseBody, true, 'text/event-stream');
    const result = await callLlmWithFallback('test prompt', undefined, config, fetch);
    assert.deepEqual(result, { sourceSide: 'supply', offsetTokenSymbols: ['USDe'] });
  });

  it('respects totalTimeoutMs', async () => {
    resetOpenRouterCache();
    const slowFetch = async () => new Promise<Response>((resolve) => {
      setTimeout(() => resolve(new Response('timeout', { status: 500 })), 10000);
    });
    const result = await callLlmWithFallback('test prompt', undefined, { ...config, totalTimeoutMs: 50 }, slowFetch);
    assert.equal(result, null);
  });

  it('returns null when no config provided', async () => {
    const result = await callLlmWithFallback('test prompt', undefined, undefined);
    assert.equal(result, null);
  });

  it('uses openrouter models when only openrouterConfig provided', async () => {
    resetOpenRouterCache();
    const openrouterConfig = { apiKey: 'or-key', baseUrl: 'https://openrouter.ai/api/v1', totalTimeoutMs: 5000 };
    const fetch = mockFetch({
      choices: [{ message: { content: '{"sourceSide":"supply","offsetTokenSymbols":["USDe"]}' } }],
    });
    const result = await callLlmWithFallback('test prompt', undefined, openrouterConfig, fetch);
    assert.deepEqual(result, { sourceSide: 'supply', offsetTokenSymbols: ['USDe'] });
  });
});

describe('fetchAvailableModels — generic /models endpoint', () => {
  it('fetches model list from baseUrl/models', async () => {
    resetPrimaryModelsCache();
    const fakeModels = [
      { id: 'claude-haiku-4.5' },
      { id: 'gpt-5.4' },
    ];
    const fetch = async (url: string) => {
      assert.ok(url.endsWith('/models'), `expected /models URL, got ${url}`);
      return new Response(JSON.stringify({ data: fakeModels }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }) as Response;
    };
    const result = await fetchAvailableModels('https://api.example.com/v1', 'test-key', fetch);
    assert.deepEqual(result, ['claude-haiku-4.5', 'gpt-5.4']);
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

  it('falls back to LLM_FALLBACK_MODELS on fetch error', async () => {
    resetPrimaryModelsCache();
    const fetch = async () => new Response('error', { status: 500 }) as Response;
    const result = await fetchAvailableModels('https://api.example.com/v1', 'key', fetch);
    assert.equal(result.length, LLM_FALLBACK_MODELS.length);
    assert.equal(result[0], LLM_FALLBACK_MODELS[0]);
    resetPrimaryModelsCache();
  });

  it('falls back to LLM_FALLBACK_MODELS on network error', async () => {
    resetPrimaryModelsCache();
    const fetch = async () => { throw new Error('network error'); };
    const result = await fetchAvailableModels('https://api.example.com/v1', 'key', fetch);
    assert.equal(result.length, LLM_FALLBACK_MODELS.length);
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
    assert.equal(result.length, LLM_FALLBACK_MODELS.length);
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
  it('uses dynamically fetched models for primary config', async () => {
    resetPrimaryModelsCache();
    resetOpenRouterCache();
    const primary = { apiKey: 'p', baseUrl: 'https://primary.com/v1' };
    const fetch = async (url: string) => {
      if (url.includes('/models')) {
        if (url.includes('primary')) {
          return new Response(JSON.stringify({ data: [{ id: 'dynamic-model-a' }, { id: 'dynamic-model-b' }] }), {
            status: 200, headers: { 'content-type': 'application/json' },
          }) as Response;
        }
        return new Response(JSON.stringify({ data: [{ id: 'or/free:free', context_length: 64000 }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }) as Response;
      }
      return new Response('not found', { status: 404 }) as Response;
    };
    const chain = await buildModelChain(primary, undefined, fetch);
    assert.ok(chain.length >= 2);
    assert.equal(chain[0].model, 'dynamic-model-a');
    assert.equal(chain[1].model, 'dynamic-model-b');
    assert.equal(chain[0].config.apiKey, 'p');
    resetPrimaryModelsCache();
    resetOpenRouterCache();
  });

  it('falls back to LLM_FALLBACK_MODELS when primary /models fails', async () => {
    resetPrimaryModelsCache();
    resetOpenRouterCache();
    const primary = { apiKey: 'p', baseUrl: 'https://primary.com/v1' };
    const fetch = async (url: string) => {
      if (url.includes('/models')) {
        if (url.includes('primary')) {
          return new Response('error', { status: 500 }) as Response;
        }
        return new Response(JSON.stringify({ data: [{ id: 'or/free:free', context_length: 64000 }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }) as Response;
      }
      return new Response('not found', { status: 404 }) as Response;
    };
    const chain = await buildModelChain(primary, undefined, fetch);
    assert.equal(chain.length, LLM_FALLBACK_MODELS.length);
    assert.equal(chain[0].model, LLM_FALLBACK_MODELS[0]);
    resetPrimaryModelsCache();
    resetOpenRouterCache();
  });
});

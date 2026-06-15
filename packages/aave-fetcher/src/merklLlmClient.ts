export interface LlmAnalysisResult {
  sourceSide: 'supply' | 'borrow';
  offsetTokenSymbols: string[];
}

export const LLM_FALLBACK_MODELS = [
  'claude-haiku-4.5',
  'claude-sonnet-4.6',
  'grok-4.20-fast',
  'gpt-5.4',
  'qwen3.5-397b',
  'deepseek-v4-flash',
  'kimi-k2.6',
  'deepseek-v4-pro',
  'gpt-5.2',
  'qwen3.5-397b-a17b',
  'openrouter/free',
  'nematron-3-super-120b',
] as const;

export const OPENROUTER_FREE_MODELS_FALLBACK = [
  'deepseek/deepseek-v4-flash:free',
  'qwen/qwen3-coder:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'moonshotai/kimi-k2.6:free',
  'minimax/minimax-m2.5:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'poolside/laguna-m.1:free',
  'poolside/laguna-xs.2:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'nousresearch/hermes-3-llama-3.1-405b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'openai/gpt-oss-120b:free',
  'z-ai/glm-4.5-air:free',
  'openai/gpt-oss-20b:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'nvidia/nemotron-nano-9b-v2:free',
  'meta-llama/llama-3.2-3b-instruct:free',
  'openrouter/free',
] as const;

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_FREE_MAX = 20;
let openrouterFreeModelsCache: string[] | null = null;

export function resetOpenRouterCache(): void {
  openrouterFreeModelsCache = null;
}

export async function fetchOpenRouterFreeModels(
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<string[]> {
  if (openrouterFreeModelsCache !== null) return openrouterFreeModelsCache;

  try {
    const res = await fetchFn(OPENROUTER_MODELS_URL, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as {
      data?: Array<{ id: string; context_length?: number }>;
    };
    const models = json.data ?? [];
    const freeModels = models.filter(m => m.id.endsWith(':free') || m.id === 'openrouter/free');
    freeModels.sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0));
    const top = freeModels.slice(0, OPENROUTER_FREE_MAX).map(m => m.id);
    if (top.length === 0) throw new Error('no free models found');
    openrouterFreeModelsCache = top;
    return top;
  } catch {
    openrouterFreeModelsCache = [...OPENROUTER_FREE_MODELS_FALLBACK];
    return openrouterFreeModelsCache;
  }
}

export async function buildModelChain(
  primaryConfig?: LlmClientConfig,
  openrouterConfig?: LlmClientConfig,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<Array<{ model: string; config: LlmClientConfig }>> {
  const chain: Array<{ model: string; config: LlmClientConfig }> = [];
  if (primaryConfig) {
    for (const model of LLM_FALLBACK_MODELS) {
      chain.push({ model, config: primaryConfig });
    }
  }
  if (openrouterConfig) {
    const freeModels = await fetchOpenRouterFreeModels(fetchFn);
    for (const model of freeModels) {
      chain.push({ model, config: openrouterConfig });
    }
  }
  return chain;
}

export function parseSseStream(raw: string): string {
  let content = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    try {
      const parsed = JSON.parse(line.slice(6));
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') content += delta;
    } catch { /* skip malformed lines */ }
  }
  return content;
}

export function parseMarkdownWrappedJson(raw: string): LlmAnalysisResult | null {
  const match = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch {
    return null;
  }
}

function tryParseJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return undefined; }
}

function validateResult(parsed: unknown): LlmAnalysisResult | null {
  if (parsed === null) return null;
  if (
    typeof parsed === 'object' && parsed !== null &&
    ('sourceSide' in parsed) && ('offsetTokenSymbols' in parsed) &&
    (parsed.sourceSide === 'supply' || parsed.sourceSide === 'borrow') &&
    Array.isArray(parsed.offsetTokenSymbols) &&
    parsed.offsetTokenSymbols.every((s: unknown) => typeof s === 'string')
  ) {
    return parsed as LlmAnalysisResult;
  }
  return null;
}

export function parseLlmResponse(raw: string): LlmAnalysisResult | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const direct = tryParseJson(trimmed);
  if (direct !== undefined) {
    if (direct === null) return null;
    const v = validateResult(direct);
    if (v !== null) return v;
  }

  const md = parseMarkdownWrappedJson(trimmed);
  if (md !== null) return md;

  if (trimmed.includes('data: ')) {
    const sseContent = parseSseStream(trimmed);
    if (sseContent) {
      const sseParsed = tryParseJson(sseContent);
      if (sseParsed !== undefined) {
        const v = validateResult(sseParsed);
        if (v !== null) return v;
      }
    }
  }

  return null;
}

export function buildLlmPrompt(opp: {
  type: string;
  action: string;
  description: string;
  tokenSymbols: string[];
}): string {
  return `You are analyzing a DeFi incentive opportunity on Aave protocol for net position constraints.

CONTEXT: In Aave, users can supply (deposit) or borrow assets. Some Merkl campaigns reward only the NET position — meaning the reward is calculated after offsetting positions in related tokens. For example, "net USDe lending" means the reward is on (USDe supply − USDe borrow), so borrow positions offset the supply reward.

OPPORTUNITY:
- type: ${opp.type}
- action: ${opp.action}
- description: ${opp.description}
- tokens: ${opp.tokenSymbols.join(', ')}

QUESTION: Does this opportunity reward only the NET position (i.e., one side minus the opposite side of offset tokens)?

If YES, return JSON (no other text):
{ "sourceSide": "supply", "offsetTokenSymbols": ["Token1","Token2"] }

Rules:
- sourceSide = "supply" if the reward is on net lending (supply side minus borrow of offset tokens)
- sourceSide = "borrow" if the reward is on net borrowing (borrow side minus supply of offset tokens)
- offsetTokenSymbols = exact token symbols whose opposite-direction positions offset the rewarded side
- Include ALL offset tokens mentioned in the description

If NO net constraint (e.g., the reward is on the full/gross position), return: null

EXAMPLES:
- "Supply USDe, excluding borrowers of USDe and GHO" → {"sourceSide":"supply","offsetTokenSymbols":["USDe","GHO"]}
- "Borrow GHO, net of GHO suppliers" → {"sourceSide":"borrow","offsetTokenSymbols":["GHO"]}
- "Supply USDC" (no mention of net/excluding/offset) → null

Respond with ONLY the JSON or null.`;
}

export interface LlmClientConfig {
  apiKey: string;
  baseUrl: string;
  totalTimeoutMs?: number;
  perModelRetries?: number;
}

const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;
const DEFAULT_PER_MODEL_RETRIES = 2;

export async function callLlmWithFallback(
  prompt: string,
  primaryConfig?: LlmClientConfig,
  openrouterConfig?: LlmClientConfig,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<LlmAnalysisResult | null> {
  const chain = await buildModelChain(primaryConfig, openrouterConfig, fetchFn);
  if (chain.length === 0) return null;

  const timeout = (primaryConfig?.totalTimeoutMs ?? openrouterConfig?.totalTimeoutMs) ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const retries = (primaryConfig?.perModelRetries ?? openrouterConfig?.perModelRetries) ?? DEFAULT_PER_MODEL_RETRIES;
  const deadline = Date.now() + timeout;

  for (const { model, config } of chain) {
    if (Date.now() >= deadline) break;
    for (let attempt = 0; attempt < retries; attempt++) {
      if (Date.now() >= deadline) break;
      try {
        const remaining = Math.max(deadline - Date.now(), 1);
        const res = await Promise.race([
          fetchFn(`${config.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: prompt }],
              temperature: 0,
              max_tokens: 256,
            }),
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), remaining)
          ),
        ]);
        if (!res.ok) continue;
        const contentType = res.headers.get('content-type') ?? '';
        let raw: string;
        if (contentType.includes('text/event-stream')) {
          raw = await res.text();
        } else {
          const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
          raw = json.choices?.[0]?.message?.content ?? '';
        }
        const parsed = parseLlmResponse(raw);
        if (parsed !== null) return parsed;
        const directNull = raw.trim() === 'null' || tryParseJson(raw.trim()) === null;
        if (directNull) return null;
      } catch { /* next attempt or model */ }
    }
  }
  return null;
}

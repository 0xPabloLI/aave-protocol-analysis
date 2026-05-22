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
  return `Analyze this Merkl opportunity for net lending/borrowing constraints.

type: ${opp.type}
action: ${opp.action}
description: ${opp.description}
tokens: ${opp.tokenSymbols.join(', ')}

Does this opportunity reward only the NET position (i.e., supply minus borrow of offset tokens)?
If yes, return JSON: { "sourceSide": "supply"|"borrow", "offsetTokenSymbols": ["Y1","Y2"] }
- sourceSide = "supply" if the reward is on net lending (supply - borrow)
- sourceSide = "borrow" if the reward is on net borrowing (borrow - supply)
- offsetTokenSymbols = tokens whose positions offset the rewarded side

If no net constraint, return: null

Respond with ONLY the JSON or null, no explanation.`;
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
  config: LlmClientConfig,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<LlmAnalysisResult | null> {
  const timeout = config.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const retries = config.perModelRetries ?? DEFAULT_PER_MODEL_RETRIES;
  const deadline = Date.now() + timeout;

  for (const model of LLM_FALLBACK_MODELS) {
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

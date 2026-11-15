#!/usr/bin/env tsx
/**
 * Daily live check for the Brevis MetaMask campaign copy (AAV-1369).
 *
 * `positionCapUsd` is not in the gRPC API — it is scraped out of the minified
 * `_app` chunk of the Brevis frontend. AAV-1365 made that scrape resilient
 * (candidate phrase table + candidate markers + ownership gate), but it fails
 * the same way a scraper always fails: silently. The copy changes, the cap
 * becomes `null`, one `logger.warn` scrolls past, and the first person to notice
 * is whoever finds the yield numbers wrong weeks later.
 *
 * This script turns that into a scheduled signal:
 *
 *   1. the copy still parses (anchors hit, `positionCap > 0`);
 *   2. the copy still talks about a position (`collateral` / `debt`) — a cap
 *      number without that wording means we may be reading a *volume* limit;
 *   3. no campaign carries a gRPC type outside the action-type table the
 *      fetcher hardcodes, because `campaignType` is currently assumed to be
 *      `FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE` for every Brevis campaign.
 *
 * Invoked by `.github/workflows/brevis-live-check.yml` and by
 * `npm run check:brevis-live`.
 *
 * Deliberate choices worth keeping:
 *
 * - **Unreachable is a failure, not a skip.** Same rule as AAV-1352: a source
 *   we cannot read must never render as "nothing to report". A third-party
 *   outage is still a reason the incentive pipeline is degraded.
 * - **Zero campaigns is not a failure.** Whether Brevis runs an Aave campaign
 *   is their business; the counts are printed so a sudden drop to zero is
 *   visible in the run summary without inventing a threshold nobody measured.
 * - **Reuses `fetchMetaMaskCampaignDescription()` / `getAaveCampaignsData()`.**
 *   Writing a second parser here would check the copy against a different
 *   implementation than the one shipping, i.e. it would pass while production
 *   broke.
 */
import { pathToFileURL } from "node:url";
import { brevisApi } from "../packages/aave-fetcher/src/brevis-api.js";

/**
 * Position wording the cap must sit next to. `POSITION_CONTEXT_RE` in
 * `brevis-api.ts` is the parser's own (broader) gate; this one is deliberately
 * narrower: if neither of these two words is anywhere in the copy, the sentence
 * is not about a position any more.
 */
export const POSITION_COPY_RE = /\b(collateral|debt)\b/i;

/**
 * gRPC `campaign.type` values `mapActionType()` knows about. That field encodes
 * an *action* type, not a distribution mechanism — the fetcher hardcodes
 * `FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE` for all of them. A value outside this
 * set is the only observable hint that Brevis introduced something else
 * (MAX/TARGET/Dutch auction), so it is reported as a failure until a human
 * confirms which it is.
 */
export const KNOWN_CAMPAIGN_TYPES: ReadonlySet<number> = new Set([
  2001, 2002, 3001, 5001, 5002, 5003, 6001,
]);

export interface BrevisCopySnapshot {
  description: string;
  positionCap: number | null;
  pattern: string | null;
  markerPair: string;
}

export interface BrevisLiveInput {
  /** Result of `fetchMetaMaskCampaignDescription()`; `null` means it gave up. */
  copy: BrevisCopySnapshot | null;
  /** `campaign.type` → how many campaigns reported it. */
  typeCounts: Map<string, number>;
  protocolCount: number;
  campaignCount: number;
  /** Set when `getAaveCampaignsData()` threw, e.g. DNS/network failure. */
  grpcError?: string | null;
}

export interface CheckFailure {
  code: string;
  detail: string;
}

export interface CheckVerdict {
  ok: boolean;
  failures: CheckFailure[];
  notes: string[];
  diagnostics: {
    positionCap: number | null;
    pattern: string | null;
    markerPair: string | null;
    typeCounts: Array<[string, number]>;
    protocolCount: number;
    campaignCount: number;
  };
  /** Copy excerpt for the summary — enough to see which word moved. */
  excerpt: string | null;
}

const EXCERPT_LENGTH = 400;

/**
 * Count `campaign.type` across raw gRPC details. Missing values are counted
 * under `"missing"` rather than dropped: dropping them would make a field move
 * look like "all observed types are known".
 */
export function collectCampaignTypeCounts(
  rawProtocolDetails: ReadonlyArray<unknown>
): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);

  for (const detail of rawProtocolDetails ?? []) {
    const list = (detail as { response?: { campaignDetailsList?: unknown[] } })
      ?.response?.campaignDetailsList;
    for (const entry of Array.isArray(list) ? list : []) {
      const campaign = (entry as { campaign?: Record<string, unknown> })
        ?.campaign;
      const config = campaign?.config as Record<string, unknown> | undefined;
      const type = campaign?.type ?? config?.type;
      bump(typeof type === "number" ? String(type) : "missing");
    }
  }
  return counts;
}

function copyFailures(copy: BrevisCopySnapshot | null): CheckFailure[] {
  if (copy === null) {
    return [
      {
        code: "copy-unavailable",
        detail:
          "fetchMetaMaskCampaignDescription() returned null — either unreachable or every anchor missed (see the warnings above for which).",
      },
    ];
  }

  const failures: CheckFailure[] = [];
  const cap = copy.positionCap;
  if (typeof cap !== "number" || !(cap > 0)) {
    failures.push({
      code: "cap-not-parsed",
      detail: `positionCap=${String(cap)} (pattern=${String(copy.pattern)})`,
    });
  }
  if (!POSITION_COPY_RE.test(copy.description ?? "")) {
    failures.push({
      code: "position-wording-missing",
      detail:
        "copy contains neither 'collateral' nor 'debt' — the scraped number may be a volume/budget cap.",
    });
  }
  return failures;
}

function mechanismFailures(
  typeCounts: Map<string, number>,
  campaignCount: number
): CheckFailure[] {
  const failures: CheckFailure[] = [];
  const unknownTypes = [...typeCounts.keys()].filter(
    (type) => type !== "missing" && !KNOWN_CAMPAIGN_TYPES.has(Number(type))
  );
  if (unknownTypes.length > 0) {
    failures.push({
      code: "unknown-campaign-type",
      detail: `campaign.type not in the action-type table: ${unknownTypes.join(", ")} — confirm it is an action type and not a new reward mechanism.`,
    });
  }

  // A campaign whose type we cannot read at all means the field moved, not that
  // the mechanism is FIX. Only a concern when there was something to read.
  if (campaignCount > 0 && typeCounts.get("missing") === campaignCount) {
    failures.push({
      code: "campaign-types-unobservable",
      detail: `${campaignCount} campaign(s) parsed but none exposed campaign.type.`,
    });
  }
  return failures;
}

export function evaluateBrevisLiveCheck(input: BrevisLiveInput): CheckVerdict {
  const failures: CheckFailure[] = [];
  const notes: string[] = [];
  const { copy } = input;

  if (input.grpcError) {
    failures.push({
      code: "grpc-unreachable",
      detail: `getAaveCampaignsData() threw: ${input.grpcError}`,
    });
  }
  failures.push(...copyFailures(copy));
  failures.push(...mechanismFailures(input.typeCounts, input.campaignCount));

  if (input.campaignCount === 0 && !input.grpcError) {
    notes.push(
      "Brevis currently returns no Aave campaigns — copy is still checked, mechanism assumption is vacuously true."
    );
  }

  const excerpt = copy?.description
    ? copy.description.slice(0, EXCERPT_LENGTH)
    : null;

  return {
    ok: failures.length === 0,
    failures,
    notes,
    diagnostics: {
      positionCap: copy?.positionCap ?? null,
      pattern: copy?.pattern ?? null,
      markerPair: copy?.markerPair ?? null,
      typeCounts: [...input.typeCounts.entries()].sort(
        (a, b) => Number(a[0]) - Number(b[0])
      ),
      protocolCount: input.protocolCount,
      campaignCount: input.campaignCount,
    },
    excerpt,
  };
}

/** Only a clean verdict may exit 0 — the whole point is failing loud. */
export function resolveExitCode(verdict: CheckVerdict): 0 | 1 {
  return verdict.ok ? 0 : 1;
}

export function formatReport(
  verdict: CheckVerdict,
  now: Date = new Date()
): string {
  const d = verdict.diagnostics;
  const lines: string[] = [];
  lines.push(`# Brevis live check (AAV-1369)`);
  lines.push("");
  lines.push(`- run: ${now.toISOString()}`);
  lines.push(
    `- positionCap: ${d.positionCap === null ? "null" : d.positionCap} (pattern ${d.pattern ?? "none"})`
  );
  lines.push(`- markers: ${d.markerPair ?? "none"}`);
  lines.push(`- protocols: ${d.protocolCount}, campaigns: ${d.campaignCount}`);
  lines.push(
    `- campaign.type: ${
      d.typeCounts.length === 0
        ? "none observed"
        : d.typeCounts.map(([type, n]) => `${type}×${n}`).join(", ")
    }`
  );
  if (verdict.excerpt) {
    lines.push("");
    lines.push("## Copy excerpt");
    lines.push("");
    lines.push("```");
    lines.push(verdict.excerpt);
    lines.push("```");
  }
  if (verdict.notes.length > 0) {
    lines.push("");
    for (const note of verdict.notes) lines.push(`> ${note}`);
  }
  lines.push("");
  if (verdict.ok) {
    lines.push("✅ All assertions passed.");
  } else {
    lines.push(`❌ ${verdict.failures.length} assertion(s) failed:`);
    for (const failure of verdict.failures) {
      lines.push(`- \`${failure.code}\`: ${failure.detail}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const [copy, campaigns] = await Promise.all([
    brevisApi.fetchMetaMaskCampaignDescription(),
    brevisApi.getAaveCampaignsData().then(
      (value) => ({ value, error: null as string | null }),
      (error: unknown) => ({
        value: null,
        error: error instanceof Error ? error.message : String(error),
      })
    ),
  ]);

  const raw = campaigns.value?.rawProtocolDetails ?? [];
  const typeCounts = collectCampaignTypeCounts(raw);
  const campaignCount = [...typeCounts.values()].reduce((a, b) => a + b, 0);

  const verdict = evaluateBrevisLiveCheck({
    copy,
    typeCounts,
    protocolCount: raw.length,
    campaignCount,
    grpcError: campaigns.error,
  });

  const report = formatReport(verdict);
  process.stdout.write(report);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(summaryPath, `${report}\n`);
  }

  process.exitCode = resolveExitCode(verdict);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

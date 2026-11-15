import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KNOWN_CAMPAIGN_TYPES,
  collectCampaignTypeCounts,
  evaluateBrevisLiveCheck,
  formatReport,
  resolveExitCode,
  type BrevisLiveInput,
} from "../scripts/brevis-live-check.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const WORKFLOW = resolve(ROOT, ".github", "workflows", "brevis-live-check.yml");
const SCRIPT = "scripts/brevis-live-check.ts";

const COPY = {
  description:
    "Eligible MetaMask Card users may earn a fixed 2.4% reward APR when lending or borrowing USDC on Aave via Linea. This rate applies to a combined total of up to 5000 USDC in collateral and/or debt per user.",
  positionCap: 5000,
  pattern: "p1",
  markerPair: 'Eligible MetaMask → per user."',
};

function input(overrides: Partial<BrevisLiveInput> = {}): BrevisLiveInput {
  return {
    copy: COPY,
    typeCounts: new Map([["3001", 1]]),
    protocolCount: 1,
    campaignCount: 1,
    grpcError: null,
    ...overrides,
  };
}

function codes(value: BrevisLiveInput): string[] {
  return evaluateBrevisLiveCheck(value).failures.map((f) => f.code);
}

test("a healthy scrape passes every assertion", () => {
  const verdict = evaluateBrevisLiveCheck(input());
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.diagnostics.positionCap, 5000);
  assert.equal(verdict.diagnostics.pattern, "p1");
  assert.equal(resolveExitCode(verdict), 0);
});

test("copy that fails to parse is a failure, not an empty pass", () => {
  assert.deepEqual(codes(input({ copy: null })), ["copy-unavailable"]);
});

test("a cap that no longer parses fails, and the pattern is reported", () => {
  const verdict = evaluateBrevisLiveCheck(
    input({ copy: { ...COPY, positionCap: null, pattern: null } })
  );
  assert.equal(verdict.ok, false);
  assert.deepEqual(
    verdict.failures.map((f) => f.code),
    ["cap-not-parsed"]
  );
  assert.match(verdict.failures[0].detail, /pattern=null/);
});

test("cap=0 is not treated as a parsed cap", () => {
  assert.deepEqual(codes(input({ copy: { ...COPY, positionCap: 0 } })), [
    "cap-not-parsed",
  ]);
});

test("copy without collateral/debt wording fails: the number may be a volume cap", () => {
  const verdict = evaluateBrevisLiveCheck(
    input({
      copy: {
        ...COPY,
        description: "Earn up to 5000 USDC of trading volume per user.",
      },
    })
  );
  assert.deepEqual(
    verdict.failures.map((f) => f.code),
    ["position-wording-missing"]
  );
});

test("an unknown campaign.type fails — it is the only hint of a new mechanism", () => {
  const verdict = evaluateBrevisLiveCheck(
    input({
      typeCounts: new Map([
        ["3001", 3],
        ["7001", 1],
      ]),
    })
  );
  assert.equal(verdict.ok, false);
  assert.deepEqual(
    verdict.failures.map((f) => f.code),
    ["unknown-campaign-type"]
  );
  assert.match(verdict.failures[0].detail, /7001/);
});

test("every known action type is accepted", () => {
  for (const type of KNOWN_CAMPAIGN_TYPES) {
    const verdict = evaluateBrevisLiveCheck(
      input({ typeCounts: new Map([[String(type), 1]]) })
    );
    assert.equal(verdict.ok, true, `type ${type} should be accepted`);
  }
});

test("campaigns whose type field vanished are unobservable, not FIX", () => {
  const verdict = evaluateBrevisLiveCheck(
    input({ typeCounts: new Map([["missing", 2]]), campaignCount: 2 })
  );
  assert.deepEqual(
    verdict.failures.map((f) => f.code),
    ["campaign-types-unobservable"]
  );
});

test("zero campaigns passes with a note — an empty source is not a copy defect", () => {
  const verdict = evaluateBrevisLiveCheck(
    input({ typeCounts: new Map(), campaignCount: 0, protocolCount: 0 })
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.notes.length, 1);
  assert.match(verdict.notes[0], /no Aave campaigns/);
});

test("gRPC that throws fails the run: unreachable is never a pass", () => {
  const verdict = evaluateBrevisLiveCheck(
    input({
      typeCounts: new Map(),
      campaignCount: 0,
      grpcError: "getaddrinfo ENOTFOUND incentra-prd.brevis.network",
    })
  );
  assert.deepEqual(
    verdict.failures.map((f) => f.code),
    ["grpc-unreachable"]
  );
  assert.equal(resolveExitCode(verdict), 1);
});

test("collectCampaignTypeCounts reads campaign.type, falls back to config.type, counts missing", () => {
  const counts = collectCampaignTypeCounts([
    { response: { campaignDetailsList: [{ campaign: { type: 3001 } }] } },
    {
      response: {
        campaignDetailsList: [
          { campaign: { config: { type: 2001 } } },
          { campaign: {} },
        ],
      },
    },
    { response: {} },
  ]);
  assert.deepEqual([...counts.entries()].sort(), [
    ["2001", 1],
    ["3001", 1],
    ["missing", 1],
  ]);
});

test("collectCampaignTypeCounts survives a malformed payload instead of throwing", () => {
  assert.deepEqual(
    [...collectCampaignTypeCounts([null, { response: null }])],
    []
  );
});

test("the report carries the pattern, markers, type counts and a bounded excerpt", () => {
  const report = formatReport(
    evaluateBrevisLiveCheck(input({ copy: { ...COPY, positionCap: null } })),
    new Date("2026-11-16T00:00:00.000Z")
  );
  assert.match(report, /2026-11-16T00:00:00.000Z/);
  assert.match(report, /pattern p1/);
  assert.match(report, /Eligible MetaMask/);
  assert.match(report, /3001×1/);
  assert.match(report, /cap-not-parsed/);
  assert.ok(report.indexOf("Copy excerpt") < report.indexOf("cap-not-parsed"));
});

test("the workflow is scheduled, dispatchable, and wires the npm script", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  assert.match(yml, /^\s{2}schedule:/m, "missing schedule trigger");
  assert.match(yml, /^\s{2}workflow_dispatch:/m, "missing workflow_dispatch");
  assert.match(yml, /npm run check:brevis-live/);
  // The two shapes that turn a failing check into a green one.
  assert.doesNotMatch(yml, /continue-on-error/);
  assert.doesNotMatch(yml, /if:\s*always\(\)/);
  assert.doesNotMatch(yml, /\|\|\s*true/);
});

test("the check is wired into package.json and not swallowed by .gitignore", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  assert.match(pkg.scripts["check:brevis-live"] ?? "", new RegExp(SCRIPT));

  // `scripts/*` is ignored wholesale, so a new script is invisible to git
  // unless it is whitelisted — this has silently dropped files before.
  const gitignore = readFileSync(resolve(ROOT, ".gitignore"), "utf8");
  assert.match(gitignore, new RegExp(`^!${SCRIPT}$`, "m"));
});

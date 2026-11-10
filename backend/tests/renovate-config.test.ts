import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

function readConfig(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf-8");
}

// Update types that carry no release timestamp, so `minimumReleaseAge` cannot
// be enforced for them. Kept in sync with the `unsupportedUpdateTypeRules`
// carve-outs in Renovate's `lib/config/presets/internal/security.preset.ts`,
// which the docs require to match the ❌ rows of
// https://docs.renovatebot.com/key-concepts/minimum-release-age/
//
// Two consequences, and both are asserted below: the cool-down rule must not
// match these (it would re-impose an age requirement they can never satisfy,
// and the update would silently stop being raised at all), and automerge must
// not cover them (nothing would enforce the ≥7-day supply-chain cool-down).
const NO_RELEASE_TIMESTAMP_UPDATE_TYPES = [
  "lockFileMaintenance",
  "lockfileUpdate",
  "pin",
  "replacement",
  "bump",
  "rollback",
];

test("renovate.json is valid JSON with required keys", () => {
  const config = JSON.parse(readConfig("renovate.json"));
  assert.ok(config.$schema);
  assert.deepEqual(config.extends, ["config:best-practices"]);
  assert.ok(
    config.osvVulnerabilityAlerts,
    "osvVulnerabilityAlerts must be enabled"
  );
});

test("renovate targets the railway branch", () => {
  const config = JSON.parse(readConfig("renovate.json"));
  // Renovate's onboarding normalizes `baseBranches` to `baseBranchPatterns`.
  const branches = config.baseBranchPatterns ?? config.baseBranches;
  assert.deepEqual(branches, ["railway"]);
});

test("renovate enforces the 7-day dependency cool-down", () => {
  const config = JSON.parse(readConfig("renovate.json"));
  assert.equal(config.minimumReleaseAge, "7 days");
});

test("renovate automerges non-major updates itself, not via platform auto-merge", () => {
  const config = JSON.parse(readConfig("renovate.json"));
  assert.equal(
    config.automerge,
    true,
    "Renovate must own automerge — the GitHub Actions workflow could never " +
      "arm it (enablePullRequestAutoMerge is rejected with 'unstable status' " +
      "while CI is still running, and nothing retries afterwards)"
  );
  // With platformAutomerge=true Renovate arms GitHub's native auto-merge
  // instead of waiting for green itself. Keep it false: arming depends on a
  // GitHub mutation that has to land at the right moment, while Renovate's own
  // automerge simply re-checks on every run. `railway` now declares required
  // status checks (added 2026-11-09), so native auto-merge would no longer be
  // unsafe — but it is still the less reliable of the two.
  assert.equal(
    config.platformAutomerge,
    false,
    "Renovate should own automerge rather than arming GitHub's native one"
  );
});

test("major updates are excluded from automerge", () => {
  const config = JSON.parse(readConfig("renovate.json"));
  const rule = config.packageRules.find(
    (r: { matchUpdateTypes?: string[]; automerge?: boolean }) =>
      r.matchUpdateTypes?.includes("major") && r.automerge === false
  );
  assert.ok(
    rule,
    "a packageRule must set automerge:false for major updates (breaking changes need review)"
  );
});

test("renovate runs npm install twice so its lockfile survives npm ci", () => {
  const config = JSON.parse(readConfig("renovate.json"));
  // npm sometimes writes a lockfile that its own `npm ci` rejects — observed
  // 2026-11-09, when the renovate/pin-dependencies branch omitted the hoisted
  // node_modules/@emnapi/wasi-threads entry and `npm ci` failed with
  // "Missing: @emnapi/wasi-threads@1.2.3 from lock file".
  // https://docs.renovatebot.com/modules/manager/npm/#invalid-lock-file-npm-ci-fails
  assert.ok(
    config.postUpdateOptions?.includes("npmInstallTwice"),
    "postUpdateOptions must include npmInstallTwice"
  );
});

test("the npm cool-down override keeps the preset's unsupported-update-type opt-outs", () => {
  const config = JSON.parse(readConfig("renovate.json"));
  // config:best-practices pulls in security:minimumReleaseAgeNpm, which sets
  // minimumReleaseAge: '3 days' for npm *inside a packageRule*. Renovate merges
  // matching packageRules in order and applies them after the top-level config,
  // so the repo's own top-level `minimumReleaseAge` does not win; this rule is
  // what restores the documented 7-day policy.
  const rule = config.packageRules.find(
    (r: { matchDatasources?: string[]; minimumReleaseAge?: string }) =>
      r.matchDatasources?.includes("npm") && r.minimumReleaseAge
  );
  assert.ok(rule, "an npm packageRule must pin minimumReleaseAge to 7 days");
  assert.equal(rule.minimumReleaseAge, "7 days");

  // The preset also sets minimumReleaseAge: null for update types that carry no
  // release timestamp. Those opt-out rules sit earlier in the array, so an
  // *unscoped* npm rule here would override them and re-impose an age
  // requirement those update types can never satisfy — lock file maintenance
  // would silently stop being raised at all. The rule must stay scoped.
  assert.ok(
    Array.isArray(rule.matchUpdateTypes),
    "the npm cool-down rule must declare matchUpdateTypes"
  );
  for (const updateType of NO_RELEASE_TIMESTAMP_UPDATE_TYPES) {
    assert.ok(
      !rule.matchUpdateTypes.includes(updateType),
      `the npm cool-down rule must not match ${updateType} (no release timestamp to check)`
    );
  }
});

test("automerge is disabled for every update type the cool-down cannot cover", () => {
  const config = JSON.parse(readConfig("renovate.json"));
  // The cool-down rule above deliberately skips update types that carry no
  // release timestamp. Repo-wide `automerge: true` would otherwise merge those
  // unattended, with nothing enforcing the ≥7-day cool-down that AGENTS.md
  // requires — the update would land as soon as CI went green.
  //
  // Verified 2026-11-09: this is live, not theoretical. PRs #190 and #192
  // changed *only* package-lock.json (lockfileUpdate — the `-lockfile` branch
  // suffix is added by the default branchTopic template when isLockfileUpdate
  // is true), and their target versions were 4.50 and 6.74 days old
  // (@aave-dao/aave-address-book@4.76.1 and express-rate-limit@8.7.3).
  const rule = config.packageRules.find(
    (r: { matchUpdateTypes?: string[]; automerge?: boolean }) =>
      r.automerge === false &&
      r.matchUpdateTypes?.includes("lockFileMaintenance")
  );
  assert.ok(
    rule,
    "a packageRule must set automerge:false for update types that carry no " +
      "release timestamp, so the cool-down cannot be bypassed"
  );
  for (const updateType of NO_RELEASE_TIMESTAMP_UPDATE_TYPES) {
    assert.ok(
      rule.matchUpdateTypes.includes(updateType),
      `automerge must be disabled for ${updateType} (no release timestamp to ` +
        "check against the 7-day cool-down)"
    );
  }
});

test("address-book upgrade rule is present with its label", () => {
  const config = JSON.parse(readConfig("renovate.json"));
  const rule = config.packageRules.find((r: { matchDepNames?: string[] }) =>
    r.matchDepNames?.includes("@aave-dao/aave-address-book")
  );
  assert.ok(rule, "address-book packageRule not found");
  assert.ok(rule.labels.includes("address-book-upgrade"));
});

test("ethers major updates stay disabled (pinned exact by policy)", () => {
  const config = JSON.parse(readConfig("renovate.json"));
  const rule = config.packageRules.find((r: { matchDepNames?: string[] }) =>
    r.matchDepNames?.includes("ethers")
  );
  assert.ok(rule, "ethers packageRule not found");
  assert.equal(rule.enabled, false);
});

test("dependabot.yml is gone (Renovate migration complete)", () => {
  let existed = true;
  try {
    readConfig(".github/dependabot.yml");
  } catch {
    existed = false;
  }
  assert.ok(!existed, ".github/dependabot.yml should be deleted");
});

test("auto-merge bot workflow YAML is valid", () => {
  const content = readConfig(".github/workflows/auto-merge-bot-prs.yml");
  assert.ok(content.length > 0);
  assert.ok(content.includes("name:"));
  assert.ok(content.includes("jobs:"));
});

test("auto-merge workflow filters for renovate[bot] actor", () => {
  const content = readConfig(".github/workflows/auto-merge-bot-prs.yml");
  assert.ok(
    content.includes("renovate[bot]"),
    "auto-merge must filter for renovate[bot] actor"
  );
});

test("the Renovate job never arms GitHub's native auto-merge", () => {
  const yaml = readConfig(".github/workflows/auto-merge-bot-prs.yml");
  const jobStart = yaml.indexOf("approve-renovate-pr:");
  assert.ok(jobStart !== -1, "approve-renovate-pr job not found");
  // Slice to the next top-level job key so the assertion stays scoped to this
  // job even when another job is appended below it.
  const rest = yaml.slice(jobStart);
  const nextJob = rest.slice(1).search(/^ {2}\S.*:$/m);
  const job = nextJob === -1 ? rest : rest.slice(0, nextJob + 1);

  // Renovate arms its own automerge (automerge=true, platformAutomerge=false)
  // and waits for green checks itself, so arming GitHub's native auto-merge
  // here would leave two merge controllers for one PR.
  //
  // Verified 2026-11-09: that was not a theoretical concern. This job armed
  // auto-merge on the rebased renovate/pin-dependencies PR #186 at 11:16:36, on
  // its 4th retry and after CI had already failed at 11:15:11; GitHub merged it
  // at 11:17:16 with a lockfile `npm ci` rejects, and the staging deploy for
  // that commit was skipped. The retry loop is what made it land — the first
  // three attempts were rejected with "unstable status". At the time `railway`
  // declared no required status checks, so the merge gate had nothing to wait
  // for. Those checks now exist (build-and-prune, security-audit,
  // socket-firewall, quality-gates), which would make the mutation safe — but
  // Renovate still owns automerge, so this job must not re-introduce a second
  // controller.
  assert.ok(
    !job.includes("enablePullRequestAutoMerge"),
    "the Renovate job must not call enablePullRequestAutoMerge — Renovate " +
      "owns automerge for its own PRs"
  );
});

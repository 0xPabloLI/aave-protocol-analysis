import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

function readWorkflow(name: string): string {
  return readFileSync(resolve(ROOT, ".github", "workflows", name), "utf-8");
}

function keepValue(yaml: string, key: "KEEP_DAILY" | "KEEP_ARCHIVE"): number {
  const match = yaml.match(new RegExp(`^\\s*${key}:\\s*(\\d+)\\s*$`, "m"));
  assert.ok(match, `${key} must be declared as a plain number`);
  return Number(match[1]);
}

// Verified 2026-11-10: db-backup.yml pruned daily/ to 7 while r2-cleanup.yml
// pruned it to 2 every Sunday, so the daily series silently never exceeded 2.
// Both files now read the same constants, and these tests keep them aligned.
test("db-backup and r2-cleanup share one R2 retention policy", () => {
  const backup = readWorkflow("db-backup.yml");
  const cleanup = readWorkflow("r2-cleanup.yml");

  for (const key of ["KEEP_DAILY", "KEEP_ARCHIVE"] as const) {
    assert.equal(
      keepValue(backup, key),
      keepValue(cleanup, key),
      `${key} must match between db-backup.yml and r2-cleanup.yml`
    );
  }
});

test("prune steps derive their counts from the retention constants", () => {
  for (const file of ["db-backup.yml", "r2-cleanup.yml"]) {
    const yaml = readWorkflow(file);

    assert.ok(
      yaml.includes('"$KEEP_DAILY"'),
      `${file}: the daily prune must use $KEEP_DAILY`
    );
    assert.ok(
      yaml.includes('"$KEEP_ARCHIVE"'),
      `${file}: the archive prune must use $KEEP_ARCHIVE`
    );

    // A literal `head -7` / `tail -n +3` is how the two files drifted before.
    assert.ok(
      !/head -\d+\s+\/tmp/.test(yaml),
      `${file}: hardcoded head counts reintroduce retention drift`
    );
    assert.ok(
      !/tail -n \+\d+\s+\/tmp/.test(yaml),
      `${file}: hardcoded tail offsets reintroduce retention drift`
    );
  }
});

test("prune step titles carry the constants, never a stale literal", () => {
  // r2-cleanup.yml's step title read "keep latest 2" long after the code had
  // moved to KEEP_DAILY=7 — the title was the only place still saying 2, and it
  // is what a reader checks when auditing retention.
  const yaml = readWorkflow("r2-cleanup.yml");

  assert.ok(
    !/- name: Delete old .*keep (latest )?\d+/i.test(yaml),
    "r2-cleanup.yml: the prune step title must interpolate the constants, not hardcode a count"
  );
  assert.ok(
    yaml.includes("${{ env.KEEP_DAILY }}") &&
      yaml.includes("${{ env.KEEP_ARCHIVE }}"),
    "r2-cleanup.yml: the prune step title must show both retention counts"
  );
});

test("db-backup retries a failed upload before discarding the dump", () => {
  // 2026-11-08: CompleteMultipartUpload answered InvalidPart — a 4xx, which
  // aws-cli will not retry — so the run gave up on the only copy of the dump
  // and the runner took it to the grave. One retry would have saved it.
  const yaml = readWorkflow("db-backup.yml");

  assert.ok(
    /for attempt in 1 2 3; do/.test(yaml),
    "the upload step must retry instead of stopping at the first failure"
  );
  assert.ok(
    yaml.includes('if aws s3 cp "$BACKUP_FILE"'),
    "the retry must wrap the aws s3 cp call itself"
  );
  assert.ok(
    yaml.includes("R2_KEY=$R2_KEY"),
    "the attempt that succeeds must still export R2_KEY for the verify step"
  );
});

test("db-backup reports a failed run as an issue", () => {
  const yaml = readWorkflow("db-backup.yml");

  assert.ok(
    /^\s*issues: write$/m.test(yaml),
    "the workflow needs issues: write to file the alert"
  );
  assert.ok(
    yaml.includes("if: failure()"),
    "the alert step must be guarded by if: failure()"
  );
  assert.ok(
    yaml.includes("db-backup-failure"),
    "the alert needs a stable label so repeats comment instead of duplicating"
  );

  // The alert must be the last step: a step appended after it would be skipped
  // by the default `if: success()` guard and its failures would go unreported.
  const lastStep = yaml.lastIndexOf("      - name:");
  assert.ok(
    yaml.slice(lastStep).includes("Report failure as an issue"),
    "the failure alert must be the last step of the job"
  );
});

test("the failure alert pins its action to a commit SHA", () => {
  const yaml = readWorkflow("db-backup.yml");
  const match = yaml.match(/uses: actions\/github-script@([a-f0-9]+)/);

  assert.ok(match, "the alert must use actions/github-script");
  assert.equal(
    match[1].length,
    40,
    "actions/github-script must be pinned to a full commit SHA"
  );
});

test("alert workflows create their issue label before deduping by it", () => {
  // Verified 2026-11-11: neither `db-backup-failure` nor `r2-quota-warning`
  // existed as a repo label, and GitHub silently drops unknown labels when an
  // issue is created. The alert still fired, but the dedupe query (which filters
  // by that label) could never match, so every failed run opened a new issue
  // instead of commenting on the open one. The workflows now ensure the label
  // exists before they query it, so this cannot depend on a manual repo setting.
  for (const file of ["db-backup.yml", "r2-cleanup.yml"]) {
    const yaml = readWorkflow(file);
    const ensureLabel = yaml.indexOf("issues.getLabel");
    const createLabel = yaml.indexOf("issues.createLabel");
    const dedupeQuery = yaml.indexOf("issues.listForRepo");

    assert.ok(
      ensureLabel !== -1,
      `${file}: the alert must check whether its label exists`
    );
    assert.ok(
      createLabel !== -1,
      `${file}: the alert must create the label when it is missing`
    );
    assert.ok(
      dedupeQuery !== -1,
      `${file}: the alert must still dedupe against the open issue`
    );
    assert.ok(
      ensureLabel < dedupeQuery,
      `${file}: the label must be ensured before the dedupe query runs`
    );
    // getLabel precedes the query even when the create path is dead code, so the
    // create call needs its own ordering assertion: moved below the query, a
    // missing label would still be undiscoverable and repeats would duplicate.
    assert.ok(
      createLabel < dedupeQuery,
      `${file}: the label must be created before the dedupe query runs, not after it`
    );
  }
});

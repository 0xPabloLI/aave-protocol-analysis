import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS = resolve(__dirname, "..", "..", ".github", "workflows");
const FULL_SHA = /^[0-9a-f]{40}$/;

// Every action this repo uses is pinned to a full commit SHA; there is not a
// single tag ref or `./local-action` ref in .github/workflows, so that is the
// rule worth asserting.
//
// Verified 2026-11-11: uptime-alert.yml carried
// `actions/github-script@ed597411d8f924073f98dfc5c65a2325f34cd` — 37 characters,
// introduced 2026-09-14 in 0076c92 — in both of its steps. Every scheduled run
// died during "Set up job" with "unable to find version", so the runtime uptime
// channel was dead for weeks while each run merely looked red in a tab nobody
// was reading. A truncated SHA reads as plausible in review and fails only at
// run time, which is exactly the kind of defect a static check can own.
test("every action ref in .github/workflows is a full 40-character commit SHA", () => {
  const problems: string[] = [];
  let refs = 0;

  for (const file of readdirSync(WORKFLOWS).sort()) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    const lines = readFileSync(resolve(WORKFLOWS, file), "utf8").split("\n");

    lines.forEach((line, index) => {
      const match = line.match(/^\s*(?:-\s*)?uses:\s*(\S+)/);
      if (!match) return;

      const ref = match[1];
      if (ref.startsWith("docker://")) return; // image digest, not an action ref

      refs += 1;
      const sha = ref.slice(ref.lastIndexOf("@") + 1);
      if (!FULL_SHA.test(sha)) {
        problems.push(
          `${file}:${index + 1}  ${ref}  (ref is ${sha.length} chars)`
        );
      }
    });
  }

  assert.ok(refs > 0, `found no action refs under ${WORKFLOWS}`);
  assert.deepEqual(
    problems,
    [],
    `action refs that are not full SHAs:\n${problems.join("\n")}`
  );
});

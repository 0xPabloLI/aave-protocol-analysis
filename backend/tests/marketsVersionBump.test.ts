import { describe, it } from "node:test";
import assert from "node:assert/strict";

it("MARKETS_API_VERSION should be snapshot-v4 (breaking: spokeName removed, AAV-449)", async () => {
  // Read the constant from `types/` rather than from the controller: the
  // controller pulls in `marketsService` → `@aave/client-v4`, whose `.d.ts`
  // does not resolve under tsx when this file runs on its own, so the test was
  // only green as a side effect of other suites loading first (AAV-1378).
  const mod = await import("../src/types/index.js");
  const version = mod.MARKETS_API_VERSION;
  assert.equal(
    version,
    "snapshot-v4",
    `Expected snapshot-v4 but got ${version}. API version bumped for the spokeName removal.`
  );
});

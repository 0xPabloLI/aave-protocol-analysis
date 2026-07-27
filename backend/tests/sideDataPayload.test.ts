import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// AAV-1210: SideDataPayload type contract tests
// Verifies that SideDataPayload is exported from shared-contracts,
// no longer has `partial: boolean`, and has precise `errors` type.
// Since SideDataPayload is a TypeScript interface (erased at runtime),
// we verify via source file inspection rather than runtime import.

const SHARED_CONTRACTS_SRC = readFileSync(
  new URL("../../packages/aave-shared-contracts/src/index.ts", import.meta.url),
  "utf8"
);

const META_CONTROLLER_SRC = readFileSync(
  new URL("../src/controllers/metaController.ts", import.meta.url),
  "utf8"
);

test("SideDataPayload is exported from shared-contracts", () => {
  assert.match(
    SHARED_CONTRACTS_SRC,
    /export\s+interface\s+SideDataPayload\b/,
    "SideDataPayload should be exported as an interface from shared-contracts"
  );
});

test("SideDataPayload type does not include `partial` field", () => {
  const sideDataMatch = SHARED_CONTRACTS_SRC.match(
    /export\s+interface\s+SideDataPayload\s*\{[\s\S]*?\n\}/
  );
  assert.ok(
    sideDataMatch,
    "SideDataPayload definition found in shared-contracts"
  );
  assert.doesNotMatch(
    sideDataMatch[0],
    /partial\s*:\s*boolean/,
    "SideDataPayload must NOT have `partial: boolean` field"
  );
});

test("SideDataPayload errors type uses precise SubSource keys", () => {
  const sideDataMatch = SHARED_CONTRACTS_SRC.match(
    /export\s+interface\s+SideDataPayload\s*\{[\s\S]*?\n\}/
  );
  assert.ok(
    sideDataMatch,
    "SideDataPayload definition found in shared-contracts"
  );
  assert.doesNotMatch(
    sideDataMatch[0],
    /errors\??\s*:\s*Record<string,\s*string>/,
    "SideDataPayload.errors must NOT use Record<string, string> — use precise SubSource keys"
  );
  // errors field should reference SideDataSubSourceErrors type
  assert.match(
    sideDataMatch[0],
    /errors\??\s*:\s*SideDataSubSourceErrors/,
    "SideDataPayload.errors should reference SideDataSubSourceErrors type"
  );
  // SideDataSubSourceErrors uses SideDataSubSource which should list all 4 keys
  const subSourceMatch = SHARED_CONTRACTS_SRC.match(
    /export\s+type\s+SideDataSubSource\s*=\s*([^;]+)/
  );
  assert.ok(subSourceMatch, "SideDataSubSource type definition found");
  assert.match(
    subSourceMatch[1],
    /categories[\s\S]*fdv[\s\S]*forecast[\s\S]*campaignAccess/,
    "SideDataSubSource should reference all 4 SubSource keys"
  );
});

test("metaController no longer sets `partial` on payload", () => {
  assert.doesNotMatch(
    META_CONTROLLER_SRC,
    /payload\.partial\s*=/,
    "metaController must not set payload.partial anymore"
  );
  assert.doesNotMatch(
    META_CONTROLLER_SRC,
    /partial:\s*boolean/,
    "metaController must not reference partial: boolean type"
  );
});

test("metaController imports SideDataPayload from shared-contracts", () => {
  assert.match(
    META_CONTROLLER_SRC,
    /from\s+['"]@internal\/aave-shared-contracts['"]/,
    "metaController should import from @internal/aave-shared-contracts"
  );
  assert.match(
    META_CONTROLLER_SRC,
    /SideDataPayload/,
    "metaController should reference SideDataPayload type"
  );
});

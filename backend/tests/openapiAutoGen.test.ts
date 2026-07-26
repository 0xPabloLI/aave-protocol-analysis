import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// AAV-1211: OpenAPI auto-generation tests
// Verifies that generate-openapi.ts uses ts-json-schema-generator
// and the generated spec includes all API layer type fields (including borrowBlacklist)

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_OPENAPI = JSON.parse(
  readFileSync(resolve(__dirname, "../static/openapi.json"), "utf8")
) as Record<string, unknown>;

const GENERATE_SCRIPT_SRC = readFileSync(
  resolve(__dirname, "../scripts/generate-openapi.ts"),
  "utf8"
);

test("generate-openapi.ts imports ts-json-schema-generator", () => {
  assert.match(
    GENERATE_SCRIPT_SRC,
    /ts-json-schema-generator/,
    "generate-openapi.ts should import ts-json-schema-generator"
  );
});

test("generate-openapi.ts no longer uses hand-written RESERVE_PROPERTIES constant", () => {
  assert.doesNotMatch(
    GENERATE_SCRIPT_SRC,
    /const\s+RESERVE_PROPERTIES/,
    "generate-openapi.ts should not have hand-written RESERVE_PROPERTIES constant"
  );
});

test("generated spec includes borrowBlacklist field", () => {
  // borrowBlacklist is in CampaignGroup interface but was missing from hand-written spec
  const spec = JSON.stringify(STATIC_OPENAPI);
  assert.match(
    spec,
    /borrowBlacklist/,
    "Generated spec must include borrowBlacklist field (from CampaignGroup type)"
  );
});

test("generated spec includes positionCapUsd field", () => {
  const spec = JSON.stringify(STATIC_OPENAPI);
  assert.match(
    spec,
    /positionCapUsd/,
    "Generated spec must include positionCapUsd field"
  );
});

test("generated spec includes netPositionConstraint field", () => {
  const spec = JSON.stringify(STATIC_OPENAPI);
  assert.match(
    spec,
    /netPositionConstraint/,
    "Generated spec must include netPositionConstraint field"
  );
});

test("generated spec still has 429 response metadata for /markets", () => {
  const paths = STATIC_OPENAPI.paths as Record<string, Record<string, unknown>>;
  const marketsGet = paths["/markets"]?.get as Record<string, unknown>;
  const responses = marketsGet?.responses as Record<string, unknown>;
  assert.ok(responses?.["429"], "/markets should have 429 response metadata");
  const response429 = responses["429"] as Record<string, unknown>;
  assert.match(
    JSON.stringify(response429),
    /Retry-After/,
    "429 response should have Retry-After header"
  );
});

test("generated spec still has 503 response metadata for /markets", () => {
  const paths = STATIC_OPENAPI.paths as Record<string, Record<string, unknown>>;
  const marketsGet = paths["/markets"]?.get as Record<string, unknown>;
  const responses = marketsGet?.responses as Record<string, unknown>;
  assert.ok(responses?.["503"], "/markets should have 503 response metadata");
});

test("generated spec still has 429 response metadata for /meta/side-data", () => {
  const paths = STATIC_OPENAPI.paths as Record<string, Record<string, unknown>>;
  const sideDataGet = paths["/meta/side-data"]?.get as Record<string, unknown>;
  const responses = sideDataGet?.responses as Record<string, unknown>;
  assert.ok(
    responses?.["429"],
    "/meta/side-data should have 429 response metadata"
  );
});

test("generated spec does not have partial field in SideDataPayload", () => {
  // AAV-1210 removed partial: boolean from SideDataPayload
  // The generated spec should also not have it
  const components = STATIC_OPENAPI.components as {
    schemas: Record<string, unknown>;
  };
  const sideDataSchema = JSON.stringify(components.schemas);
  // partial may appear in other contexts, but not as a top-level field of SideData
  const sideDataMatch = sideDataSchema.match(/"SideData[^"]*"[^{]*\{[^}]*\}/);
  if (sideDataMatch) {
    assert.doesNotMatch(
      sideDataMatch[0],
      /"partial"\s*:\s*\{[^}]*"type"\s*:\s*"boolean"/,
      "SideData schema should not have partial: boolean field"
    );
  }
});

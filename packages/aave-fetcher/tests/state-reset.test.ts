import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resetMerklState } from "../src/merkl-api.js";

describe("merkl-api state encapsulation", () => {
  it("exports resetMerklState as a function", () => {
    assert.equal(typeof resetMerklState, "function");
  });

  it("resetMerklState does not throw", () => {
    assert.doesNotThrow(() => resetMerklState());
  });

  it("resetMerklState is idempotent", () => {
    resetMerklState();
    assert.doesNotThrow(() => resetMerklState());
  });
});

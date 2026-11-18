import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { refreshMarketsSnapshot } from "../src/services/marketsService.js";

describe("AAV-1394 refreshMarketsSnapshot total-fetch failure", () => {
  it("routes an empty refresh through the eMode stale merge and fails closed", async () => {
    await assert.rejects(
      refreshMarketsSnapshot(async () => {
        throw new Error("simulated total fetch failure");
      }),
      /Both V3 and V4 fetch failed/
    );
  });
});

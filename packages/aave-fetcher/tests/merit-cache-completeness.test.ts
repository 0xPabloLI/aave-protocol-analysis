import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isCachedTimeRangeComplete } from "../src/merit-api.js";
import type { MeritCampaignInfo } from "../src/merit-api.js";

const COMPLETE_CACHE = {
  link: "https://merit.link",
  startDate: "2025-01-01",
  endDate: "2025-12-31",
  name: "SGHO Boost",
  message: [] as MeritCampaignInfo[],
} as const;

describe("isCachedTimeRangeComplete: empty message/name should not cause infinite retry", () => {
  it("returns isComplete=true when name is empty but defined (attempted, no data)", () => {
    const result = isCachedTimeRangeComplete({
      key: "ethereum-new-sgho-boost",
      cached: { ...COMPLETE_CACHE, name: "" },
      hasSelfAuth: false,
    });
    assert.equal(result.isComplete, true);
    assert.deepEqual(result.missing, []);
  });

  it("returns isComplete=true when message is empty array (attempted, no data)", () => {
    const result = isCachedTimeRangeComplete({
      key: "ethereum-new-sgho-boost",
      cached: { ...COMPLETE_CACHE, message: [] },
      hasSelfAuth: false,
    });
    assert.equal(result.isComplete, true);
  });

  it("returns isComplete=false when message is undefined (never attempted)", () => {
    const { message: _, ...noMsgCache } = COMPLETE_CACHE;
    const result = isCachedTimeRangeComplete({
      key: "ethereum-new-sgho-boost",
      cached: noMsgCache,
      hasSelfAuth: false,
    });
    assert.equal(result.isComplete, false);
    assert.ok(result.missing.includes("message"));
  });

  it("returns isComplete=false when name is undefined (never attempted)", () => {
    const { name: _, ...noNameCache } = COMPLETE_CACHE;
    const result = isCachedTimeRangeComplete({
      key: "ethereum-new-sgho-boost",
      cached: noNameCache,
      hasSelfAuth: false,
    });
    assert.equal(result.isComplete, false);
    assert.ok(result.missing.includes("name"));
  });

  it("still flags missing link/startDate/endDate as incomplete", () => {
    const result = isCachedTimeRangeComplete({
      key: "ethereum-new-sgho-boost",
      cached: { link: "", startDate: "", endDate: "", name: "X", message: [] },
      hasSelfAuth: false,
    });
    assert.equal(result.isComplete, false);
    assert.ok(result.missing.includes("link"));
    assert.ok(result.missing.includes("startDate"));
    assert.ok(result.missing.includes("endDate"));
  });

  it("key with <=2 parts does not require message", () => {
    const { message: _, ...noMsgCache } = COMPLETE_CACHE;
    const result = isCachedTimeRangeComplete({
      key: "ethereum-new",
      cached: noMsgCache,
      hasSelfAuth: false,
    });
    assert.equal(result.isComplete, true);
  });

  it("empty message does not require self-auth check", () => {
    const result = isCachedTimeRangeComplete({
      key: "ethereum-new-sgho-boost",
      cached: { ...COMPLETE_CACHE, message: [] },
      hasSelfAuth: true,
    });
    assert.equal(result.isComplete, true);
    assert.deepEqual(result.missing, []);
  });

  it("spread preserves name when empty string", () => {
    const name = "";
    const spread = { ...(name !== undefined ? { name } : {}) };
    assert.ok("name" in spread);
    assert.equal(spread.name, "");
  });

  it("spread omits name when undefined", () => {
    const name = undefined;
    const spread = { ...(name !== undefined ? { name } : {}) };
    assert.ok(!("name" in spread));
  });

  it("cache write path: name='' is preserved via !== undefined spread", () => {
    const timeRangeData = { name: "" as string | undefined };
    const obj = { ...(timeRangeData.name !== undefined ? { name: timeRangeData.name } : {}) };
    assert.ok("name" in obj);
    assert.equal(obj.name, "");
  });

  it("cache write path: message=[] is preserved via !== undefined spread", () => {
    const timeRangeData = { message: [] as MeritCampaignInfo[] | undefined };
    const obj = { ...(timeRangeData.message !== undefined ? { message: timeRangeData.message } : {}) };
    assert.ok("message" in obj);
    assert.deepEqual(obj.message, []);
  });

  it("cache write path: name=undefined is omitted via !== undefined spread", () => {
    const timeRangeData = { name: undefined as string | undefined };
    const obj = { ...(timeRangeData.name !== undefined ? { name: timeRangeData.name } : {}) };
    assert.ok(!("name" in obj));
  });

  it("cache write path: message=undefined is omitted via !== undefined spread", () => {
    const timeRangeData = { message: undefined as MeritCampaignInfo[] | undefined };
    const obj = { ...(timeRangeData.message !== undefined ? { message: timeRangeData.message } : {}) };
    assert.ok(!("message" in obj));
  });
});

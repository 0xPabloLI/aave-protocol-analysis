import test from "node:test";
import assert from "node:assert/strict";

import { buildForecastState } from "../src/services/merklForecastModel.js";

test("buildForecastState supports DUTCH_AUCTION without apr cap", () => {
  const state = buildForecastState({
    campaignId: "dutch-1",
    campaignType: "DUTCH_AUCTION",
    totalBudget: 1000,
    aprCap: null,
    startTimestamp: 1_000,
    endTimestamp: 1_000 + 10 * 86400,
    nowTimestamp: 1_000 + 5 * 86400,
    distributedSoFar: 400,
    latestTvl: 2_000_000,
  });

  assert.equal(state.campaignType, "DUTCH_AUCTION");
  assert.equal(state.aprCap, null);
  assert.equal(state.remainingBudget, 600);
  assert.equal(state.remainingDays, 5);
  assert.equal(state.plannedDaily, 100);
  assert.equal(state.requiredDaily, state.plannedDaily);
});

test("buildForecastState requires apr cap for MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE campaigns", () => {
  assert.throws(
    () =>
      buildForecastState({
        campaignId: "max-apr-1",
        campaignType: "MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE",
        totalBudget: 1000,
        aprCap: null,
        startTimestamp: 1_000,
        endTimestamp: 1_000 + 10 * 86400,
        nowTimestamp: 1_000 + 5 * 86400,
        distributedSoFar: 500,
        latestTvl: 1_000_000,
      }),
    /Missing APR cap/
  );
});

test("buildForecastState requires apr cap for FIX campaigns and stores it in aprCap field", () => {
  assert.throws(
    () =>
      buildForecastState({
        campaignId: "fix-1",
        campaignType: "FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE",
        totalBudget: 1000,
        aprCap: null,
        startTimestamp: 1_000,
        endTimestamp: 1_000 + 10 * 86400,
        nowTimestamp: 1_000 + 5 * 86400,
        distributedSoFar: 300,
        latestTvl: 1_000_000,
      }),
    /Missing APR cap/
  );

  const state = buildForecastState({
    campaignId: "fix-2",
    campaignType: "FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE",
    totalBudget: 1000,
    aprCap: 0.005,
    startTimestamp: 1_000,
    endTimestamp: 1_000 + 10 * 86400,
    nowTimestamp: 1_000 + 5 * 86400,
    distributedSoFar: 300,
    latestTvl: 1_000_000,
  });
  assert.equal(state.aprCap, 0.005);
  assert.equal(state.plannedDaily, 100);
  assert.equal(state.requiredDaily, 140);
});

test("buildForecastState requires apr cap for TARGET_TOTAL_APR campaigns", () => {
  assert.throws(
    () =>
      buildForecastState({
        campaignId: "tta-1",
        campaignType: "TARGET_TOTAL_APR",
        totalBudget: 1000,
        aprCap: null,
        startTimestamp: 1_000,
        endTimestamp: 1_000 + 10 * 86400,
        nowTimestamp: 1_000 + 5 * 86400,
        distributedSoFar: 300,
        latestTvl: 1_000_000,
      }),
    /Missing APR cap/
  );
});

test("buildForecastState computes TARGET_TOTAL_APR forecast correctly", () => {
  const state = buildForecastState({
    campaignId: "tta-2",
    campaignType: "TARGET_TOTAL_APR",
    totalBudget: 5000,
    aprCap: 0.047,
    startTimestamp: 1_000,
    endTimestamp: 1_000 + 10 * 86400,
    nowTimestamp: 1_000 + 5 * 86400,
    distributedSoFar: 2000,
    latestTvl: 1_000_000,
  });
  assert.equal(state.aprCap, 0.047);
  assert.equal(state.remainingBudget, 3000);
  assert.equal(state.plannedDaily, 500);
  assert.equal(state.requiredDaily, 600);
});

test("buildForecastState requires apr cap for FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE", () => {
  assert.throws(
    () =>
      buildForecastState({
        campaignId: "fix-amt-val-1",
        campaignType: "FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE",
        totalBudget: 1000,
        aprCap: null,
        startTimestamp: 1_000,
        endTimestamp: 1_000 + 10 * 86400,
        nowTimestamp: 1_000 + 5 * 86400,
        distributedSoFar: 300,
        latestTvl: 1_000_000,
      }),
    /Missing APR cap/
  );
});

test("buildForecastState accepts USD-converted aprCap for FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE", () => {
  const state = buildForecastState({
    campaignId: "fix-amt-val-2",
    campaignType: "FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE",
    totalBudget: 5000,
    aprCap: 0.035,
    startTimestamp: 1_000,
    endTimestamp: 1_000 + 10 * 86400,
    nowTimestamp: 1_000 + 5 * 86400,
    distributedSoFar: 1000,
    latestTvl: 2_000_000,
  });
  assert.equal(state.aprCap, 0.035);
  assert.equal(state.plannedDaily, 500);
});

test("buildForecastState requires apr cap for FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT", () => {
  assert.throws(
    () =>
      buildForecastState({
        campaignId: "fix-amt-amt-1",
        campaignType: "FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT",
        totalBudget: 1000,
        aprCap: null,
        startTimestamp: 1_000,
        endTimestamp: 1_000 + 10 * 86400,
        nowTimestamp: 1_000 + 5 * 86400,
        distributedSoFar: 300,
        latestTvl: 1_000_000,
      }),
    /Missing APR cap/
  );
});

test("buildForecastState requires apr cap for MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT", () => {
  assert.throws(
    () =>
      buildForecastState({
        campaignId: "max-val-amt-1",
        campaignType: "MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT",
        totalBudget: 1000,
        aprCap: null,
        startTimestamp: 1_000,
        endTimestamp: 1_000 + 10 * 86400,
        nowTimestamp: 1_000 + 5 * 86400,
        distributedSoFar: 300,
        latestTvl: 1_000_000,
      }),
    /Missing APR cap/
  );
});

// INVARIANT — bet ladder reconciled to the real display currency (manual-session)
//
// Pragmatic's do_init reports coin values (`sc`) in a BASE unit. For high-
// denomination currencies (e.g. Colombian Peso) the game DISPLAYS + BILLS a far
// larger unit, so `sc × lines` yields a ladder 100s–1000s× smaller than the bet
// the player actually places (captured betMax 250 vs a real on-screen 450 000).
// That wrong ladder used to flow verbatim into assertion generation. When the
// on-screen bet-selector chips prove a large upward scale gap, reconcileBetScale
// adopts the chips as the ladder and re-anchors min/max/default. Normal-
// denomination games (chips ≈ ladder) and partial low-chip reads are left alone.

import { test, expect } from "@playwright/test";
import { reconcileBetScale, BET_SCALE_MISMATCH_FACTOR, type BetScaleSpec } from "../../src/pipeline/server/manual-session.ts";

// A base-unit do_init capture: coin [0.01…5] × 50 lines → ladder [0.5…250].
const copBase: BetScaleSpec = {
  coinValues: [0.01, 0.02, 0.03, 0.04, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.75, 1, 2, 3, 4, 5],
  lines: 50,
  defaultCoin: 0.05,
  betLevels: [1],
  betMin: 0.5,
  betMax: 250,
  defaultBet: 2.5,
  betLadder: [0.5, 1, 1.5, 2, 2.5, 5, 10, 15, 20, 25, 37.5, 50, 100, 150, 200, 250],
};

// A normal-denomination game (BRL): the on-screen chips equal the ladder.
const brlBase: BetScaleSpec = {
  coinValues: [4, 8],
  lines: 1,
  defaultCoin: 4,
  betLevels: [1],
  betMin: 4,
  betMax: 8,
  defaultBet: 4,
  betLadder: [4, 8],
};

test("COP: chips ≫ do_init ladder → adopt chips as ladder + re-anchor min/max", () => {
  // Real COP bet chips read off the selector (partial/noisy is fine).
  const chips = [1000, 2000, 5000, 50000, 450000];
  const { spec, rescaled, factor } = reconcileBetScale(copBase, chips);
  expect(rescaled).toBe(true);
  expect(factor).toBeCloseTo(450000 / 250); // 1800
  expect(spec.betMin).toBe(1000);
  expect(spec.betMax).toBe(450000);
  expect(spec.betLadder).toEqual([1000, 2000, 5000, 50000, 450000]);
  // structural do_init params are preserved
  expect(spec.lines).toBe(50);
  expect(spec.coinValues).toEqual(copBase.coinValues);
});

test("COP: defaultBet snaps to the chip nearest the scaled do_init default", () => {
  // scaledDefault = 2.5 × 1800 = 4500 → nearest chip is 5000 (not 2000).
  const chips = [1000, 2000, 5000, 50000, 450000];
  const { spec } = reconcileBetScale(copBase, chips);
  expect(spec.defaultBet).toBe(5000);
});

test("BRL: chips ≈ ladder → do_init ladder trusted verbatim (no rescale)", () => {
  const { spec, rescaled, factor } = reconcileBetScale(brlBase, [4, 8]);
  expect(rescaled).toBe(false);
  expect(factor).toBe(1);
  expect(spec).toBe(brlBase); // returned untouched
});

test("ante / double-chance rung (chips ~2× ladder) stays under the bar → no rescale", () => {
  // Double Chance rung inflates max chip to 16 vs ladder max 8 → factor 2 < 4.
  const { rescaled, factor } = reconcileBetScale(brlBase, [4, 8, 16]);
  expect(factor).toBe(2);
  expect(factor).toBeLessThan(BET_SCALE_MISMATCH_FACTOR);
  expect(rescaled).toBe(false);
});

test("downward direction (partial low-chip read) never shrinks a correct ladder", () => {
  // Only the small chips got OCR'd → chipMax 50 < ladderMax 250 → left alone.
  const { spec, rescaled } = reconcileBetScale(copBase, [10, 25, 50]);
  expect(rescaled).toBe(false);
  expect(spec.betMax).toBe(250);
});

test("no chip evidence → spec returned unchanged", () => {
  const { spec, rescaled } = reconcileBetScale(copBase, []);
  expect(rescaled).toBe(false);
  expect(spec).toBe(copBase);
});

test("empty do_init ladder → spec returned unchanged (different capture path)", () => {
  const empty: BetScaleSpec = { ...copBase, betLadder: [] };
  const { rescaled } = reconcileBetScale(empty, [1000, 450000]);
  expect(rescaled).toBe(false);
});

test("non-finite / non-positive chip values are ignored", () => {
  const chips = [0, -5, Number.NaN, 1000, 450000];
  const { spec, rescaled } = reconcileBetScale(copBase, chips);
  expect(rescaled).toBe(true);
  expect(spec.betLadder).toEqual([1000, 450000]);
  expect(spec.betMin).toBe(1000);
});

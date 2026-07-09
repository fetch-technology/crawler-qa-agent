// INVARIANT — Pure assertion helpers (Phase 11.1)
//
// These helpers are exposed to custom_assertion check_code at runtime.
// They MUST be deterministic + pure (no I/O) so assertion evaluation
// stays sandboxed-safe.

import { test, expect } from "@playwright/test";
import {
  getRoundEndSpins,
  getCurrentBalance,
  detectBuyFeatureDeduction,
  sumWinBreakdown,
} from "../../src/pipeline/step8-run-scenarios/assertion-helpers.ts";

// === getRoundEndSpins ===

test("getRoundEndSpins: empty input → empty", () => {
  expect(getRoundEndSpins([])).toEqual([]);
});

test("getRoundEndSpins: prefers explicit isEndRound flag", () => {
  const spins = [
    { id: "a", isEndRound: false },
    { id: "b", isEndRound: true },
    { id: "c", isEndRound: true },
  ];
  const ends = getRoundEndSpins(spins);
  expect(ends.length).toBe(2);
  expect(ends.map((s) => s.id)).toEqual(["b", "c"]);
});

test("getRoundEndSpins: groups by roundId when no flag, returns last per group", () => {
  const spins = [
    { id: "a", roundId: "R1" },
    { id: "b", roundId: "R1" },
    { id: "c", roundId: "R2" },
    { id: "d", roundId: "R2" },
    { id: "e", roundId: "R2" },
  ];
  const ends = getRoundEndSpins(spins);
  expect(ends.map((s) => s.id)).toEqual(["b", "e"]);
});

test("getRoundEndSpins: fallback to all spins when no flag + no round key", () => {
  const spins = [{ foo: 1 }, { foo: 2 }];
  expect(getRoundEndSpins(spins).length).toBe(2);
});

// === getCurrentBalance ===

test("getCurrentBalance: returns last endingBalance", () => {
  const c = { spins: [{ endingBalance: 100 }, { endingBalance: 95 }] };
  expect(getCurrentBalance(c)).toBe(95);
});

test("getCurrentBalance: falls back to balance / balanceAfter alias", () => {
  expect(getCurrentBalance({ spins: [{ balanceAfter: 42 }] })).toBe(42);
  expect(getCurrentBalance({ spins: [{ balance: 7 }] })).toBe(7);
});

test("getCurrentBalance: empty collector → null", () => {
  expect(getCurrentBalance({ spins: [] })).toBe(null);
  expect(getCurrentBalance(undefined)).toBe(null);
});

// === sumWinBreakdown ===

test("sumWinBreakdown rounds floating drift to cents", () => {
  const sum = sumWinBreakdown({
    winBreakdown: [{ win: 0.1 }, { win: 0.2 }, { win: 0.30000000000000004 }],
  });
  expect(sum).toBe(0.6);
});

// === detectBuyFeatureDeduction ===

test("detectBuyFeatureDeduction: high-ratio buy detected", () => {
  const spins = [
    {
      isEndRound: true,
      betAmount: 0.5, // base bet
      winAmount: 0,
      endingBalance: 950, // 1000 - 50 (50× buy)
    },
  ];
  const d = detectBuyFeatureDeduction(spins, 0, 1000);
  expect(d).not.toBeNull();
  expect(d!.baseBet).toBe(0.5);
  expect(d!.ratio).toBeCloseTo(100, 1); // 50 / 0.5 = 100×
});

test("detectBuyFeatureDeduction: negative win (buy cost folded into win) still measures full deduction", () => {
  // PP buy spins emit winAmount = -(buyCost - baseBet). Balance dropped by the
  // full $40 buy cost; the parser reports bet=0.4, win=-39.6. The deduction
  // must measure 40 (ratio 100×), NOT 0.4 (ratio 1× — would false-fail).
  const spins = [
    { isEndRound: true, betAmount: 0.4, winAmount: -39.6, endingBalance: 960 }, // 1000 - 40
  ];
  const d = detectBuyFeatureDeduction(spins, 0, 1000);
  expect(d).not.toBeNull();
  expect(d!.deduction).toBeCloseTo(40, 1);
  expect(d!.ratio).toBeCloseTo(100, 1);
});

test("detectBuyFeatureDeduction: positive win on buy spin is added back to deduction", () => {
  // Buy cost 40, buy spin also pays a 5 line win: after = 1000 - 40 + 5 = 965.
  // True deduction = 40 (ratio 100×), recovered by adding the credited win back.
  const spins = [{ isEndRound: true, betAmount: 0.4, winAmount: 5, endingBalance: 965 }];
  const d = detectBuyFeatureDeduction(spins, 0, 1000);
  expect(d!.deduction).toBeCloseTo(40, 1);
  expect(d!.ratio).toBeCloseTo(100, 1);
});

test("detectBuyFeatureDeduction: parser may stamp purchase cost as betAmount; raw c*l recovers base bet", () => {
  // User case: buy-respin purchase cost is 40, but the adapted first spin has
  // betAmount=40. Raw PP fields still show base wager c*l = 0.02*20 = 0.40.
  // The buy ratio must be 40/0.40 = 100x, not 40/40 = 1x.
  const spins = [{
    isEndRound: true,
    betAmount: 40,
    winAmount: 0,
    endingBalance: 999999925.2,
    raw: { c: "0.02", l: "20", bl: "0" },
  }];
  const d = detectBuyFeatureDeduction(spins, 0, 999999965.2);
  expect(d).not.toBeNull();
  expect(d!.deduction).toBeCloseTo(40, 2);
  expect(d!.baseBet).toBeCloseTo(0.4, 2);
  expect(d!.ratio).toBeCloseTo(100, 1);
});

test("detectBuyFeatureDeduction: null when no end-spins available", () => {
  expect(detectBuyFeatureDeduction([], 0, 100)).toBeNull();
});

test("detectBuyFeatureDeduction: null when balanceBefore unresolvable", () => {
  // No caller hint AND startIndex=0 so no prior spin → null
  const spins = [{ isEndRound: true, betAmount: 0.5, winAmount: 0, endingBalance: 950 }];
  expect(detectBuyFeatureDeduction(spins, 0)).toBeNull();
});

test("detectBuyFeatureDeduction: handles bet alias (bet vs betAmount)", () => {
  const spins = [{ isEndRound: true, bet: 0.5, win: 0, endingBalance: 950 }];
  const d = detectBuyFeatureDeduction(spins, 0, 1000);
  expect(d).not.toBeNull();
  expect(d!.baseBet).toBe(0.5);
  expect(d!.ratio).toBeCloseTo(100, 1);
});

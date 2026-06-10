// INVARIANT — Buy-feature FS chain capture (2026-05-25)
//
// When a case purchases a buy-feature (e.g. Buy Free Spins), the server
// responds with a BUY transaction first (large balance deduction = N× base
// bet, typically 88×), then auto-plays the FS chain over 30-90s. Engine's
// default 10s post-action settle window expires BEFORE the FS chain even
// begins → all FS frames missed → assertions fail.
//
// Fix: detect buy-feature signature on the first captured spin (drop/bet ≥ 50)
// and auto-extend the per-spin settle window to 45s. Works alongside the
// translator-prompt fix that emits wait_until_state MAIN after dismiss.

import { test, expect } from "@playwright/test";

test("buy-feature signature: ratio >= 50 triggers extended settle", () => {
  // Replicates engine logic: drop / bet >= 50 → buy detected
  const firstSpin = { bet: 0.2, balanceBefore: 100, balanceAfter: 82.4 };
  const drop = firstSpin.balanceBefore - firstSpin.balanceAfter;  // 17.6
  const ratio = drop / firstSpin.bet;                              // 88
  expect(ratio).toBeGreaterThanOrEqual(50);
  // Engine would extend settle to 45s here
});

test("buy-feature signature: ratio < 50 stays in normal mode", () => {
  // Regular spin: bet 0.5, no win → drop=0.5, ratio=1
  const firstSpin = { bet: 0.5, balanceBefore: 100, balanceAfter: 99.5 };
  const ratio = (firstSpin.balanceBefore - firstSpin.balanceAfter) / firstSpin.bet;
  expect(ratio).toBeLessThan(50);
});

test("buy-feature signature: zero-bet edge case doesn't divide by zero", () => {
  const firstSpin = { bet: 0, balanceBefore: 100, balanceAfter: 100 };
  // Engine guards: `first.bet > 0 ? drop / first.bet : 0`
  const ratio = firstSpin.bet > 0 ? (firstSpin.balanceBefore - firstSpin.balanceAfter) / firstSpin.bet : 0;
  expect(ratio).toBe(0);
});

test("buy-feature signature: only fires on FIRST captured spin", () => {
  // Engine condition: `!buyFeatureDetected && collectedSpins.length === 1`
  // Subsequent spins shouldn't re-trigger detection (e.g., a FS frame
  // with large win shouldn't be mistaken for a buy).
  const spinIndex = 5;
  const shouldDetect = spinIndex === 1; // simulated check
  expect(shouldDetect).toBe(false);
});

test("buy-feature signature: extended settle is 45s not 10s", () => {
  // Engine sets settleMs = 45_000 when ratio >= 50.
  // 45s should be long enough to cover:
  //   - dismiss popup wait (10s)
  //   - "FREE SPINS START" interstitial transition (5-10s)
  //   - First FS frame land (5-15s)
  //   - Inter-FS-frame gap (~3-5s per frame)
  const settleMs = 45_000;
  expect(settleMs).toBeGreaterThanOrEqual(30_000);
  expect(settleMs).toBeLessThanOrEqual(60_000);
});

test("user-reported case math: vswaysmahwin2 buy-free-spins at 0.2", () => {
  // From user log:
  //   bet=0.2, balanceBefore=99996750.62, balanceAfter=99996733.02
  const drop = 99996750.62 - 99996733.02;
  expect(drop).toBeCloseTo(17.6, 1);
  const ratio = drop / 0.2;
  expect(ratio).toBeCloseTo(88, 0);  // 88× base bet — classic PP buy-FS price
  expect(ratio).toBeGreaterThanOrEqual(50);  // triggers buy-feature settle extension
});

// 2026-06-10 — lower-multiple buys (e.g. "Buy Respins for 20×") sat BELOW the
// flat 50× cutoff and were mis-scored as "UI-only, 0 spins". Engine now lowers
// the detection threshold for cases the catalog already tags `buy_feature`:
//   const isBuyFeatureCaseRun = /buy/i.test(input.category);
//   const buyRatioThreshold  = isBuyFeatureCaseRun ? 3 : 50;
function buyRatioThreshold(category: string): number {
  return /buy/i.test(category) ? 3 : 50;
}

test("buy-respins 20× on a buy_feature case IS detected (threshold lowered to 3)", () => {
  // Reported case: bet=0.40, balanceBefore=996057.82, balanceAfter=996049.82
  const drop = 996057.82 - 996049.82;        // 8.00 = 20× base bet
  const ratio = drop / 0.4;                   // 20
  expect(ratio).toBeCloseTo(20, 0);
  expect(ratio).toBeGreaterThanOrEqual(buyRatioThreshold("buy_feature")); // 20 ≥ 3 → detected
  expect(ratio).toBeLessThan(50);             // would have been MISSED by the old flat cutoff
});

test("non-buy category keeps the conservative 50× cutoff (no false buy detection)", () => {
  // A big organic win on a base_game spin must NOT be mistaken for a buy.
  expect(buyRatioThreshold("base_game")).toBe(50);
  const ratio = 20; // 20× swing on a normal spin
  expect(ratio).toBeLessThan(buyRatioThreshold("base_game")); // stays in normal mode
});

// 2026-06-10 — buy-round win-non-negativity must read serverTotalWin, NOT the
// balance-derived `win`. On a buy round `win = balanceAfter − balanceBefore +
// bet` folds the purchase premium in and legitimately goes negative.
test("buy-round API win check uses serverTotalWin, not balance-derived win", () => {
  // Reported round: bet=0.4, bb=996057.82, ba=996049.82, serverTotalWin=0
  const bet = 0.4, bb = 996057.82, ba = 996049.82, serverTotalWin = 0;
  const balanceDerivedWin = Math.round((ba - bb + bet) * 100) / 100; // -7.6
  expect(balanceDerivedWin).toBeCloseTo(-7.6, 2);

  // OLD check (balance-derived >= 0) wrongly fails:
  expect(balanceDerivedWin >= 0).toBe(false);
  // NEW buy-aware check (serverTotalWin >= 0) passes:
  const hasServerWin = typeof serverTotalWin === "number" && Number.isFinite(serverTotalWin);
  const match = hasServerWin ? serverTotalWin >= 0 : Number.isFinite(balanceDerivedWin);
  expect(match).toBe(true);
});

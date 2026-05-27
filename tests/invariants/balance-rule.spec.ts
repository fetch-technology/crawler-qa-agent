// INVARIANT — balance conservation
//
// Core contract: for any spin (free or paid), the balance change must
// reconcile bet + win:
//   - Non-free spin:  balanceAfter = balanceBefore - bet + win
//   - Free spin:      balanceAfter = balanceBefore + win  (no bet deduction)
//
// This invariant lives in the engine's verification layer. If broken, EITHER
// the parser is producing wrong bet/win values, OR the game is misreporting
// balance. Engine MUST detect both cases.

import { test, expect } from "@playwright/test";
import { synthSpin, balanceConserved, expectedDrop, computeDrop } from "./helpers.js";

test("paid spin: balanceAfter == balanceBefore - bet + win", () => {
  const spin = synthSpin({ bet: 10, win: 3, balanceBefore: 100, balanceAfter: 93 });
  expect(balanceConserved(spin)).toBe(true);
});

test("paid spin: zero-win still conserves (drop == bet)", () => {
  const spin = synthSpin({ bet: 10, win: 0, balanceBefore: 100, balanceAfter: 90 });
  expect(balanceConserved(spin)).toBe(true);
});

test("paid spin: net-zero (bet == win) → balance unchanged", () => {
  const spin = synthSpin({ bet: 10, win: 10, balanceBefore: 100, balanceAfter: 100 });
  expect(balanceConserved(spin)).toBe(true);
});

test("paid spin: big win → balance rises by (win - bet)", () => {
  const spin = synthSpin({ bet: 10, win: 110, balanceBefore: 100, balanceAfter: 200 });
  expect(balanceConserved(spin)).toBe(true);
});

test("free spin: balanceAfter == balanceBefore + win (no deduction)", () => {
  const spin = synthSpin({
    bet: 10, win: 5, isFreeSpin: true, state: "FREE_SPIN",
    balanceBefore: 100, balanceAfter: 105,
  });
  expect(balanceConserved(spin)).toBe(true);
});

test("free spin: zero-win → balance unchanged", () => {
  const spin = synthSpin({
    bet: 10, win: 0, isFreeSpin: true, state: "FREE_SPIN",
    balanceBefore: 100, balanceAfter: 100,
  });
  expect(balanceConserved(spin)).toBe(true);
});

test("VIOLATION: paid spin with bet=0 but balance dropped (game overcharge)", () => {
  const spin = synthSpin({ bet: 0, win: 0, balanceBefore: 100, balanceAfter: 90 });
  expect(balanceConserved(spin)).toBe(false);
  expect(computeDrop(spin)).toBe(10);
  expect(expectedDrop(spin)).toBe(0);
});

test("VIOLATION: free spin but balance went DOWN (game misclassified)", () => {
  const spin = synthSpin({
    bet: 10, win: 0, isFreeSpin: true, state: "FREE_SPIN",
    balanceBefore: 100, balanceAfter: 90,
  });
  expect(balanceConserved(spin)).toBe(false);
});

test("VIOLATION: paid spin with phantom win (balance rose more than win)", () => {
  const spin = synthSpin({ bet: 10, win: 5, balanceBefore: 100, balanceAfter: 200 });
  expect(balanceConserved(spin)).toBe(false);
  // Expected drop = bet - win = 5; actual drop = -100 → 105 off
  expect(computeDrop(spin)).toBe(-100);
});

test("skip when balanceBefore null (first spin without priorBalance hint)", () => {
  const spin = synthSpin({ bet: 10, win: 0, balanceBefore: null, balanceAfter: 90 });
  // Cannot evaluate — engine should treat as inconclusive, not as failure.
  expect(balanceConserved(spin)).toBe(true);
  expect(computeDrop(spin)).toBe(null);
});

test("float tolerance: 0.005 drift is acceptable", () => {
  const spin = synthSpin({ bet: 0.45, win: 0, balanceBefore: 100, balanceAfter: 99.555 });
  // Math: 100 - 0.45 + 0 = 99.55, observed 99.555 → drift 0.005 < 0.01 tolerance
  expect(balanceConserved(spin)).toBe(true);
});

test("float tolerance: 0.05 drift is NOT acceptable (too large)", () => {
  const spin = synthSpin({ bet: 0.45, win: 0, balanceBefore: 100, balanceAfter: 99.6 });
  // Math: expected 99.55, observed 99.6 → drift 0.05 > 0.01 tolerance
  expect(balanceConserved(spin)).toBe(false);
});

// INVARIANT — first-spin balanceBefore must use the LIVE pre-spin balance
//
// PP spin responses carry no `bb` (balance-before) field, so the executor
// patches it. For chained spins the prior spin's balanceAfter is authoritative.
// For the FIRST spin it must prefer the LIVE balance captured just before the
// spin fired over the `priorBalance` snapshot taken when ctx was built.
//
// Why this matters: the per-case retry loop reuses the SAME ctx across attempts.
// `priorBalance` is frozen at the value from before attempt #1, so by attempt #2
// it is one (or more) bets stale. Seeding balanceBefore from it made the
// balance-conservation assertion fail by ~bet (observed diff=1.000 over 2
// retries at bet=0.50). The live getter fixes this. If this regresses, retried
// cases flake on a phantom balance-arithmetic mismatch.

import { test, expect } from "@playwright/test";
import { resolveSpinBalanceBefore } from "../../src/pipeline/step8-run-scenarios/case-executor.js";

test("first spin: prefers live balance over stale priorBalance snapshot", () => {
  // Stale snapshot is 1.0 ahead of reality (two 0.50 bets behind across retries).
  const got = resolveSpinBalanceBefore({
    priorSpins: [],
    liveBeforeFirstSpin: 99997331.64, // true pre-spin balance
    priorBalance: 99997332.64,        // stale snapshot
  });
  expect(got).toBe(99997331.64);
});

test("first spin: falls back to priorBalance when no live value", () => {
  const got = resolveSpinBalanceBefore({
    priorSpins: [],
    liveBeforeFirstSpin: null,
    priorBalance: 1000,
  });
  expect(got).toBe(1000);
});

test("first spin: null when neither live nor priorBalance available", () => {
  expect(
    resolveSpinBalanceBefore({ priorSpins: [], liveBeforeFirstSpin: null, priorBalance: null }),
  ).toBeNull();
  expect(
    resolveSpinBalanceBefore({ priorSpins: [], liveBeforeFirstSpin: null, priorBalance: undefined }),
  ).toBeNull();
});

test("chained spin: uses previous spin's balanceAfter, ignores live + prior", () => {
  const got = resolveSpinBalanceBefore({
    priorSpins: [{ balanceAfter: 950 }, { balanceAfter: 900 }],
    liveBeforeFirstSpin: 12345, // must be ignored once a spin has landed
    priorBalance: 1000,
  });
  expect(got).toBe(900);
});

test("chained spin: single prior spin chains from its balanceAfter", () => {
  const got = resolveSpinBalanceBefore({
    priorSpins: [{ balanceAfter: 99.5 }],
    liveBeforeFirstSpin: null,
    priorBalance: 100,
  });
  expect(got).toBe(99.5);
});

test("live value of 0 is honored (not treated as missing)", () => {
  const got = resolveSpinBalanceBefore({
    priorSpins: [],
    liveBeforeFirstSpin: 0,
    priorBalance: 1000,
  });
  expect(got).toBe(0);
});

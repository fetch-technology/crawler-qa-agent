// INVARIANT — fsCreditTiming self-learning from a captured FS chain
//
// detectFsCreditTimingFromSpins classifies a game's free-spin credit timing
// from already-parsed collector spins (so a buy/FS case can self-certify it at
// the end of a run, no separate Calibrate-with-FS pass). Self-validating:
// trusted ONLY when every winning FS frame is unanimously immediate or deferred.

import { test, expect } from "@playwright/test";
import { detectFsCreditTimingFromSpins } from "../../src/pipeline/step8-run-scenarios/spec-learner.ts";
import type { NormalizedSpinResult } from "../../src/pipeline/step6-build-model/normalized.ts";

function spin(p: { fs?: boolean; bb: number; ba: number; win: number }): NormalizedSpinResult {
  return {
    roundId: `r${Math.round(p.bb * 1000)}-${Math.round(p.ba * 1000)}-${p.win}`,
    bet: 0,
    win: p.win,
    balanceBefore: p.bb,
    balanceAfter: p.ba,
    isFreeSpin: p.fs ?? false,
    reels: [],
    cascadeFrames: [],
    raw: {},
  } as unknown as NormalizedSpinResult;
}

test("deferred chain: every winning FS frame flat (ba≈bb) → trusted 'deferred'", () => {
  // vs10hottuna shape: balance flat at 984227.2 across the chain, server win
  // (here cumulative) grows; total credited at the end.
  const spins = [
    spin({ fs: true, bb: 984227.2, ba: 984227.2, win: 52.0 }),
    spin({ fs: true, bb: 984227.2, ba: 984227.2, win: 52.8 }),
    spin({ fs: true, bb: 984227.2, ba: 984227.2, win: 69.8 }),
    spin({ fs: true, bb: 984227.2, ba: 984227.2, win: 102.2 }),
  ];
  const d = detectFsCreditTimingFromSpins(spins);
  expect(d.value).toBe("deferred");
  expect(d.trusted).toBe(true);
});

test("immediate chain: every winning FS frame credits per-round (ba≈bb+win) → trusted 'immediate'", () => {
  const spins = [
    spin({ fs: true, bb: 100, ba: 105, win: 5 }),
    spin({ fs: true, bb: 105, ba: 107, win: 2 }),
    spin({ fs: true, bb: 107, ba: 117, win: 10 }),
  ];
  const d = detectFsCreditTimingFromSpins(spins);
  expect(d.value).toBe("immediate");
  expect(d.trusted).toBe(true);
});

test("mixed/inconsistent → NOT trusted (no false positive)", () => {
  const spins = [
    spin({ fs: true, bb: 100, ba: 100, win: 5 }),   // deferred-looking
    spin({ fs: true, bb: 100, ba: 105, win: 5 }),   // immediate-looking
  ];
  const d = detectFsCreditTimingFromSpins(spins);
  expect(d.trusted).toBe(false);
  expect(d.value).toBeNull();
});

test("no winning FS frames → not trusted (can't classify)", () => {
  const spins = [
    spin({ fs: true, bb: 100, ba: 100, win: 0 }),
    spin({ fs: false, bb: 100, ba: 99, win: 0 }),
  ];
  const d = detectFsCreditTimingFromSpins(spins);
  expect(d.trusted).toBe(false);
  expect(d.value).toBeNull();
});

test("balanceBefore chains from the previous spin's balanceAfter when null", () => {
  const s1 = spin({ fs: true, bb: 200, ba: 200, win: 10 });
  const s2 = spin({ fs: true, bb: 200, ba: 200, win: 20 });
  (s2 as { balanceBefore: number | null }).balanceBefore = null; // must fall back to s1.ba=200
  const d = detectFsCreditTimingFromSpins([s1, s2]);
  expect(d.value).toBe("deferred");
  expect(d.trusted).toBe(true);
});

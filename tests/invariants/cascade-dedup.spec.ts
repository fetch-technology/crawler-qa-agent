// INVARIANT — cascade frame deduplication
//
// Cascade slot games emit MULTIPLE network responses per round (initial bet
// frame + cascade payout frames). Engine must merge them into a SINGLE
// NormalizedSpinResult per round, else:
//   - bet is double-counted (cumulative balance assertion fails)
//   - spinsCount inflated (statistical RTP skewed)
//   - per-spin balance conservation false-positives
//
// Two merge signals:
//   1. Same roundId → cascade frames within same logical round
//   2. Balance continuity → bb of frame N equals ba of frame N-1, with no
//      new bet deduction (ba >= bb). Catches games that issue NEW roundIds
//      for cascade frames (e.g., vswaysmahwin2 doCollect requests).
//
// Independent rounds (clean separate spins) MUST NOT be merged.

import { test, expect } from "@playwright/test";
import { createDedupState, ingestFrame } from "../../src/pipeline/step8-run-scenarios/cascade-dedup.js";
import { synthSpin } from "./helpers.js";

test("two separate spins (different roundIds, balance drops each time) → both appended", () => {
  const state = createDedupState();
  ingestFrame(state, synthSpin({ roundId: "r1", bet: 10, win: 0, balanceBefore: 100, balanceAfter: 90 }));
  ingestFrame(state, synthSpin({ roundId: "r2", bet: 10, win: 0, balanceBefore: 90, balanceAfter: 80 }));
  expect(state.spins.length).toBe(2);
  expect(state.spins[0]!.roundId).toBe("r1");
  expect(state.spins[1]!.roundId).toBe("r2");
});

test("two frames same roundId → merge to single entry", () => {
  const state = createDedupState();
  ingestFrame(state, synthSpin({ roundId: "r1", bet: 10, win: 0, balanceBefore: 100, balanceAfter: 90 }));
  ingestFrame(state, synthSpin({ roundId: "r1", bet: 10, win: 5, balanceBefore: 90, balanceAfter: 95 }));
  expect(state.spins.length).toBe(1);
  expect(state.spins[0]!.balanceBefore).toBe(100); // first frame's bb
  expect(state.spins[0]!.balanceAfter).toBe(95);    // last frame's ba
  expect(state.spins[0]!.bet).toBe(10);
  expect(state.spins[0]!.win).toBe(5); // derived: 95 - 100 + 10
});

test("3 cascade frames same roundId → merge all into single entry, win derived", () => {
  const state = createDedupState();
  ingestFrame(state, synthSpin({ roundId: "r1", bet: 10, balanceBefore: 100, balanceAfter: 90 }));
  ingestFrame(state, synthSpin({ roundId: "r1", bet: 10, balanceBefore: 90, balanceAfter: 92 }));
  ingestFrame(state, synthSpin({ roundId: "r1", bet: 10, balanceBefore: 92, balanceAfter: 105 }));
  expect(state.spins.length).toBe(1);
  expect(state.spins[0]!.balanceAfter).toBe(105);
  expect(state.spins[0]!.win).toBe(15); // 105 - 100 + 10
});

test("balance continuity fallback: different roundIds but continuous balance + no drop → merge", () => {
  const state = createDedupState();
  // First frame: bet deducted
  ingestFrame(state, synthSpin({ roundId: "r1", bet: 10, balanceBefore: 100, balanceAfter: 90 }));
  // Second frame: NEW roundId (PP doCollect-style) but bb=prev.ba, balance rises
  ingestFrame(state, synthSpin({ roundId: "r2-cascade", bet: 10, balanceBefore: 90, balanceAfter: 95 }));
  expect(state.spins.length).toBe(1);
  expect(state.spins[0]!.balanceAfter).toBe(95);
  expect(state.spins[0]!.win).toBe(5); // derived: 95 - 100 + 10
});

test("balance continuity blocked when next frame shows DROP (new bet deduction)", () => {
  const state = createDedupState();
  ingestFrame(state, synthSpin({ roundId: "r1", bet: 10, balanceBefore: 100, balanceAfter: 90 }));
  // Continuous balance BUT another drop → new spin, NOT cascade
  ingestFrame(state, synthSpin({ roundId: "r2", bet: 10, balanceBefore: 90, balanceAfter: 80 }));
  expect(state.spins.length).toBe(2);
});

test("balance continuity blocked when bb discontinuous with prev.ba", () => {
  const state = createDedupState();
  ingestFrame(state, synthSpin({ roundId: "r1", bet: 10, balanceBefore: 100, balanceAfter: 90 }));
  // Discontinuous: bb != prev.ba (some other transaction happened, or this is a stale response)
  ingestFrame(state, synthSpin({ roundId: "r2", bet: 10, balanceBefore: 200, balanceAfter: 195 }));
  expect(state.spins.length).toBe(2);
});

test("vswaysmahwin2 reproduction: bet + 3 cascade frames, all different roundIds", () => {
  const state = createDedupState();
  // Initial spin: bet deducted
  ingestFrame(state, synthSpin({ roundId: "req-1-1", bet: 10, balanceBefore: 99999065, balanceAfter: 99999055, win: 2.5 }));
  // Cascade frame 1: same balance (no change), PP reports partial cumulative win
  ingestFrame(state, synthSpin({ roundId: "req-2-1", bet: 10, balanceBefore: 99999055, balanceAfter: 99999055, win: 54.5 }));
  // Cascade frame 2: same balance, more cumulative win
  ingestFrame(state, synthSpin({ roundId: "req-3-1", bet: 10, balanceBefore: 99999055, balanceAfter: 99999055, win: 69.5 }));
  // Final cascade frame: actual credit applied
  ingestFrame(state, synthSpin({ roundId: "req-4-1", bet: 10, balanceBefore: 99999055, balanceAfter: 99999124.5, win: 69.5 }));
  expect(state.spins.length).toBe(1);
  expect(state.spins[0]!.balanceBefore).toBe(99999065);
  expect(state.spins[0]!.balanceAfter).toBe(99999124.5);
  expect(state.spins[0]!.bet).toBe(10);
  expect(state.spins[0]!.win).toBe(69.5); // derived: 99999124.5 - 99999065 + 10
});

test("allowBalanceContinuity=false → only roundId merges, no balance heuristic", () => {
  const state = createDedupState();
  ingestFrame(state, synthSpin({ roundId: "r1", bet: 10, balanceBefore: 100, balanceAfter: 90 }), { allowBalanceContinuity: false });
  ingestFrame(state, synthSpin({ roundId: "r2-cascade", bet: 10, balanceBefore: 90, balanceAfter: 95 }), { allowBalanceContinuity: false });
  expect(state.spins.length).toBe(2);
});

test("deriveWinFromBalance=false → preserves latest frame's parser-reported win", () => {
  const state = createDedupState();
  ingestFrame(state, synthSpin({ roundId: "r1", bet: 10, balanceBefore: 100, balanceAfter: 90, win: 0 }), { deriveWinFromBalance: false });
  ingestFrame(state, synthSpin({ roundId: "r1", bet: 10, balanceBefore: 90, balanceAfter: 95, win: 7.5 }), { deriveWinFromBalance: false });
  expect(state.spins.length).toBe(1);
  expect(state.spins[0]!.win).toBe(7.5); // latest frame's win, NOT derived (which would be 5)
});

test("tolerance: 0.005 balance jitter still merges", () => {
  const state = createDedupState();
  ingestFrame(state, synthSpin({ roundId: "r1", bet: 10, balanceBefore: 100, balanceAfter: 90 }));
  ingestFrame(state, synthSpin({ roundId: "r2", bet: 10, balanceBefore: 90.005, balanceAfter: 95 }));
  expect(state.spins.length).toBe(1); // 0.005 < default 0.01 tolerance
});

test("tolerance: 0.1 balance jitter does NOT merge", () => {
  const state = createDedupState();
  ingestFrame(state, synthSpin({ roundId: "r1", bet: 10, balanceBefore: 100, balanceAfter: 90 }));
  ingestFrame(state, synthSpin({ roundId: "r2", bet: 10, balanceBefore: 90.1, balanceAfter: 95 }));
  expect(state.spins.length).toBe(2);
});

test("10 clean spins (no cascade) → 10 entries, no merging", () => {
  const state = createDedupState();
  let balance = 1000;
  for (let i = 0; i < 10; i++) {
    ingestFrame(state, synthSpin({ roundId: `r${i}`, bet: 10, balanceBefore: balance, balanceAfter: balance - 10 }));
    balance -= 10;
  }
  expect(state.spins.length).toBe(10);
});

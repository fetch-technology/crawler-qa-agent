// INVARIANT — Cascade dedup must NOT merge free-spin frames by balance continuity
//
// User-reported bug (2026-05-26): buy-feature case captured only 1 spin
// instead of full FS chain. Cause: FS frames have continuous balance (no
// deduction) — looks identical to cascade-within-spin pattern. Engine merged
// req-423/424/425/426/427 (separate FS frames) into req-422 (BUY transaction).
//
// Fix: skip balance-continuity merge when current spin is FREE_SPIN
// (isFreeSpin=true). Cascade-within-FS still merges correctly via roundId.

import { test, expect } from "@playwright/test";
import { createDedupState, ingestFrame } from "../../src/pipeline/step8-run-scenarios/cascade-dedup.ts";
import type { NormalizedSpinResult } from "../../src/pipeline/step6-build-model/normalized.ts";

function spin(opts: Partial<NormalizedSpinResult> & { roundId: string; bet: number; balanceBefore: number; balanceAfter: number }): NormalizedSpinResult {
  return {
    roundId: opts.roundId,
    bet: opts.bet,
    win: opts.win ?? 0,
    balanceBefore: opts.balanceBefore,
    balanceAfter: opts.balanceAfter,
    reels: [],
    cascadeFrames: [],
    state: opts.isFreeSpin ? "FREE_SPIN" : "NORMAL",
    freeSpinsRemaining: opts.freeSpinsRemaining ?? null,
    isFreeSpin: opts.isFreeSpin ?? false,
    hasBonus: false,
    raw: {},
  };
}

test("REGRESSION (user's buy-feature case): BUY + 5 FS frames → 6 entries, NOT 1", () => {
  const state = createDedupState();
  // Spin #1: BUY transaction (drop 44 = 88× base bet 0.5)
  ingestFrame(state, spin({ roundId: "req-422-2", bet: 0.5, balanceBefore: 99996598.29, balanceAfter: 99996554.29 }));
  expect(state.spins.length).toBe(1);

  // Spins #2-6: FS chain frames (no deduction, isFreeSpin=true)
  ingestFrame(state, spin({ roundId: "req-423-2", bet: 0, balanceBefore: 99996554.29, balanceAfter: 99996554.29, isFreeSpin: true }));
  ingestFrame(state, spin({ roundId: "req-424-2", bet: 0, balanceBefore: 99996554.29, balanceAfter: 99996554.29, isFreeSpin: true }));
  ingestFrame(state, spin({ roundId: "req-425-2", bet: 0, balanceBefore: 99996554.29, balanceAfter: 99996562.04, isFreeSpin: true, win: 7.75 }));
  ingestFrame(state, spin({ roundId: "req-426-2", bet: 0, balanceBefore: 99996562.04, balanceAfter: 99996562.04, isFreeSpin: true }));
  ingestFrame(state, spin({ roundId: "req-427-2", bet: 0, balanceBefore: 99996562.04, balanceAfter: 99996562.04, isFreeSpin: true }));

  // Should be 6 spins: BUY + 5 FS frames (each FS frame is a separate logical round)
  expect(state.spins.length).toBe(6);
  expect(state.spins[0]!.isFreeSpin).toBe(false);
  for (let i = 1; i <= 5; i++) {
    expect(state.spins[i]!.isFreeSpin).toBe(true);
  }
});

test("cascade-within-FS still merges via roundId (same roundId across frames)", () => {
  const state = createDedupState();
  // One FS spin with cascade: 3 frames sharing same roundId
  ingestFrame(state, spin({ roundId: "req-100-1", bet: 0, balanceBefore: 1000, balanceAfter: 1000, isFreeSpin: true }));
  ingestFrame(state, spin({ roundId: "req-100-1", bet: 0, balanceBefore: 1000, balanceAfter: 1005, isFreeSpin: true, win: 5 }));
  ingestFrame(state, spin({ roundId: "req-100-1", bet: 0, balanceBefore: 1005, balanceAfter: 1010, isFreeSpin: true, win: 10 }));

  // Should be 1 spin (cascade frames merged by roundId)
  expect(state.spins.length).toBe(1);
  expect(state.spins[0]!.balanceAfter).toBe(1010);  // last frame's ba wins
});

test("normal cascade still merges by balance continuity (non-FS case)", () => {
  const state = createDedupState();
  // PP cascade where frames have new roundIds but no deduction between them
  ingestFrame(state, spin({ roundId: "req-50-1", bet: 0.5, balanceBefore: 1000, balanceAfter: 999.5 }));
  ingestFrame(state, spin({ roundId: "req-50-2", bet: 0, balanceBefore: 999.5, balanceAfter: 1002.0, isFreeSpin: false, win: 2.5 }));

  // Should be 1 spin — cascade-within-NORMAL merges via balance continuity (current behavior)
  expect(state.spins.length).toBe(1);
});

test("BUY + cascade frames within BUY (same roundId) → 1 entry (normal merge)", () => {
  const state = createDedupState();
  ingestFrame(state, spin({ roundId: "req-422-2", bet: 0.5, balanceBefore: 1000, balanceAfter: 956 }));  // BUY (drop 44)
  ingestFrame(state, spin({ roundId: "req-422-2", bet: 0.5, balanceBefore: 956, balanceAfter: 960 }));   // cascade win
  expect(state.spins.length).toBe(1);
});

test("FS chain ENDING: transition back to NORMAL → new entry", () => {
  const state = createDedupState();
  ingestFrame(state, spin({ roundId: "req-100-1", bet: 0, balanceBefore: 1000, balanceAfter: 1050, isFreeSpin: true }));
  ingestFrame(state, spin({ roundId: "req-101-1", bet: 0.5, balanceBefore: 1050, balanceAfter: 1049.5, isFreeSpin: false }));  // back to normal — bet deducted

  expect(state.spins.length).toBe(2);
  expect(state.spins[0]!.isFreeSpin).toBe(true);
  expect(state.spins[1]!.isFreeSpin).toBe(false);
});

test("PATHOLOGICAL: FS frame with ZERO balance change still creates new entry (no balance-continuity merge)", () => {
  const state = createDedupState();
  ingestFrame(state, spin({ roundId: "req-1-1", bet: 0.5, balanceBefore: 1000, balanceAfter: 999.5 }));
  // Pre-fix: this would merge into spin 1 via balance-continuity. Post-fix: appended.
  ingestFrame(state, spin({ roundId: "req-2-1", bet: 0, balanceBefore: 999.5, balanceAfter: 999.5, isFreeSpin: true }));
  expect(state.spins.length).toBe(2);
});

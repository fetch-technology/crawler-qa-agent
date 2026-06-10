// INVARIANT — bet-from-balance reconciliation only corrects the exact failure
// mode (server-side ante surcharge absent from the request) and is a NO-OP for
// every other shape (correct rounds, bet-level games, buys, free spins).
import { test, expect } from "@playwright/test";
import { reconcileBetFromBalance } from "../../src/pipeline/step8-run-scenarios/bet-reconcile.js";

// Helper to build a minimal spin shape.
const spin = (o: Partial<Parameters<typeof reconcileBetFromBalance>[0]>) => ({
  bet: 0, win: 0, balanceBefore: null, balanceAfter: 0,
  serverTotalWin: 0, isFreeSpin: false, freeSpinsRemaining: 0, hasBonus: false,
  ...o,
}) as Parameters<typeof reconcileBetFromBalance>[0];

test("ante ON: parser misread bet=0.02, true wager 0.50 from drop → corrected", () => {
  // vs20olympgate Double Chance: c×l base 0.40, server adds ×1.25 → drop 0.50.
  // ppBetFromRequest returned bare coin 0.02 (c×bl, bl=1). win=0 (no win).
  const r = reconcileBetFromBalance(spin({
    bet: 0.02, win: 0, balanceBefore: 1999409.01, balanceAfter: 1999408.51, serverTotalWin: 0,
  }));
  expect(r).not.toBeNull();
  expect(r!.bet).toBeCloseTo(0.5, 2);
  expect(r!.win).toBe(0);
});

test("ante ON winning spin: bet recovered as drop + serverWin", () => {
  // base 0.40 × 1.25 = 0.50 bet, win 2.00 → balance net +1.50 (drop = -1.50).
  const r = reconcileBetFromBalance(spin({
    bet: 0.02, win: -1.48, balanceBefore: 1000, balanceAfter: 1001.5, serverTotalWin: 2.0,
  }));
  expect(r).not.toBeNull();
  expect(r!.bet).toBeCloseTo(0.5, 2); // (-1.5) + 2.0
  expect(r!.win).toBe(2.0);
});

test("NO-OP: request bet already conserved (normal ante-off spin)", () => {
  // bet 0.40, win 0, drop 0.40 → drop == bet − win → consistent, leave it.
  expect(reconcileBetFromBalance(spin({
    bet: 0.4, win: 0, balanceBefore: 1000, balanceAfter: 999.6, serverTotalWin: 0,
  }))).toBeNull();
});

test("NO-OP: tumble round captured BEFORE win credited (drop == bet, serverWin pending) — bet NOT inflated", () => {
  // vs20olympx Gates of Olympus: bet 1.00 (c0.05×l20), tumble win 5.60 NOT yet
  // credited at capture (PP credits on doCollect) → balance moved only by the
  // bet (drop = 1.00). Old behavior folded the pending win into bet (1.00→6.60)
  // and broke `betAmount == 1.00`. drop == request bet → leave bet alone.
  expect(reconcileBetFromBalance(spin({
    bet: 1.0, win: 0, balanceBefore: 1000003.41, balanceAfter: 1000002.41, serverTotalWin: 5.6,
  }))).toBeNull();
});

test("NO-OP: settled tumble round (bet 0.40, win 0.42, net +0.02) — conserved, untouched", () => {
  // Regression: a per-frame check fired on the tumble START frame (win pending,
  // not yet credited) and inflated bet by the pending win (0.40→0.50). Run on
  // the SETTLED merged round, conservation holds → no change.
  const r = reconcileBetFromBalance(spin({
    bet: 0.4, win: 0.42, balanceBefore: 1999398.39, balanceAfter: 1999398.41, serverTotalWin: 0.42,
  }));
  expect(r).toBeNull();
});

test("NO-OP: normal winning spin already conserved", () => {
  // bet 0.40, win 1.10, drop −0.70 → consistent.
  expect(reconcileBetFromBalance(spin({
    bet: 0.4, win: 1.1, balanceBefore: 1000, balanceAfter: 1000.7, serverTotalWin: 1.1,
  }))).toBeNull();
});

test("NO-OP: bet-level game (PP bl as genuine multiplier) — c×bl correct", () => {
  // bl=5 → bet 2.5, drop 2.5, win 0 → conserved → untouched (no regression on
  // games that legitimately encode stake via bl).
  expect(reconcileBetFromBalance(spin({
    bet: 2.5, win: 0, balanceBefore: 100, balanceAfter: 97.5, serverTotalWin: 0,
  }))).toBeNull();
});

test("NO-OP: feature buy (drop is 100× base, grants free spins)", () => {
  // Buy $40 of FS: drop 40, base bet 0.40, freeSpinsRemaining>0. Must NOT fold
  // the buy premium into bet (the buy-cost ratio assertion needs bet=base).
  expect(reconcileBetFromBalance(spin({
    bet: 0.4, win: 0, balanceBefore: 1000, balanceAfter: 960, serverTotalWin: 0, freeSpinsRemaining: 1,
  }))).toBeNull();
});

test("NO-OP: free spin frame", () => {
  expect(reconcileBetFromBalance(spin({
    bet: 0, win: 1.2, balanceBefore: 1000, balanceAfter: 1001.2, serverTotalWin: 1.2, isFreeSpin: true,
  }))).toBeNull();
});

test("NO-OP: hasBonus spin (bonus buy/trigger)", () => {
  expect(reconcileBetFromBalance(spin({
    bet: 0.4, win: 0, balanceBefore: 1000, balanceAfter: 980, serverTotalWin: 0, hasBonus: true,
  }))).toBeNull();
});

test("NO-OP: balanceBefore unknown → cannot reconcile", () => {
  expect(reconcileBetFromBalance(spin({
    bet: 0.02, win: 0, balanceBefore: null, balanceAfter: 999.5, serverTotalWin: 0,
  }))).toBeNull();
});

test("NO-OP: serverTotalWin missing → cannot split drop", () => {
  expect(reconcileBetFromBalance(spin({
    bet: 0.02, win: 0, balanceBefore: 1000, balanceAfter: 999.5, serverTotalWin: undefined as unknown as number,
  }))).toBeNull();
});

test("NO-OP: would imply non-positive bet (credit-only frame)", () => {
  // drop negative and serverWin 0 → impliedBet ≤ 0 → don't invent a bet.
  expect(reconcileBetFromBalance(spin({
    bet: 0.02, win: 0, balanceBefore: 1000, balanceAfter: 1000.5, serverTotalWin: 0,
  }))).toBeNull();
});

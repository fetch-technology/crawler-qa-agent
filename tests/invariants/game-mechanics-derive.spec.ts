// INVARIANT — bet-multiplier derivation must NOT be poisoned by tumble desync.
//
// deriveGameMechanics infers the per-spin stake multiplier from a balance
// delta. On tumble/cascade games a mid-tumble WINNING frame reports `tw`
// (running win) before it's credited to balance, so deducted = stake +
// uncredited-win → a garbage multiplier (vs20fruitsw saw 41 for l=20,
// vswaysrsm saw 47). That then mis-stamps bet on every spin, breaking
// money-conservation / OCR-bet / per-round-balance signals.
//
// Defence in depth:
//   (A) caller derives only from LOSING spins (win==0) — clean stake, tested
//       at the integration layer; here we assert the unit-level guarantees:
//   (B) deriveGameMechanics REJECTS a multiplier matching no request structure.
//   (C) ppBetFromRequest ignores an implausible stored multiplier for "unknown"
//       mechanic and falls back to c×l (self-heals poisoned game-mechanics.json).

import { test, expect } from "@playwright/test";
import { deriveGameMechanics } from "../../src/pipeline/registry/game-mechanics.ts";
import { ppBetFromRequest } from "../../src/pipeline/step6-build-model/providers/pragmatic-parser.ts";

// Losing spin: balanceAfter = balanceBefore - stake, win = 0 → deducted = stake.
function losing(c: number, l: number, stake: number, bl = 0) {
  return deriveGameMechanics({
    parsedRequest: { c, l, bl },
    balanceBefore: 1000,
    balanceAfter: 1000 - stake,
    win: 0,
  });
}

test("(B) lines game: multiplier ≈ l → lines, betMultiplier snapped to l", () => {
  const m = losing(0.01, 20, 0.20); // 0.20/0.01 = 20 = l
  expect(m?.mechanic).toBe("lines");
  expect(m?.betMultiplier).toBe(20);
});

test("(B) ways game: l ≫ M, M integer → ways, betMultiplier = M", () => {
  const m = losing(0.02, 1024, 0.40); // 0.40/0.02 = 20, l=1024
  expect(m?.mechanic).toBe("ways");
  expect(m?.betMultiplier).toBe(20);
});

test("(B) ante ON during sample: multiplier = l×factor → stored as BASE lines/l", () => {
  const m = losing(0.01, 20, 0.25); // 0.25/0.01 = 25 = 20×1.25 (ante)
  expect(m?.mechanic).toBe("lines");
  expect(m?.betMultiplier).toBe(20); // base, not 25
});

test("(B) REJECT mid-tumble desync: deducted = stake + uncredited win → null", () => {
  // vs20fruitsw shape: stake 0.20 deducted, but tw=0.21 counted early.
  const m = deriveGameMechanics({
    parsedRequest: { c: 0.01, l: 20, bl: 0 },
    balanceBefore: 1000,
    balanceAfter: 999.8,   // only stake (0.20) left balance
    win: 0.21,             // running win not yet credited → deducted = 0.41
  });
  expect(m).toBeNull(); // multiplier 41 fits nothing → rejected, NOT persisted
});

test("(B) REJECT vswaysrsm shape (multiplier 47, l 20) → null", () => {
  const m = deriveGameMechanics({
    parsedRequest: { c: 0.02, l: 20, bl: 0 },
    balanceBefore: 1000,
    balanceAfter: 999.6,   // stake 0.40
    win: 0.54,             // → deducted 0.94 → multiplier 47
  });
  expect(m).toBeNull();
});

test("(C) ppBetFromRequest: lines mechanic → c × l (ignores any stored M)", () => {
  expect(ppBetFromRequest({ c: 0.01, l: 20, bl: 0 }, { mechanic: "lines", betMultiplier: 41 })).toBeCloseTo(0.20, 6);
});

test("(C) ppBetFromRequest: ways mechanic → trusts M (l is the ways-count)", () => {
  expect(ppBetFromRequest({ c: 0.02, l: 1024, bl: 0 }, { mechanic: "ways", betMultiplier: 20 })).toBeCloseTo(0.40, 6);
});

test("(C) ppBetFromRequest SELF-HEAL: unknown + poisoned M (41, l=20) → falls back to c×l", () => {
  // Already-stored bad game-mechanics.json: mechanic unknown, betMultiplier 41.
  // 41 is neither <= l(20) nor ≈ bl → implausible → ignore, use c×l = 0.20.
  expect(ppBetFromRequest({ c: 0.01, l: 20, bl: 0 }, { mechanic: "unknown", betMultiplier: 41 })).toBeCloseTo(0.20, 6);
});

test("(C) ppBetFromRequest: unknown + plausible ways-like M (≤ l) → trusts M", () => {
  expect(ppBetFromRequest({ c: 0.02, l: 1024, bl: 0 }, { mechanic: "unknown", betMultiplier: 20 })).toBeCloseTo(0.40, 6);
});

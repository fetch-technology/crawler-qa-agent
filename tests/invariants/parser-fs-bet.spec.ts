// INVARIANT — Parser sets bet=0 for free-spin frames (2026-05-26)
//
// User-reported bug: FS frames carry the same `c=0.025` in request (game UI
// fires identical doSpin during auto-played chain), so `ppBetFromRequest`
// returned the base bet 0.5 even though server didn't actually deduct from
// balance. Stamping bet=0.5 on FS frames broke:
//   - FinancialRule expected = bb + win (off by 0.5 each frame)
//   - dedup deriveWin formula (added phantom 0.5)
//   - Signal Roll-up Rule check (balance arithmetic mismatch)
// Fix: parser sets bet=0 when isFreeSpin=true. Tested with PragmaticParser.

import { test, expect } from "@playwright/test";
import { PragmaticParser } from "../../src/pipeline/step6-build-model/providers/pragmatic-parser.ts";

// Helper — build a PP response querystring. Generic parser reads:
//   balance      → balanceAfter
//   balancebefore → balanceBefore (note: lowercase, no underscore)
//   tw           → win
//   isfreespin   → isFreeSpin (legacy)
//   fs           → freeSpinsRemaining + isFreeSpin (PP override 2026-05-26)
function ppRespBody(opts: { bb?: number; ba: number; tw?: number; fs?: number; sw?: number; sh?: number }): string {
  const parts: string[] = [];
  if (opts.bb !== undefined) parts.push(`balancebefore=${opts.bb}`);
  parts.push(`balance=${opts.ba}`);
  if (opts.tw !== undefined) parts.push(`tw=${opts.tw}`);
  if (opts.fs !== undefined) parts.push(`fs=${opts.fs}`);
  parts.push(`sw=${opts.sw ?? 5}`, `sh=${opts.sh ?? 3}`);
  parts.push("na=s", "index=3", "counter=5");
  return parts.join("&");
}

test("PragmaticParser: NORMAL spin (fs=0) → bet = c × M", () => {
  const parser = new PragmaticParser();
  parser.setBetMultiplier(20);
  const reqBody = "action=doSpin&c=0.025&l=1024&bl=0&index=3&counter=5";
  const respBody = ppRespBody({ bb: 100, ba: 99.5, tw: 0, fs: 0 });
  const spin = parser.parseSpinPair(reqBody, respBody);
  expect(spin.isFreeSpin).toBe(false);
  expect(spin.bet).toBe(0.5);  // c × M = 0.025 × 20
});

test("PragmaticParser: FREE_SPIN frame (fs > 0) → isFreeSpin=true + bet=0", () => {
  const parser = new PragmaticParser();
  parser.setBetMultiplier(20);
  const reqBody = "action=doSpin&c=0.025&l=1024&bl=0&index=4&counter=2";
  const respBody = ppRespBody({ bb: 99.5, ba: 106, tw: 6.5, fs: 8 });
  const spin = parser.parseSpinPair(reqBody, respBody);
  expect(spin.isFreeSpin).toBe(true);   // detected via fs > 0
  expect(spin.bet).toBe(0);             // ← FS no deduction
  expect(spin.freeSpinsRemaining).toBe(8);
});

test("PragmaticParser: losing FS frame (fs > 0, tw = 0) still bet=0", () => {
  const parser = new PragmaticParser();
  parser.setBetMultiplier(20);
  const reqBody = "action=doSpin&c=0.025&l=1024&bl=0&index=5&counter=2";
  const respBody = ppRespBody({ bb: 100, ba: 100, tw: 0, fs: 3 });
  const spin = parser.parseSpinPair(reqBody, respBody);
  expect(spin.isFreeSpin).toBe(true);
  expect(spin.bet).toBe(0);
});

test("PragmaticParser: balance arithmetic works for FS spin after fix", () => {
  const parser = new PragmaticParser();
  parser.setBetMultiplier(20);
  const reqBody = "action=doSpin&c=0.025&l=1024&bl=0&index=10&counter=2";
  // FS win: bb=500, ba=505 (no deduction, +5 win)
  const respBody = ppRespBody({ bb: 500, ba: 505, tw: 5, fs: 2 });
  const spin = parser.parseSpinPair(reqBody, respBody);
  expect(spin.isFreeSpin).toBe(true);
  expect(spin.bet).toBe(0);
  expect(spin.win).toBe(5);

  // FinancialRule formula for FS: expected = bb + win (or generally bb - bet + win)
  // With bet=0: expected = bb - 0 + win = bb + win = 500 + 5 = 505 = actual ba ✓
  const expected = (spin.balanceBefore ?? 0) - spin.bet + spin.win;
  expect(expected).toBe(spin.balanceAfter);  // 505 == 505
});

test("PragmaticParser: REGRESSION before-fix, FS+bet=0.5 → arithmetic OFF by 0.5", () => {
  const parser = new PragmaticParser();
  parser.setBetMultiplier(20);
  const reqBody = "action=doSpin&c=0.025&l=1024&bl=0&index=10&counter=2";
  const respBody = ppRespBody({ bb: 500, ba: 505, tw: 5, fs: 2 });
  const spin = parser.parseSpinPair(reqBody, respBody);

  // Pre-fix calculation: bet would have been 0.5 (c × M)
  const oldFormulaBet = 0.025 * 20;   // = 0.5
  const oldExpected = (spin.balanceBefore ?? 0) - oldFormulaBet + spin.win;
  // oldExpected = 500 - 0.5 + 5 = 504.5
  expect(oldExpected).toBe(504.5);
  expect(spin.balanceAfter).toBe(505);
  // Diff would be 0.5 — the user-reported "balance arithmetic off by bet" bug
  expect(Math.abs(oldExpected - spin.balanceAfter)).toBeCloseTo(0.5, 2);

  // POST-fix: bet=0 → no phantom
  expect(spin.bet).toBe(0);
});

test("PragmaticParser: BUY transaction (fs=0, balance drop) → bet from request (not FS)", () => {
  const parser = new PragmaticParser();
  parser.setBetMultiplier(20);
  const reqBody = "action=doSpin&c=0.025&l=1024&bl=0&pur=0&index=3&counter=5";
  // BUY: massive balance drop, fs=0 (chain starts NEXT spin)
  const respBody = ppRespBody({ bb: 99996579.24, ba: 99996535.24, tw: 0, fs: 0 });
  const spin = parser.parseSpinPair(reqBody, respBody);
  expect(spin.isFreeSpin).toBe(false);
  expect(spin.bet).toBe(0.5);
  // BUY cost detected via balance delta (44) vs base bet (0.5) → ratio 88×
  // → engine post-action settle extends + detectBuyFeatureDeduction passes.
});

test("user case math: vswaysmahwin2 FS chain dedup post-fix", () => {
  // After parser-fix, dedup deriveWin = ba - bb + bet for the MERGED entry.
  // For an FS chain merged into one spin: bet=0 (parser fix) → win = ba - bb.
  const bb = 99996535.24;
  const ba = 99996584.74;
  const bet = 0;  // post-fix for FS
  const derivedWin = ba - bb + bet;
  expect(derivedWin).toBeCloseTo(49.50, 2);

  // Pre-fix value would have been:
  const derivedWinOld = ba - bb + 0.5;
  expect(derivedWinOld).toBe(50.00);
  expect(Math.abs(derivedWinOld - derivedWin)).toBeCloseTo(0.5, 2);
});

test("PragmaticParser: fs=0 explicitly (after FS chain) → isFreeSpin=false + bet from request", () => {
  // First spin AFTER FS chain ends: server emits fs=0 → back to NORMAL.
  const parser = new PragmaticParser();
  parser.setBetMultiplier(20);
  const reqBody = "action=doSpin&c=0.025&l=1024&bl=0&index=25&counter=2";
  const respBody = ppRespBody({ bb: 99996584.74, ba: 99996584.24, tw: 0, fs: 0 });
  const spin = parser.parseSpinPair(reqBody, respBody);
  expect(spin.isFreeSpin).toBe(false);
  expect(spin.bet).toBe(0.5);  // back to normal deduction
});

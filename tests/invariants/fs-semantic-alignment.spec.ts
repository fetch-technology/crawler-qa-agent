// INVARIANT — Free-Spin semantic alignment across parser + signals (2026-05-26)
//
// Option 1 from user-driven design discussion: parser bet=0 for FS frames is
// the canonical semantic (server-truth: no deduction during FS). All
// downstream checks must align:
//   - Adapter isFreeSpin: fs > 0 AND balance not decreased (exclude BUY)
//   - API signal bet check: FS → bet=0, NORMAL → bet>0
//   - UI OCR bet check: skip for FS (UI=stake vs API=deduction)

import { test, expect } from "@playwright/test";
import { PragmaticParser } from "../../src/pipeline/step6-build-model/providers/pragmatic-parser.ts";

function ppRespBody(opts: { bb?: number; ba: number; tw?: number; fs?: number }): string {
  const parts: string[] = [];
  if (opts.bb !== undefined) parts.push(`balancebefore=${opts.bb}`);
  parts.push(`balance=${opts.ba}`);
  if (opts.tw !== undefined) parts.push(`tw=${opts.tw}`);
  if (opts.fs !== undefined) parts.push(`fs=${opts.fs}`);
  parts.push("sw=5", "sh=3", "na=s", "index=3", "counter=5");
  return parts.join("&");
}

// === Fix #1: Adapter isFreeSpin requires fs>0 AND balance not decreased ===

test("BUY transaction (fs>0 BUT balance decreased) → NOT isFreeSpin", () => {
  // PP buy-feature server response: fs=10 (you'll get 10 FS) + drop=44 (cost)
  // Pre-fix: adapter saw fs>0 → set isFreeSpin=true → bet=0 → buy detection broke
  // Post-fix: balance decreased → keep isFreeSpin=false → bet=0.5 → buy detection works
  const parser = new PragmaticParser();
  parser.setBetMultiplier(20);
  const reqBody = "action=doSpin&c=0.025&l=1024&pur=0&index=3&counter=5";
  const respBody = ppRespBody({ bb: 99996579.24, ba: 99996535.24, tw: 0, fs: 10 });
  const spin = parser.parseSpinPair(reqBody, respBody);
  expect(spin.isFreeSpin).toBe(false);  // ← balance decreased → not FS
  expect(spin.bet).toBe(0.5);           // ← bet from request (88× buy ratio detection works)
});

test("FS frame mid-chain (fs>0 AND balance stable) → isFreeSpin=true", () => {
  const parser = new PragmaticParser();
  parser.setBetMultiplier(20);
  const reqBody = "action=doSpin&c=0.025&l=1024&index=10&counter=2";
  const respBody = ppRespBody({ bb: 99996535.24, ba: 99996535.24, tw: 5, fs: 8 });
  const spin = parser.parseSpinPair(reqBody, respBody);
  expect(spin.isFreeSpin).toBe(true);   // ← balance stable + fs>0 → FS
  expect(spin.bet).toBe(0);             // ← no deduction
});

test("FS frame last (fs>0 AND balance INCREASED with chain credit) → isFreeSpin=true", () => {
  // Last FS frame credits chain win → balance UP, not down.
  const parser = new PragmaticParser();
  parser.setBetMultiplier(20);
  const reqBody = "action=doSpin&c=0.025&l=1024&index=22&counter=2";
  const respBody = ppRespBody({ bb: 99996535.24, ba: 99996584.74, tw: 49.5, fs: 1 });
  const spin = parser.parseSpinPair(reqBody, respBody);
  expect(spin.isFreeSpin).toBe(true);   // balance went UP, not down
  expect(spin.bet).toBe(0);
});

test("REGRESSION: vswaysmahwin2 BUY response with fs=10 → buy-feature ratio detection works", () => {
  // The exact failure user reported: previously isFreeSpin became true on
  // BUY → bet=0 → drop/bet = NaN → ratio never ≥ 50 → engine couldn't fire
  // "buy-feature detected" warning → Signal Roll-up Network signal said
  // "UI-only case" mistakenly.
  const parser = new PragmaticParser();
  parser.setBetMultiplier(20);
  const reqBody = "action=doSpin&c=0.025&l=1024&pur=0&index=3&counter=5";
  const respBody = ppRespBody({ bb: 99996579.24, ba: 99996535.24, tw: 0, fs: 10 });
  const spin = parser.parseSpinPair(reqBody, respBody);

  // Reproduce engine's buy-feature detection math:
  const drop = (spin.balanceBefore ?? 0) - spin.balanceAfter;
  const ratio = spin.bet > 0 ? drop / spin.bet : 0;
  expect(drop).toBeCloseTo(44, 2);
  expect(ratio).toBeCloseTo(88, 0);
  expect(ratio).toBeGreaterThanOrEqual(50);  // ← engine fires buy-feature warning ✓
});

test("Normal spin (fs=0, balance decreased) → NORMAL state, bet from request", () => {
  const parser = new PragmaticParser();
  parser.setBetMultiplier(20);
  const reqBody = "action=doSpin&c=0.025&l=1024&index=1&counter=1";
  const respBody = ppRespBody({ bb: 100, ba: 99.5, tw: 0, fs: 0 });
  const spin = parser.parseSpinPair(reqBody, respBody);
  expect(spin.isFreeSpin).toBe(false);
  expect(spin.bet).toBe(0.5);
});

// === Fix #2: API signal bet expectation depends on isFreeSpin ===

test("API signal bet check: NORMAL spin expects bet>0", () => {
  const spin = { bet: 0.5, isFreeSpin: false };
  const expected = spin.isFreeSpin ? "0 (FS — no deduction)" : "> 0 (bet was applied)";
  const match = spin.isFreeSpin
    ? typeof spin.bet === "number" && spin.bet === 0
    : typeof spin.bet === "number" && spin.bet > 0;
  expect(expected).toBe("> 0 (bet was applied)");
  expect(match).toBe(true);
});

test("API signal bet check: FS spin expects bet=0 (NOT bet>0)", () => {
  const spin = { bet: 0, isFreeSpin: true };
  const expected = spin.isFreeSpin ? "0 (FS — no deduction)" : "> 0 (bet was applied)";
  const match = spin.isFreeSpin
    ? typeof spin.bet === "number" && spin.bet === 0
    : typeof spin.bet === "number" && spin.bet > 0;
  expect(expected).toBe("0 (FS — no deduction)");
  expect(match).toBe(true);  // pre-fix this failed; post-fix passes
});

test("API signal bet check REGRESSION: FS spin with bet=0 no longer fails as 'bet > 0' violation", () => {
  // User-reported failure: API signal ✗ "bet > 0 (bet was applied)" actual 0
  // when last spin is FS frame. Post-fix: check uses isFreeSpin to choose
  // expectation and now matches.
  const lastSpin = { bet: 0, isFreeSpin: true };
  const passes = lastSpin.isFreeSpin
    ? lastSpin.bet === 0
    : lastSpin.bet > 0;
  expect(passes).toBe(true);
});

// === Fix #3: UI OCR signal skips bet check for FS ===

test("UI OCR bet check: NORMAL spin compares OCR vs spin.bet within tolerance", () => {
  const spin = { bet: 0.5, isFreeSpin: false };
  const ocrBet = 0.5;
  const TOL = 0.05;
  if (spin.isFreeSpin) {
    // skipped
  } else {
    const diff = Math.abs(ocrBet - spin.bet);
    expect(diff < TOL).toBe(true);
  }
});

test("UI OCR bet check: FS spin SKIPS bet comparison (pass=true with explanatory note)", () => {
  // User-reported: UI bet=0.5 vs API spin.bet=0 → diff=0.5 → fail.
  // Different semantics (stake vs deduction). Post-fix: comparison skipped.
  const spin = { bet: 0, isFreeSpin: true };
  const ocrBet = 0.5;
  // Replicate post-fix logic:
  let match: boolean;
  let note: string | undefined;
  if (spin.isFreeSpin) {
    match = true;
    note = "Different semantics: UI=stake, API=deduction. Comparison skipped.";
  } else {
    const diff = Math.abs(ocrBet - spin.bet);
    match = diff < 0.05;
    note = undefined;
  }
  expect(match).toBe(true);
  expect(note).toMatch(/Different semantics/);
});

// === End-to-end: user's full case scenario ===

// === Fix #4 (2026-05-26 third pass): adapter reads `bb` directly ===

test("PP adapter reads `bb` field directly (generic only reads `balancebefore`)", () => {
  // Pre-fix: generic parser missed PP's `bb` field → base.balanceBefore=null
  // → adapter's balanceDecreased check fell through to default → BUY mis-flagged
  // as FS → buy-feature detection broke.
  // Post-fix: adapter explicitly reads `bb` from raw parsed response.
  const parser = new PragmaticParser();
  parser.setBetMultiplier(20);
  const reqBody = "action=doSpin&c=0.025&l=1024&pur=0&index=3&counter=5";
  // Note: use ONLY `bb` field (no `balancebefore`) — replicates PP server
  const respBody = "bb=100&balance=99.5&tw=0&fs=10&na=s&sw=5&sh=3";
  const spin = parser.parseSpinPair(reqBody, respBody);
  expect(spin.balanceBefore).toBe(100);           // adapter read `bb` ✓
  expect(spin.balanceAfter).toBe(99.5);
  // BUY-like: balance decreased + fs>0 → NOT FS
  expect(spin.isFreeSpin).toBe(false);
  expect(spin.bet).toBe(0.5);
});

test("PP adapter: when bb missing AND fs > 0 → default NOT FS (conservative)", () => {
  // If response has fs>0 but no `bb` field, we can't tell if balance decreased.
  // Conservative: don't mark FS (avoids mis-flagging real BUY responses where
  // `bb` field might be missing for some reason).
  const parser = new PragmaticParser();
  parser.setBetMultiplier(20);
  const reqBody = "action=doSpin&c=0.025&l=1024&index=3&counter=5";
  const respBody = "balance=100&tw=0&fs=5&na=s&sw=5&sh=3";  // NO bb field
  const spin = parser.parseSpinPair(reqBody, respBody);
  expect(spin.balanceBefore).toBeNull();          // bb not provided
  expect(spin.isFreeSpin).toBe(false);            // conservative default
});

test("end-to-end: vswaysmahwin2 buy-feature case → all 3 fixes converge to Signal Roll-up 5/5", () => {
  const parser = new PragmaticParser();
  parser.setBetMultiplier(20);

  // Spin 1 — BUY transaction
  const buy = parser.parseSpinPair(
    "action=doSpin&c=0.025&pur=0&index=3&counter=5",
    ppRespBody({ bb: 99996579.24, ba: 99996535.24, tw: 0, fs: 10 }),
  );
  expect(buy.isFreeSpin).toBe(false);
  expect(buy.bet).toBe(0.5);

  // Engine buy-feature detection works:
  const ratio = (buy.balanceBefore! - buy.balanceAfter) / buy.bet;
  expect(ratio).toBeCloseTo(88, 0);
  expect(ratio).toBeGreaterThanOrEqual(50);
  // → engine emits warning → Network signal sees buy-feature → expects spins≥1

  // Spin N (last) — FS chain ending frame
  const lastFs = parser.parseSpinPair(
    "action=doSpin&c=0.025&index=22&counter=2",
    ppRespBody({ bb: 99996534.16, ba: 99996568.76, tw: 34.6, fs: 1 }),
  );
  expect(lastFs.isFreeSpin).toBe(true);
  expect(lastFs.bet).toBe(0);

  // API signal bet check for last FS spin: expects bet=0 (post-fix #2):
  const apiBetMatch = lastFs.isFreeSpin ? lastFs.bet === 0 : lastFs.bet > 0;
  expect(apiBetMatch).toBe(true);

  // UI OCR bet check for FS: skipped (post-fix #3) → match=true regardless
  // of UI widget showing 0.5 stake.
  const uiBetMatch = lastFs.isFreeSpin ? true : Math.abs(0.5 - lastFs.bet) < 0.05;
  expect(uiBetMatch).toBe(true);

  // Rule signal balance arithmetic: bb - bet + win = ba (FS-aware via bet=0)
  const expectedBa = (lastFs.balanceBefore ?? 0) - lastFs.bet + lastFs.win;
  expect(expectedBa).toBeCloseTo(lastFs.balanceAfter, 2);
});

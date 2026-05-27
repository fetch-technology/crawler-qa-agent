// INVARIANT — Catalog assertion identifier validation (2026-05-27)
//
// The validator's check_code identifier scan was producing ~192 FALSE
// "unrecognized top-level identifier" warnings because it:
//   1. didn't know the Phase-11 runtime vars (warnings/stateTimeline/interrupts/
//      previousSpin/networkBalance) bound in case-executor evaluateAssertions
//   2. didn't strip REGEX literals → words inside /debounced|popup/i leaked
//   3. didn't track IIFE-local declarations (const/let/var/for/catch) or skip
//      JS keywords
// These must NOT warn (they're valid at runtime). Genuine unknown identifiers
// (typos / hallucinated vars) MUST still warn.

import { test, expect } from "@playwright/test";
import { validateCheckCodeIdentifiers } from "../../src/ai/catalog-validator.ts";

function warns(code: string): string[] {
  return validateCheckCodeIdentifiers(code).warnings;
}

// === Phase-11 runtime vars recognized ===

test("runtime var `warnings` recognized", () => {
  expect(warns("warnings.filter(w => w.length > 0).length === 0")).toEqual([]);
});

test("runtime vars stateTimeline / interrupts / previousSpin / networkBalance recognized", () => {
  expect(warns("stateTimeline.every(t => t.to === 'MAIN')")).toEqual([]);
  expect(warns("interrupts.count === 0")).toEqual([]);
  expect(warns("previousSpin == null || previousSpin.endingBalance >= 0")).toEqual([]);
  expect(warns("networkBalance === null || networkBalance >= 0")).toEqual([]);
});

// === Regex literals stripped (words inside don't count as identifiers) ===

test("regex literal words (debounced/popup/error/fail) do NOT warn", () => {
  expect(warns("warnings.filter(w => /error|fail|threw|timeout/i.test(w)).length === 0")).toEqual([]);
  expect(warns("warnings.filter(w => /debounced|likely debounced|popup may have blocked/i.test(w)).length === 0")).toEqual([]);
});

test("regex with char class + flags stripped cleanly", () => {
  expect(warns("collector.spins.every(s => /^[A-Z0-9_]+$/.test(s.id))")).toEqual([]);
});

test("state-name words inside regex (FREE_SPIN/BONUS/MAIN) do NOT warn", () => {
  expect(warns("stateTimeline.some(t => /FREE_SPIN|BONUS/.test(t.to))")).toEqual([]);
});

// === IIFE locals + JS keywords tracked/skipped ===

test("IIFE with const locals (ids/ends) does NOT warn", () => {
  const code = "(() => { const ids = collector.spins.map(s => s.id); const ends = ids.length; return ends > 0 })()";
  expect(warns(code)).toEqual([]);
});

test("buy-feature IIFE (const d = detectBuyFeatureDeduction...) does NOT warn", () => {
  const code = "(() => { const d = detectBuyFeatureDeduction(collector.spins, 0, balanceBefore); return d != null && d.ratio >= 50 })()";
  expect(warns(code)).toEqual([]);
});

test("cumulative-balance IIFE (first/last/sb/sw) does NOT warn", () => {
  const code = "(() => { const first = collector.spins[0]; const last = collector.spins[collector.spins.length-1]; const sb = collector.spins.reduce((a,s)=>a+s.betAmount,0); const sw = collector.spins.reduce((a,s)=>a+s.winAmount,0); if (!first || !last) return true; return Math.abs(last.endingBalance - (first.startingBalance - sb + sw)) <= 0.01 })()";
  expect(warns(code)).toEqual([]);
});

test("for-loop IIFE (let i / const fs) does NOT warn", () => {
  const code = "(() => { for (let i = 0; i < collector.spins.length; i++) { const fs = collector.spins[i].freeSpinsRemaining; if (typeof fs === 'number' && fs < 0) return false } return true })()";
  expect(warns(code)).toEqual([]);
});

test("destructuring locals do NOT warn", () => {
  expect(warns("(() => { const { spins } = collector; return spins.length >= 0 })()")).toEqual([]);
});

// === Genuine unknowns STILL warn (regression guard) ===

test("typo of a known var (colector) STILL warns", () => {
  const w = warns("colector.spins.length > 0");
  expect(w.some((x) => x.includes("colector"))).toBe(true);
});

test("hallucinated bare identifier STILL warns", () => {
  const w = warns("magicHelper(spin) === true");
  expect(w.some((x) => x.includes("magicHelper"))).toBe(true);
});

test("a local declared inside IIFE does not whitelist a DIFFERENT typo", () => {
  // `ids` is declared + used (in checked positions); `idz` is a typo in a
  // checked position (after `&&`) → warn for idz only, not ids.
  const code = "(() => { const ids = collector.spins.map(s => s.id); return new Set(ids).size === ids.length && idz.length > 0 })()";
  const w = warns(code);
  expect(w.some((x) => x.includes("idz"))).toBe(true);
  expect(w.some((x) => x.includes("ids"))).toBe(false);
});

// === End-to-end: representative assertions from the 192-warning log ===

test("REGRESSION: log assertions that falsely warned now produce ZERO warnings", () => {
  const samples = [
    "warnings.filter(w => /error|fail|threw/i.test(w)).length === 0",
    "(() => { const ids = collector.spins.map(s => s.id); return new Set(ids).size === ids.length })()",
    "stateTimeline.every(t => t.to === 'MAIN' || t.to === 'FREE_SPIN')",
    "interrupts.count >= 0",
    "(() => { const d = detectBuyFeatureDeduction(collector.spins, 0, balanceBefore); return d != null && d.ratio >= 50 })()",
    "warnings.filter(w => /likely debounced|popup may have blocked|no spin.*response within/i.test(w)).length === 0",
  ];
  for (const s of samples) {
    expect(warns(s)).toEqual([]);
  }
});

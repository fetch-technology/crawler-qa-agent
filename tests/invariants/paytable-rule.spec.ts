// INVARIANT — PaytableContentRule diff + Rule class
//
// Pure diff is OCR-output → expected JSON comparison. Tested without
// Tesseract: feed pre-canned OCR text. Rule class is tested by stamping
// a pre-computed verification result into spin.raw.

import { test, expect } from "@playwright/test";
import {
  PaytableContentRule,
  diffPaytableAgainstOcr,
  type PaytableVerificationResult,
} from "../../src/pipeline/step9-verify/paytable-rule.ts";
import type { NormalizedSpinResult } from "../../src/pipeline/step6-build-model/normalized.ts";
import type { Paytable } from "../../src/pipeline/registry/types.ts";

const expected: Paytable = {
  symbols: [
    { symbol: "H1", name: "Crown", payouts: [{ count: 3, multiplier: 1.5 }, { count: 4, multiplier: 5 }, { count: 5, multiplier: 25 }] },
    { symbol: "H2", name: "Gem", payouts: [{ count: 3, multiplier: 1 }, { count: 4, multiplier: 3 }, { count: 5, multiplier: 15 }] },
    { symbol: "L1", name: "Nine", payouts: [{ count: 3, multiplier: 0.3 }, { count: 4, multiplier: 0.5 }, { count: 5, multiplier: 2 }] },
  ],
};

function spinWithVerification(v: PaytableVerificationResult | undefined): NormalizedSpinResult {
  return {
    roundId: "r1",
    bet: 0.5,
    win: 0,
    balanceBefore: 100,
    balanceAfter: 99.5,
    reels: [],
    cascadeFrames: [],
    state: "NORMAL",
    freeSpinsRemaining: null,
    isFreeSpin: false,
    hasBonus: false,
    raw: v ? { _paytableVerification: v } : {},
  };
}

const ctx = { previousBalance: null, previousState: null, roundIndex: 0 };

test("diff: OCR contains all expected symbols with correct multipliers → no mismatches", () => {
  const ocrText = `
    Crown  1.5  5  25
    Gem    1    3  15
    Nine   0.3  0.5  2
  `;
  const m = diffPaytableAgainstOcr(expected, ocrText);
  expect(m).toEqual([]);
});

test("diff: missing symbol → mismatch.reason='missing'", () => {
  const ocrText = `Crown 1.5 5 25\nGem 1 3 15`; // Nine absent
  const m = diffPaytableAgainstOcr(expected, ocrText);
  expect(m.length).toBe(1);
  expect(m[0]!.symbol).toBe("L1");
  expect(m[0]!.reason).toBe("missing");
});

test("diff: wrong multiplier → mismatch.reason='payout_mismatch'", () => {
  const ocrText = `Crown 1.5 5 30\nGem 1 3 15\nNine 0.3 0.5 2`; // Crown 5-of-kind shows 30 not 25
  const m = diffPaytableAgainstOcr(expected, ocrText);
  expect(m.length).toBe(1);
  expect(m[0]!.symbol).toBe("H1");
  expect(m[0]!.reason).toBe("payout_mismatch");
});

test("diff: numbers anywhere on line still match (OCR layout variations)", () => {
  const ocrText = `x5 Crown 25\nx5 Gem 15\nx5 Nine 2\nx4 Crown 5\nx4 Gem 3\nx4 Nine 0.5\nx3 Crown 1.5\nx3 Gem 1\nx3 Nine 0.3`;
  const m = diffPaytableAgainstOcr(expected, ocrText);
  // Each row only contains ONE expected multiplier — first match for that
  // symbol misses the other expected multipliers. Diff catches this.
  expect(m.length).toBeGreaterThan(0);
});

test("diff: empty OCR → all symbols missing", () => {
  const m = diffPaytableAgainstOcr(expected, "");
  expect(m.length).toBe(expected.symbols.length);
  for (const x of m) expect(x.reason).toBe("missing");
});

test("Rule: no _paytableVerification in raw → pass + 'no-paytable-verification'", () => {
  const rule = new PaytableContentRule();
  const r = rule.check(spinWithVerification(undefined), ctx);
  expect(r.pass).toBe(true);
  expect(r.detail).toBe("no-paytable-verification");
});

test("Rule: skipReason → pass + 'skipped:...'", () => {
  const rule = new PaytableContentRule();
  const r = rule.check(spinWithVerification({
    ok: true, matchedSymbols: 0, totalExpected: 0, mismatches: [], ocrTextLength: 0, durationMs: 5, skipReason: "no expected paytable.json in registry",
  }), ctx);
  expect(r.pass).toBe(true);
  expect(r.detail).toMatch(/skipped/);
});

test("Rule: ok=true → pass + matched count detail", () => {
  const rule = new PaytableContentRule();
  const r = rule.check(spinWithVerification({
    ok: true, matchedSymbols: 3, totalExpected: 3, mismatches: [], ocrTextLength: 200, durationMs: 800,
  }), ctx);
  expect(r.pass).toBe(true);
  expect(r.detail).toContain("3/3");
});

test("Rule: ok=false → fail + first 3 mismatches in detail", () => {
  const rule = new PaytableContentRule();
  const r = rule.check(spinWithVerification({
    ok: false, matchedSymbols: 1, totalExpected: 4, mismatches: [
      { symbol: "H1", expected: [], actual: null, reason: "missing" },
      { symbol: "H2", expected: [], actual: null, reason: "missing" },
      { symbol: "L1", expected: [], actual: null, reason: "payout_mismatch" },
      { symbol: "L2", expected: [], actual: null, reason: "missing" },
    ], ocrTextLength: 150, durationMs: 700,
  }), ctx);
  expect(r.pass).toBe(false);
  expect(r.severity).toBe("error");
  expect(r.detail).toContain("H1:missing");
  expect(r.detail).toContain("H2:missing");
  expect(r.detail).toContain("L1:payout_mismatch");
  expect(r.detail).toContain("(+1 more)");
});

test("diff: case-insensitive symbol name match", () => {
  const ocrText = `CROWN 1.5 5 25\ngem 1 3 15\nNINE 0.3 0.5 2`;
  const m = diffPaytableAgainstOcr(expected, ocrText);
  expect(m).toEqual([]);
});

test("diff: tolerance 0.01 on multipliers (Tesseract may round)", () => {
  const ocrText = `Crown 1.5 5 25.001\nGem 1 3 15\nNine 0.3 0.5 2`;
  const m = diffPaytableAgainstOcr(expected, ocrText);
  expect(m).toEqual([]);
});

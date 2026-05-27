// INVARIANT — HistoryReconciliationRule
//
// Same split-design as paytable-rule: pure `reconcileHistoryRows` is tested
// without Playwright/Tesseract by feeding pre-canned OCR text. Rule class
// is tested by stamping verification result into spin.raw.

import { test, expect } from "@playwright/test";
import {
  HistoryReconciliationRule,
  reconcileHistoryRows,
  type HistoryVerificationResult,
} from "../../src/pipeline/step9-verify/history-rule.ts";
import type { NormalizedSpinResult } from "../../src/pipeline/step6-build-model/normalized.ts";

function spin(roundId: string, bet: number, win: number): NormalizedSpinResult {
  return {
    roundId,
    bet,
    win,
    balanceBefore: 100,
    balanceAfter: 100 - bet + win,
    reels: [],
    cascadeFrames: [],
    state: "NORMAL",
    freeSpinsRemaining: null,
    isFreeSpin: false,
    hasBonus: false,
    raw: {},
  };
}

function spinWithVerification(v: HistoryVerificationResult | undefined): NormalizedSpinResult {
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
    raw: v ? { _historyVerification: v } : {},
  };
}

const ctx = { previousBalance: null, previousState: null, roundIndex: 0 };

test("reconcile: all rows present with matching bet+win → no mismatches", () => {
  const spins = [spin("abc123def", 0.5, 0), spin("xyz456abc", 1.0, 2.5)];
  const ocrText = `
    Round abc123def  bet 0.5  win 0
    Round xyz456abc  bet 1.0  win 2.5
  `;
  expect(reconcileHistoryRows(spins, ocrText)).toEqual([]);
});

test("reconcile: missing row → row_missing_in_ocr mismatch", () => {
  const spins = [spin("abc123def", 0.5, 0), spin("missing999", 0.5, 5)];
  const ocrText = `Round abc123def bet 0.5 win 0`;
  const m = reconcileHistoryRows(spins, ocrText);
  expect(m.length).toBe(1);
  expect(m[0]!.roundId).toBe("missing999");
  expect(m[0]!.reason).toBe("row_missing_in_ocr");
});

test("reconcile: roundId match by SUFFIX (UIs often show last 6-8 chars only)", () => {
  const spins = [spin("d6f7a8b9c0", 0.5, 0)];
  const ocrText = `Last round: ...a8b9c0 bet 0.5 win 0`;
  // Sliding window of length 6 → "a8b9c0" matches inside "...a8b9c0..."
  expect(reconcileHistoryRows(spins, ocrText)).toEqual([]);
});

test("reconcile: bet mismatch → bet_mismatch", () => {
  const spins = [spin("abc123def", 0.5, 0)];
  const ocrText = `Round abc123def bet 0.4 win 0`; // wrong bet
  const m = reconcileHistoryRows(spins, ocrText);
  expect(m.length).toBe(1);
  expect(m[0]!.reason).toBe("bet_mismatch");
});

test("reconcile: win mismatch when spin had non-zero win", () => {
  const spins = [spin("abc123def", 0.5, 2.5)];
  const ocrText = `Round abc123def bet 0.5 win 3.0`;
  const m = reconcileHistoryRows(spins, ocrText);
  expect(m.length).toBe(1);
  expect(m[0]!.reason).toBe("win_mismatch");
});

test("reconcile: 0-win spin doesn't trigger win_mismatch (UI may show '-' or omit)", () => {
  const spins = [spin("abc123def", 0.5, 0)];
  const ocrText = `Round abc123def bet 0.5`; // no win number on line
  expect(reconcileHistoryRows(spins, ocrText)).toEqual([]);
});

test("reconcile: fallback match by bet+win when no roundId in OCR", () => {
  const spins = [spin("hidden_id", 0.5, 2.5)];
  const ocrText = `bet 0.5 win 2.5`; // no id, but bet+win pair appears
  expect(reconcileHistoryRows(spins, ocrText)).toEqual([]);
});

test("reconcile: empty captured spins → no mismatches", () => {
  expect(reconcileHistoryRows([], "anything")).toEqual([]);
});

test("Rule: no _historyVerification → pass + 'no-history-verification'", () => {
  const r = new HistoryReconciliationRule().check(spinWithVerification(undefined), ctx);
  expect(r.pass).toBe(true);
  expect(r.detail).toBe("no-history-verification");
});

test("Rule: skipReason → pass + 'skipped:...'", () => {
  const r = new HistoryReconciliationRule().check(spinWithVerification({
    ok: true, capturedSpins: 0, matchedRows: 0, mismatches: [], ocrTextLength: 0, durationMs: 1, skipReason: "no historyButton in ui-registry",
  }), ctx);
  expect(r.pass).toBe(true);
  expect(r.detail).toMatch(/skipped/);
});

test("Rule: ok=true → pass + matched/captured count", () => {
  const r = new HistoryReconciliationRule().check(spinWithVerification({
    ok: true, capturedSpins: 5, matchedRows: 5, mismatches: [], ocrTextLength: 400, durationMs: 700,
  }), ctx);
  expect(r.pass).toBe(true);
  expect(r.detail).toContain("5/5");
});

test("Rule: ok=false → fail + first 3 mismatches", () => {
  const r = new HistoryReconciliationRule().check(spinWithVerification({
    ok: false, capturedSpins: 5, matchedRows: 1, mismatches: [
      { roundId: "r1", capturedBet: 0.5, capturedWin: 0, ocrLine: "", reason: "row_missing_in_ocr" },
      { roundId: "r2", capturedBet: 0.5, capturedWin: 0, ocrLine: "", reason: "row_missing_in_ocr" },
      { roundId: "r3", capturedBet: 0.5, capturedWin: 0, ocrLine: "x", reason: "bet_mismatch" },
      { roundId: "r4", capturedBet: 0.5, capturedWin: 0, ocrLine: "x", reason: "win_mismatch" },
    ], ocrTextLength: 300, durationMs: 800,
  }), ctx);
  expect(r.pass).toBe(false);
  expect(r.severity).toBe("error");
  expect(r.detail).toContain("r1:row_missing_in_ocr");
  expect(r.detail).toContain("(+1 more)");
});

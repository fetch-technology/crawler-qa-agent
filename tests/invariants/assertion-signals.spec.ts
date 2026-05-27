// INVARIANT — Signal-aware assertion evaluation (Phase 11.4 + refactor C)
//
// Heuristic that scans check_code text → which evidence signals contribute.
// Pure function; tests cover positive + negative detection per signal.
//
// Refactor (C) — 2026-05-25: ui_ocr signal is now PER-FIELD and
// data-availability-strict. A check_code referencing `screen.bet` ONLY gets
// ui_ocr credit when `hasOcrBet=true`. The previous text-scan + null-guard
// fallback (which would credit ui_ocr without actual OCR data) is removed
// to eliminate false-positive confidence on cases with silent OCR failures.

import { test, expect } from "@playwright/test";
import {
  detectAssertionSignals,
  signalsFromRefs,
} from "../../src/pipeline/step8-run-scenarios/assertion-signals.ts";

const defaultOpts = {
  spinsCaptured: 1,
  hasOcrBalance: false,
  hasOcrBet: false,
  hasOcrLastWin: false,
};
const allOcrOpts = {
  spinsCaptured: 1,
  hasOcrBalance: true,
  hasOcrBet: true,
  hasOcrLastWin: true,
};

// === api signal ===

test("api signal: triggered by spin reference", () => {
  const refs = detectAssertionSignals("spin.betAmount === 0.5", defaultOpts);
  expect(refs.api).toBe(true);
});

test("api signal: triggered by collector reference", () => {
  const refs = detectAssertionSignals("collector.spins.length >= 1", defaultOpts);
  expect(refs.api).toBe(true);
});

test("api signal: NOT triggered by string mention of 'spin' without word boundary", () => {
  const refs = detectAssertionSignals("'no spinResult here'", defaultOpts);
  expect(refs.api).toBe(false);
});

// === ui_ocr signal — per-field data-strict (refactor C) ===

test("ui_ocr: screen.balance + hasOcrBalance=true → ✓", () => {
  const refs = detectAssertionSignals("screen.balance === spin.endingBalance", {
    ...defaultOpts,
    hasOcrBalance: true,
  });
  expect(refs.ui_ocr).toBe(true);
});

test("ui_ocr: screen.bet + hasOcrBet=true → ✓", () => {
  const refs = detectAssertionSignals("Math.abs(screen.bet - 0.5) <= 0.01", {
    ...defaultOpts,
    hasOcrBet: true,
  });
  expect(refs.ui_ocr).toBe(true);
});

test("ui_ocr: screen.last_win + hasOcrLastWin=true → ✓", () => {
  const refs = detectAssertionSignals("screen.last_win === spin.winAmount", {
    ...defaultOpts,
    hasOcrLastWin: true,
  });
  expect(refs.ui_ocr).toBe(true);
});

test("ui_ocr: REGRESSION — screen.bet + null-guard but hasOcrBet=false → ✗ (no longer credits text-scan)", () => {
  // Before refactor C: null-guard pattern alone credited ui_ocr → false-positive
  // confidence when OCR silently failed. Now strictly requires actual data.
  const refs = detectAssertionSignals(
    "screen.bet === null || Math.abs(screen.bet - 0.5) <= 0.01",
    { ...defaultOpts, hasOcrBet: false },
  );
  expect(refs.ui_ocr).toBe(false);
});

test("ui_ocr: PER-FIELD — screen.balance reference + only hasOcrBet=true → ✗", () => {
  // Only the field actually referenced needs data. Having OCR for an
  // UNRELATED field doesn't credit ui_ocr.
  const refs = detectAssertionSignals("Math.abs(screen.balance - spin.endingBalance) <= 0.01", {
    ...defaultOpts,
    hasOcrBet: true, // wrong field
    hasOcrBalance: false,
  });
  expect(refs.ui_ocr).toBe(false);
});

test("ui_ocr: PER-FIELD — multi-field assertion credits if ANY referenced field has data", () => {
  const code =
    "(screen.balance === null || Math.abs(screen.balance - spin.endingBalance) <= 0.01) && " +
    "(screen.bet === null || Math.abs(screen.bet - spin.betAmount) <= 0.01)";
  // Only bet has OCR data; balance doesn't. Should still credit ui_ocr
  // because bet is referenced AND has data.
  const refs = detectAssertionSignals(code, {
    ...defaultOpts,
    hasOcrBet: true,
    hasOcrBalance: false,
  });
  expect(refs.ui_ocr).toBe(true);
});

test("ui_ocr: NOT triggered when no screen.X reference", () => {
  const refs = detectAssertionSignals("spin.endingBalance > 0", allOcrOpts);
  expect(refs.ui_ocr).toBe(false);
});

test("ui_ocr: ALL fields have data, assertion references all 3 → ✓", () => {
  const code =
    "screen.balance === spin.endingBalance && " +
    "screen.bet === spin.betAmount && " +
    "screen.last_win === spin.winAmount";
  const refs = detectAssertionSignals(code, allOcrOpts);
  expect(refs.ui_ocr).toBe(true);
});

test("ui_ocr: NO OCR data anywhere + screen.X references → ✗", () => {
  // The case that motivated refactor C: silent OCR failure → confidence
  // shouldn't inflate via text-scan credit.
  const code = "screen.balance === null || Math.abs(screen.balance - spin.endingBalance) <= 0.01";
  const refs = detectAssertionSignals(code, defaultOpts);
  expect(refs.ui_ocr).toBe(false);
});

// === state signal ===

test("state signal: triggered by stateTimeline reference", () => {
  const refs = detectAssertionSignals("stateTimeline.every(t => t.to === 'MAIN')", defaultOpts);
  expect(refs.state).toBe(true);
});

test("state signal: triggered by interrupts reference", () => {
  const refs = detectAssertionSignals("interrupts.count === 0", defaultOpts);
  expect(refs.state).toBe(true);
});

// === network signal ===

test("network signal: triggered by warnings reference", () => {
  const refs = detectAssertionSignals("warnings.length === 0", defaultOpts);
  expect(refs.network).toBe(true);
});

test("network signal: implicit when assertion uses captured spin data", () => {
  const refs = detectAssertionSignals("spin.betAmount === 0.5", defaultOpts);
  expect(refs.network).toBe(true); // every captured spin came from network
});

test("network signal: NOT triggered when no spin/warnings reference", () => {
  const refs = detectAssertionSignals("Math.abs(1 - 1) <= 0.01", defaultOpts);
  expect(refs.network).toBe(false);
});

// === rule signal ===

test("rule signal: triggered by detectBuyFeatureDeduction helper", () => {
  const refs = detectAssertionSignals("detectBuyFeatureDeduction(collector.spins, 0, balanceBefore) != null", defaultOpts);
  expect(refs.rule).toBe(true);
});

test("rule signal: triggered by typeof guard", () => {
  const refs = detectAssertionSignals("typeof spin.betAmount === 'number'", defaultOpts);
  expect(refs.rule).toBe(true);
});

test("rule signal: triggered by Math.abs tolerance", () => {
  const refs = detectAssertionSignals("Math.abs(spin.endingBalance - expected) <= 0.01", defaultOpts);
  expect(refs.rule).toBe(true);
});

// === signalsFromRefs combiner ===

test("signalsFromRefs: pass=false zeros all signals", () => {
  const refs = { api: true, network: true, ui_ocr: true, state: true, rule: true };
  const signals = signalsFromRefs(refs, false);
  expect(signals.api).toBe(false);
  expect(signals.network).toBe(false);
  expect(signals.ui_ocr).toBe(false);
  expect(signals.state).toBe(false);
  expect(signals.rule).toBe(false);
});

test("signalsFromRefs: pass=true preserves ref bools", () => {
  const refs = { api: true, network: false, ui_ocr: true, state: false, rule: true };
  const signals = signalsFromRefs(refs, true);
  expect(signals.api).toBe(true);
  expect(signals.network).toBe(false);
  expect(signals.ui_ocr).toBe(true);
  expect(signals.state).toBe(false);
  expect(signals.rule).toBe(true);
});

// === end-to-end multi-aspect detection ===

test("multi-aspect assertion: bet-boundary check triggers api + ui_ocr + network + rule", () => {
  const code = "spin.betAmount === 0.2 && (screen.bet === null || Math.abs(screen.bet - 0.2) <= 0.01) && warnings.filter(w => /error/.test(w)).length === 0";
  const refs = detectAssertionSignals(code, { ...defaultOpts, hasOcrBet: true });
  expect(refs.api).toBe(true);
  expect(refs.ui_ocr).toBe(true);
  expect(refs.network).toBe(true);
  expect(refs.rule).toBe(true);
});

test("state-only assertion: detects only state + rule (no api)", () => {
  const code = "stateTimeline.every(t => t.to === 'MAIN')";
  const refs = detectAssertionSignals(code, { ...defaultOpts, spinsCaptured: 0 });
  expect(refs.state).toBe(true);
  expect(refs.api).toBe(false);
});

// === rule signal expanded coverage (Fix 1) ===

test("rule signal: Array.isArray triggers rule", () => {
  const refs = detectAssertionSignals(
    "collector.spins.every(s => Array.isArray(s.matrix))",
    defaultOpts,
  );
  expect(refs.rule).toBe(true);
});

test("rule signal: .every / .filter / .some method triggers rule", () => {
  expect(detectAssertionSignals("collector.spins.every(s => s.id)", defaultOpts).rule).toBe(true);
  expect(detectAssertionSignals("collector.spins.filter(s => s.win > 0)", defaultOpts).rule).toBe(true);
  expect(detectAssertionSignals("collector.spins.some(s => s.id)", defaultOpts).rule).toBe(true);
  expect(detectAssertionSignals("collector.spins.map(s => s.id)", defaultOpts).rule).toBe(true);
  expect(detectAssertionSignals("collector.spins.reduce((a,s) => a + s.bet, 0)", defaultOpts).rule).toBe(true);
});

test("rule signal: .length === literal triggers rule", () => {
  const refs = detectAssertionSignals(
    "collector.spins.length === 5 && spin.matrix.length === 5",
    defaultOpts,
  );
  expect(refs.rule).toBe(true);
});

test("rule signal: new Set(...) uniqueness check triggers rule", () => {
  const refs = detectAssertionSignals(
    "new Set(collector.spins.map(s => s.id)).size === collector.spins.length",
    defaultOpts,
  );
  expect(refs.rule).toBe(true);
});

test("rule signal: null comparison triggers rule", () => {
  expect(detectAssertionSignals("screen.bet !== null", defaultOpts).rule).toBe(true);
  expect(detectAssertionSignals("spin.startingBalance == null", defaultOpts).rule).toBe(true);
});

test("rule signal: bare equality WITHOUT typeof/Math/helpers does NOT trigger rule", () => {
  const refs = detectAssertionSignals("spin.id === 'r1'", defaultOpts);
  expect(refs.rule).toBe(false);
});

// Regression test for the case that motivated Fix 1:
test("matrix-shape assertion (Array.isArray + .length === 5) gets rule signal", () => {
  const code = "collector.spins.filter(s => Array.isArray(s.matrix) && s.matrix.length > 0).every(s => s.matrix.length === 5)";
  const refs = detectAssertionSignals(code, { ...defaultOpts, spinsCaptured: 3 });
  expect(refs.api).toBe(true);
  expect(refs.rule).toBe(true); // was missed before Fix 1 — only got 0.45 confidence
  expect(refs.network).toBe(true); // implicit baseline from spinsCaptured > 0
});

// === Refactor (C) regression — false-positive elimination ===

test("REGRESSION (refactor C): ui-bet assertion with no actual OCR data → ui_ocr ✗", () => {
  // The case that motivated refactor C: user case showed PASS_HIGH 90% with
  // ui_ocr ✓ via text-scan, but balance-multi-signal path (used by twin
  // ui-balance assertion) correctly showed ui_ocr ✗ because ocrBalance was
  // undefined. Now both paths agree.
  const code = "screen.bet === null || Math.abs(screen.bet - spin.betAmount) <= 0.01";
  const refs = detectAssertionSignals(code, { ...defaultOpts, hasOcrBet: false });
  expect(refs.ui_ocr).toBe(false); // would have been TRUE pre-refactor
});

test("REGRESSION (refactor C): ui-win assertion with no OCR data → ui_ocr ✗", () => {
  const code = "screen.last_win === null || Math.abs(screen.last_win - spin.winAmount) <= 0.01";
  const refs = detectAssertionSignals(code, { ...defaultOpts, hasOcrLastWin: false });
  expect(refs.ui_ocr).toBe(false);
});

test("REGRESSION (refactor C): consistency with balance-multi-signal path", () => {
  // balance-multi-signal credits ui_ocr only when ocrBalance is a number
  // (data-strict). Refactor C aligns generic Phase 11.4 path to the same
  // method. Both should now agree.
  const code = "screen.balance === null || Math.abs(screen.balance - spin.endingBalance) <= 0.01";
  // Pre-refactor: text-scan said ✓ (had screen.X + null-guard).
  // Post-refactor: hasOcrBalance=false → ✗.
  const refsNoData = detectAssertionSignals(code, { ...defaultOpts, hasOcrBalance: false });
  expect(refsNoData.ui_ocr).toBe(false);
  // With actual OCR data → ✓ on both paths.
  const refsWithData = detectAssertionSignals(code, { ...defaultOpts, hasOcrBalance: true });
  expect(refsWithData.ui_ocr).toBe(true);
});

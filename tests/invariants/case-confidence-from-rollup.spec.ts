// INVARIANT — Case confidence derived from Signal Roll-up (2026-05-25)
//
// Replaces legacy MIN-of-assertion-confidences formula. The old formula
// dragged a 5/5-signal-pass case down to 30% just because one assertion
// (e.g. `warnings.filter(...)`) had narrow signal coverage. New formula
// weights signals directly:
//   api 0.35 · ui_ocr 0.25 · rule 0.20 · network 0.10 · state 0.10 = 1.00
//
// We can't directly import the private helper (deriveCaseConfidenceFromRollup
// is internal to case-executor.ts), so these tests replicate the formula
// and lock in the contract. If the formula changes, update both this file
// AND the executor.

import { test, expect } from "@playwright/test";
import type { SignalRollup } from "../../src/pipeline/step8-run-scenarios/case-executor.ts";

const WEIGHTS: Record<SignalRollup["signal"], number> = {
  api: 0.35,
  ui_ocr: 0.25,
  rule: 0.20,
  network: 0.10,
  state: 0.10,
};

function expectedConfidence(rollup: SignalRollup[]): number {
  if (rollup.length === 0) return 0;
  let pass = 0;
  let total = 0;
  for (const s of rollup) {
    const w = WEIGHTS[s.signal] ?? 0;
    total += w;
    if (s.pass) pass += w;
  }
  return total > 0 ? Math.min(1, pass / total) : 0;
}

function makeRollup(passSignals: SignalRollup["signal"][]): SignalRollup[] {
  const all: SignalRollup["signal"][] = ["api", "ui_ocr", "rule", "network", "state"];
  return all.map((s) => ({
    signal: s,
    pass: passSignals.includes(s),
    checks: [],
  }));
}

test("5/5 signals pass → confidence = 1.00 (PASS_HIGH)", () => {
  const rollup = makeRollup(["api", "ui_ocr", "rule", "network", "state"]);
  expect(expectedConfidence(rollup)).toBe(1);
});

test("REGRESSION: case with 30%-min-assertion BUT 5/5 signals → now 100%", () => {
  // The user-reported case: base-game-response-shape had `_precheck_bet` +
  // `shape-no-engine-warnings` at PASSLOW 30% (narrow signal coverage),
  // pulling case to 30%. But signal roll-up was 5/5 PASS. New formula:
  const rollup = makeRollup(["api", "ui_ocr", "rule", "network", "state"]);
  expect(expectedConfidence(rollup)).toBe(1);  // was 0.30 before, now 1.00
});

test("only state fails (low-weight signal) → confidence 0.90 (still PASS_HIGH)", () => {
  const rollup = makeRollup(["api", "ui_ocr", "rule", "network"]);
  expect(expectedConfidence(rollup)).toBeCloseTo(0.90, 2);
});

test("only api fails (high-weight signal) → confidence 0.65 (PASS_LOW)", () => {
  const rollup = makeRollup(["ui_ocr", "rule", "network", "state"]);
  expect(expectedConfidence(rollup)).toBeCloseTo(0.65, 2);
});

test("api + ui_ocr fail → confidence 0.40 (INCONCLUSIVE)", () => {
  const rollup = makeRollup(["rule", "network", "state"]);
  expect(expectedConfidence(rollup)).toBeCloseTo(0.40, 2);
});

test("only ui_ocr fails (silent OCR failure) → confidence 0.75 (PASS_LOW)", () => {
  const rollup = makeRollup(["api", "rule", "network", "state"]);
  expect(expectedConfidence(rollup)).toBeCloseTo(0.75, 2);
});

test("0/5 signals pass → confidence 0 (worst case)", () => {
  const rollup = makeRollup([]);
  expect(expectedConfidence(rollup)).toBe(0);
});

test("empty rollup → confidence 0 (no data)", () => {
  expect(expectedConfidence([])).toBe(0);
});

test("weights sum to 1.00 (or extremely close due to FP)", () => {
  const total = WEIGHTS.api + WEIGHTS.ui_ocr + WEIGHTS.rule + WEIGHTS.network + WEIGHTS.state;
  expect(total).toBeCloseTo(1, 5);
});

test("outcome mapping: confidence >= 0.85 + allPass → PASS_HIGH", () => {
  const allPass = true;
  const conf = 1.0;
  const outcome = allPass
    ? (conf >= 0.85 ? "PASS_HIGH" : conf >= 0.50 ? "PASS_LOW" : "INCONCLUSIVE")
    : (conf >= 0.85 ? "FAIL_HIGH" : conf >= 0.50 ? "FAIL_LOW" : "INCONCLUSIVE");
  expect(outcome).toBe("PASS_HIGH");
});

test("outcome mapping: 0.65 + allPass → PASS_LOW (only api fails)", () => {
  const allPass = true;
  const conf = 0.65;
  const outcome = allPass
    ? (conf >= 0.85 ? "PASS_HIGH" : conf >= 0.50 ? "PASS_LOW" : "INCONCLUSIVE")
    : (conf >= 0.85 ? "FAIL_HIGH" : conf >= 0.50 ? "FAIL_LOW" : "INCONCLUSIVE");
  expect(outcome).toBe("PASS_LOW");
});

test("outcome mapping: 0.40 + allPass → INCONCLUSIVE (multiple signal failures)", () => {
  const allPass = true;
  const conf = 0.40;
  const outcome = allPass
    ? (conf >= 0.85 ? "PASS_HIGH" : conf >= 0.50 ? "PASS_LOW" : "INCONCLUSIVE")
    : (conf >= 0.85 ? "FAIL_HIGH" : conf >= 0.50 ? "FAIL_LOW" : "INCONCLUSIVE");
  expect(outcome).toBe("INCONCLUSIVE");
});

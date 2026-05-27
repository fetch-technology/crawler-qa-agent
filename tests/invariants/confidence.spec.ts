// INVARIANT — confidence scoring + outcome derivation (Phase 8.1)
//
// Pure functions, no I/O. These define the contract for multi-signal
// validation: how individual signals combine, when verdict becomes
// inconclusive, how case outcome aggregates across assertions.

import { test, expect } from "@playwright/test";
import {
  calcConfidence,
  aggregateCaseOutcome,
  outcomeToLegacyStatus,
  legacyStatusToOutcome,
  DEFAULT_SIGNAL_WEIGHTS,
} from "../../src/pipeline/step8-run-scenarios/evidence/index.ts";
import type {
  ConfidentAssertionResult,
} from "../../src/pipeline/step8-run-scenarios/evidence/index.ts";

// ============================================================================
// calcConfidence
// ============================================================================

test("zero signals true → confidence 0 + PASS_LOW (verdict=true)", () => {
  const r = calcConfidence({ signals: {}, booleanVerdict: true });
  expect(r.confidence).toBe(0);
  expect(r.outcome).toBe("PASS_LOW");
});

test("all default signals true → confidence ~1.0 → PASS_HIGH", () => {
  const r = calcConfidence({
    signals: { api: true, network: true, ui_ocr: true, history: true, screenshot: true },
    booleanVerdict: true,
  });
  // 0.35 + 0.10 + 0.25 + 0.20 + 0.10 = 1.00
  expect(r.confidence).toBeGreaterThanOrEqual(0.99);
  expect(r.outcome).toBe("PASS_HIGH");
});

test("only API + history → confidence 0.55 → PASS_LOW (< 0.85 default)", () => {
  const r = calcConfidence({
    signals: { api: true, history: true },
    booleanVerdict: true,
  });
  expect(r.confidence).toBeCloseTo(0.55, 2);
  expect(r.outcome).toBe("PASS_LOW");
});

test("only API → confidence 0.35 → PASS_LOW (single-signal weak)", () => {
  const r = calcConfidence({ signals: { api: true }, booleanVerdict: true });
  expect(r.confidence).toBeCloseTo(0.35, 2);
  expect(r.outcome).toBe("PASS_LOW");
});

test("custom threshold 0.5 → 0.55 confidence becomes PASS_HIGH", () => {
  const r = calcConfidence({
    signals: { api: true, history: true },
    booleanVerdict: true,
    requirement: { passConfidenceThreshold: 0.5 },
  });
  expect(r.outcome).toBe("PASS_HIGH");
});

test("FAIL_HIGH when verdict=false + many signals corroborate (high confidence)", () => {
  const r = calcConfidence({
    signals: { api: true, network: true, ui_ocr: true, history: true },
    booleanVerdict: false,
  });
  expect(r.outcome).toBe("FAIL_HIGH");
});

test("FAIL_LOW when verdict=false but only one signal (weak evidence)", () => {
  const r = calcConfidence({ signals: { api: true }, booleanVerdict: false });
  expect(r.outcome).toBe("FAIL_LOW");
});

test("required signal MISSING → INCONCLUSIVE (not pass nor fail)", () => {
  const r = calcConfidence({
    signals: { api: true },  // ui_ocr missing entirely (not even false)
    booleanVerdict: true,
    requirement: { required: ["api", "ui_ocr"] },
  });
  expect(r.outcome).toBe("INCONCLUSIVE");
  expect(r.confidence).toBe(0);
  expect(r.inconclusiveReason).toMatch(/ui_ocr/);
});

test("required signal present (even false) does NOT trigger INCONCLUSIVE", () => {
  const r = calcConfidence({
    signals: { api: true, ui_ocr: false },
    booleanVerdict: true,
    requirement: { required: ["api", "ui_ocr"] },
  });
  // ui_ocr is false (present, didn't agree) but not missing → not inconclusive
  expect(r.outcome).not.toBe("INCONCLUSIVE");
});

test("custom signal weight overrides default", () => {
  const r = calcConfidence({
    signals: { customSignal: true },
    weights: { customSignal: 1.0 },
    booleanVerdict: true,
  });
  expect(r.confidence).toBe(1);
  expect(r.outcome).toBe("PASS_HIGH");
});

test("unknown signal name defaults to 0.1 weight", () => {
  const r = calcConfidence({
    signals: { weirdSignal: true },
    booleanVerdict: true,
  });
  expect(r.confidence).toBeCloseTo(0.1, 2);
});

test("confidence capped at 1.0 even with over-summed weights", () => {
  const r = calcConfidence({
    signals: { a: true, b: true, c: true, d: true, e: true },
    weights: { a: 0.5, b: 0.5, c: 0.5, d: 0.5, e: 0.5 },
    booleanVerdict: true,
  });
  expect(r.confidence).toBe(1);
});

// ============================================================================
// aggregateCaseOutcome
// ============================================================================

function fakeAssertion(outcome: ConfidentAssertionResult["outcome"], confidence = 0.5): ConfidentAssertionResult {
  return {
    id: "a",
    description: "",
    pass: outcome === "PASS_HIGH" || outcome === "PASS_LOW",
    outcome,
    confidence,
    signals: [],
  };
}

test("aggregate: empty assertions → INCONCLUSIVE", () => {
  const r = aggregateCaseOutcome([]);
  expect(r.outcome).toBe("INCONCLUSIVE");
});

test("aggregate: all PASS_HIGH → case PASS_HIGH", () => {
  const r = aggregateCaseOutcome([
    fakeAssertion("PASS_HIGH", 0.95),
    fakeAssertion("PASS_HIGH", 0.90),
  ]);
  expect(r.outcome).toBe("PASS_HIGH");
  expect(r.confidence).toBe(0.9); // MIN
});

test("aggregate: one PASS_LOW among PASS_HIGH → case PASS_LOW", () => {
  const r = aggregateCaseOutcome([
    fakeAssertion("PASS_HIGH", 0.95),
    fakeAssertion("PASS_LOW", 0.60),
  ]);
  expect(r.outcome).toBe("PASS_LOW");
});

test("aggregate: any FAIL_HIGH wins over PASS_HIGH", () => {
  const r = aggregateCaseOutcome([
    fakeAssertion("PASS_HIGH", 0.95),
    fakeAssertion("FAIL_HIGH", 0.90),
  ]);
  expect(r.outcome).toBe("FAIL_HIGH");
});

test("aggregate: FAIL_LOW + PASS_HIGH → case FAIL_LOW (any fail beats pass)", () => {
  const r = aggregateCaseOutcome([
    fakeAssertion("PASS_HIGH", 0.95),
    fakeAssertion("FAIL_LOW", 0.40),
  ]);
  expect(r.outcome).toBe("FAIL_LOW");
});

test("aggregate: FAIL_HIGH beats FAIL_LOW", () => {
  const r = aggregateCaseOutcome([
    fakeAssertion("FAIL_LOW", 0.40),
    fakeAssertion("FAIL_HIGH", 0.95),
  ]);
  expect(r.outcome).toBe("FAIL_HIGH");
});

test("aggregate: INCONCLUSIVE beats everything", () => {
  const r = aggregateCaseOutcome([
    fakeAssertion("PASS_HIGH", 0.95),
    fakeAssertion("FAIL_HIGH", 0.95),
    fakeAssertion("INCONCLUSIVE", 0),
  ]);
  expect(r.outcome).toBe("INCONCLUSIVE");
});

test("aggregate: NEEDS_REVIEW beats INCONCLUSIVE (highest precedence)", () => {
  const r = aggregateCaseOutcome([
    fakeAssertion("INCONCLUSIVE", 0),
    fakeAssertion("NEEDS_REVIEW", 0),
  ]);
  expect(r.outcome).toBe("NEEDS_REVIEW");
});

// ============================================================================
// outcome ↔ legacy status conversion
// ============================================================================

test("PASS_HIGH/PASS_LOW/PASS_WITH_INTERRUPT → legacy 'pass'", () => {
  expect(outcomeToLegacyStatus("PASS_HIGH")).toBe("pass");
  expect(outcomeToLegacyStatus("PASS_LOW")).toBe("pass");
  expect(outcomeToLegacyStatus("PASS_WITH_INTERRUPT")).toBe("pass");
});

test("PASS_WITH_INTERRUPT outcome exists in the Outcome union (smoke check)", () => {
  // Compile-time check via assignment — fails type-check if union shrunk.
  // (Runtime form: just verify the string travels through the helpers.)
  const o = "PASS_WITH_INTERRUPT" as const;
  expect(outcomeToLegacyStatus(o)).toBe("pass");
});

test("FAIL_HIGH/FAIL_LOW → legacy 'fail'", () => {
  expect(outcomeToLegacyStatus("FAIL_HIGH")).toBe("fail");
  expect(outcomeToLegacyStatus("FAIL_LOW")).toBe("fail");
});

test("INCONCLUSIVE/NEEDS_REVIEW/FLAKY → legacy 'skip'", () => {
  expect(outcomeToLegacyStatus("INCONCLUSIVE")).toBe("skip");
  expect(outcomeToLegacyStatus("NEEDS_REVIEW")).toBe("skip");
  expect(outcomeToLegacyStatus("FLAKY")).toBe("skip");
});

test("legacy 'pass' + high confidence → PASS_HIGH", () => {
  expect(legacyStatusToOutcome("pass", 0.95)).toBe("PASS_HIGH");
});

test("legacy 'pass' + low confidence → PASS_LOW", () => {
  expect(legacyStatusToOutcome("pass", 0.5)).toBe("PASS_LOW");
});

test("legacy 'fail' + low confidence → FAIL_LOW", () => {
  expect(legacyStatusToOutcome("fail", 0.5)).toBe("FAIL_LOW");
});

test("DEFAULT_SIGNAL_WEIGHTS sums correctly for all default signals true", () => {
  // api(.35) + network(.10) + ui_ocr(.25) + history(.20) + screenshot(.10)
  // = 1.00. (state, rule extras would push over without cap.)
  const sum = DEFAULT_SIGNAL_WEIGHTS.api + DEFAULT_SIGNAL_WEIGHTS.network
    + DEFAULT_SIGNAL_WEIGHTS.ui_ocr + DEFAULT_SIGNAL_WEIGHTS.history + DEFAULT_SIGNAL_WEIGHTS.screenshot;
  expect(sum).toBeCloseTo(1.0, 2);
});

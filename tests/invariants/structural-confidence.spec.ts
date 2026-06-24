// INVARIANT — structural-confidence gate (fail-soft on unseen game encodings)
//
// When the engine could not faithfully represent the spin traffic it observed
// (free-spin frames swallowed into the buy round, bet balance-derived), a
// feature-semantics assertion failure must downgrade to INCONCLUSIVE — NOT a
// confident FAIL. But a GENUINELY broken buy (no extra traffic, no merges) must
// still FAIL. The downgrade is keyed on representation-mismatch, never on the
// bare assertion failure.

import { test, expect } from "@playwright/test";
import {
  deriveStructuralConfidence,
  FEATURE_SEMANTIC_ASSERTION_IDS,
} from "../../src/pipeline/step8-run-scenarios/structural-confidence.ts";

const BASE = {
  doSpinCount: 4,
  collectedSpinsLen: 1,
  dedupSwallowed: 3,
  betWasReconciled: true,
  stateNeverLeftNormal: true,
  isBuyOrFeatureIntent: true,
  failingIds: ["buy-cost-ratio", "buy-feature-state-transition"],
};

test("collapsed multi-spin buy case (4 doSpins → 1 round) → low confidence", () => {
  const r = deriveStructuralConfidence(BASE);
  expect(r.lowConfidence).toBe(true);
  expect(r.reason).toContain("4 doSpin");
});

test("genuine feature absence (1 doSpin → 1 round, no merges, no derived bet) → stays FAIL", () => {
  const r = deriveStructuralConfidence({
    ...BASE,
    doSpinCount: 1,
    collectedSpinsLen: 1,
    dedupSwallowed: 0,
    betWasReconciled: false,
    failingIds: ["buy-cost-ratio"],
  });
  expect(r.lowConfidence).toBe(false);
});

test("a non-feature assertion also failed → real defect, stays FAIL", () => {
  const r = deriveStructuralConfidence({
    ...BASE,
    failingIds: ["buy-cost-ratio", "buy-feature-win-non-negative"],
  });
  expect(r.lowConfidence).toBe(false);
});

test("not a buy/feature case → never downgraded", () => {
  const r = deriveStructuralConfidence({ ...BASE, isBuyOrFeatureIntent: false });
  expect(r.lowConfidence).toBe(false);
});

test("state DID leave NORMAL (feature recognised) → no downgrade", () => {
  const r = deriveStructuralConfidence({ ...BASE, stateNeverLeftNormal: false });
  expect(r.lowConfidence).toBe(false);
});

test("balance-derived bet alone is enough evidence even without collapse", () => {
  const r = deriveStructuralConfidence({
    ...BASE,
    doSpinCount: 1,
    collectedSpinsLen: 1,
    dedupSwallowed: 0,
    betWasReconciled: true,
  });
  expect(r.lowConfidence).toBe(true);
  expect(r.reason).toContain("balance-derived");
});

test("no failing assertions → not applicable", () => {
  const r = deriveStructuralConfidence({ ...BASE, failingIds: [] });
  expect(r.lowConfidence).toBe(false);
});

test("the two daydead assertion ids are in the suppressible set", () => {
  expect(FEATURE_SEMANTIC_ASSERTION_IDS.has("buy-cost-ratio")).toBe(true);
  expect(FEATURE_SEMANTIC_ASSERTION_IDS.has("buy-feature-state-transition")).toBe(true);
  expect(FEATURE_SEMANTIC_ASSERTION_IDS.has("buy-feature-win-non-negative")).toBe(false);
});

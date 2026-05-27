// INVARIANT — set_bet_to_value action (2026-05-25)
//
// OCR-verified bet navigation. Replaces hardcoded "click betMinus times=N"
// patterns that assume known starting bet (brittle).
//
// Type contract + behavior contract (decision tree).

import { test, expect } from "@playwright/test";
import type { CaseAction } from "../../src/pipeline/step7-testcase-gen/case-action-translator.ts";

test("CaseAction includes set_bet_to_value variant", () => {
  const a: CaseAction = { kind: "set_bet_to_value", value: 0.5 };
  expect(a.kind).toBe("set_bet_to_value");
  expect(a.value).toBe(0.5);
});

test("set_bet_to_value supports optional maxAttempts (default 30)", () => {
  const a: CaseAction = { kind: "set_bet_to_value", value: 1.0, maxAttempts: 50 };
  expect(a.maxAttempts).toBe(50);
});

test("set_bet_to_value supports optional reason note", () => {
  const a: CaseAction = { kind: "set_bet_to_value", value: 0.2, reason: "min bet test" };
  expect(a.reason).toBe("min bet test");
});

test("decision tree: when current bet matches target → 0 clicks needed", () => {
  // Pure simulation of the engine's loop predicate.
  const target = 0.5;
  const currentBet = 0.5;
  const tolerance = 0.01;
  const shouldClick = Math.abs(currentBet - target) > tolerance;
  expect(shouldClick).toBe(false);
});

test("decision tree: current > target → click betMinus", () => {
  const target = 0.5;
  const currentBet = 2.0;
  const direction = currentBet > target ? "betMinus" : "betPlus";
  expect(direction).toBe("betMinus");
});

test("decision tree: current < target → click betPlus", () => {
  const target = 5.0;
  const currentBet = 1.0;
  const direction = currentBet > target ? "betMinus" : "betPlus";
  expect(direction).toBe("betPlus");
});

test("decision tree: stuck detection — same value 2 consecutive clicks → bail out", () => {
  // Simulates ladder edge: clicking betMinus at 0.20 (already min) doesn't change value.
  const prev = 0.20;
  const after = 0.20;
  const tolerance = 0.01;
  const stuck = Math.abs(after - prev) < tolerance;
  expect(stuck).toBe(true);
});

test("decision tree: tolerance 0.01 catches small floating-point drift", () => {
  const target = 0.5;
  const currentBet = 0.5001;  // OCR returned slightly different float
  const tolerance = 0.01;
  expect(Math.abs(currentBet - target) <= tolerance).toBe(true);
});

test("regression for hardcoded count bug: user's example case", () => {
  // catalog had: "click betMinus ×8 // step bet from 10 down to 0.50 (index 10 → 2)"
  // Problem: assumes current bet = 10. If user changed bet manually before run,
  // 8 clicks lands on wrong value.
  // set_bet_to_value fixes this by reading OCR after each click → robust.
  const oldAction: CaseAction = { kind: "click", uiKey: "betMinus", times: 8 };
  const newAction: CaseAction = { kind: "set_bet_to_value", value: 0.5 };
  expect(oldAction.times).toBe(8);          // brittle: assumes start=10
  expect(newAction.kind).toBe("set_bet_to_value");  // robust: OCR-verified
});

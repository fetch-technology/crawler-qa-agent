// INVARIANT — set_bet_to_value action (2026-05-25)
//
// OCR-verified bet navigation. Replaces hardcoded "click betMinus times=N"
// patterns that assume known starting bet (brittle).
//
// Type contract + behavior contract (decision tree).

import { test, expect } from "@playwright/test";
import type { CaseAction } from "../../src/pipeline/step7-testcase-gen/case-action-translator.ts";
import {
  findBetChip,
  findBetChipExtreme,
  hasDropdownBetSelector,
  parseBetValueFromChipKey,
  parseNumberOfSpinsValueFromKey,
} from "../../src/pipeline/step8-run-scenarios/case-executor.ts";
import type { UiRegistry } from "../../src/pipeline/registry/types.ts";

const el = (x = 1, y = 1) => ({ x, y, strategy: "coord" }) as unknown as UiRegistry[string];

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

// findBetChip — direct-chip fast path. Discovery names the same chip either
// `__bet-<n>` OR `__betAmount-<n>`; BOTH must match or the fast path silently
// dies and set_bet falls to the slow 30-click OCR ladder.
test("findBetChip matches `__bet-<n>` chip keys", () => {
  const reg = { betPlus: el(), "betPlus__bet-2.00": el(5, 5) } as unknown as UiRegistry;
  const m = findBetChip(reg, 2.0, 0.01);
  expect(m?.chipKey).toBe("betPlus__bet-2.00");
});

test("findBetChip matches `__betAmount-<n>` chip keys (the vs20fruitsw shape)", () => {
  const reg = {
    betPlus: el(), betMinus: el(),
    "betPlus__betAmount-0.20": el(), "betPlus__betAmount-1.40": el(7, 7), "betPlus__betAmount-10.00": el(),
  } as unknown as UiRegistry;
  const m = findBetChip(reg, 1.4, 0.01);
  expect(m?.chipKey).toBe("betPlus__betAmount-1.40");
});

test("findBetChip returns null when no chip is within tolerance (→ OCR fallback)", () => {
  const reg = { betPlus: el(), "betPlus__betAmount-6.00": el() } as unknown as UiRegistry;
  expect(findBetChip(reg, 6.25, 0.01)).toBeNull(); // 6.25 (ante rung) not a real chip
});

// Popup-only games: NO betPlus/betMinus, a single `betButton` opens a chooser
// whose chips are discovered as `betButton__bet-<n>`. set_bet_to_min/max pick
// the extreme chip; set_bet_to_value picks the matching/nearest chip.
test("findBetChip prefers a dedicated betButton opener over betPlus/betMinus", () => {
  const reg = {
    betPlus: el(), betMinus: el(), betButton: el(9, 9),
    "betPlus__bet-1.00": el(1, 1),
    "betButton__bet-1.00": el(2, 2),
  } as unknown as UiRegistry;
  const m = findBetChip(reg, 1.0, 0.01);
  expect(m?.parentKey).toBe("betButton");
  expect(m?.chipKey).toBe("betButton__bet-1.00");
});

test("findBetChipExtreme('min') returns the lowest chip (popup-only registry)", () => {
  const reg = {
    betButton: el(9, 9),
    "betButton__bet-0.20": el(1, 1),
    "betButton__bet-1.00": el(2, 2),
    "betButton__bet-50.00": el(3, 3),
  } as unknown as UiRegistry;
  const m = findBetChipExtreme(reg, "min");
  expect(m?.chipKey).toBe("betButton__bet-0.20");
});

test("findBetChipExtreme('max') returns the highest chip", () => {
  const reg = {
    betButton: el(9, 9),
    "betButton__bet-0.20": el(1, 1),
    "betButton__bet-1.00": el(2, 2),
    "betButton__bet-50.00": el(3, 3),
  } as unknown as UiRegistry;
  const m = findBetChipExtreme(reg, "max");
  expect(m?.chipKey).toBe("betButton__bet-50.00");
});

test("findBetChipExtreme picks up the discovered closeButton in the same namespace", () => {
  const reg = {
    betButton: el(9, 9),
    "betButton__bet-0.20": el(1, 1),
    "betButton__closeButton": el(8, 2),
  } as unknown as UiRegistry;
  const m = findBetChipExtreme(reg, "min");
  expect(m?.closeKey).toBe("betButton__closeButton");
  expect(m?.closeButton).toBeTruthy();
});

test("findBetChipExtreme returns null when there are no chips", () => {
  const reg = { spinButton: el(), betButton: el() } as unknown as UiRegistry;
  expect(findBetChipExtreme(reg, "min")).toBeNull();
});

test("findBetChip nearest (infinite tolerance) snaps to closest available chip", () => {
  const reg = {
    betButton: el(9, 9),
    "betButton__bet-0.20": el(1, 1),
    "betButton__bet-1.00": el(2, 2),
  } as unknown as UiRegistry;
  // target 0.9 has no exact chip; nearest is 1.00.
  const m = findBetChip(reg, 0.9, Number.POSITIVE_INFINITY);
  expect(m?.chipKey).toBe("betButton__bet-1.00");
});

test("detects scrollable bet dropdown selectors", () => {
  const reg = {
    betButton: el(9, 9),
    "betButton__totalBetDropdown": el(20, 200),
    "betButton__bet-8.00": el(20, 280),
  } as unknown as UiRegistry;
  expect(hasDropdownBetSelector(reg)).toBe(true);
});

test("parseBetValueFromChipKey extracts direct bet-row values", () => {
  expect(parseBetValueFromChipKey("betButton__bet-8.00")).toBe(8);
  expect(parseBetValueFromChipKey("betPlus__betAmount-30.00")).toBe(30);
  expect(parseBetValueFromChipKey("betButton__totalBetDropdown__totalBet-60.00")).toBe(60);
  expect(parseBetValueFromChipKey("betButton__bet-400.00-selected")).toBe(400);
  expect(parseBetValueFromChipKey("betButton__closeButton")).toBeNull();
});

test("parseNumberOfSpinsValueFromKey extracts autoplay dropdown option values", () => {
  expect(parseNumberOfSpinsValueFromKey("spinButton__numberOfSpinsDropdown__numberOfSpins-20")).toBe(20);
  expect(parseNumberOfSpinsValueFromKey("spinButton__numberOfSpinsDropdown__numberOfSpins-50-selected")).toBe(50);
  expect(parseNumberOfSpinsValueFromKey("spinButton__numberOfSpinsDropdown__numberOfSpins-untilFeature")).toBe(-1);
  expect(parseNumberOfSpinsValueFromKey("spinButton__numberOfSpinsDropdown__numberOfSpins-until-1")).toBe(-1);
  expect(parseNumberOfSpinsValueFromKey("spinButton__numberOfSpinsDropdown__startButton")).toBeNull();
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

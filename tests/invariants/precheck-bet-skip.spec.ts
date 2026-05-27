// INVARIANT — _precheck_bet skip when no bet-adjustment in actions (2026-05-26)
//
// User-reported case: `options-battery-saver-toggle` had assertion
// `Math.abs(spin.betAmount - 0.5) <= 0.01` but case actions are MENU-ONLY
// (click menuButton → click batterySaverToggle → click closeButton). No bet
// adjustment intended. Previous case left bet at 0.2 → precheck failed.
//
// Engine fix: scan actions for any bet-changing action. If none, the
// assertion's literal bet is AI catalog overreach — skip precheck with a
// transparent note instead of failing the case.

import { test, expect } from "@playwright/test";

// Replicate the predicate from runPrechecks in case-executor.ts
function hasBetAdjustment(actions: Array<{ kind: string; uiKey?: string }>): boolean {
  return actions.some((a) =>
    a.kind === "set_bet_to_min" ||
    a.kind === "set_bet_to_max" ||
    a.kind === "set_bet_to_value" ||
    (a.kind === "click" && /bet(Minus|Plus|Amount-)/i.test(a.uiKey ?? "")),
  );
}

test("menu-only case (user's battery-toggle scenario): no bet adjustment → skip precheck", () => {
  const actions = [
    { kind: "click", uiKey: "menuButton" },
    { kind: "wait_ms" },
    { kind: "click", uiKey: "menuButton__batterySaverToggle" },
    { kind: "wait_ms" },
    { kind: "click", uiKey: "menuButton__closeButton" },
    { kind: "wait_ms" },
    { kind: "spin" },
    { kind: "wait_ms" },
  ];
  expect(hasBetAdjustment(actions)).toBe(false);
});

test("bet-variation case: set_bet_to_value detected", () => {
  const actions = [
    { kind: "set_bet_to_value" },
    { kind: "wait_ms" },
    { kind: "spin" },
  ];
  expect(hasBetAdjustment(actions)).toBe(true);
});

test("bet-boundary case: set_bet_to_min detected", () => {
  const actions = [{ kind: "set_bet_to_min" }, { kind: "spin" }];
  expect(hasBetAdjustment(actions)).toBe(true);
});

test("bet-boundary overshoot: click betPlus detected", () => {
  const actions = [
    { kind: "set_bet_to_max" },
    { kind: "click", uiKey: "betPlus" },
    { kind: "spin" },
  ];
  expect(hasBetAdjustment(actions)).toBe(true);
});

test("popup-based bet selection: click betMinus__betAmount-0.50 detected", () => {
  const actions = [
    { kind: "click", uiKey: "betMinus" },
    { kind: "wait_ms" },
    { kind: "click", uiKey: "betMinus__betAmount-0.50" },
    { kind: "spin" },
  ];
  expect(hasBetAdjustment(actions)).toBe(true);
});

test("history-only case: no bet adjustment", () => {
  const actions = [
    { kind: "click", uiKey: "historyButton" },
    { kind: "wait_ms" },
    { kind: "click", uiKey: "historyButton__closeButton" },
  ];
  expect(hasBetAdjustment(actions)).toBe(false);
});

test("paytable-inspect case: no bet adjustment", () => {
  const actions = [
    { kind: "click", uiKey: "paytableButton" },
    { kind: "wait_ms" },
    { kind: "click", uiKey: "paytableButton__nextPage" },
    { kind: "click", uiKey: "paytableButton__closeButton" },
  ];
  expect(hasBetAdjustment(actions)).toBe(false);
});

test("autoplay UI case: bet not adjusted, only autoplay slider", () => {
  const actions = [
    { kind: "click", uiKey: "autoButton" },
    { kind: "click", uiKey: "autoButton__autoplaySlider-10" },
    { kind: "click", uiKey: "autoButton__startButton" },
  ];
  expect(hasBetAdjustment(actions)).toBe(false);
});

test("turbo-toggle case: no bet adjustment", () => {
  const actions = [
    { kind: "click", uiKey: "turboButton" },
    { kind: "spin" },
  ];
  expect(hasBetAdjustment(actions)).toBe(false);
});

test("autoplay-with-bet case: set_bet first THEN autoplay → bet adjustment detected", () => {
  const actions = [
    { kind: "set_bet_to_value" },
    { kind: "click", uiKey: "autoButton" },
    { kind: "click", uiKey: "autoButton__startButton" },
  ];
  expect(hasBetAdjustment(actions)).toBe(true);
});

test("regression: user's bet=0.2 vs catalog expected=0.5 inheritance", () => {
  // The exact case user reported. Without action-based gate, precheck
  // would fail with: "Setup did NOT reach expected bet. Expected 0.5, captured 0.2"
  // even though the test isn't ABOUT bet at all.
  const userActions = [
    { kind: "click", uiKey: "menuButton" },
    { kind: "click", uiKey: "menuButton__batterySaverToggle" },
    { kind: "click", uiKey: "menuButton__closeButton" },
    { kind: "spin" },
  ];
  const noBetAdjustment = !hasBetAdjustment(userActions);
  expect(noBetAdjustment).toBe(true);
  // Engine now emits _precheck_bet with pass=true + "Skipped: ..." detail.
  // Case verdict not blocked by this AI overreach.
});

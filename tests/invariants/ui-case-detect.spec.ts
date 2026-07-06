// INVARIANT — UI-only case detection + reopen pattern (Phase 11 follow-up)
//
// Pins the synthetic-assertion gating logic. Without endsOnReopen detection,
// cases that intentionally end with a popup OPEN (e.g. "click X to reopen
// and verify persistence") would falsely fail _auto_returned_to_main_after_close.

import { test, expect } from "@playwright/test";
import {
  detectUiOnlyCase,
  isOpenUiKey,
  isCloseUiKey,
} from "../../src/pipeline/step8-run-scenarios/ui-case-detect.ts";
import type { CaseAction } from "../../src/pipeline/step7-testcase-gen/case-action-translator.ts";

// === uiKey predicates ===

test("isOpenUiKey: matches info/paytable/history/settings/menu/rules/help prefixes", () => {
  expect(isOpenUiKey("infoButton")).toBe(true);
  expect(isOpenUiKey("paytableButton")).toBe(true);
  expect(isOpenUiKey("historyButton")).toBe(true);
  expect(isOpenUiKey("menuButton")).toBe(true);
  expect(isOpenUiKey("settingsIcon")).toBe(true);
});

test("isOpenUiKey: rejects nested close buttons", () => {
  expect(isOpenUiKey("menuButton__closeButton")).toBe(false);
  expect(isOpenUiKey("infoButton__close_btn")).toBe(false);
});

test("isCloseUiKey: matches close button variants", () => {
  expect(isCloseUiKey("closeButton")).toBe(true);
  expect(isCloseUiKey("infoButton__closeButton")).toBe(true);
  expect(isCloseUiKey("menu__close")).toBe(true);
});

// === detectUiOnlyCase ===

function click(uiKey: string): CaseAction {
  return { kind: "click", uiKey };
}
function hold(uiKey: string): CaseAction {
  return { kind: "hold", uiKey, ms: 5000 };
}
function wait(ms = 500): CaseAction {
  return { kind: "wait_ms", ms };
}
function spin(): CaseAction {
  return { kind: "spin" };
}

test("UI-only popup tour: open → next ×3 → close", () => {
  const actions = [
    click("infoButton"),
    wait(1500),
    click("infoButton__nextPage"),
    wait(500),
    click("infoButton__nextPage"),
    wait(500),
    click("infoButton__closeButton"),
  ];
  const r = detectUiOnlyCase(actions);
  expect(r.isUiOnlyCase).toBe(true);
  expect(r.endsOnReopen).toBe(false);
});

test("Reopen-to-verify pattern: open → toggle → close → reopen", () => {
  const actions = [
    click("menuButton"),
    wait(1500),
    click("menuButton__soundFxToggle"),
    wait(500),
    click("menuButton__closeButton"),
    wait(1500),
    click("menuButton"), // ← reopen for verification
  ];
  const r = detectUiOnlyCase(actions);
  expect(r.isUiOnlyCase).toBe(true);
  expect(r.endsOnReopen).toBe(true); // ← skip _auto_returned_to_main_after_close
});

test("UI-only detection treats hold as an open UI action", () => {
  const actions = [
    hold("menuButton"),
    wait(1500),
    click("menuButton__closeButton"),
  ];
  const r = detectUiOnlyCase(actions);
  expect(r.isUiOnlyCase).toBe(true);
});

test("Not UI-only when actions contain spin", () => {
  const actions = [click("infoButton"), click("infoButton__closeButton"), spin()];
  const r = detectUiOnlyCase(actions);
  expect(r.isUiOnlyCase).toBe(false);
});

test("Not UI-only when no close action present", () => {
  const actions = [click("infoButton"), click("infoButton__nextPage")];
  const r = detectUiOnlyCase(actions);
  expect(r.isUiOnlyCase).toBe(false);
});

test("Trailing wait_ms doesn't change endsOnReopen judgment (last CLICK matters)", () => {
  const actions = [
    click("menuButton"),
    click("menuButton__closeButton"),
    click("menuButton"), // last click
    wait(1500), // trailing wait — should NOT make endsOnReopen=false
  ];
  const r = detectUiOnlyCase(actions);
  expect(r.endsOnReopen).toBe(true);
});

test("endsOnReopen=false when last click IS a close button", () => {
  const actions = [
    click("menuButton"),
    click("menuButton__soundFxToggle"),
    click("menuButton__closeButton"), // last click = close
  ];
  const r = detectUiOnlyCase(actions);
  expect(r.endsOnReopen).toBe(false);
});

test("endsOnReopen=false for non-UI cases (no open/close pattern)", () => {
  const actions = [click("betMinus"), spin()];
  const r = detectUiOnlyCase(actions);
  expect(r.isUiOnlyCase).toBe(false);
  expect(r.endsOnReopen).toBe(false);
});

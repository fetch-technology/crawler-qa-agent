// Pure regression tests for safe-click's discovery whitelist. Critical
// blacklist (spinButton, confirm*, yes*, start*Button, gamble) MUST always
// reject; the discovery-friendly additions (betPlus/Minus, popup-internal
// patterns) MUST always accept. Tests run with QA_AGGRESSIVE_DISCOVER
// unset so they exercise the PRODUCTION whitelist path — the strict one.

import { test, expect } from "@playwright/test";
import { isSafeToClickForDiscovery } from "../../src/pipeline/step2-detect-ui/safe-click.ts";

test.beforeEach(() => {
  delete process.env.QA_AGGRESSIVE_DISCOVER;
});

// --- CRITICAL blacklist (must always reject) ---

test("spinButton always rejected", () => {
  expect(isSafeToClickForDiscovery("spinButton")).toBe(false);
});

test("confirmButton rejected (buy-bonus commit)", () => {
  expect(isSafeToClickForDiscovery("buyBonusButton__confirmButton")).toBe(false);
});

test("yesButton rejected (generic commit)", () => {
  expect(isSafeToClickForDiscovery("buyBonusButton__yesButton")).toBe(false);
});

test("startButton rejected (autoplay start)", () => {
  expect(isSafeToClickForDiscovery("autoButton__startButton")).toBe(false);
});

test("gambleButton rejected", () => {
  expect(isSafeToClickForDiscovery("gambleButton")).toBe(false);
});

// --- NEW: betPlus/betMinus accepted (reversible bet adjuster / opens picker) ---

test("betPlus accepted for discovery", () => {
  expect(isSafeToClickForDiscovery("betPlus")).toBe(true);
});

test("betMinus accepted for discovery", () => {
  expect(isSafeToClickForDiscovery("betMinus")).toBe(true);
});

// --- NEW: popup-internal patterns accepted (enables depth 2/3) ---

test("autoButton__autospinsSlider accepted (generic slider)", () => {
  expect(isSafeToClickForDiscovery("autoButton__autospinsSlider")).toBe(true);
});

test("autoButton__lossLimitButton accepted (autoplay option)", () => {
  expect(isSafeToClickForDiscovery("autoButton__lossLimitButton")).toBe(true);
});

test("autoButton__singleWinLimitButton accepted (autoplay option)", () => {
  expect(isSafeToClickForDiscovery("autoButton__singleWinLimitButton")).toBe(true);
});

test("autoButton__stopOnAnyWin accepted (stopOn-* family)", () => {
  expect(isSafeToClickForDiscovery("autoButton__stopOnAnyWin")).toBe(true);
});

test("paytableButton__page2Button accepted", () => {
  expect(isSafeToClickForDiscovery("paytableButton__page2Button")).toBe(true);
});

test("paytableButton__nextPageButton accepted", () => {
  expect(isSafeToClickForDiscovery("paytableButton__nextPageButton")).toBe(true);
});

test("paytableButton__prevPageButton accepted", () => {
  expect(isSafeToClickForDiscovery("paytableButton__prevPageButton")).toBe(true);
});

test("settingsPopup__musicToggle accepted (generic toggle)", () => {
  expect(isSafeToClickForDiscovery("settingsPopup__musicToggle")).toBe(true);
});

test("settingsPopup__volumeButton accepted", () => {
  expect(isSafeToClickForDiscovery("settingsPopup__volumeButton")).toBe(true);
});

test("settingsPopup__muteButton accepted", () => {
  expect(isSafeToClickForDiscovery("settingsPopup__muteButton")).toBe(true);
});

test("anyPopup__symbolButton accepted (paytable detail)", () => {
  expect(isSafeToClickForDiscovery("paytable__symbolButton")).toBe(true);
});

test("anyPopup__closeButton accepted", () => {
  expect(isSafeToClickForDiscovery("autoButton__closeButton")).toBe(true);
});

test("anyPopup__backButton accepted (sub-popup back nav)", () => {
  expect(isSafeToClickForDiscovery("settingsPopup__backButton")).toBe(true);
});

test("anyPopup__cancelButton accepted (non-committing dismissal)", () => {
  expect(isSafeToClickForDiscovery("buyBonusButton__cancelButton")).toBe(true);
});

test("symbolDetailsTab accepted (generic tab nav)", () => {
  expect(isSafeToClickForDiscovery("paytable__symbolDetailsTab")).toBe(true);
});

// --- BLOCKED commit-money patterns still rejected ---

test("buyMaxButton still rejected (buy commit)", () => {
  expect(isSafeToClickForDiscovery("buyMaxButton")).toBe(false);
});

test("buyNormalButton rejected (tier choice → commits)", () => {
  expect(isSafeToClickForDiscovery("buyBonusButton__normalButton")).toBe(false);
});

test("superButton rejected (buy tier)", () => {
  expect(isSafeToClickForDiscovery("buyBonusButton__superButton")).toBe(false);
});

test("anteButton rejected (ante toggle changes next spin)", () => {
  expect(isSafeToClickForDiscovery("anteButton")).toBe(false);
});

// --- Unknown keys still skipped in PRODUCTION mode (default) ---

test("totally unknown key skipped in production (defensive default)", () => {
  expect(isSafeToClickForDiscovery("foobar_button_xyz")).toBe(false);
});

// --- Aggressive mode: skip narrows to CRITICAL_BLACKLIST only ---

test("aggressive mode: unknown key allowed", () => {
  process.env.QA_AGGRESSIVE_DISCOVER = "1";
  try {
    expect(isSafeToClickForDiscovery("foobar_button_xyz")).toBe(true);
    expect(isSafeToClickForDiscovery("autoButton__strangeNewWidget")).toBe(true);
  } finally {
    delete process.env.QA_AGGRESSIVE_DISCOVER;
  }
});

test("aggressive mode: critical blacklist still enforced", () => {
  process.env.QA_AGGRESSIVE_DISCOVER = "1";
  try {
    expect(isSafeToClickForDiscovery("spinButton")).toBe(false);
    expect(isSafeToClickForDiscovery("anyPopup__confirmButton")).toBe(false);
    expect(isSafeToClickForDiscovery("anyPopup__startButton")).toBe(false);
    expect(isSafeToClickForDiscovery("gambleButton")).toBe(false);
  } finally {
    delete process.env.QA_AGGRESSIVE_DISCOVER;
  }
});

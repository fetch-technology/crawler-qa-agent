// INVARIANT — popup-select ante detection (ante-normalize)
//
// Some games' "ante" is not a toggle: clicking the button (when OFF) opens a
// "SELECT A SPECIAL BET" chooser; you pick ANTE BET / SUPER SPIN to turn it ON.
// The probe click then leaves the bet unchanged (e.g. 7.5→7.5, the chooser's
// own base-bet stepper) — which previously read as a "no-change" FAIL and left
// the popup open. isSpecialBetPopupText recognises the chooser off its OCR text
// so normalize/ensureAnteOff can close it and treat the prior state as OFF.

import { test, expect } from "@playwright/test";
import { isSpecialBetPopupText } from "../../src/pipeline/step2-detect-ui/ante-normalize.ts";

test("recognises the SELECT A SPECIAL BET chooser title", () => {
  expect(isSpecialBetPopupText("SELECT A SPECIAL BET")).toBe(true);
});

test("recognises the chooser from its option labels (vs25tripleps)", () => {
  const ocr = "ANTE BET $15.00 HIGHER CHANCE TO WIN FEATURE SUPER SPIN $75.00 MONEY AND WILD ARE ACTIVE FRAMES ARE GUARANTEED BASE BET $7.50";
  expect(isSpecialBetPopupText(ocr)).toBe(true);
});

test("recognises the OFF-state entry button label", () => {
  // The small ante crop reads this when no special bet is selected.
  expect(isSpecialBetPopupText("SPECIAL BET 2 OPTIONS")).toBe(true);
});

test("does NOT match a plain ante toggle label", () => {
  // A single 'ante bet' hit with no second special-bet keyword is ambiguous —
  // must not be mistaken for the chooser (those games ARE toggles).
  expect(isSpecialBetPopupText("ANTE BET")).toBe(false);
  expect(isSpecialBetPopupText("BET BOOST +25%")).toBe(false);
  expect(isSpecialBetPopupText("ON")).toBe(false);
});

test("empty / whitespace OCR → not a popup", () => {
  expect(isSpecialBetPopupText("")).toBe(false);
  expect(isSpecialBetPopupText("   \n  ")).toBe(false);
});

test("case-insensitive", () => {
  expect(isSpecialBetPopupText("select a special bet")).toBe(true);
  expect(isSpecialBetPopupText("Super Spin ... Base Bet")).toBe(true);
});

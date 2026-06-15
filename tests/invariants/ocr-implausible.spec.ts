// INVARIANT — OCR plausibility gate (ocr-popup)
//
// isOcrReadImplausible decides when a deterministic (Tesseract) numeric read is
// "impossible for a correctly-rendered UI" → escalate to the AI-vision
// fallback. The threshold (100×) separates OCR FAILURE (dropped/duplicated
// digits → ≥100× off) from a REAL UI bug (stale / off-by-a-bet / cents / FX →
// within ~1–10×, must NOT be masked). `expected` is used only to decide
// re-read, never to pick the answer.

import { test, expect } from "@playwright/test";
import { isOcrReadImplausible, OCR_IMPLAUSIBLE_FACTOR } from "../../src/pipeline/utils/ocr-popup.ts";

test("the live failure: 3.257 vs network 983252.8 → implausible (≥100× off)", () => {
  expect(isOcrReadImplausible(3.257, 983252.8)).toBe(true);
});

test("parse failure (null) is always implausible", () => {
  expect(isOcrReadImplausible(null, 983252.8)).toBe(true);
  expect(isOcrReadImplausible(null, undefined)).toBe(true);
});

test("correct read is plausible", () => {
  expect(isOcrReadImplausible(983252.8, 983252.8)).toBe(false);
  expect(isOcrReadImplausible(45, 45)).toBe(false);
});

test("real UI bug within 10× is NOT masked (stays plausible → compared honestly)", () => {
  // stale balance off by a few bets, or a dropped single digit (~10×) — these
  // must be allowed through so the network comparison can FAIL on a real bug.
  expect(isOcrReadImplausible(983207.8, 983252.8)).toBe(false); // off by a bet
  expect(isOcrReadImplausible(98325.28, 983252.8)).toBe(false); // ~10× (one digit) — borderline, NOT escalated
});

test("exactly 100× off is implausible (boundary inclusive)", () => {
  expect(isOcrReadImplausible(9832.528, 983252.8)).toBe(true); // 100× → escalate
});

test("bet read off by 100× is implausible", () => {
  expect(isOcrReadImplausible(0.45, 45)).toBe(true);
  expect(isOcrReadImplausible(45, 45)).toBe(false);
});

test("read 0 when network is non-zero → implausible (off by ∞)", () => {
  expect(isOcrReadImplausible(0, 45)).toBe(true);
});

test("unknown/zero expected → cannot judge magnitude (only parse-failure counts)", () => {
  expect(isOcrReadImplausible(3.257, undefined)).toBe(false);
  expect(isOcrReadImplausible(123456, 0)).toBe(false); // win=0 idle widget — not judged here
});

test("too-few-digits vs a multi-digit expected → implausible", () => {
  // expected 6 digits; a 1–3 digit read is a dropped-digits failure even if
  // the ratio alone wouldn't trip (it does here too, but the digit tier is the
  // belt-and-suspenders).
  expect(isOcrReadImplausible(99, 983252)).toBe(true);
});

test("factor constant is 100", () => {
  expect(OCR_IMPLAUSIBLE_FACTOR).toBe(100);
});

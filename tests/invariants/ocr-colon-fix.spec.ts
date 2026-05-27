// INVARIANT — Tesseract colon-to-period normalization
//
// Tesseract often reads "." as ":" on small slot game fonts. Without
// normalization, `parseNumericFromOcr` regex stops at colon → loses the
// decimal portion of a balance.

import { test, expect } from "@playwright/test";
import { parseNumericFromOcr } from "../../src/pipeline/utils/ocr-popup.ts";

test("colon as decimal: '99998033:29' parses as 99998033.29", () => {
  // The exact bug reported by QA for vswaysmahwin2 balance widget.
  expect(parseNumericFromOcr("99998033:29")).toBe(99998033.29);
});

test("colon + currency + thousand separators: '$99,998,033:29 USD'", () => {
  expect(parseNumericFromOcr("$99,998,033:29 USD")).toBe(99998033.29);
});

test("real decimal point still works: '99,998,033.29'", () => {
  expect(parseNumericFromOcr("99,998,033.29")).toBe(99998033.29);
});

test("Swiss apostrophe thousand separator: '1'234.50' parses as 1234.50", () => {
  expect(parseNumericFromOcr("1'234.50")).toBe(1234.50);
});

test("integer-only balance still parses (no decimal at all): '99998033'", () => {
  expect(parseNumericFromOcr("99998033")).toBe(99998033);
});

test("negative balance: '-12.50' parses", () => {
  expect(parseNumericFromOcr("-12.50")).toBe(-12.5);
});

test("garbled text returns null", () => {
  expect(parseNumericFromOcr("|||abc|||")).toBeNull();
});

test("empty string returns null", () => {
  expect(parseNumericFromOcr("")).toBeNull();
});

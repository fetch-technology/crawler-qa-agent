// INVARIANT — region OCR numeric parser (Gap A)
//
// parseNumericFromOcr extracts a number from OCR'd text (balance widget,
// win amount, freeSpin counter). Must handle currency symbols, commas,
// whitespace, decimal points. Returns null when no number found.

import { test, expect } from "@playwright/test";
import { parseNumericFromOcr } from "../../src/pipeline/utils/ocr-popup.ts";

test("plain integer", () => {
  expect(parseNumericFromOcr("1000")).toBe(1000);
});

test("decimal number", () => {
  expect(parseNumericFromOcr("99.95")).toBe(99.95);
});

test("with USD prefix", () => {
  expect(parseNumericFromOcr("$1,234.56")).toBe(1234.56);
});

test("with euro symbol", () => {
  expect(parseNumericFromOcr("€999.80")).toBe(999.80);
});

test("with comma thousands separator", () => {
  expect(parseNumericFromOcr("99,999,123.45")).toBe(99999123.45);
});

test("VND (no decimal)", () => {
  expect(parseNumericFromOcr("₫1,000,000")).toBe(1000000);
});

test("with surrounding text", () => {
  expect(parseNumericFromOcr("Balance: $1,234")).toBe(1234);
});

test("multi-line text — picks first match", () => {
  expect(parseNumericFromOcr("Win: 50\nBet: 10")).toBe(50);
});

test("negative number", () => {
  expect(parseNumericFromOcr("-100")).toBe(-100);
});

test("empty string → null", () => {
  expect(parseNumericFromOcr("")).toBe(null);
});

test("non-numeric text → null", () => {
  expect(parseNumericFromOcr("free spins remaining")).toBe(null);
});

test("only spaces → null", () => {
  expect(parseNumericFromOcr("   ")).toBe(null);
});

test("OCR noise around number (typical Tesseract output)", () => {
  expect(parseNumericFromOcr("Bd ance: $99,999.80 CRD")).toBe(99999.80);
});

test("multiple decimals — picks first valid number", () => {
  expect(parseNumericFromOcr("99.95 (was 100.00)")).toBe(99.95);
});

test("zero", () => {
  expect(parseNumericFromOcr("0")).toBe(0);
});

test("zero with decimal", () => {
  expect(parseNumericFromOcr("0.00")).toBe(0);
});

// === Semicolon mis-OCR of thousands comma (2026-05-27) ===
// Tesseract sometimes reads the thousands "," as ";" (a comma with a stray
// dot). Without treating ";" as a group separator the regex stops at it.

test("REGRESSION: '$99,996;103.04' (semicolon thousands) → 99996103.04", () => {
  expect(parseNumericFromOcr("$99,996;103.04")).toBe(99996103.04);
});

test("semicolon-only grouping: '99;996;103' → 99996103", () => {
  expect(parseNumericFromOcr("99;996;103")).toBe(99996103);
});

test("mixed comma + semicolon grouping → stripped", () => {
  expect(parseNumericFromOcr("1,234;567.89")).toBe(1234567.89);
});

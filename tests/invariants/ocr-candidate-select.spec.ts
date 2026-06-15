// INVARIANT — numeric OCR ensemble decision layer (ocr-popup)
//
// ocrRegion runs several preprocessing strategies (raw + Otsu binarizations)
// over colored slot text on busy backgrounds, then picks the best read via
// selectBestOcrCandidate. Real Tesseract is exercised manually on live games;
// here we lock down the PURE decision + threshold logic so it can't regress.
//
// Motivating live failure (2026-06-15, vs10hottuna BRL):
//   - balance crop clearly "R$983,621.80" → single-pass Tesseract read just ","
//   - bet crop clearly "45.00"            → read "00" → parsed 0
// Binarization recovers the digits; consensus across strategies picks the
// correct value over a truncated/garbage raw read.

import { test, expect } from "@playwright/test";
import { selectBestOcrCandidate, otsuThreshold, pickLongestBand } from "../../src/pipeline/utils/ocr-popup.ts";

test("consensus: 2 strategies agree on 983621.80, raw garbage loses", () => {
  const best = selectBestOcrCandidate([
    { name: "raw", text: "," },
    { name: "lum-dark", text: "R$983,621.80" },
    { name: "warm", text: "983,621.80" },
  ]);
  expect(best.text).toBe("R$983,621.80"); // first of the 2 agreeing reads
});

test("bet: truncated raw '00'→0 loses to consensus '45.00'→45", () => {
  const best = selectBestOcrCandidate([
    { name: "raw", text: "00" },
    { name: "lum-dark", text: "45.00" },
    { name: "sat", text: "45.00" },
  ]);
  expect(best.text).toBe("45.00");
});

test("no consensus → most-digits finite read wins ('00' has fewer digits)", () => {
  const best = selectBestOcrCandidate([
    { name: "raw", text: "00" },
    { name: "warm", text: "45.00" },
  ]);
  expect(best.text).toBe("45.00");
});

test("clean raw with an agreeing binarization keeps the raw value (no regression)", () => {
  const best = selectBestOcrCandidate([
    { name: "raw", text: "$1,234.56" },
    { name: "lum-dark", text: "1234.56" },
  ]);
  // Both parse to 1234.56 → consensus → first (raw) returned.
  expect(best.text).toBe("$1,234.56");
});

test("absurd-length garbage (>12 digits) is dropped as noise", () => {
  const best = selectBestOcrCandidate([
    { name: "raw", text: "45.00" },
    { name: "sat", text: "9999999999999999" }, // 16 digits → noise
  ]);
  expect(best.text).toBe("45.00");
});

test("nothing parses → first non-empty text returned (caller fails loud)", () => {
  const best = selectBestOcrCandidate([
    { name: "raw", text: "" },
    { name: "lum-dark", text: "~~" },
    { name: "warm", text: "::" },
  ]);
  expect(best.text).toBe("~~");
});

test("empty candidate list → empty text", () => {
  expect(selectBestOcrCandidate([]).text).toBe("");
});

// --- Otsu threshold ---

test("otsu: clean bimodal histogram returns a threshold that separates the peaks", () => {
  const hist = new Array<number>(256).fill(0);
  hist[30] = 500;  // dark cluster
  hist[220] = 500; // bright cluster
  const thr = otsuThreshold(hist, 1000);
  // Any threshold in [30, 219] separates the two clusters (dark ≤ thr < bright).
  // Ties on equal-mass clusters resolve to the lower bound (30) by design.
  expect(thr).toBeGreaterThanOrEqual(30);
  expect(thr).toBeLessThan(220);
});

test("otsu: empty histogram → safe default 127", () => {
  expect(otsuThreshold(new Array<number>(256).fill(0), 0)).toBe(127);
});

// --- content-band selection (noise-band trim) ---
// Motivating failure: a WHITE balance crop binarizes with a jagged noise band
// bleeding in from the photographic background. Tesseract reads the band + the
// digits as one line → "$983,252.80" → "0003.257". pickLongestBand isolates
// the glyph-density rows from both empty (background) and near-solid (noise
// band / filled bar) rows.

test("isolates the text band from empty margins above and below", () => {
  // rows 0–2 empty, 3–7 glyph-like, 8–9 empty
  const frac = [0, 0.01, 0.0, 0.3, 0.35, 0.28, 0.32, 0.3, 0.0, 0.01];
  expect(pickLongestBand(frac, 0.03, 0.92)).toEqual([3, 7]);
});

test("excludes a near-solid noise band (≈100% ink) sitting above the digits", () => {
  // row 0 is a solid noise band (0.98), 1 empty, 2–5 are the digit rows
  const frac = [0.98, 0.0, 0.3, 0.33, 0.29, 0.31];
  expect(pickLongestBand(frac, 0.03, 0.92)).toEqual([2, 5]);
});

test("returns null when no row is glyph-like (all empty or all solid)", () => {
  expect(pickLongestBand([0, 0, 0.99, 1, 0], 0.03, 0.92)).toBeNull();
});

test("longest band wins when two glyph-like runs exist", () => {
  // short run 1–2, longer run 5–9
  const frac = [0, 0.3, 0.3, 0, 0, 0.3, 0.3, 0.3, 0.3, 0.3];
  expect(pickLongestBand(frac, 0.03, 0.92)).toEqual([5, 9]);
});

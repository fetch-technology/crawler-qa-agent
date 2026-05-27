// INVARIANT — OCR UI element matcher
//
// Validates the pure matching layer of ocr-strategy without spinning up
// Tesseract. Real Tesseract integration is tested manually on real slot
// games; here we lock down the keyword + confidence + bbox logic so it
// can't silently regress.

import { test, expect } from "@playwright/test";
import { pickBestWordForKind, type OcrWord } from "../../src/pipeline/step2-detect-ui/ocr-strategy.ts";

function word(text: string, confidence: number, x = 100, y = 200, w = 50, h = 20): OcrWord {
  return { text, confidence, bbox: { x0: x, y0: y, x1: x + w, y1: y + h } };
}

test("buyBonusButton: matches 'BUY BONUS' label", () => {
  const words = [word("BUY", 85), word("BONUS", 87, 200, 200)];
  const best = pickBestWordForKind("buyBonusButton", words);
  expect(best).not.toBeNull();
  // BONUS scores higher (87 vs 85) → bbox at x=200
  expect(best!.text).toBe("BONUS");
});

test("autoButton: matches 'AUTOPLAY'", () => {
  const words = [word("AUTOPLAY", 92)];
  const best = pickBestWordForKind("autoButton", words);
  expect(best).not.toBeNull();
  expect(best!.text).toBe("AUTOPLAY");
});

test("paytableButton: matches lowercase 'paytable'", () => {
  const words = [word("paytable", 80)];
  expect(pickBestWordForKind("paytableButton", words)?.text).toBe("paytable");
});

test("paytableButton: matches 'Pay Table' (with space)", () => {
  // Tesseract often groups "Pay Table" into 2 words. The matcher uses
  // substring on per-word text; "Table" doesn't match "pay table". The case
  // "Pay" alone doesn't match either. Real Tesseract on this label would
  // emit each word separately → expect no match. This is intentional:
  // multi-word labels need refinement (line-level matching) later.
  const words = [word("Pay", 80), word("Table", 82)];
  const best = pickBestWordForKind("paytableButton", words);
  expect(best).toBeNull();
});

test("rejects below-confidence matches", () => {
  const words = [word("history", 40)]; // below default min 60
  expect(pickBestWordForKind("historyButton", words)).toBeNull();
});

test("unknown elementKind → null", () => {
  expect(pickBestWordForKind("nonExistentKey", [word("spin", 95)])).toBeNull();
});

test("no match in words list → null", () => {
  const words = [word("balance", 95), word("$100.00", 90)];
  expect(pickBestWordForKind("spinButton", words)).toBeNull();
});

test("picks HIGHEST-confidence match when multiple words match", () => {
  const words = [
    word("history", 65, 100, 100),
    word("history", 90, 300, 100), // duplicate label, more confident
    word("history", 70, 500, 100),
  ];
  const best = pickBestWordForKind("historyButton", words);
  expect(best?.bbox.x0).toBe(300);
});

test("custom minConfidence threshold honored", () => {
  const words = [word("turbo", 50)];
  expect(pickBestWordForKind("turboButton", words, 40)).not.toBeNull();
  expect(pickBestWordForKind("turboButton", words, 60)).toBeNull();
});

test("buy keyword alone (without 'bonus') still matches buyBonusButton", () => {
  // PP buy popup often shows just "BUY" then a price below
  const words = [word("BUY", 78)];
  expect(pickBestWordForKind("buyBonusButton", words)?.text).toBe("BUY");
});

test("case-insensitive: lowercase/uppercase/mixed all match", () => {
  expect(pickBestWordForKind("spinButton", [word("SPIN", 85)])?.text).toBe("SPIN");
  expect(pickBestWordForKind("spinButton", [word("Spin", 85)])?.text).toBe("Spin");
  expect(pickBestWordForKind("spinButton", [word("spin", 85)])?.text).toBe("spin");
});

// INVARIANT — state observer multi-signal classification (Phase 8.3)
//
// `classify` is the pure decision function inside the state observer.
// Given a set of signals (API state, OCR keywords, overlay, signatures),
// it must produce a deterministic ObservedState verdict with confidence.
//
// Tests check that:
//   - Each canonical state can be reached from at least one signal combo
//   - Higher-priority signals win when multiple agree
//   - UNKNOWN is reached when no signal classifies
//   - Custom signatures override OCR-based classification

import { test, expect } from "@playwright/test";
import { classify } from "../../src/pipeline/step8-run-scenarios/state-observer.ts";

test("no signals at all → MAIN with low-mid confidence", () => {
  const r = classify({});
  expect(r.state).toBe("MAIN");
  expect(r.confidence).toBeGreaterThan(0.5);
});

test("API state = FREE_SPIN → FREE_SPIN with high confidence", () => {
  const r = classify({ apiState: "FREE_SPIN" });
  expect(r.state).toBe("FREE_SPIN");
  expect(r.confidence).toBeGreaterThan(0.85);
});

test("free spins remaining > 0 → FREE_SPIN (even without explicit state)", () => {
  const r = classify({ apiFreeSpinsRemaining: 5 });
  expect(r.state).toBe("FREE_SPIN");
});

test("API state = BONUS → BONUS_POPUP", () => {
  const r = classify({ apiState: "BONUS" });
  expect(r.state).toBe("BONUS_POPUP");
});

test("OCR 'big win' → BIG_WIN_POPUP", () => {
  const r = classify({ ocrMatched: ["big win"] });
  expect(r.state).toBe("BIG_WIN_POPUP");
});

test("OCR 'mega win' → BIG_WIN_POPUP", () => {
  const r = classify({ ocrMatched: ["mega win"] });
  expect(r.state).toBe("BIG_WIN_POPUP");
});

test("OCR 'free spins' + 'congratulations' → FREE_SPIN_TRIGGERED", () => {
  const r = classify({ ocrMatched: ["free spins", "congratulations"] });
  expect(r.state).toBe("FREE_SPIN_TRIGGERED");
});

test("OCR 'free spins' + 'press anywhere' → FREE_SPIN_TRIGGERED", () => {
  const r = classify({ ocrMatched: ["free spins", "press anywhere"] });
  expect(r.state).toBe("FREE_SPIN_TRIGGERED");
});

test("OCR 'paytable' → PAYTABLE_POPUP", () => {
  const r = classify({ ocrMatched: ["paytable"] });
  expect(r.state).toBe("PAYTABLE_POPUP");
});

test("OCR 'pay table' (with space) → PAYTABLE_POPUP", () => {
  const r = classify({ ocrMatched: ["pay table"] });
  expect(r.state).toBe("PAYTABLE_POPUP");
});

test("OCR 'autoplay' label ALONE (permanent main-screen button) → NOT AUTOPLAY_POPUP", () => {
  // False positive on games (Gates of Olympus) that always render an AUTOPLAY
  // button on main. A bare label with no dialog phrase + no overlay = on main.
  const r = classify({ ocrMatched: ["autoplay"] });
  expect(r.state).toBe("MAIN");
});

test("OCR 'autoplay' + dialog phrase 'number of spins' → AUTOPLAY_POPUP", () => {
  const r = classify({ ocrMatched: ["autoplay", "number of spins"] });
  expect(r.state).toBe("AUTOPLAY_POPUP");
});

test("OCR 'autoplay' label + dark overlay → AUTOPLAY_POPUP (overlay corroborates)", () => {
  const r = classify({ ocrMatched: ["autoplay"], darkOverlay: true });
  expect(r.state).toBe("AUTOPLAY_POPUP");
});

test("OCR 'loss limit' (autoplay dialog phrase) → AUTOPLAY_POPUP", () => {
  const r = classify({ ocrMatched: ["loss limit"] });
  expect(r.state).toBe("AUTOPLAY_POPUP");
});

test("OCR 'buy feature' → BUY_FEATURE_POPUP", () => {
  const r = classify({ ocrMatched: ["buy feature"] });
  expect(r.state).toBe("BUY_FEATURE_POPUP");
});

test("OCR 'history' → HISTORY_POPUP", () => {
  const r = classify({ ocrMatched: ["history"] });
  expect(r.state).toBe("HISTORY_POPUP");
});

test("OCR generic 'congratulations' (no FREE SPIN) → BIG_WIN_POPUP low confidence", () => {
  const r = classify({ ocrMatched: ["congratulations"] });
  expect(r.state).toBe("BIG_WIN_POPUP");
  expect(r.confidence).toBeLessThan(0.85);
});

test("dark overlay alone (no keywords) → UNKNOWN", () => {
  const r = classify({ darkOverlay: true });
  expect(r.state).toBe("UNKNOWN");
  expect(r.confidence).toBeLessThan(0.5);
});

test("custom signature match → uses that signature's label", () => {
  const r = classify({ signatureMatched: "BIG_WIN_POPUP" });
  expect(r.state).toBe("BIG_WIN_POPUP");
  expect(r.confidence).toBeGreaterThan(0.9);
});

test("custom signature with non-canonical name → UNKNOWN", () => {
  const r = classify({ signatureMatched: "WEIRD_GAME_SPECIFIC_POPUP" });
  expect(r.state).toBe("UNKNOWN");
});

test("API FREE_SPIN beats OCR 'paytable' (API state wins priority)", () => {
  const r = classify({ apiState: "FREE_SPIN", ocrMatched: ["paytable"] });
  expect(r.state).toBe("FREE_SPIN");
});

test("Signature beats API + OCR (highest precedence)", () => {
  const r = classify({
    signatureMatched: "BIG_WIN_POPUP",
    apiState: "FREE_SPIN",
    ocrMatched: ["paytable"],
  });
  expect(r.state).toBe("BIG_WIN_POPUP");
});

test("classify is deterministic — same input twice → same output", () => {
  const a = classify({ apiState: "FREE_SPIN", ocrMatched: ["free spins"] });
  const b = classify({ apiState: "FREE_SPIN", ocrMatched: ["free spins"] });
  expect(a).toEqual(b);
});

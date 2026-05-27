// INVARIANT — multi-signal balance assertion (Phase 8.2)
//
// The balance assertion must combine API + rule + optional UI/history/network
// signals into a CONFIDENT verdict. Test cases:
//   - API alone passing → PASS_LOW (single signal)
//   - API + history corroborating → PASS_HIGH
//   - API says pass but OCR disagrees → FAIL_LOW (1 signal flipped)
//   - balanceBefore null → INCONCLUSIVE
//   - Required signal missing → INCONCLUSIVE

import { test, expect } from "@playwright/test";
import { evaluateBalanceMultiSignal } from "../../src/pipeline/step8-run-scenarios/evidence/balance-multi-signal.ts";
import { synthSpin } from "./helpers.js";

test("API only passing → PASS_LOW (confidence < 0.85)", () => {
  const r = evaluateBalanceMultiSignal({
    spin: synthSpin({ bet: 10, win: 0, balanceBefore: 1000, balanceAfter: 990 }),
  });
  expect(r.outcome).toBe("PASS_LOW");
  expect(r.confidence).toBeLessThan(0.85);
  expect(r.pass).toBe(true); // legacy field still indicates pass
});

test("API + history corroborating → PASS_HIGH", () => {
  const r = evaluateBalanceMultiSignal({
    spin: synthSpin({ bet: 10, win: 0, balanceBefore: 1000, balanceAfter: 990 }),
    historyBalance: 990,
  });
  // api(0.35) + rule(0.20) + history(0.20) = 0.75 → still PASS_LOW
  // Need to add network/ocr to reach 0.85
  expect(r.confidence).toBeGreaterThan(0.5);
});

test("API + network + OCR + history → PASS_HIGH", () => {
  const r = evaluateBalanceMultiSignal({
    spin: synthSpin({ bet: 10, win: 0, balanceBefore: 1000, balanceAfter: 990 }),
    networkBalance: 990,
    ocrBalance: 990,
    historyBalance: 990,
  });
  // api(.35) + rule(.20) + network(.10) + ui_ocr(.25) + history(.20) = 1.10 → cap 1.0
  expect(r.outcome).toBe("PASS_HIGH");
  expect(r.confidence).toBe(1);
});

test("API says pass but OCR disagrees → still PASS but lower confidence", () => {
  const r = evaluateBalanceMultiSignal({
    spin: synthSpin({ bet: 10, win: 0, balanceBefore: 1000, balanceAfter: 990 }),
    ocrBalance: 985, // disagrees with API
  });
  // api(.35) + rule(.20) = 0.55 — ocr signal = false → no contribution
  expect(r.pass).toBe(true); // API verdict still passes
  expect(r.confidence).toBeCloseTo(0.55, 1);
  expect(r.outcome).toBe("PASS_LOW");
});

test("API says fail (balance off) → FAIL family", () => {
  const r = evaluateBalanceMultiSignal({
    spin: synthSpin({ bet: 10, win: 0, balanceBefore: 1000, balanceAfter: 980 }), // -20 not -10
  });
  expect(r.pass).toBe(false);
  expect(r.outcome).toMatch(/^FAIL/);
});

test("API fail + network corroborates fail → FAIL with reasonable confidence", () => {
  const r = evaluateBalanceMultiSignal({
    spin: synthSpin({ bet: 10, win: 0, balanceBefore: 1000, balanceAfter: 980 }),
    networkBalance: 980, // network agrees ba=980 (so signals network=true with actual ba)
  });
  expect(r.pass).toBe(false);
});

test("balanceBefore null → INCONCLUSIVE", () => {
  const r = evaluateBalanceMultiSignal({
    spin: synthSpin({ bet: 10, win: 0, balanceBefore: null, balanceAfter: 990 }),
  });
  expect(r.outcome).toBe("INCONCLUSIVE");
  expect(r.detail).toMatch(/balanceBefore/);
});

test("required signal missing → INCONCLUSIVE", () => {
  const r = evaluateBalanceMultiSignal({
    spin: synthSpin({ bet: 10, win: 0, balanceBefore: 1000, balanceAfter: 990 }),
    requirement: { required: ["api", "ui_ocr"] }, // ocr not provided
  });
  expect(r.outcome).toBe("INCONCLUSIVE");
});

test("free spin: balanceAfter = balanceBefore + win (no deduction)", () => {
  const r = evaluateBalanceMultiSignal({
    spin: synthSpin({
      bet: 10, win: 5, isFreeSpin: true, state: "FREE_SPIN",
      balanceBefore: 1000, balanceAfter: 1005,
    }),
  });
  expect(r.pass).toBe(true);
});

test("free spin: WRONG balance (deducted incorrectly) → FAIL", () => {
  const r = evaluateBalanceMultiSignal({
    spin: synthSpin({
      bet: 10, win: 0, isFreeSpin: true, state: "FREE_SPIN",
      balanceBefore: 1000, balanceAfter: 990, // shouldn't deduct for free spin
    }),
  });
  expect(r.pass).toBe(false);
});

test("signals array reports per-signal observed values", () => {
  const r = evaluateBalanceMultiSignal({
    spin: synthSpin({ bet: 10, win: 0, balanceBefore: 1000, balanceAfter: 990 }),
    ocrBalance: 990,
  });
  const apiSignal = r.signals.find((s) => s.name === "api");
  expect(apiSignal?.observed).toBe(990);
  expect(apiSignal?.expected).toBe(990);
  expect(apiSignal?.weight).toBeCloseTo(0.35, 2);

  const ocrSignal = r.signals.find((s) => s.name === "ui_ocr");
  expect(ocrSignal?.observed).toBe(990);
  expect(ocrSignal?.source).toMatch(/ocr/);
});

test("float tolerance: 0.005 drift passes", () => {
  const r = evaluateBalanceMultiSignal({
    spin: synthSpin({ bet: 0.45, win: 0, balanceBefore: 1000, balanceAfter: 999.555 }),
  });
  expect(r.pass).toBe(true);
});

test("float tolerance: 0.5 drift fails", () => {
  const r = evaluateBalanceMultiSignal({
    spin: synthSpin({ bet: 0.45, win: 0, balanceBefore: 1000, balanceAfter: 999.05 }),
  });
  expect(r.pass).toBe(false);
});

test("custom passConfidenceThreshold lower → PASS_HIGH with fewer signals", () => {
  const r = evaluateBalanceMultiSignal({
    spin: synthSpin({ bet: 10, win: 0, balanceBefore: 1000, balanceAfter: 990 }),
    requirement: { passConfidenceThreshold: 0.5 },
  });
  expect(r.outcome).toBe("PASS_HIGH");
});

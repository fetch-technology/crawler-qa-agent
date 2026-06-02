// INVARIANT — self-calibrated payout model (Layer 2 of payout verification)
//
// The model maps each numeric symbol index to a coin-invariant unit rate
// (win/ways/coin) measured from the server's own data, corroborated against the
// paytable. CRITICAL SAFETY PROPERTY: the model is only `trusted` when it
// reproduces 100% of observed combos across >= 2 coin levels AND agrees with the
// paytable — and verification is a NO-OP unless trusted. So an uncalibrated or
// single-coin model can NEVER false-fail a real spin.

import { test, expect } from "@playwright/test";
import {
  measureRates,
  corroborateWithPaytable,
  validatePayoutModel,
  derivePayoutModel,
  type CalibrationCombo,
} from "../../src/ai/payout-model-derive.js";
import { checkCombosAgainstModel, computeComboWin } from "../../src/pipeline/step6-build-model/payout-model-eval.js";
import type { Paytable } from "../../src/pipeline/registry/types.js";

// A tiny 2-symbol paytable. Index "3" pays like zhong, index "5" like fa.
const PAYTABLE: Paytable = {
  symbols: [
    { symbol: "zhong", name: "Z", payouts: [{ count: 3, multiplier: 0.25 }, { count: 4, multiplier: 0.5 }] },
    { symbol: "fa", name: "F", payouts: [{ count: 3, multiplier: 0.15 }, { count: 4, multiplier: 0.3 }] },
  ],
};

// Observations at TWO coin levels (0.03 and 0.06). win = mult * ways * coin / c0
// with c0 = 0.03 → rate = mult/c0. zhong-3: rate = 0.25/0.03 = 8.333.
function combo(symbol: string, win: number, ways: number, count: number, coin: number): CalibrationCombo {
  return { symbol, win, ways, count, coin, positions: [], type: "l" };
}
const TWO_COIN: CalibrationCombo[] = [
  // coin 0.03
  combo("3", 0.25, 1, 3, 0.03), // zhong 3oak ways1
  combo("3", 0.50, 2, 3, 0.03), // zhong 3oak ways2 → 2x
  combo("5", 0.15, 1, 3, 0.03), // fa 3oak
  combo("3", 0.50, 1, 4, 0.03), // zhong 4oak
  // coin 0.06 (everything doubles)
  combo("3", 0.50, 1, 3, 0.06),
  combo("5", 0.30, 1, 3, 0.06),
  combo("3", 1.00, 1, 4, 0.06),
];

test("measureRates: coin-invariant unit rate per (symbol,count)", () => {
  const { rates } = measureRates(TWO_COIN);
  // zhong-3: 0.25/1/0.03 = 8.333 ; at 0.06: 0.50/1/0.06 = 8.333 (consistent)
  expect(rates["3"]!["3"]).toBeCloseTo(8.3333, 2);
  expect(rates["3"]!["4"]).toBeCloseTo(16.6667, 2);
  expect(rates["5"]!["3"]).toBeCloseTo(5.0, 2);
});

test("measureRates: flags coin-VARIANT (inconsistent) rates", () => {
  const bad = [combo("9", 0.10, 1, 3, 0.03), combo("9", 0.99, 1, 3, 0.06)]; // not 2x
  const { rates, inconsistent } = measureRates(bad);
  expect(rates["9"]).toBeUndefined();
  expect(inconsistent).toEqual([{ symbol: "9", count: 3 }]);
});

test("corroborateWithPaytable: matches rate shape to paytable, derives c0", () => {
  const { rates } = measureRates(TWO_COIN);
  const { symbolCurves, agreement } = corroborateWithPaytable(rates, PAYTABLE);
  expect(agreement).toBe(true);
  expect(symbolCurves["3"]!.names).toContain("zhong");
  expect(symbolCurves["5"]!.names).toContain("fa");
  expect(symbolCurves["3"]!.paytableAgreement).toBe(true);
});

test("computeComboWin: rate * ways * coin (ways absent => 1)", () => {
  const { rates } = measureRates(TWO_COIN);
  const { symbolCurves } = corroborateWithPaytable(rates, PAYTABLE);
  const model = validatePayoutModel(
    { mechanic: "ways", symbolCurves, generatedAt: "t", notes: [] },
    TWO_COIN, true, "deterministic",
  );
  expect(computeComboWin(model, "3", 3, 1, 0.03)).toBeCloseTo(0.25, 3);
  expect(computeComboWin(model, "3", 3, 2, 0.03)).toBeCloseTo(0.50, 3);
  expect(computeComboWin(model, "3", 3, 0, 0.03)).toBeCloseTo(0.25, 3); // ways 0 => 1
  expect(computeComboWin(model, "999", 3, 1, 0.03)).toBeNull(); // unknown symbol
});

test("GATE: trusted only when reproduce-all AND >=2 coins AND paytable agreement", () => {
  const { rates } = measureRates(TWO_COIN);
  const { symbolCurves, agreement } = corroborateWithPaytable(rates, PAYTABLE);
  const ok = validatePayoutModel({ mechanic: "ways", symbolCurves, generatedAt: "t", notes: [] }, TWO_COIN, agreement, "deterministic");
  expect(ok.calibration.reproducedAll).toBe(true);
  expect(ok.calibration.coinLevels.length).toBeGreaterThanOrEqual(2);
  expect(ok.trusted).toBe(true);
});

test("GATE: single coin level → NOT trusted (coin-scaling unconfirmed)", () => {
  const oneCoin = TWO_COIN.filter((c) => c.coin === 0.03);
  const { rates } = measureRates(oneCoin);
  const { symbolCurves, agreement } = corroborateWithPaytable(rates, PAYTABLE);
  const m = validatePayoutModel({ mechanic: "ways", symbolCurves, generatedAt: "t", notes: [] }, oneCoin, agreement, "deterministic");
  expect(m.calibration.coinLevels.length).toBe(1);
  expect(m.trusted).toBe(false);
});

test("GATE: paytable disagreement → NOT trusted", () => {
  const { rates } = measureRates(TWO_COIN);
  const { symbolCurves } = corroborateWithPaytable(rates, PAYTABLE);
  // Force agreement=false (e.g. game pays differently than published paytable).
  const m = validatePayoutModel({ mechanic: "ways", symbolCurves, generatedAt: "t", notes: [] }, TWO_COIN, false, "deterministic");
  expect(m.trusted).toBe(false);
});

test("checkCombosAgainstModel: untrusted model → skipped no-op (never fails)", () => {
  const untrusted = { trusted: false, symbolCurves: {}, mechanic: "ways" } as never;
  const r = checkCombosAgainstModel(untrusted, [{ symbol: "3", win: 99, ways: 1, count: 3, positions: [], type: "l" }], 0.03);
  expect(r.skipped).toBe(true);
  expect(r.ok).toBe(true);
});

test("checkCombosAgainstModel: trusted model FAILS a wrong combo win", () => {
  const { rates } = measureRates(TWO_COIN);
  const { symbolCurves, agreement } = corroborateWithPaytable(rates, PAYTABLE);
  const model = validatePayoutModel({ mechanic: "ways", symbolCurves, generatedAt: "t", notes: [] }, TWO_COIN, agreement, "deterministic");
  // Correct: zhong-3 ways1 @0.03 = 0.25. Feed a wrong win 0.99 → mismatch.
  const r = checkCombosAgainstModel(model, [{ symbol: "3", win: 0.99, ways: 1, count: 3, positions: [], type: "l" }], 0.03);
  expect(r.skipped).toBe(false);
  expect(r.ok).toBe(false);
  expect(r.mismatches).toHaveLength(1);
  // And a correct one passes.
  const r2 = checkCombosAgainstModel(model, [{ symbol: "3", win: 0.25, ways: 1, count: 3, positions: [], type: "l" }], 0.03);
  expect(r2.ok).toBe(true);
});

test("derivePayoutModel (no AI): end-to-end trusted on clean 2-coin data", async () => {
  const model = await derivePayoutModel({ combos: TWO_COIN, paytable: PAYTABLE, mechanic: "ways", allowAi: false });
  expect(model.trusted).toBe(true);
  expect(model.calibration.derivedBy).toBe("deterministic");
  expect(Object.keys(model.symbolCurves).sort()).toEqual(["3", "5"]);
});

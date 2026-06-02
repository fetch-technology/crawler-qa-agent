// Pure evaluation of a self-calibrated PayoutModel against observed win combos.
//
// SAME formula is used by (a) the calibration self-validation gate and (b) the
// runtime payout-integrity check — so a model that passes calibration verifies
// identically at run time. No AI, no I/O: safe inside assertion sandboxes.
//
// Predicted combo win = rate[count] * ways * coin.
// `rate` is the coin-INVARIANT unit rate (win / ways / coin) measured from the
// server's own data during calibration and confirmed to match the published
// paytable (within 2dp rounding). Measuring the rate — rather than plugging the
// rounded paytable multiplier into a formula — means verification never
// false-fails on paytable display rounding, yet still effectively checks
// against the paytable because the rate was gated to agree with it.

import type { PayoutModel } from "../registry/types.js";
import type { WinCombo } from "./win-breakdown.js";

export const PAYOUT_TOLERANCE = 0.01;

/**
 * Predict a single combo's win from the model, or null when the model can't
 * speak to it (unknown symbol index, missing count tier, bad coin) — null means
 * "skip this combo", never "fail". `ways` absent/0 is treated as 1.
 */
export function computeComboWin(
  model: PayoutModel,
  symbol: string,
  count: number,
  ways: number,
  coin: number,
): number | null {
  const sc = model.symbolCurves[symbol];
  if (!sc) return null;
  const rate = sc.curve[String(count)];
  if (typeof rate !== "number" || !Number.isFinite(rate)) return null;
  if (!Number.isFinite(coin) || coin <= 0) return null;
  const w = Number.isFinite(ways) && ways > 0 ? ways : 1;
  return rate * w * coin;
}

export type PayoutCheckResult = {
  /** true = every checkable combo matched (or nothing checkable). */
  ok: boolean;
  /** true = model absent/untrusted → verification skipped (NOT a failure). */
  skipped: boolean;
  reason?: string;
  checked: number;
  matched: number;
  mismatches: Array<{
    symbol: string;
    count: number;
    ways: number;
    coin: number;
    expected: number;
    actual: number;
    delta: number;
  }>;
};

/**
 * Check a round's combos against the model. Combos the model can't predict are
 * skipped (not failed). Returns ok=true & skipped=true when the model is
 * missing/untrusted — so an uncalibrated game never false-fails.
 */
export function checkCombosAgainstModel(
  model: PayoutModel | null | undefined,
  combos: ReadonlyArray<WinCombo> | null | undefined,
  coin: number,
  tol: number = PAYOUT_TOLERANCE,
): PayoutCheckResult {
  if (!model || model.trusted !== true) {
    return { ok: true, skipped: true, reason: "no trusted payout model", checked: 0, matched: 0, mismatches: [] };
  }
  const list = Array.isArray(combos) ? combos : [];
  const mismatches: PayoutCheckResult["mismatches"] = [];
  let checked = 0;
  let matched = 0;
  for (const c of list) {
    const expected = computeComboWin(model, c.symbol, c.count, c.ways, coin);
    if (expected == null) continue; // model can't predict → skip, don't fail
    checked++;
    const delta = Math.abs(expected - c.win);
    if (delta <= tol) matched++;
    else mismatches.push({ symbol: c.symbol, count: c.count, ways: c.ways, coin, expected, actual: c.win, delta });
  }
  return { ok: mismatches.length === 0, skipped: checked === 0, checked, matched, mismatches };
}

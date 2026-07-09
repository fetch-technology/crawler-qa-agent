// Pure helpers exposed to custom_assertion check_code at runtime.
//
// Phase 11.1 — close the vocab gap between the catalog generator's EXPAND
// prompt (which promises these helpers exist) and the runtime binding
// (which previously only had spin/previousSpin/collector + an identity
// `getRoundEndSpins`). Re-implemented inline here so the case-executor
// doesn't need to import the legacy runner/test-harness.ts module
// (which pulls heavy Playwright deps).
//
// Each helper is pure (no I/O, no async, deterministic) → safe to expose
// inside `new Function(...)` sandboxes.

import type { WinCombo } from "../step6-build-model/win-breakdown.js";
import { sumWinCombos } from "../step6-build-model/win-breakdown.js";
import { checkCombosAgainstModel, type PayoutCheckResult } from "../step6-build-model/payout-model-eval.js";
import type { PayoutModel } from "../registry/types.js";

/** Loose spin shape — assertions are JS predicates run on adapted spins. */
type LooseSpin = Record<string, unknown>;

/**
 * Pick out the spins that represent the END of a logical round. Cascade /
 * cluster games emit MANY responses per click; only the final frame holds
 * the canonical round outcome. Strategy:
 *
 *   1. If any spin has explicit `isEndRound === true` → return those only.
 *   2. Else group by `round` / `roundId` and return the LAST entry per group.
 *   3. Else (no flags, no round key) → treat every spin as its own round.
 *
 * NOTE: For PP cascade games the cascade-dedup module already collapses
 * cascade frames into single entries before assertions run, so this helper
 * typically returns the input unchanged. Still useful for providers whose
 * dedup is partial.
 */
export function getRoundEndSpins(spins: LooseSpin[]): LooseSpin[] {
  if (!Array.isArray(spins) || spins.length === 0) return [];

  const flagged = spins.filter((s) => s?.isEndRound === true);
  if (flagged.length > 0) return flagged;

  const roundKey = (s: LooseSpin): string | null => {
    const r = s?.round ?? s?.roundId ?? s?.id;
    return typeof r === "string" || typeof r === "number" ? String(r) : null;
  };
  const haveKey = spins.some((s) => roundKey(s) != null);
  if (haveKey) {
    const out: LooseSpin[] = [];
    for (let i = 0; i < spins.length; i++) {
      const cur = roundKey(spins[i]!);
      const next = i + 1 < spins.length ? roundKey(spins[i + 1]!) : null;
      if (cur !== next) out.push(spins[i]!);
    }
    if (out.length > 0) return out;
  }

  return spins;
}

/**
 * Read the LATEST balance the collector has observed. Falls back to null
 * when no spins or balances available. Useful when an assertion needs a
 * stable balance reference but doesn't want to assume `spin.endingBalance`
 * is the most recent.
 */
export function getCurrentBalance(
  collector: { spins: LooseSpin[] } | undefined,
): number | null {
  if (!collector || !Array.isArray(collector.spins) || collector.spins.length === 0) {
    return null;
  }
  const last = collector.spins[collector.spins.length - 1] as LooseSpin;
  const ending = last?.endingBalance ?? last?.balanceAfter ?? last?.balance;
  return typeof ending === "number" ? ending : null;
}

function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function deriveBaseBetFromRaw(spin: LooseSpin): number | null {
  const raw = spin.raw as Record<string, unknown> | undefined;
  if (!raw) return null;
  const c = toFiniteNumber(raw["c"]);
  if (c == null || c <= 0) return null;
  const bl = toFiniteNumber(raw["bl"]);
  if (bl != null && bl > 0) return Math.round(c * bl * 100) / 100;
  const l = toFiniteNumber(raw["l"]);
  if (l != null && l > 0) return Math.round(c * l * 100) / 100;
  return null;
}

/**
 * Detect a buy-feature deduction: returns the first round AFTER `startIndex`
 * whose effective bet (balance drop + win) is significantly larger than the
 * base spin bet. Catalog assertions check the `ratio` field to confirm a
 * buy actually happened (e.g. `ratio >= 50` for "buy 50× base bet").
 *
 * Returns null when:
 *   - no round-end spins after startIndex
 *   - balanceBefore can't be resolved (no caller hint + no prior spin)
 *   - first end-spin doesn't expose endingBalance
 */
export function detectBuyFeatureDeduction(
  spins: LooseSpin[],
  startIndex = 0,
  balanceBefore?: number | null,
): {
  deduction: number;
  baseBet: number;
  ratio: number;
  spin: LooseSpin;
} | null {
  if (!Array.isArray(spins)) return null;
  const after = spins.slice(startIndex);
  const ends = getRoundEndSpins(after);
  if (ends.length === 0) return null;
  const first = ends[0]!;
  const parsedBaseBet = typeof first.betAmount === "number"
    ? (first.betAmount as number)
    : typeof first.bet === "number" ? (first.bet as number) : 0;
  const win = typeof first.winAmount === "number"
    ? (first.winAmount as number)
    : typeof first.win === "number" ? (first.win as number) : 0;

  let before = typeof balanceBefore === "number" ? balanceBefore : null;
  if (before == null && startIndex > 0) {
    const prior = spins[startIndex - 1];
    const v = prior?.endingBalance ?? prior?.balanceAfter ?? prior?.balance;
    if (typeof v === "number") before = v;
  }
  const afterBalance = first.endingBalance ?? first.balanceAfter ?? first.balance;
  if (before == null || typeof afterBalance !== "number") return null;

  // Add back only a CREDITED (positive) win so a buy spin that ALSO pays a
  // small line win still measures the full cash outflow. A NEGATIVE winAmount
  // means the parser folded the buy cost itself into `win` (PP buy spins emit
  // win = -(buyCost - baseBet)) — that outflow is already captured by
  // (before - afterBalance), so adding it back would cancel it out and yield
  // ratio ≈ 1, false-failing the buy-cost assertion. Mirror the executor's
  // own buy-feature detector, which uses the raw balance drop / bet.
  const winCredit = win > 0 ? win : 0;
  const deduction = before - afterBalance + winCredit;
  const rawBaseBet = deriveBaseBetFromRaw(first);
  // Some buy-feature parsers/adapters stamp the PURCHASE COST into betAmount
  // for the first buy spin (e.g. betAmount=40 for a 100x buy at base 0.40).
  // In that shape, deduction / betAmount ≈ 1 and buy-cost assertions false-
  // fail. The raw PP fields still expose the base wager (`c × l` or `c × bl`),
  // so prefer that smaller raw-derived bet when it yields a real buy ratio.
  const parsedRatio = parsedBaseBet > 0 ? deduction / parsedBaseBet : 0;
  const rawRatio = rawBaseBet != null && rawBaseBet > 0 ? deduction / rawBaseBet : 0;
  const baseBet =
    rawBaseBet != null
    && rawBaseBet > 0
    && (parsedBaseBet <= 0 || (rawBaseBet < parsedBaseBet && rawRatio >= 3 && rawRatio > parsedRatio))
      ? rawBaseBet
      : parsedBaseBet;
  return {
    deduction,
    baseBet,
    ratio: baseBet > 0 ? deduction / baseBet : 0,
    spin: first,
  };
}

/**
 * LAYER 1 (universal, no calibration) — sum the per-combo win breakdown the
 * server itemized for a round (PP `wlc_v`, accumulated across tumble frames by
 * cascade-dedup). Assertions compare this to the round's reported win to catch
 * a "phantom win" — a win not backed by any winning symbol combination.
 * Returns 0 when no breakdown present.
 */
export function sumWinBreakdown(spin: LooseSpin | null | undefined): number {
  if (!spin) return 0;
  const combos = spin.winBreakdown as WinCombo[] | undefined;
  return Math.round(sumWinCombos(combos) * 100) / 100;
}

/**
 * LAYER 2 (self-calibrated) — verify each combo's win against the per-game
 * payout model derived from (captured responses + paytable). NO-OP (ok=true,
 * skipped=true) when no trusted model exists, so an uncalibrated game never
 * false-fails. The `model` is bound into the sandbox as a closure over the
 * executor ctx (see case-executor.ts).
 */
export function payoutModelCheck(
  spin: LooseSpin | null | undefined,
  model: PayoutModel | null | undefined,
): PayoutCheckResult {
  if (!spin) return { ok: true, skipped: true, reason: "no spin", checked: 0, matched: 0, mismatches: [] };
  const combos = spin.winBreakdown as WinCombo[] | undefined;
  const raw = (spin.raw ?? {}) as Record<string, unknown>;
  const coin = Number(raw["c"]);
  return checkCombosAgainstModel(model, combos, coin);
}

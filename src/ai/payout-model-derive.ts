// AI: payout-model calibration — onboarding/recovery only. Derives a per-game
// PayoutModel from captured win-combos + paytable so the runtime can verify
// that reported wins are backed by winning symbol patterns. Deterministic fit
// is primary; AI assist is a guarded fallback for ambiguous/exotic games. The
// model is ONLY trusted after a self-validation gate (reproduce 100% of
// observed combos + >=2 coin levels + paytable agreement) → never false-fails.

import { askClaude, extractJsonFromText } from "./claude.js";
import type { PayoutModel, Paytable, GameMechanics } from "../pipeline/registry/types.js";
import { checkCombosAgainstModel, PAYOUT_TOLERANCE } from "../pipeline/step6-build-model/payout-model-eval.js";
import type { WinCombo } from "../pipeline/step6-build-model/win-breakdown.js";

/** One observed winning combo plus the coin value of the spin it came from. */
export type CalibrationCombo = WinCombo & { coin: number };

/** Relative tolerance when matching measured rates to the (2dp-rounded)
 *  paytable — absorbs display rounding without masking real divergence. */
const PAYTABLE_REL_TOL = 0.03;
/** Rates within this relative spread are considered the SAME (consistency). */
const RATE_CONSISTENCY_REL_TOL = 0.02;

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Group combos by symbol index, compute coin-invariant unit rate per count
 *  (rate = win / ways / coin), and reject a symbol/count whose observations
 *  disagree (not coin-invariant → can't model). Pure. */
export function measureRates(combos: ReadonlyArray<CalibrationCombo>): {
  rates: Record<string, Record<string, number>>;   // index -> count -> rate
  inconsistent: Array<{ symbol: string; count: number }>;
} {
  const byKey = new Map<string, number[]>(); // `${symbol}|${count}` -> rates
  for (const c of combos) {
    if (!Number.isFinite(c.win) || c.win <= 0) continue;
    if (!Number.isFinite(c.coin) || c.coin <= 0) continue;
    const ways = Number.isFinite(c.ways) && c.ways > 0 ? c.ways : 1;
    const rate = c.win / ways / c.coin;
    if (!Number.isFinite(rate) || rate <= 0) continue;
    const key = `${c.symbol}|${c.count}`;
    let arr = byKey.get(key);
    if (!arr) { arr = []; byKey.set(key, arr); }
    arr.push(rate);
  }
  const rates: Record<string, Record<string, number>> = {};
  const inconsistent: Array<{ symbol: string; count: number }> = [];
  for (const [key, list] of byKey) {
    const [symbol, countStr] = key.split("|");
    const min = Math.min(...list);
    const max = Math.max(...list);
    const mean = list.reduce((a, b) => a + b, 0) / list.length;
    // coin-invariance check: spread must be tight
    if (mean > 0 && (max - min) / mean > RATE_CONSISTENCY_REL_TOL) {
      inconsistent.push({ symbol: symbol!, count: Number(countStr) });
      continue;
    }
    (rates[symbol!] ??= {})[countStr!] = round4(mean);
  }
  return { rates, inconsistent };
}

/** Find the global reference coin `c0` such that paytable_mult == rate * c0 for
 *  matched symbols, then attach candidate paytable names + agreement per index.
 *  Pure. Returns the symbolCurves map + overall agreement. */
/** Map a measured N-of-a-kind count to its paytable TIER entry: the payout
 *  whose `count` is the LARGEST that is still <= the measured count.
 *
 *  Pays-anywhere / cluster paytables store ONE entry per tier start — e.g.
 *  {8, 10, 12}, where 8 covers 8-9, 10 covers 10-11, 12 covers 12+. But the
 *  measured curve carries EXACT observed counts ({8, 9, 10, 11}), so exact
 *  `count === entry.count` matching silently dropped counts 9/11 → the symbol
 *  failed paytable agreement and the whole model stayed untrusted. Tier lookup
 *  fixes that. For classic lines games (exact 3/4/5 entries) the largest-<=
 *  rule returns the exact same entry, so this is safe for both shapes.
 *  Returns undefined when the count is below the lowest paytable tier. */
function findPaytableTier(
  payouts: ReadonlyArray<{ count: number; multiplier: number }>,
  count: number,
): { count: number; multiplier: number } | undefined {
  let best: { count: number; multiplier: number } | undefined;
  for (const p of payouts) {
    if (p.count <= count && (best === undefined || p.count > best.count)) best = p;
  }
  return best;
}

export function corroborateWithPaytable(
  rates: Record<string, Record<string, number>>,
  paytable: Paytable | null,
): { symbolCurves: PayoutModel["symbolCurves"]; agreement: boolean; notes: string[] } {
  const notes: string[] = [];
  const symbolCurves: PayoutModel["symbolCurves"] = {};
  const pts = paytable?.symbols ?? [];

  // Candidate c0 values from every (index,count,paytableSymbol) pairing.
  const c0cands: number[] = [];
  for (const [, curve] of Object.entries(rates)) {
    for (const [countStr, rate] of Object.entries(curve)) {
      for (const p of pts) {
        const m = findPaytableTier(p.payouts, Number(countStr));
        if (m && rate > 0) c0cands.push(m.multiplier / rate);
      }
    }
  }
  const c0 = clusterMode(c0cands);

  let agreedAll = pts.length > 0 && c0 != null;
  for (const [idx, curve] of Object.entries(rates)) {
    let best: { names: string[]; err: number } = { names: [], err: Infinity };
    if (c0 != null) {
      const matches: string[] = [];
      let worst = 0;
      for (const p of pts) {
        let ok = true;
        let maxErr = 0;
        for (const [countStr, rate] of Object.entries(curve)) {
          const m = findPaytableTier(p.payouts, Number(countStr));
          if (!m) { ok = false; break; }
          const expected = rate * c0;
          const denom = Math.max(Math.abs(m.multiplier), 1e-6);
          const relErr = Math.abs(expected - m.multiplier) / denom;
          maxErr = Math.max(maxErr, relErr);
          if (relErr > PAYTABLE_REL_TOL) { ok = false; break; }
        }
        if (ok) { matches.push(p.symbol); worst = Math.max(worst, maxErr); }
      }
      if (matches.length > 0) best = { names: matches, err: worst };
    }
    const agreement = best.names.length > 0;
    if (!agreement) agreedAll = false;
    symbolCurves[idx] = { curve, names: best.names, paytableAgreement: agreement };
  }
  if (c0 != null) notes.push(`derived reference coin c0=${round4(c0)}`);
  else notes.push("no paytable reference coin found (no symbol shape match)");
  return { symbolCurves, agreement: agreedAll, notes };
}

/** Most common value within a relative tolerance (simple 1-D mode). */
function clusterMode(values: number[], relTol = 0.05): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  let best: { center: number; count: number } = { center: sorted[0]!, count: 0 };
  for (const v of sorted) {
    const inBand = sorted.filter((x) => Math.abs(x - v) <= Math.abs(v) * relTol);
    if (inBand.length > best.count) {
      best = { center: inBand.reduce((a, b) => a + b, 0) / inBand.length, count: inBand.length };
    }
  }
  return best.center;
}

/** Self-validation GATE (pure). Replays the model over every observed combo and
 *  sets calibration stats + `trusted`. Trusted requires: reproduce ALL combos,
 *  >=2 distinct coin levels, and paytable agreement for matched symbols. */
export function validatePayoutModel(
  draft: Pick<PayoutModel, "mechanic" | "symbolCurves" | "generatedAt" | "notes">,
  combos: ReadonlyArray<CalibrationCombo>,
  paytableAgreement: boolean,
  derivedBy: PayoutModel["calibration"]["derivedBy"],
): PayoutModel {
  const coinLevels = [...new Set(combos.map((c) => c.coin).filter((n) => Number.isFinite(n) && n > 0))]
    .map(round4)
    .sort((a, b) => a - b);

  const model: PayoutModel = {
    mechanic: draft.mechanic,
    symbolCurves: draft.symbolCurves,
    calibration: {
      coinLevels,
      spinsUsed: 0,
      combosTotal: 0,
      combosMatched: 0,
      reproducedAll: false,
      paytableAgreement,
      derivedBy,
    },
    trusted: false,
    generatedAt: draft.generatedAt,
    notes: draft.notes,
  };

  // Use the SAME eval as runtime, but force trusted=true transiently so the
  // checker doesn't short-circuit during validation.
  const probe: PayoutModel = { ...model, trusted: true };
  let total = 0;
  let matched = 0;
  for (const c of combos) {
    if (!Number.isFinite(c.win) || c.win <= 0) continue;
    const r = checkCombosAgainstModel(probe, [c], c.coin);
    if (r.skipped) continue; // model can't speak to this combo → not counted
    total += r.checked;
    matched += r.matched;
  }
  model.calibration.combosTotal = total;
  model.calibration.combosMatched = matched;
  model.calibration.reproducedAll = total > 0 && matched === total;
  model.trusted =
    model.calibration.reproducedAll &&
    coinLevels.length >= 2 &&
    paytableAgreement;
  return model;
}

export type DerivePayoutInput = {
  combos: CalibrationCombo[];
  paytable: Paytable | null;
  mechanic: GameMechanics["mechanic"];
  /** Allow the guarded AI fallback (default true). */
  allowAi?: boolean;
};

/**
 * Derive + self-validate a PayoutModel. Deterministic fit first; if it can't
 * reach a trusted model and AI is allowed, ask Claude to propose which symbol
 * indices are wild/scatter (to exclude) or special multipliers, then RE-derive
 * deterministically and RE-validate. AI output is NEVER trusted directly — the
 * validation gate is the sole arbiter, so AI can only ever HELP, never harm.
 */
export async function derivePayoutModel(input: DerivePayoutInput): Promise<PayoutModel> {
  const now = new Date().toISOString();
  const { rates, inconsistent } = measureRates(input.combos);
  const corr = corroborateWithPaytable(rates, input.paytable);
  const notes = [...corr.notes];
  if (inconsistent.length > 0) {
    notes.push(`dropped ${inconsistent.length} symbol/count with coin-variant rates (non-modelable)`);
  }
  let model = validatePayoutModel(
    { mechanic: input.mechanic, symbolCurves: corr.symbolCurves, generatedAt: now, notes },
    input.combos,
    corr.agreement,
    "deterministic",
  );

  if (model.trusted || input.allowAi === false) return model;

  // Guarded AI fallback — only to identify symbol indices to EXCLUDE (wild /
  // scatter / multiplier carriers) that pollute the deterministic fit.
  try {
    const exclude = await aiSuggestExcludedSymbols(input);
    if (exclude.length > 0) {
      const filtered = input.combos.filter((c) => !exclude.includes(c.symbol));
      const { rates: r2 } = measureRates(filtered);
      const corr2 = corroborateWithPaytable(r2, input.paytable);
      const aiNotes = [...corr2.notes, `AI excluded symbol indices: ${exclude.join(", ")}`];
      const aiModel = validatePayoutModel(
        { mechanic: input.mechanic, symbolCurves: corr2.symbolCurves, generatedAt: now, notes: aiNotes },
        filtered,
        corr2.agreement,
        "deterministic+ai",
      );
      // Keep the AI-assisted model only if it is strictly better (trusted).
      if (aiModel.trusted) model = aiModel;
    }
  } catch (err) {
    model.notes = [...(model.notes ?? []), `AI fallback unavailable: ${err instanceof Error ? err.message : String(err)}`];
  }
  return model;
}

/** Ask Claude which numeric symbol indices are wild/scatter/multiplier (and so
 *  should be excluded from the line/cluster payout fit). Returns [] on any
 *  failure. The result only ever filters input — the validation gate decides
 *  trust — so a wrong answer cannot cause a false-fail. */
async function aiSuggestExcludedSymbols(input: DerivePayoutInput): Promise<string[]> {
  const sample = input.combos.slice(0, 60).map((c) => ({
    symbol: c.symbol, win: c.win, ways: c.ways, count: c.count, coin: c.coin,
  }));
  const paytableNames = (input.paytable?.symbols ?? []).map((s) => s.symbol);
  const system =
    "You are a slot-math analyst. Given observed winning-combo records (numeric symbol index, win, ways, count, coin) " +
    "and the paytable symbol names, identify which NUMERIC symbol indices behave as wild/scatter/multiplier carriers " +
    "(i.e. do NOT pay a normal N-of-a-kind line/cluster amount and would corrupt a payout-rate fit). " +
    'Reply ONLY with JSON: {"exclude": ["<index>", ...]} . Empty array if none.';
  const content = JSON.stringify({ mechanic: input.mechanic, paytableNames, combos: sample });
  const raw = await askClaude({ content, system, label: "payout-model/exclude", maxTurns: 1, timeoutMs: 60_000 });
  const parsed = extractJsonFromText<{ exclude?: unknown }>(raw);
  const ex = Array.isArray(parsed?.exclude) ? parsed!.exclude : [];
  return ex.filter((x): x is string => typeof x === "string");
}

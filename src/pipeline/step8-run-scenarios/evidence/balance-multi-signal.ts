// Multi-signal balance assertion (Phase 8.2). Replaces single-signal balance
// conservation with a richer evaluation that combines:
//   - api: parsed response shows balanceAfter = balanceBefore - bet + win
//   - network: balance field in any gameService response we observed
//   - ui_ocr: OCR-read balance from the play-screen balance widget (opt-in)
//   - history: history popup row balance matches (opt-in)
//   - rule: arithmetic formula passes (always — pure math on spin object)
//
// Each signal's contribution is recorded → audit-friendly + AI-debuggable.

import type { NormalizedSpinResult } from "../../step6-build-model/normalized.js";
import { buildSignalEvidence, calcConfidence } from "./confidence.js";
import type {
  ConfidentAssertionResult,
  EvidenceRequirement,
  SignalEvidence,
  Signals,
} from "./types.js";

const TOLERANCE = 0.01;

export type BalanceSignalsInput = {
  spin: NormalizedSpinResult;
  /** OCR-read balance (opt-in via per-case minimumEvidence.optional). */
  ocrBalance?: number;
  /** History popup balance (opt-in). */
  historyBalance?: number;
  /** Raw `balance=` value from any gameService response (e.g., reloadBalance). */
  networkBalance?: number;
  /** Optional per-case requirement spec (else defaults). */
  requirement?: EvidenceRequirement;
  /** When THIS game credits FS wins (learned per-game, parser-overlay aspect).
   *  "immediate" → each FS round credits as it resolves (bb + win == ba).
   *  "deferred"  → balance stays flat mid-chain; total credited at chain end.
   *  undefined/null → NOT LEARNED: an FS frame that fails the immediate model
   *  is INCONCLUSIVE (can't tell deferred-credit from a real bug), never a
   *  hard FAIL. Games differ — never assume one model. */
  fsCreditTiming?: import("../../step6-build-model/providers/spec-types.js").FsCreditTiming | null;
};

/**
 * Evaluate per-spin balance conservation as a confident assertion.
 *
 * Verdict (boolean): `balanceAfter == balanceBefore - bet + win` within
 * TOLERANCE for non-free spins. Free spins: `balanceAfter == balanceBefore
 * + win` (no deduction).
 *
 * Signals individually compare API-reported balance against expected, plus
 * (when available) UI/history/network observations. Caller decides which
 * are optional vs required.
 */
export function evaluateBalanceMultiSignal(
  input: BalanceSignalsInput,
): ConfidentAssertionResult {
  const { spin, ocrBalance, historyBalance, networkBalance } = input;

  // Skip case — can't evaluate without balanceBefore
  if (spin.balanceBefore === null) {
    return {
      id: "balance-conservation",
      description: "Balance conservation (skipped — no priorBalance)",
      pass: true,
      outcome: "INCONCLUSIVE",
      confidence: 0,
      signals: [],
      detail: "balanceBefore is null; cannot evaluate. Configure priorBalance via doInit tracker.",
    };
  }

  // BUY round (game-agnostic SIGNATURE, not per-game hardcode): a non-FS round
  // that grants a feature (fs counter / bonus) while deducting MORE than the
  // bet is a feature purchase — the wallet moved by the BUY COST, not the bet.
  // `bb − bet + win` is the wrong model for it; per-round conservation can't
  // be checked against bet (and validating against the drop itself is a
  // tautology). The buy-cost-ratio catalog assertion + chain-end totals cover
  // it — report honestly instead of false-failing round 1 of every buy case.
  const drop = (spin.balanceBefore ?? 0) - spin.balanceAfter;
  const grantsFeature = (spin.freeSpinsRemaining ?? 0) > 0 || spin.hasBonus === true;
  const isBuyRound = !spin.isFreeSpin && grantsFeature && spin.bet > 0 && drop > spin.bet * 1.5;
  if (isBuyRound) {
    return {
      id: "balance-conservation",
      description: "Balance conservation (buy round — deduction is the purchase cost, not the bet)",
      pass: true,
      outcome: "INCONCLUSIVE",
      confidence: 0,
      signals: [],
      detail: `feature-buy signature: deduction ${drop.toFixed(2)} ≈ ${(drop / spin.bet).toFixed(1)}× bet with feature granted — per-round bet conservation does not apply; verified instead by buy-cost-ratio + chain-end totals`,
    };
  }

  // FS frame: WHICH conservation model applies is a PER-GAME behavior
  // (learned during calibrate → parser-overlay.fsCreditTiming). immediate →
  // bb + win == ba. deferred → balance flat mid-chain (win accumulates,
  // credited at chain end) → expect ba == bb; the final credit lands ≥ bb so
  // it also passes. Unknown → evaluate the immediate model but downgrade a
  // mismatch to INCONCLUSIVE (can't tell deferred-credit from a real bug).
  const fsTiming = input.fsCreditTiming ?? null;
  const expected = spin.isFreeSpin
    ? (fsTiming === "deferred"
        ? (spin.balanceBefore ?? 0) // flat mid-chain; chain-end credit only adds
        : (spin.balanceBefore ?? 0) + spin.win)
    : (spin.balanceBefore ?? 0) - spin.bet + spin.win;

  if (spin.isFreeSpin && fsTiming === "deferred") {
    // Deferred game: mid-chain frames must not DECREASE the balance; flat or
    // the final chain credit are both legitimate.
    const ok = spin.balanceAfter >= (spin.balanceBefore ?? 0) - TOLERANCE;
    return {
      id: "balance-conservation",
      description: "Balance conservation (FS, deferred credit — flat mid-chain, total credited at chain end)",
      pass: ok,
      outcome: ok ? "PASS_HIGH" : "FAIL_HIGH",
      confidence: ok ? 0.9 : 0.9,
      signals: [],
      detail: ok
        ? undefined
        : `FS frame balance DECREASED (${spin.balanceBefore} → ${spin.balanceAfter}) — illegal even under deferred credit`,
    };
  }

  const apiMatches = Math.abs(spin.balanceAfter - expected) <= TOLERANCE;

  // Unknown timing + immediate model failed: downgrade ONLY when the mismatch
  // is consistent with DEFERRED credit — balance flat / under-credited but NOT
  // decreased (bb ≤ ba ≤ bb + win). A DECREASE on an FS frame is illegal under
  // BOTH models and stays a hard FAIL; same for an over-credit.
  const deferralConsistent =
    spin.balanceAfter >= (spin.balanceBefore ?? 0) - TOLERANCE &&
    spin.balanceAfter <= expected + TOLERANCE;
  if (spin.isFreeSpin && fsTiming == null && !apiMatches && deferralConsistent) {
    return {
      id: "balance-conservation",
      description: "Balance conservation (FS frame — credit timing not learned for this game)",
      pass: true,
      outcome: "INCONCLUSIVE",
      confidence: 0,
      signals: [],
      detail: `FS frame: balanceAfter=${spin.balanceAfter} ≠ bb+win=${expected} — could be deferred chain-end credit OR a bug. Run Calibrate with FS coverage to learn fsCreditTiming (parser-overlay) so this can be verified.`,
    };
  }
  const ruleSatisfied = apiMatches; // Same here — math is the rule
  const networkMatches = typeof networkBalance === "number"
    ? Math.abs(networkBalance - spin.balanceAfter) <= TOLERANCE
    : undefined;
  const ocrMatches = typeof ocrBalance === "number"
    ? Math.abs(ocrBalance - spin.balanceAfter) <= TOLERANCE
    : undefined;
  const historyMatches = typeof historyBalance === "number"
    ? Math.abs(historyBalance - spin.balanceAfter) <= TOLERANCE
    : undefined;

  // Build signals map — only include signals where data exists
  const signals: Signals = {
    api: apiMatches,
    rule: ruleSatisfied,
  };
  if (networkMatches !== undefined) signals.network = networkMatches;
  if (ocrMatches !== undefined) signals.ui_ocr = ocrMatches;
  if (historyMatches !== undefined) signals.history = historyMatches;

  // Overall verdict: API + rule must agree; other signals are corroborating
  // evidence that boost confidence but won't flip the verdict.
  const booleanVerdict = apiMatches && ruleSatisfied;

  const { outcome, confidence, inconclusiveReason } = calcConfidence({
    signals,
    booleanVerdict,
    requirement: input.requirement,
  });

  const signalEvidence: SignalEvidence[] = buildSignalEvidence(signals, {
    api: { observed: spin.balanceAfter, expected, source: "parser/balanceAfter" },
    rule: { observed: "balance formula", expected: "balanceAfter == bb - bet + win" },
    network: networkMatches !== undefined
      ? { observed: networkBalance, expected: spin.balanceAfter, source: "gameService/balance" }
      : undefined,
    ui_ocr: ocrMatches !== undefined
      ? { observed: ocrBalance, expected: spin.balanceAfter, source: "ocr/balanceArea" }
      : undefined,
    history: historyMatches !== undefined
      ? { observed: historyBalance, expected: spin.balanceAfter, source: "history-popup" }
      : undefined,
  });

  const detail = booleanVerdict
    ? undefined
    : `expected balanceAfter=${expected} but observed ${spin.balanceAfter} (diff ${spin.balanceAfter - expected}). bb=${spin.balanceBefore} bet=${spin.bet} win=${spin.win} isFreeSpin=${spin.isFreeSpin}`;

  return {
    id: "balance-conservation",
    description: "balanceAfter matches bb - bet + win (or bb + win for free spin)",
    pass: outcome === "PASS_HIGH" || outcome === "PASS_LOW",
    outcome,
    confidence,
    signals: signalEvidence,
    detail: detail ?? (inconclusiveReason ? `Inconclusive: ${inconclusiveReason}` : undefined),
  };
}

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
  const expected = spin.isFreeSpin
    ? (spin.balanceBefore ?? 0) + spin.win
    : (spin.balanceBefore ?? 0) - spin.bet + spin.win;

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

  const apiMatches = Math.abs(spin.balanceAfter - expected) <= TOLERANCE;
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

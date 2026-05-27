// Pure confidence scoring. Phase 8.1. No I/O, no side effects. Fully
// invariant-testable.
//
// Strategy:
//   - Each signal contributes its weight if value=true
//   - Sum of weights of TRUE signals = total confidence
//   - Cap at 1.0
//   - INCONCLUSIVE if any REQUIRED signal is missing (not just false — absent)
//   - Outcome derived from confidence + booleanVerdict + thresholds

import type {
  ConfidentAssertionResult,
  EvidenceRequirement,
  Outcome,
  SignalEvidence,
  Signals,
} from "./types.js";
import { DEFAULT_SIGNAL_WEIGHTS } from "./types.js";

export type CalcInput = {
  /** Boolean signals — true = signal agreed with assertion's claim, false = disagreed. */
  signals: Signals;
  /** Optional per-signal weights (override defaults). */
  weights?: Record<string, number>;
  /** Optional minimum evidence + thresholds. */
  requirement?: EvidenceRequirement;
  /** Overall boolean verdict from the assertion — used to pick PASS vs FAIL family. */
  booleanVerdict: boolean;
};

export type CalcOutput = {
  outcome: Outcome;
  confidence: number;
  /** Optional reason why outcome differs from straightforward pass/fail. */
  inconclusiveReason?: string;
};

/**
 * Compute outcome + confidence from a set of signals + per-case requirement.
 *
 * Confidence = sum of weights of TRUE signals (capped at 1.0).
 * Outcome rules (in order):
 *   1. Any REQUIRED signal missing from `signals` → INCONCLUSIVE
 *   2. booleanVerdict=true:
 *      - confidence ≥ passConfidenceThreshold → PASS_HIGH
 *      - else PASS_LOW
 *   3. booleanVerdict=false:
 *      - confidence ≥ failConfidenceThreshold → FAIL_HIGH
 *      - else FAIL_LOW
 */
export function calcConfidence(input: CalcInput): CalcOutput {
  const weights = { ...DEFAULT_SIGNAL_WEIGHTS, ...(input.weights ?? {}) };
  const passThreshold = input.requirement?.passConfidenceThreshold ?? 0.85;
  const failThreshold = input.requirement?.failConfidenceThreshold ?? 0.85;
  const required = input.requirement?.required ?? [];

  // Missing required signal → INCONCLUSIVE
  const missing = required.filter((name) => !(name in input.signals));
  if (missing.length > 0) {
    return {
      outcome: "INCONCLUSIVE",
      confidence: 0,
      inconclusiveReason: `missing required signals: ${missing.join(", ")}`,
    };
  }

  // Sum weights of TRUE signals
  let confidence = 0;
  for (const [name, value] of Object.entries(input.signals)) {
    if (value) {
      const w = weights[name] ?? 0.1; // unknown signals default to 0.1
      confidence += w;
    }
  }
  confidence = Math.min(1, Math.round(confidence * 100) / 100);

  // Pick outcome family + tier
  if (input.booleanVerdict) {
    return {
      outcome: confidence >= passThreshold ? "PASS_HIGH" : "PASS_LOW",
      confidence,
    };
  }
  return {
    outcome: confidence >= failThreshold ? "FAIL_HIGH" : "FAIL_LOW",
    confidence,
  };
}

/**
 * Build a SignalEvidence[] from a signals map + optional metadata so each
 * row is self-describing for AI review + dashboard.
 */
export function buildSignalEvidence(
  signals: Signals,
  metadata?: Record<string, Partial<Omit<SignalEvidence, "name" | "value" | "weight">>>,
  weights?: Record<string, number>,
): SignalEvidence[] {
  const w = { ...DEFAULT_SIGNAL_WEIGHTS, ...(weights ?? {}) };
  return Object.entries(signals).map(([name, value]) => ({
    name,
    value,
    weight: w[name] ?? 0.1,
    ...(metadata?.[name] ?? {}),
  }));
}

/**
 * Aggregate per-assertion outcomes → case outcome. Rule:
 *   - any INCONCLUSIVE → case INCONCLUSIVE
 *   - any FAIL_HIGH → case FAIL_HIGH
 *   - any FAIL_LOW → case FAIL_LOW (unless higher confidence FAIL_HIGH exists)
 *   - any PASS_LOW + no fails → case PASS_LOW
 *   - all PASS_HIGH → case PASS_HIGH
 *
 * Case confidence = MIN of assertion confidences (weakest link).
 */
export function aggregateCaseOutcome(assertions: ConfidentAssertionResult[]): {
  outcome: Outcome;
  confidence: number;
} {
  if (assertions.length === 0) return { outcome: "INCONCLUSIVE", confidence: 0 };

  let hasInconclusive = false;
  let hasFailHigh = false;
  let hasFailLow = false;
  let hasPassLow = false;
  let hasNeedsReview = false;
  let minConfidence = 1;

  for (const a of assertions) {
    if (a.outcome === "NEEDS_REVIEW") hasNeedsReview = true;
    if (a.outcome === "INCONCLUSIVE") hasInconclusive = true;
    if (a.outcome === "FAIL_HIGH") hasFailHigh = true;
    if (a.outcome === "FAIL_LOW") hasFailLow = true;
    if (a.outcome === "PASS_LOW") hasPassLow = true;
    if (a.confidence < minConfidence) minConfidence = a.confidence;
  }

  if (hasNeedsReview) return { outcome: "NEEDS_REVIEW", confidence: minConfidence };
  if (hasInconclusive) return { outcome: "INCONCLUSIVE", confidence: minConfidence };
  if (hasFailHigh) return { outcome: "FAIL_HIGH", confidence: minConfidence };
  if (hasFailLow) return { outcome: "FAIL_LOW", confidence: minConfidence };
  if (hasPassLow) return { outcome: "PASS_LOW", confidence: minConfidence };
  return { outcome: "PASS_HIGH", confidence: minConfidence };
}

/**
 * Map 5-state Outcome → legacy 3-state status for back-compat with existing
 * dashboard + CLI consumers that only know pass/fail/skip.
 */
export function outcomeToLegacyStatus(outcome: Outcome): "pass" | "fail" | "skip" {
  if (outcome === "PASS_HIGH" || outcome === "PASS_LOW" || outcome === "PASS_WITH_INTERRUPT") return "pass";
  if (outcome === "FAIL_HIGH" || outcome === "FAIL_LOW") return "fail";
  return "skip";
}

/** Inverse of outcomeToLegacyStatus + reasonable defaults for old data. */
export function legacyStatusToOutcome(
  status: "pass" | "fail" | "skip",
  confidence = 0.5,
): Outcome {
  if (status === "pass") return confidence >= 0.85 ? "PASS_HIGH" : "PASS_LOW";
  if (status === "fail") return confidence >= 0.85 ? "FAIL_HIGH" : "FAIL_LOW";
  return "INCONCLUSIVE";
}

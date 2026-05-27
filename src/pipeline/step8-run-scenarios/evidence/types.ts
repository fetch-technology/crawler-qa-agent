// Outcome + Evidence types (Phase 8.1).
//
// Replaces binary pass/fail with 5-state outcome + confidence + multi-signal
// evidence. Backward compatible: legacy `pass: boolean` consumers still see
// status="PASS" or "FAIL" derived from the new model.

/**
 * Per-assertion / per-case outcome. Captures "how confident are we" alongside
 * the verdict.
 *
 *   PASS_HIGH            — evidence overwhelming, auto-trust (≥ passConfidenceThreshold)
 *   PASS_LOW             — looks like pass but evidence thin (< threshold)
 *   PASS_WITH_INTERRUPT  — assertions pass AND an allowed interrupt (free spin,
 *                          big win, bonus) was observed + handled during the
 *                          run. Not a fail — expected variation of cascade /
 *                          bonus games.
 *   FAIL_HIGH            — multiple signals confirm failure
 *   FAIL_LOW             — one signal says fail, may be flaky / OCR noise
 *   INCONCLUSIVE         — insufficient evidence; rerun or pause for review
 *   FLAKY                — repeated runs disagree (auto-detected over N runs)
 *   NEEDS_REVIEW         — unknown state encountered; QA must label manually
 */
export type Outcome =
  | "PASS_HIGH"
  | "PASS_LOW"
  | "PASS_WITH_INTERRUPT"
  | "FAIL_HIGH"
  | "FAIL_LOW"
  | "INCONCLUSIVE"
  | "FLAKY"
  | "NEEDS_REVIEW";

/** Boolean signal — name → was-it-satisfied. */
export type Signals = Record<string, boolean>;

/** Per-signal evidence record — used for audit + AI review. */
export type SignalEvidence = {
  name: string;
  value: boolean;
  /** Raw observed value (e.g., balanceAfter from API: 999.8). */
  observed?: unknown;
  /** Expected value when comparison applicable. */
  expected?: unknown;
  /** Confidence weight contributed by this signal. */
  weight: number;
  /** Optional source label (e.g., "api/gameService", "ocr/balanceArea"). */
  source?: string;
  /** Optional URL / file pointer for the evidence artifact. */
  artifact?: string;
};

/**
 * Result of a single assertion under the multi-signal model. The legacy
 * `pass: boolean` field stays for back-compat — callers that don't know
 * about confidence just see pass=true (outcome PASS_HIGH or PASS_LOW).
 */
export type ConfidentAssertionResult = {
  id: string;
  description: string;
  /** Legacy boolean (true ⇔ outcome ∈ { PASS_HIGH, PASS_LOW }). */
  pass: boolean;
  /** 5-state verdict. */
  outcome: Outcome;
  /** 0..1 aggregate confidence. */
  confidence: number;
  /** Each signal contributing to verdict. */
  signals: SignalEvidence[];
  /** Optional human-readable detail (verbose explanation on fail). */
  detail?: string;
};

/** Configurable per-case thresholds + minimum evidence requirements. */
export type EvidenceRequirement = {
  /** Signal names that MUST contribute (else INCONCLUSIVE). */
  required?: string[];
  /** Signal names that boost confidence but aren't strictly required. */
  optional?: string[];
  /** Confidence ≥ this → PASS_HIGH (else PASS_LOW). Default 0.85. */
  passConfidenceThreshold?: number;
  /** Confidence ≥ this for negative cases → FAIL_HIGH (else FAIL_LOW). Default 0.85. */
  failConfidenceThreshold?: number;
};

/** Evidence collected during case execution — feeds AI review + dashboard. */
export type EvidencePackage = {
  caseId: string;
  startedAt: string;
  durationMs: number;
  /** All assertions run, with their confidence. */
  assertions: ConfidentAssertionResult[];
  /** Aggregate case outcome (worst-of assertions, with INCONCLUSIVE precedence). */
  caseOutcome: Outcome;
  /** Aggregate confidence (min across assertions). */
  caseConfidence: number;
  /** Captured spin records (post cascade-dedup). */
  spinsCount: number;
  /** State transition timeline observed during the case. */
  stateTimeline: Array<{ at: string; from?: string; to: string; via?: string }>;
  /** Per-artifact paths (relative to repo root for portability). */
  artifacts: {
    screenshots: string[];
    networkResponseSnippets: string[];
    ocrReadings: string[];
  };
  /** Engine warnings during execution (popup retries, etc.). */
  warnings: string[];
};

/** Default signal weights — used when caller doesn't supply per-signal weight. */
export const DEFAULT_SIGNAL_WEIGHTS: Record<string, number> = {
  api: 0.35,
  network: 0.10,
  ui_ocr: 0.25,
  history: 0.20,
  screenshot: 0.10,
  state: 0.10,
  rule: 0.20,
};

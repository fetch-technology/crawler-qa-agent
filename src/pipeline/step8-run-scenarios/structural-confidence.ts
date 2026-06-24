// Structural-confidence gate, extracted from case-executor's verdict block so
// it can be unit-tested in isolation (no Playwright, no async).
//
// Purpose: when the engine could not faithfully REPRESENT the spin traffic it
// observed (e.g. an unseen game-clone whose free-spin frames were swallowed into
// the buy round, or whose bet had to be balance-derived), a feature-semantics
// assertion failure is NOT trustworthy evidence of a defect. In that case the
// case should be reported INCONCLUSIVE (re-run / learn the parser) rather than a
// confident red FAIL. This avoids false-failing brand-new games.
//
// CRITICAL: the downgrade is keyed on "we saw more spin traffic than we
// represented" (an internal-confidence signal), NEVER on the bare fact that an
// assertion failed. A genuinely broken buy (button does nothing, server grants
// no free spins) produces doSpinCount ≈ collectedSpins with no merges, so the
// predicate stays false and the case correctly FAILs.

/** Feature-semantics assertion ids whose failure is suppressible when the tool
 *  is structurally unsure. Money-correctness assertions (e.g.
 *  buy-feature-win-non-negative, balance arithmetic) are deliberately EXCLUDED —
 *  those are real defects regardless of state-detection. */
export const FEATURE_SEMANTIC_ASSERTION_IDS: ReadonlySet<string> = new Set([
  "buy-cost-ratio",
  "buy-cost-deducted",
  "buy-feature-cost-deducted",
  "buy-feature-state-transition",
  "buy-feature-free-spins-triggered",
  "buy-free-respins-frames-shape",
  "buy-feature-rounds-resolved",
]);

export type StructuralConfidenceInput = {
  /** # of network responses the parser ACCEPTED as spins (parsedAsSpin===true),
   *  i.e. how many doSpin frames actually arrived. */
  doSpinCount: number;
  /** # of logical rounds the engine ended up with after dedup. */
  collectedSpinsLen: number;
  /** # of accepted frames that produced NO new entry (merged into a prior
   *  round). High on a feature case ⇒ frames were collapsed. */
  dedupSwallowed: number;
  /** Whether any round's bet had to be balance-derived (reconcileBetFromBalance
   *  fired) — pollutes baseBet for ratio assertions. */
  betWasReconciled: boolean;
  /** Whether the state machine never left NORMAL across all captured rounds. */
  stateNeverLeftNormal: boolean;
  /** Whether the case intends to exercise a buy / feature / free-spin flow. */
  isBuyOrFeatureIntent: boolean;
  /** ids of assertions that FAILED this run. */
  failingIds: string[];
};

export type StructuralConfidenceResult = {
  /** True ⇒ downgrade FAIL → INCONCLUSIVE for this case. */
  lowConfidence: boolean;
  /** Human-readable explanation (empty when lowConfidence is false). */
  reason: string;
};

/**
 * Decide whether a failing buy/feature case should be downgraded to
 * INCONCLUSIVE because the engine's representation of the run is structurally
 * unreliable. Pure — no I/O.
 */
export function deriveStructuralConfidence(
  input: StructuralConfidenceInput,
): StructuralConfidenceResult {
  const {
    doSpinCount,
    collectedSpinsLen,
    dedupSwallowed,
    betWasReconciled,
    stateNeverLeftNormal,
    isBuyOrFeatureIntent,
    failingIds,
  } = input;

  if (!isBuyOrFeatureIntent) return { lowConfidence: false, reason: "" };
  if (failingIds.length === 0) return { lowConfidence: false, reason: "" };

  // The failures must be EXCLUSIVELY feature-semantics ones. If anything else
  // failed (e.g. a money-conservation assertion), that's a real defect — keep
  // the FAIL.
  const onlyFeatureSemanticsFailed = failingIds.every((id) =>
    FEATURE_SEMANTIC_ASSERTION_IDS.has(id),
  );
  if (!onlyFeatureSemanticsFailed) return { lowConfidence: false, reason: "" };

  // The case must look like a feature that never registered as one...
  if (!stateNeverLeftNormal) return { lowConfidence: false, reason: "" };

  // ...AND there must be POSITIVE evidence the representation is unreliable.
  const collapsedMultiSpin = doSpinCount >= 3 && collectedSpinsLen <= 1;
  const framesMergedAway = dedupSwallowed >= 2 && collectedSpinsLen <= 1;
  const unreliable = collapsedMultiSpin || framesMergedAway || betWasReconciled;
  if (!unreliable) return { lowConfidence: false, reason: "" };

  const evidence: string[] = [];
  if (collapsedMultiSpin || framesMergedAway) {
    evidence.push(
      `network saw ${doSpinCount} doSpin frame(s) but engine captured `
        + `${collectedSpinsLen} round(s) (${dedupSwallowed} merged away)`,
    );
  }
  if (betWasReconciled) evidence.push("bet had to be balance-derived");

  return {
    lowConfidence: true,
    reason:
      `low structural confidence: ${evidence.join("; ")}. Free-spin / buy state `
      + `was never recognised, so feature-semantics assertions cannot be trusted `
      + `— likely an unseen game encoding. Re-run or learn the parser spec before `
      + `treating this as a failure.`,
  };
}

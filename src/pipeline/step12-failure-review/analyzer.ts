// AI: called only during post-FAIL — Failure Review Layer (Phase 7.5).
// Builds the Evidence package consumed by the classifier. Pure: no I/O,
// no network, no side effects — just shaping a CaseResult + CompiledKnowledge
// into the AI-friendly Evidence shape.

import { KNOWN_FIELD_NAMES } from "../step6-build-model/spin-adapter.js";
import type { Evidence, EvidenceBuilderInput } from "./types.js";

/**
 * Build Evidence from a failed CaseResult + active CompiledKnowledge.
 * Filters out passed assertions from `failures` (keeps full list in
 * `assertions` for context). Safe to call on pass results too — Evidence
 * just won't have any `failures` to analyze.
 */
export function buildEvidence(input: EvidenceBuilderInput): Evidence {
  const { result, knowledge, actionPlan, screenshotPath } = input;
  const assertions = (result.assertions ?? []).map((a) => ({
    id: a.id,
    description: a.description,
    detail: a.detail,
  }));
  const failures = (result.assertions ?? [])
    .filter((a) => !a.pass)
    .map((a) => ({
      id: a.id,
      description: a.description,
      detail: a.detail,
    }));

  // Forward the FULL per-round breakdown so the classifier sees every spin's
  // bet / win / balance — not just lastSpin. Capped to bound prompt size; for
  // a longer autoplay the head + tail matter most, so keep first and last rows.
  const PER_SPIN_CAP = 100;
  const allSpins = result.spins ?? [];
  const kept = allSpins.length > PER_SPIN_CAP
    ? [...allSpins.slice(0, PER_SPIN_CAP - 20), ...allSpins.slice(-20)]
    : allSpins;
  const perSpinRows = kept.map((s, i) => ({
    idx: allSpins.length > PER_SPIN_CAP && i >= PER_SPIN_CAP - 20
      ? allSpins.length - (kept.length - i) + 1
      : i + 1,
    bet: s.bet,
    win: s.win,
    balanceBefore: s.balanceBefore,
    balanceAfter: s.balanceAfter,
    roundId: s.roundId,
    state: s.state,
    isFreeSpin: s.isFreeSpin,
  }));

  return {
    caseId: result.caseId,
    caseName: result.name,
    category: result.category,
    severity: result.severity,
    status: result.status === "skip" ? "skip" : "fail",
    skipReason: result.skipReason,
    assertions,
    failures,
    lastSpin: result.spin
      ? {
          bet: result.spin.bet,
          win: result.spin.win,
          balanceBefore: result.spin.balanceBefore,
          balanceAfter: result.spin.balanceAfter,
          roundId: result.spin.roundId,
          state: result.spin.state,
        }
      : null,
    spinsCount: result.spinsCount ?? (result.spin ? 1 : 0),
    perSpin: perSpinRows,
    perSpinTruncated: (result.spins?.length ?? 0) > PER_SPIN_CAP,
    warnings: result.warnings ?? [],
    actionPlan,
    knowledge: {
      gameSlug: knowledge.gameSlug,
      parserKind: knowledge.parser?.parser ?? null,
      mechanic: knowledge.mechanics?.mechanic ?? null,
      betMultiplier: knowledge.mechanics?.betMultiplier ?? null,
      betFormulaDescription: knowledge.derived.betFormulaDescription,
      uiElementCount: Object.keys(knowledge.ui).length,
      spinApiUrl: knowledge.api?.spinApi?.url ?? null,
      knownAliasFields: [...KNOWN_FIELD_NAMES],
    },
    screenshotPath,
  };
}

/**
 * Quick heuristic pre-classifier — returns a classification + confidence
 * WITHOUT calling AI. Useful as a fast path for obvious cases (saves AI
 * cost) and as a fallback when AI is unavailable. Returns null if heuristic
 * can't decide → caller invokes full AI classifier.
 */
export function heuristicClassify(evidence: Evidence): {
  classification: import("./types.js").RootCauseClassification;
  confidence: number;
  reason: string;
} | null {
  // Skip reason mentions "uiKey '...' not in registry" → wrong_registry
  if (evidence.skipReason && /uiKey ['"](\w+(?:__\w+)*)['"] not in registry/.test(evidence.skipReason)) {
    const m = evidence.skipReason.match(/uiKey ['"]([^'"]+)['"] not in registry/);
    return {
      classification: "wrong_registry",
      confidence: 0.95,
      reason: `Action referenced uiKey '${m?.[1]}' which is missing from ui-registry.json. Add the element via dashboard Pick or AI Recover.`,
    };
  }
  // Skip reason: no spin response → could be popup or API issue
  if (evidence.skipReason && /no spin response captured/i.test(evidence.skipReason)) {
    // Hint: was there a popup-blocked warning?
    if (evidence.warnings.some((w) => /popup blocked/i.test(w))) {
      return {
        classification: "wrong_popup_keywords",
        confidence: 0.7,
        reason: "Spin blocked by popup that wasn't auto-dismissed. Add the popup's text to popup-keywords.json or pick its closeButton in ui-registry.",
      };
    }
    return null; // Let AI decide
  }
  // matrix-present / reels-shape assertion fail → ALWAYS wrong_assertion
  // (parser legitimately may not populate reels for cascade frames; the
  // assertion needs to be more tolerant). Do NOT classify as core_logic_bug.
  const matrixFail = evidence.failures.find((f) =>
    /matrix.*length|matrix.*array|reels.*length|reels.*array/i.test(f.description) ||
    /matrix.*present|reels.*present/i.test(f.id),
  );
  if (matrixFail) {
    return {
      classification: "wrong_assertion",
      confidence: 0.85,
      reason: `Assertion '${matrixFail.id}' fails because reels/matrix may be empty for cascade frames or this game's parser doesn't decode reels. This is an assertion gap, not a game bug. Suggest: relax check to (s.matrix?.length > 0 || s.cascadeFrames?.length > 0) or skip for non-reel cases.`,
    };
  }
  // Cumulative balance failure with cascade game → wrong_cascade_rule
  const cumulativeFail = evidence.failures.find((f) => /cumulative.*balance.*reconcile/i.test(f.id));
  if (cumulativeFail && evidence.spinsCount > evidence.actionPlan.filter((a) => a.kind === "spin").length) {
    return {
      classification: "wrong_cascade_rule",
      confidence: 0.6,
      reason: `Captured ${evidence.spinsCount} spins but action plan had ${evidence.actionPlan.filter((a) => a.kind === "spin").length} spin actions — cascade dedup may have missed merging frames.`,
    };
  }

  // wrong_test_pacing — symptoms: (1) at least 1 warning about "no response
  // within Xs"; (2) captured spins fewer than action plan asked for; (3) the
  // spins that DID land reconcile (balance assertion passes / no balance
  // failure in `failures`). That combination is the signature of a cascade
  // game whose animation debounces subsequent clicks, NOT a network flake.
  //
  // Sub-classification by cause:
  //   - Heavy cascade-merge present (mergedHint in warning) → the game is
  //     cluster/cascade-heavy; bumping timeouts won't help (clicks are being
  //     IGNORED during animation, not delayed). Best fix = relax assertion.
  //   - No merge hint → likely slow network; bumping timeouts CAN help.
  const expectedSpins = evidence.actionPlan.filter((a) => a.kind === "spin").length;
  const captured = evidence.spinsCount;
  const noResponseWarning = evidence.warnings.some((w) =>
    /no spin\/?(?:gameService)? response within|no response within|no new spin response/i.test(w),
  );
  const cascadeMergeWarning = evidence.warnings.some((w) =>
    /dedup-merged|cascade frames|cascade-heavy|debounced/i.test(w),
  );
  const countFailure = evidence.failures.find((f) =>
    /round[- _]?end|spin.*count|end.*rounds.*recorded|spins.*observed/i.test(f.id),
  );
  const balanceFailure = evidence.failures.find((f) =>
    /balance|reconcil|conserv/i.test(f.id),
  );
  if (
    expectedSpins >= 3
    && captured > 0
    && captured < expectedSpins
    && noResponseWarning
    && countFailure
    && !balanceFailure
  ) {
    // Cascade-heavy variant: clicks are being IGNORED by the game during
    // ongoing cluster animations. Raising spinResponseTimeoutMs does NOT
    // help because the game never sends a response for ignored clicks. The
    // ONLY reliable fixes here are (a) longer wait_ms between spins, or
    // (b) relax the spin-count assertion to match observed game pace.
    if (cascadeMergeWarning) {
      return {
        classification: "wrong_test_pacing",
        confidence: 0.85,
        reason: `Captured ${captured}/${expectedSpins} spins. Engine merged extra responses as cascade frames — this is a cluster/cascade-heavy game where rapid clicks are IGNORED during cluster animation (not delayed). Bumping spinResponseTimeoutMs WON'T help. Fix: increase wait_ms between spins to 8000+ (test-cases.json), OR relax the spin-count assertion to match observed pace.`,
      };
    }
    // Pure timing variant: no cascade-merge signal, just slow responses.
    // Raising timeout actually does help here.
    return {
      classification: "wrong_test_pacing",
      confidence: 0.75,
      reason: `Captured ${captured}/${expectedSpins} spins with timeout warnings, balance math correct. No cascade-merge signal — likely slow per-spin responses. Fix: raise spinResponseTimeoutMs in timing-config.json, or add longer wait_ms between spins.`,
    };
  }
  // bet=460.8 (or any bet × 50× of typical) when balance shows small drop →
  // wrong_bet_formula (ways game with naive c × l = c × waysCount)
  const balanceMismatch = evidence.lastSpin
    && typeof evidence.lastSpin.balanceBefore === "number"
    && typeof evidence.lastSpin.balanceAfter === "number"
    && Math.abs(evidence.lastSpin.bet) > 0
    && Math.abs((evidence.lastSpin.balanceBefore - evidence.lastSpin.balanceAfter) - evidence.lastSpin.bet) > evidence.lastSpin.bet * 0.5;
  if (balanceMismatch && evidence.knowledge.mechanic === "unknown") {
    return {
      classification: "wrong_bet_formula",
      confidence: 0.8,
      reason: `Reported bet (${evidence.lastSpin!.bet}) far from observed balance drop. game-mechanics.mechanic is "unknown" — likely a ways/cluster game with wrong formula. Reload session to trigger auto-derive.`,
    };
  }
  return null;
}

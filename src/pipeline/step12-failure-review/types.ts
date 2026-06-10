// AI Failure Review Layer types (Phase 7.5).
//
// Evidence is the input to the classifier — a structured snapshot of what
// failed. RootCauseClassification is the output — a labeled diagnosis with
// optional patch suggestion that downstream patch-validator can attempt to
// auto-apply.

import type { CaseResult } from "../step8-run-scenarios/case-executor.js";
import type { CompiledKnowledge } from "../knowledge/types.js";
import type { CaseAction } from "../step7-testcase-gen/case-action-translator.js";

export type AssertionFailure = {
  id: string;
  description: string;
  checkCode?: string;
  detail?: string;
};

export type Evidence = {
  caseId: string;
  caseName: string;
  category: string;
  severity: "critical" | "major" | "minor";
  /** Status of the failed case run. */
  status: "fail" | "skip";
  /** Reason if the case skipped (no spin captured, action threw, etc.). */
  skipReason?: string;
  /** All assertion results — pass + fail. */
  assertions: AssertionFailure[];
  /** Just the failing assertions for AI focus. */
  failures: AssertionFailure[];
  /** Compact spin snapshot — last captured spin's key fields. */
  lastSpin: {
    bet: number;
    win: number;
    balanceBefore: number | null;
    balanceAfter: number;
    roundId: string;
    state: string;
  } | null;
  /** Total spins captured (cascade-dedup'd). */
  spinsCount: number;
  /** Per-round breakdown for EVERY captured spin (bet / win / balance / state),
   *  in order. Lets the classifier reason over the WHOLE sequence — not just
   *  lastSpin — so multi-spin failures (spin-count mismatch, a mid-run round
   *  whose arithmetic breaks, FS frames) are diagnosable instead of the AI only
   *  seeing the final round. Capped at 100 rows; see perSpinTruncated. */
  perSpin?: Array<{
    idx: number;
    bet: number;
    win: number;
    balanceBefore: number | null;
    balanceAfter: number;
    roundId: string;
    state: string;
    isFreeSpin?: boolean;
  }>;
  /** True when more rounds were captured than included in perSpin (capped). */
  perSpinTruncated?: boolean;
  /** Engine warnings emitted during run (popup retries, etc.). */
  warnings: string[];
  /** Action plan that was executed. */
  actionPlan: CaseAction[];
  /** Active game configuration snapshot (helps AI suggest patches to right file). */
  knowledge: {
    gameSlug: string;
    parserKind: string | null;
    mechanic: string | null;
    betMultiplier: number | null;
    betFormulaDescription: string;
    uiElementCount: number;
    spinApiUrl: string | null;
    knownAliasFields: string[];
  };
  /** Optional path to a failure screenshot saved at fail time. */
  screenshotPath?: string;
};

export type RootCauseClassification =
  | "real_game_bug"          // game violates its own spec; report to game dev
  | "wrong_registry"         // ui coord/key wrong → fixable in ui-registry.json
  | "wrong_api_mapping"      // spin URL wrong → fixable in api-mapping.json
  | "wrong_field_mapping"    // alias missing → fixable in field-mapping.json
  | "wrong_bet_formula"      // multiplier wrong → fixable in game-mechanics.json
  | "wrong_popup_keywords"   // missing keyword → fixable in popup-keywords.json
  | "wrong_cascade_rule"     // dedup heuristic mis-fires → cascade-rules.json
  | "wrong_assertion"        // AI-generated assertion checks wrong thing
  | "wrong_test_pacing"      // action plan fires spins faster than the game's
                             // animation lets it accept (e.g. cascade games
                             // debounce clicks during the animation window).
                             // Reproducible, not transient. Patch:
                             //   - timing-config.json (raise timeouts), OR
                             //   - test-cases.json (insert wait_until_network_idle
                             //     between spin actions), OR
                             //   - relax assertion expected spin count.
  | "core_logic_bug"         // engine bug — file dev ticket
  | "transient";             // race/network blip → just rerun

export type SuggestedPatch = {
  /** File under fixtures/registry/<slug>/ to patch. */
  file: string;
  /** Operation type. */
  operation: "merge" | "replace" | "add_alias" | "set_field";
  /** Diff payload — partial JSON to merge or replace. */
  diff: Record<string, unknown>;
};

export type ReviewResult = {
  classification: RootCauseClassification;
  /** 0..1 confidence. ≥0.85 → auto-apply gate. */
  confidence: number;
  /** Human-readable explanation of the root cause. */
  reason: string;
  /** Optional patch (data-only — engine refuses to mutate core code). */
  suggestedPatch?: SuggestedPatch;
  /** Optional dev escalation notes if classification = core_logic_bug. */
  devNotification?: {
    severity: "low" | "medium" | "high";
    title: string;
    body: string;
  };
  /** Token usage + cost telemetry. */
  meta: {
    promptTokens?: number;
    completionTokens?: number;
    estimatedCostUsd?: number;
    durationMs: number;
  };
};

/** Result of building Evidence (separated from review for testability). */
export type EvidenceBuilderInput = {
  result: CaseResult;
  knowledge: CompiledKnowledge;
  actionPlan: CaseAction[];
  screenshotPath?: string;
};

export type { CaseResult };

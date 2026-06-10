// Auto-rerun orchestrator (Phase 8 final item 3). After a patch is applied,
// optionally re-run the case + re-review + re-patch up to N times until
// PASS or escalation. Caps to avoid infinite AI cost.
//
// Loop:
//   1. Apply patch → rerun case
//   2. If outcome PASS_HIGH → done (success)
//   3. If outcome FAIL/INCONCLUSIVE → re-review
//   4. If new patch suggested + confidence high → apply + repeat
//   5. After MAX_RERUN attempts → escalate (status: "escalated")
//   6. If same patch re-suggested → escalate (loop detected)

import type { ReviewResult, SuggestedPatch } from "../step12-failure-review/index.js";
import type { RerunResult } from "./types.js";

export const MAX_RERUN_ATTEMPTS = 3;

export type RerunOrchestratorInput = {
  caseId: string;
  gameSlug: string;
  /** Initial patch suggested by first AI review. */
  initialPatch: SuggestedPatch;
  /** Initial review result (used as first iteration's metadata). */
  initialReview: ReviewResult;
  /** Callbacks bound to manualSession — keeps this module pure. */
  callbacks: {
    applyPatch: (patch: SuggestedPatch, review: ReviewResult) => Promise<{ ok: boolean; reason?: string }>;
    rerunCase: () => Promise<{ ok: boolean; result?: { status: "pass" | "fail" | "skip" | "inconclusive"; outcome?: string }; reason?: string }>;
    reReview: () => Promise<{ ok: boolean; review?: ReviewResult; reason?: string }>;
  };
  /** Auto-apply confidence threshold (default 0.85). Below this, loop stops + escalates. */
  autoApplyThreshold?: number;
};

export async function rerunWithPatches(input: RerunOrchestratorInput): Promise<RerunResult> {
  const log: string[] = [];
  const autoThreshold = input.autoApplyThreshold ?? 0.85;
  let patchesApplied = 0;
  let lastReview: ReviewResult = input.initialReview;
  let currentPatch: SuggestedPatch | undefined = input.initialPatch;
  let attempts = 0;
  const appliedSignatures = new Set<string>();

  while (attempts < MAX_RERUN_ATTEMPTS) {
    attempts++;
    if (!currentPatch) {
      log.push(`attempt ${attempts}: no patch to apply — escalating`);
      return { status: "escalated", attemptsUsed: attempts, patchesApplied, finalReview: lastReview, log };
    }

    // Loop detection: same file + same diff JSON → already tried
    const sig = `${currentPatch.file}::${JSON.stringify(currentPatch.diff)}`;
    if (appliedSignatures.has(sig)) {
      log.push(`attempt ${attempts}: same patch re-suggested (${sig}) — loop detected, escalating`);
      return { status: "escalated", attemptsUsed: attempts, patchesApplied, finalReview: lastReview, log };
    }
    appliedSignatures.add(sig);

    // Confidence gate
    if (lastReview.confidence < autoThreshold) {
      log.push(`attempt ${attempts}: review confidence ${lastReview.confidence} < ${autoThreshold} — escalating (manual approve needed)`);
      return { status: "escalated", attemptsUsed: attempts, patchesApplied, finalReview: lastReview, log };
    }

    log.push(`attempt ${attempts}: applying patch (file=${currentPatch.file}, op=${currentPatch.operation})`);
    const applied = await input.callbacks.applyPatch(currentPatch, lastReview);
    if (!applied.ok) {
      log.push(`apply failed: ${applied.reason}`);
      return { status: "escalated", attemptsUsed: attempts, patchesApplied, finalReview: lastReview, log };
    }
    patchesApplied++;

    log.push(`rerunning case`);
    const rerun = await input.callbacks.rerunCase();
    if (!rerun.ok) {
      log.push(`rerun failed: ${rerun.reason}`);
      return { status: "escalated", attemptsUsed: attempts, patchesApplied, finalReview: lastReview, log };
    }

    const outcome = rerun.result?.outcome ?? (rerun.result?.status === "pass" ? "PASS_HIGH" : "FAIL_HIGH");
    log.push(`rerun outcome: ${outcome}`);

    if (outcome === "PASS_HIGH" || outcome === "PASS_LOW") {
      log.push(`SUCCESS — case passing after ${patchesApplied} patches`);
      return { status: "pass", attemptsUsed: attempts, patchesApplied, finalReview: lastReview, log };
    }

    // Still failing → re-review
    log.push(`still failing — calling AI review for next iteration`);
    const reReview = await input.callbacks.reReview();
    if (!reReview.ok || !reReview.review) {
      log.push(`re-review failed: ${reReview.reason}`);
      return { status: "escalated", attemptsUsed: attempts, patchesApplied, finalReview: lastReview, log };
    }
    lastReview = reReview.review;
    currentPatch = reReview.review.suggestedPatch;
  }

  log.push(`hit MAX_RERUN_ATTEMPTS=${MAX_RERUN_ATTEMPTS} — escalating`);
  return { status: "escalated", attemptsUsed: attempts, patchesApplied, finalReview: lastReview, log };
}

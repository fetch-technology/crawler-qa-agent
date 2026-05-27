// Patch application pipeline (Phase 7.6) — types.
//
// Flow:
//   1. AI Review (Phase 7.5) produces a SuggestedPatch
//   2. Patch Validator: JSON Schema check + sanity bounds
//   3. Dry-run: re-evaluate the failed assertion against patched config
//   4. Auto-apply (confidence ≥ threshold + dry-run pass) or manual approve
//   5. Append patch to audit log under fixtures/registry/<slug>/patches/
//   6. Trigger Knowledge Compiler rebuild
//   7. Rerun case (max N=3 iterations)

import type { SuggestedPatch, ReviewResult } from "../step12-failure-review/types.js";

export type ValidationOutcome = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

export type DryRunOutcome = {
  ok: boolean;
  /** Reason why dry-run passed/failed. */
  reason: string;
  /** Optional: predicted assertion result after patch. */
  predictedAssertionPass?: boolean;
};

export type ApplyOutcome = {
  ok: boolean;
  patchedFile: string;
  /** Path to the audit log entry written. */
  auditLogPath?: string;
  errors: string[];
};

export type PatchAuditEntry = {
  timestamp: string;
  caseId: string;
  classification: string;
  confidence: number;
  reason: string;
  patch: SuggestedPatch;
  validation: ValidationOutcome;
  dryRun: DryRunOutcome | null;
  applied: boolean;
  appliedAt?: string;
  prevContent?: unknown;   // For rollback
  newContent?: unknown;
};

export type RerunResult = {
  /** Final status after up to N rerun attempts. */
  status: "pass" | "fail" | "escalated";
  attemptsUsed: number;
  patchesApplied: number;
  finalReview?: ReviewResult;
  log: string[];
};

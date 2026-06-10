// Gap B — Per-case retry loop. Wraps executeCase: if outcome ∈
// retryPolicy.retryWhen and attempts < retryPolicy.maxRetries, rerun.
// Different from auto-rerun-with-patches (Phase 8 item 3): no patch applied
// here, just re-execute with same config (catches transient + flaky issues).
//
// Pure orchestrator — calls an executeFn callback. Testable without browser.

import type { CaseResult } from "./case-executor.js";

export const DEFAULT_MAX_RETRIES = 3;

export type RetryPolicy = {
  maxRetries?: number;
  /** Outcomes (case-level) that trigger a retry. Default: INCONCLUSIVE +
   *  FAIL_LOW + FLAKY. PASS_HIGH/PASS_LOW never retried. */
  retryWhen?: string[];
  /** When true, ALSO retry whenever the case status is "fail" (regardless of
   *  outcome — including a confident FAIL_HIGH). Used for the default
   *  "re-run on fail, only record fail if it persists" behavior. */
  retryOnFailStatus?: boolean;
};

export const DEFAULT_RETRY_OUTCOMES: ReadonlyArray<string> = [
  "INCONCLUSIVE",
  "FAIL_LOW",
  "FLAKY",
];

export type RetryLoopResult = {
  finalResult: CaseResult;
  attempts: number;
  attemptHistory: Array<{
    attempt: number;
    outcome?: string;
    status: "pass" | "fail" | "skip" | "inconclusive";
    durationMs: number;
  }>;
};

/**
 * Run a case with retry policy. Retries while the result is "retryable":
 *   - outcome ∈ retryWhen (default INCONCLUSIVE / FAIL_LOW / FLAKY), OR
 *   - retryOnFailStatus && status === "fail" (any fail, incl. FAIL_HIGH).
 * Stops early on a non-retryable result (pass, or a fail that isn't covered),
 * or when maxRetries is hit. The LAST result is the one recorded — so a case
 * that fails then passes on re-run is recorded as pass.
 */
export async function runWithRetry(
  executeFn: () => Promise<CaseResult>,
  policy: RetryPolicy = {},
): Promise<RetryLoopResult> {
  const max = Math.max(0, Math.min(10, policy.maxRetries ?? DEFAULT_MAX_RETRIES));
  const retryWhen = policy.retryWhen ?? DEFAULT_RETRY_OUTCOMES;
  const history: RetryLoopResult["attemptHistory"] = [];

  let attempt = 0;
  let lastResult: CaseResult | null = null;

  while (attempt < max + 1) {
    attempt++;
    const result = await executeFn();
    lastResult = result;
    history.push({
      attempt,
      outcome: result.outcome,
      status: result.status,
      durationMs: result.durationMs,
    });

    const outcomeRetry = result.outcome != null && retryWhen.includes(result.outcome);
    const statusRetry = policy.retryOnFailStatus === true && result.status === "fail";
    if (!outcomeRetry && !statusRetry) break; // definitive (pass / non-retryable)
    if (attempt >= max + 1) break;            // hit retry cap → record last
  }

  return {
    finalResult: lastResult!,
    attempts: attempt,
    attemptHistory: history,
  };
}

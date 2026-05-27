// FLAKY detector. Pure function — given a list of HistoryEntry (most recent
// runs), classify whether the case is FLAKY (outcomes disagree across
// recent runs) or STABLE (consistent pass / consistent fail).

import type { Outcome } from "../evidence/types.js";
import type { HistoryEntry } from "./types.js";
import { FLAKY_MIN_HISTORY, FLAKY_WINDOW } from "./types.js";

export type FlakyVerdict = {
  flaky: boolean;
  /** Reason why classified flaky (or "stable"). */
  reason: string;
  /** Distribution of outcomes in the inspected window. */
  outcomeCounts: Record<string, number>;
  /** Number of entries inspected. */
  entriesInspected: number;
};

const PASS_OUTCOMES: ReadonlySet<Outcome> = new Set(["PASS_HIGH", "PASS_LOW"]);
const FAIL_OUTCOMES: ReadonlySet<Outcome> = new Set(["FAIL_HIGH", "FAIL_LOW"]);

/**
 * Inspect the last FLAKY_WINDOW entries. Cases are flaky when:
 *   - At least FLAKY_MIN_HISTORY entries exist
 *   - The window contains BOTH pass-family AND fail-family outcomes
 *
 * INCONCLUSIVE / NEEDS_REVIEW / FLAKY entries don't count toward
 * disagreement (they're already non-binary verdicts).
 */
export function detectFlaky(history: HistoryEntry[]): FlakyVerdict {
  const recent = history.slice(-FLAKY_WINDOW);
  const counts: Record<string, number> = {};
  for (const e of recent) counts[e.outcome] = (counts[e.outcome] ?? 0) + 1;

  if (recent.length < FLAKY_MIN_HISTORY) {
    return {
      flaky: false,
      reason: `only ${recent.length} runs (need ≥${FLAKY_MIN_HISTORY} to decide)`,
      outcomeCounts: counts,
      entriesInspected: recent.length,
    };
  }

  let hasPass = false;
  let hasFail = false;
  for (const e of recent) {
    if (PASS_OUTCOMES.has(e.outcome)) hasPass = true;
    if (FAIL_OUTCOMES.has(e.outcome)) hasFail = true;
  }

  if (hasPass && hasFail) {
    const passN = recent.filter((e) => PASS_OUTCOMES.has(e.outcome)).length;
    const failN = recent.filter((e) => FAIL_OUTCOMES.has(e.outcome)).length;
    return {
      flaky: true,
      reason: `${passN} pass + ${failN} fail across last ${recent.length} runs`,
      outcomeCounts: counts,
      entriesInspected: recent.length,
    };
  }

  return {
    flaky: false,
    reason: hasPass
      ? `consistent pass across last ${recent.length} runs`
      : hasFail
      ? `consistent fail across last ${recent.length} runs`
      : "all runs inconclusive — no pass/fail disagreement",
    outcomeCounts: counts,
    entriesInspected: recent.length,
  };
}

/**
 * Combine a fresh outcome with stored history to produce the FINAL outcome
 * that gets returned to the user. If the fresh outcome is PASS or FAIL but
 * history shows FLAKY pattern, promote to FLAKY (helps QA know "this run
 * passed but the case has been flapping").
 */
export function maybePromoteToFlaky(
  freshOutcome: Outcome,
  history: HistoryEntry[],
): Outcome {
  // Only promote PASS/FAIL outcomes. INCONCLUSIVE / NEEDS_REVIEW stay.
  if (!PASS_OUTCOMES.has(freshOutcome) && !FAIL_OUTCOMES.has(freshOutcome)) {
    return freshOutcome;
  }
  const verdict = detectFlaky(history);
  if (verdict.flaky) return "FLAKY";
  return freshOutcome;
}

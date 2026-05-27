// N-run history per test case (Phase 8 final). Append-only log used by
// FLAKY detector to identify cases that disagree on outcome across runs.
//
// Storage: fixtures/registry/<slug>/case-history/<caseId>.jsonl
// Each line = 1 HistoryEntry. Bounded by MAX_HISTORY_ENTRIES (trim oldest
// when limit reached — keep last N).

import type { Outcome } from "../evidence/types.js";

export type HistoryEntry = {
  /** ISO8601 timestamp of the run. */
  ranAt: string;
  /** Outcome of this run. */
  outcome: Outcome;
  /** Confidence at this run (if recorded). */
  confidence?: number;
  /** Legacy status mapping (back-compat with consumers that read raw status). */
  status: "pass" | "fail" | "skip";
  /** Duration of the run in ms. */
  durationMs: number;
  /** Optional: number of spins captured. */
  spinsCount?: number;
  /** Optional: error or skip reason. */
  reason?: string;
};

/** How many recent entries to keep per case (older trimmed when exceeded). */
export const MAX_HISTORY_ENTRIES = 50;

/** How many recent entries the FLAKY detector inspects. */
export const FLAKY_WINDOW = 5;

/**
 * FLAKY ⇔ across the last K runs, outcomes disagree (mix of PASS_* and
 * FAIL_*). If all PASS or all FAIL → not flaky. If only 1 historical run
 * → can't decide.
 */
export const FLAKY_MIN_HISTORY = 3;

// Per-case statistics derived from history log. Phase 8 final / Gap C.
// passRate = passed / total
// flakyScore = disagreement ratio in last K runs
//
// Pure functions — no I/O. Tests cover edge cases (empty, all-pass, mixed).

import type { HistoryEntry } from "./types.js";
import { FLAKY_WINDOW } from "./types.js";

export type CaseStats = {
  totalRuns: number;
  passes: number;
  fails: number;
  inconclusives: number;
  /** passes / totalRuns ∈ [0, 1]. Returns 0 when no runs. */
  passRate: number;
  /** Disagreement ratio in last FLAKY_WINDOW runs. 0 = stable, 1 = max flaky.
   *  Computed as 2 * min(passes, fails) / window — peaks at 1 when 50/50 split. */
  flakyScore: number;
  /** Recent outcomes (most recent first). */
  recentOutcomes: string[];
};

const PASS_OUTCOMES = new Set(["PASS_HIGH", "PASS_LOW"]);
const FAIL_OUTCOMES = new Set(["FAIL_HIGH", "FAIL_LOW"]);

export function computeStats(history: HistoryEntry[]): CaseStats {
  const total = history.length;
  if (total === 0) {
    return {
      totalRuns: 0,
      passes: 0,
      fails: 0,
      inconclusives: 0,
      passRate: 0,
      flakyScore: 0,
      recentOutcomes: [],
    };
  }

  let passes = 0, fails = 0, inconclusives = 0;
  for (const e of history) {
    if (PASS_OUTCOMES.has(e.outcome)) passes++;
    else if (FAIL_OUTCOMES.has(e.outcome)) fails++;
    else inconclusives++;
  }

  // Flaky score from last FLAKY_WINDOW only — recent flakiness matters more
  const recent = history.slice(-FLAKY_WINDOW);
  let recentPass = 0, recentFail = 0;
  for (const e of recent) {
    if (PASS_OUTCOMES.has(e.outcome)) recentPass++;
    else if (FAIL_OUTCOMES.has(e.outcome)) recentFail++;
  }
  const recentDecisive = recentPass + recentFail;
  const flakyScore = recentDecisive > 0
    ? Math.round((2 * Math.min(recentPass, recentFail) / recentDecisive) * 100) / 100
    : 0;

  return {
    totalRuns: total,
    passes,
    fails,
    inconclusives,
    passRate: Math.round((passes / total) * 100) / 100,
    flakyScore,
    recentOutcomes: history.slice(-10).reverse().map((e) => e.outcome),
  };
}

/** Human-readable flaky tier from score. */
export function flakyTier(flakyScore: number): "STABLE" | "LOW" | "MEDIUM" | "HIGH" {
  if (flakyScore < 0.2) return "STABLE";
  if (flakyScore < 0.5) return "LOW";
  if (flakyScore < 0.8) return "MEDIUM";
  return "HIGH";
}
